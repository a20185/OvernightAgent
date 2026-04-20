import * as fs from 'node:fs/promises';
import { assertAbs, spawnHeadless } from '@soulerou/oa-core';
import type { AgentAdapter, AgentRunOpts, AgentRunResult } from '@soulerou/oa-core';

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
      ...opts.extraArgs,
    ];

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
    });

    // Parse session_id AFTER the spawn returns — the capture file is now
    // closed and complete. Best-effort: if the file is missing, empty, or
    // contains no init event, sessionId stays undefined and the supervisor
    // logs that absence rather than failing the step.
    const sessionId = await parseSessionIdFromStreamJson(opts.stdoutPath);

    return sessionId === undefined ? result : { ...result, sessionId };
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
