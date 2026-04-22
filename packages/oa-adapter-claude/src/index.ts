import * as fs from 'node:fs/promises';
import { assertAbs, spawnHeadless } from '@soulerou/oa-core';
import type { AgentAdapter, AgentRunOpts, AgentRunResult } from '@soulerou/oa-core';
import { createStreamJsonHeartbeatParser } from './heartbeat.js';

/**
 * Headless `claude` AgentAdapter — first concrete implementation of the
 * AgentAdapter contract (ADR-0009).
 *
 * Wire diagram:
 *   supervisor → registry.lookup('claude') → adapter.run(opts)
 *                                              ↓
 *                       reads opts.promptPath into a string
 *                                              ↓
 *                       builds claude argv (-p text --model M --output-format
 *                       stream-json [...extraArgs])
 *                                              ↓
 *                       spawnHeadless({command:'claude', ...})
 *                                              ↓
 *                       parseSessionIdFromStreamJson(opts.stdoutPath)
 *                                              ↓
 *                       returns AgentRunResult with sessionId overlaid
 *
 * SECURITY NOTE: extraArgs is spread verbatim into claude's argv. Intake
 * content is trusted (validated by the source-agent shim's intake Q&A);
 * arbitrary strings could expose credentials in process listings or alter
 * claude's behavior unexpectedly. Schema-level tightening of extraArgs (regex
 * bounds, secret-pattern rejection) is a known carry-forward — see Task 4.3
 * review and the TODO in handoff.ts.
 */
export const adapter: AgentAdapter = {
  id: 'claude',
  defaultModel: 'opus',
  capabilities: () => ({ supportsSessionId: true, supportsStructuredOutput: true }),
  async run(opts: AgentRunOpts): Promise<AgentRunResult> {
    // Defence-in-depth: spawnHeadless asserts cwd/stdoutPath/stderrPath but
    // not promptPath, and we read the prompt file ourselves before the spawn.
    // A relative promptPath would resolve against the current process cwd
    // rather than the worktree, which would be a silent footgun.
    assertAbs(opts.promptPath);

    const promptText = await fs.readFile(opts.promptPath, 'utf8');

    // claude headless invocation: `-p <prompt>` is the prompt-text mode,
    // `--output-format stream-json` gives us the per-event JSON stream we parse
    // session_id out of below. extraArgs is appended last so callers can
    // override individual flags if they need to.
    const args = [
      '-p',
      promptText,
      '--model',
      opts.model,
      '--output-format',
      'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      ...opts.extraArgs,
    ];

    // Live heartbeat parser — classifies each stream-json line and forwards
    // notable signals to opts.onHeartbeat. The post-hoc session_id +
    // rate-limit walkers below still run against the capture file as a
    // belt-and-braces safety net; this only adds observability during the
    // run. If the caller didn't wire onHeartbeat, we skip line parsing
    // entirely — no cost for adapters the supervisor didn't opt into.
    const heartbeat = opts.onHeartbeat
      ? createStreamJsonHeartbeatParser({ emit: opts.onHeartbeat })
      : undefined;

    const result = await spawnHeadless({
      command: 'claude',
      args,
      cwd: opts.cwd,
      env: opts.env,
      timeoutSec: opts.timeoutSec,
      stdoutCapBytes: opts.stdoutCapBytes,
      stdoutPath: opts.stdoutPath,
      stderrPath: opts.stderrPath,
      signal: opts.signal,
      onSpawned: opts.onSpawned,
      ...(heartbeat !== undefined ? { onStdoutLine: (line) => heartbeat.onLine(line) } : {}),
    });

    // Drain any debounced assistant.delta so the supervisor's last seen
    // counter matches the child's actual total bytes on exit.
    heartbeat?.flush();

    // Parse session_id AFTER the spawn returns — the capture file is now
    // closed and complete. Best-effort: if the file is missing, empty, or
    // contains no init event, sessionId stays undefined and the supervisor
    // logs that absence rather than failing the step.
    const sessionId = await parseSessionIdFromStreamJson(opts.stdoutPath);

    // ADR-0017 — scan the same stream-json capture for rate-limit signatures
    // so the supervisor's backoff wrapper can retry without mutating the
    // prompt. Same "walk once after spawn" pattern as session_id parsing.
    const ratelimit = await parseRateLimitFromStreamJson(opts.stdoutPath);

    return {
      ...result,
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(ratelimit.rateLimited ? { rateLimited: true } : {}),
      ...(ratelimit.retryAfterMs !== undefined ? { retryAfterMs: ratelimit.retryAfterMs } : {}),
    };
  },
};

