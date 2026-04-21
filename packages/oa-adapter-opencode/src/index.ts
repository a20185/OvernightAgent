import * as fs from 'node:fs/promises';
import { assertAbs, detectRateLimitInStderr, spawnHeadless } from '@soulerou/oa-core';
import type { AgentAdapter, AgentRunOpts, AgentRunResult } from '@soulerou/oa-core';

/**
 * Headless `opencode` AgentAdapter (ADR-0009). Mirrors the claude/codex
 * adapter shape but targets opencode's `opencode run` headless mode.
 *
 * Invocation shape (verify against installed CLI at deploy time):
 *   `opencode run --model <model> --prompt-file <abs> [extraArgs...]`
 *
 * opencode's headless mode does not emit a per-run session_id we can parse,
 * so `supportsSessionId` is false; the supervisor records attempts via its
 * own `attempt` counter.
 *
 * SECURITY NOTE: `extraArgs` is spread verbatim into argv; same caveat as
 * the claude/codex adapters (schema-level tightening → Phase 12).
 */
export const adapter: AgentAdapter = {
  id: 'opencode',
  defaultModel: 'claude-opus-4',
  capabilities: () => ({ supportsSessionId: false, supportsStructuredOutput: false }),
  async run(opts: AgentRunOpts): Promise<AgentRunResult> {
    assertAbs(opts.promptPath);
    await fs.access(opts.promptPath);

    const args = [
      'run',
      '--model',
      opts.model,
      '--prompt-file',
      opts.promptPath,
      ...opts.extraArgs,
    ];

    const result = await spawnHeadless({
      command: 'opencode',
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

    // ADR-0017 — opencode, like codex, lacks structured error events. Sniff
    // the captured stderr for rate-limit phrases via the shared helper. Same
    // contract as the codex adapter (undefined when no signal / no file).
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
