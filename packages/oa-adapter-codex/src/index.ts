import * as fs from 'node:fs/promises';
import { assertAbs, detectRateLimitInStderr, spawnHeadless } from '@soulerou/oa-core';
import type { AgentAdapter, AgentRunOpts, AgentRunResult } from '@soulerou/oa-core';
import { createCodexHeartbeatParser } from './heartbeat.js';

/**
 * Headless `codex` AgentAdapter (ADR-0009). Mirrors the claude adapter's
 * shape but targets codex's `codex exec` headless mode.
 *
 * Invocation shape (verified against codex exec --help):
 *   `codex exec --full-auto --model <model> [extraArgs...] <promptText>`
 *
 * codex's `exec` subcommand takes the prompt as a positional argument (or
 * from stdin if omitted/`-`). It does NOT accept `--prompt-file` — an earlier
 * revision of this adapter used that flag and failed every reviewer call with
 * `error: unexpected argument '--prompt-file' found`. We read the prompt
 * file into a string and pass it as the positional, matching the claude
 * adapter's `-p <promptText>` pattern.
 *
 * codex's headless mode does not emit a per-run session_id we can parse, so
 * `supportsSessionId` returns false; the supervisor records attempts by its
 * own `attempt` counter instead.
 *
 * SECURITY NOTE: like the claude adapter, `extraArgs` is spread verbatim
 * into argv. Intake-sourced content is trusted by way of the Q&A shim;
 * schema-level tightening remains a Phase 12 carry-forward.
 */
export const adapter: AgentAdapter = {
  id: 'codex',
  defaultModel: 'gpt-5.4',
  capabilities: () => ({ supportsSessionId: false, supportsStructuredOutput: false }),
  async run(opts: AgentRunOpts): Promise<AgentRunResult> {
    assertAbs(opts.promptPath);
    const promptText = await fs.readFile(opts.promptPath, 'utf8');

    // Prompt is passed as the trailing positional. `extraArgs` is spread
    // before it so callers can add flags without displacing the prompt.
    const args = [
      'exec',
      '--full-auto',
      '--model',
      opts.model,
      ...opts.extraArgs,
      promptText,
    ];

    // Live liveness classifier — accumulates byte counts on stdout, sniffs
    // stderr for rate-limit phrases. No-op if the caller didn't wire
    // onHeartbeat. Codex emits no structured event stream so this is the only
    // observability signal we can surface during the run.
    const heartbeat = opts.onHeartbeat
      ? createCodexHeartbeatParser({ emit: opts.onHeartbeat })
      : undefined;

    const result = await spawnHeadless({
      command: 'codex',
      args,
      cwd: opts.cwd,
      env: opts.env,
      timeoutSec: opts.timeoutSec,
      stdoutCapBytes: opts.stdoutCapBytes,
      stdoutPath: opts.stdoutPath,
      stderrPath: opts.stderrPath,
      signal: opts.signal,
      onSpawned: opts.onSpawned,
      ...(heartbeat !== undefined
        ? {
            onStdoutLine: (line) => heartbeat.onStdoutLine(line),
            onStderrLine: (line) => heartbeat.onStderrLine(line),
          }
        : {}),
    });
    heartbeat?.flush();

    // ADR-0017 — codex doesn't emit structured error events, so we sniff the
    // captured stderr for common rate-limit phrases. Same contract as the
    // claude adapter: undefined = no detection / no signal; supervisor's
    // backoff wrapper short-circuits. Failure to read the stderr file (e.g.
    // spawn crashed before creating it) leaves detection untouched.
    const detection = await detectRateLimitFromStderrPath(opts.stderrPath);
    return {
      ...result,
      ...(detection.rateLimited ? { rateLimited: true } : {}),
      ...(detection.retryAfterMs !== undefined ? { retryAfterMs: detection.retryAfterMs } : {}),
    };
  },
};

async function detectRateLimitFromStderrPath(
  stderrPath: string,
): Promise<{ rateLimited: boolean; retryAfterMs?: number }> {
  let raw: string;
  try {
    raw = await fs.readFile(stderrPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { rateLimited: false };
    throw err;
  }
  return detectRateLimitInStderr(raw);
}

export default adapter;