/**
 * Best-effort parser for claude's stream-json output.
 *
 * The expected init event is `{type:'system', subtype:'init', session_id:'…'}`,
 * but to be robust to format drift across claude versions we accept *any*
 * top-level JSON object with a string `session_id` field — the first such
 * event wins. Lines that aren't JSON are skipped silently (the stream may
 * include human-readable preamble or trailing diagnostics depending on
 * version).
 *
 * Failure modes that all return `undefined` (never throw):
 *   - file does not exist (e.g. spawn failed before opening stdout)
 *   - file is empty
 *   - no line parses as JSON
 *   - no parsed line has a string `session_id` field
 *
 * Failure modes that DO throw (rare): the stdoutPath exists but reading it
 * fails for a reason other than ENOENT (permissions, EIO). Letting those
 * propagate is intentional — they signal a host-level problem the supervisor
 * should see, not a content-level absence the adapter should mask.
 */
/**
 * ADR-0017 — best-effort rate-limit detector for claude's stream-json output.
 *
 * Signals we match (all inside JSON lines, any line order):
 *   - `{"type":"result","subtype":"error_*"}` terminal events whose subtype
 *     contains "rate_limit", "overload", or the generic retry-worthy "server_error".
 *   - Embedded API error objects of shape
 *     `{"type":"error","error":{"type":"rate_limit_error"|"overloaded_error",...}}`.
 *     These can be nested inside message content or surfaced as top-level
 *     events depending on the CLI version — we accept both.
 *   - `retry_after_seconds` / `retry-after` fields on the matched object,
 *     converted to milliseconds. First hit wins.
 *
 * Returns `{rateLimited:false}` when no signal is found. NEVER throws on
 * content — only propagates true host-level read errors (same contract as
 * `parseSessionIdFromStreamJson`).
 */
async function parseRateLimitFromStreamJson(
  stdoutPath: string,
): Promise<{ rateLimited: boolean; retryAfterMs?: number }> {
  let raw: string;
  try {
    raw = await fs.readFile(stdoutPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { rateLimited: false };
    throw err;
  }
  if (raw.length === 0) return { rateLimited: false };

  let rateLimited = false;
  let retryAfterMs: number | undefined;

  // Recursive-ish walker implemented iteratively via a stack. Bounded by the
  // stdoutCapBytes caller contract — we never explode on unbounded nesting.
  const inspect = (node: unknown): void => {
    if (rateLimited && retryAfterMs !== undefined) return;
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) inspect(item);
      return;
    }
    const obj = node as Record<string, unknown>;

    // Top-level result/error event shapes.
    if (typeof obj.type === 'string') {
      if (obj.type === 'error') {
        const err = obj.error;
        if (err !== null && typeof err === 'object') {
          const errType = (err as { type?: unknown }).type;
          if (
            typeof errType === 'string' &&
            /(rate[_-]?limit|overload)/i.test(errType)
          ) {
            rateLimited = true;
          }
        }
      } else if (obj.type === 'result') {
        // Claude CLI v2.x emits rate-limit exits as:
        //   {type:"result", subtype:"success", is_error:true, api_error_status:429}
        // The subtype is "success" (!), so we match on is_error + api_error_status.
        if (obj.is_error === true && (obj.api_error_status === 429 || obj.api_error_status === '429')) {
          rateLimited = true;
        }
        if (typeof obj.subtype === 'string' && /(rate[_-]?limit|overload)/i.test(obj.subtype)) {
          rateLimited = true;
        }
      }
    }

    // Retry-after hints. Accept both snake_case and dash forms; first hit wins.
    if (retryAfterMs === undefined) {
      const seconds = obj['retry_after_seconds'] ?? obj['retry-after'];
      if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) {
        retryAfterMs = Math.floor(seconds * 1000);
      } else if (typeof seconds === 'string' && /^\d+$/.test(seconds)) {
        retryAfterMs = Number.parseInt(seconds, 10) * 1000;
      }
    }

    for (const value of Object.values(obj)) inspect(value);
  };

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    inspect(parsed);
    if (rateLimited && retryAfterMs !== undefined) break;
  }

  return rateLimited
    ? retryAfterMs !== undefined
      ? { rateLimited: true, retryAfterMs }
      : { rateLimited: true }
    : { rateLimited: false };
}

async function parseSessionIdFromStreamJson(stdoutPath: string): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(stdoutPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  if (raw.length === 0) return undefined;
  // Split on \n (LF). Claude's stream-json is line-delimited JSON; we don't
  // need a streaming parser at the sizes we expect (capped by stdoutCapBytes).
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Malformed JSON line — skip silently. See JSDoc above.
      continue;
    }
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'session_id' in parsed &&
      typeof (parsed as { session_id: unknown }).session_id === 'string'
    ) {
      return (parsed as { session_id: string }).session_id;
    }
  }
  return undefined;
}
