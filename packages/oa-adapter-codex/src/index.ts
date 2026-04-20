import * as fs from 'node:fs/promises';
import { assertAbs, spawnHeadless } from 'oa-core';
import type { AgentAdapter, AgentRunOpts, AgentRunResult } from 'oa-core';

/**
 * Headless `codex` AgentAdapter (ADR-0009). Mirrors the claude adapter's
 * shape but targets codex's `codex exec` headless mode.
 *
 * Invocation shape (verify against installed CLI at deploy time):
 *   `codex exec --model <model> --prompt-file <abs> [extraArgs...]`
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
  defaultModel: 'gpt-5-codex',
  capabilities: () => ({ supportsSessionId: false, supportsStructuredOutput: false }),
  async run(opts: AgentRunOpts): Promise<AgentRunResult> {
    assertAbs(opts.promptPath);
    // Verify prompt file is readable before handing argv off — a missing
    // prompt would otherwise surface as a cryptic codex error.
    await fs.access(opts.promptPath);

    const args = [
      'exec',
      '--model',
      opts.model,
      '--prompt-file',
      opts.promptPath,
      ...opts.extraArgs,
    ];

    return spawnHeadless({
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
    });
  },
};

export default adapter;
