import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomBytes } from 'node:crypto';
import { execa } from 'execa';
import { assertAbs } from '../paths.js';
import { assertId } from '../ids.js';
import type { EventWriter } from '../events/writer.js';

/**
 * Task 7.2 — bootstrap runner.
 *
 * Phase 7's supervisor calls `runBootstrap` exactly once per task, before the
 * first step runs. The script is the per-task setup hook copied verbatim from
 * `intake.bootstrap.script` (e.g. `pnpm install`, `cargo fetch`,
 * project-specific environment priming). Bootstrap is *optional*: an
 * empty-or-whitespace-only script short-circuits with a clean ok-result and
 * emits ZERO events, so a task that doesn't actually bootstrap doesn't
 * pollute the run log with `task.bootstrap.{start,end}` pairs.
 *
 * Contract notes pinned by `bootstrap.test.ts`:
 *
 *   - **Boundary asserts.** `assertAbs(absWorktree)` and `assertId(taskId)`
 *     fire at the entrypoint so misuse from the supervisor surfaces with the
 *     canonical error messages, not buried inside execa's spawn failure.
 *   - **Tmp script lifecycle.** We materialize the script under `os.tmpdir()`
 *     with a per-call random suffix (so concurrent supervisor runs can't
 *     collide), `chmod 0o755` it (so the kernel will exec it directly), and
 *     unlink in `finally` regardless of outcome. Cleanup is best-effort —
 *     errors are swallowed because a leaked tmp file is preferable to a
 *     bootstrap failure that masks the real script's exit code.
 *   - **Direct exec, no shell.** The script carries its own shebang line.
 *     Spawning via `execa(path, [], { shell: false })` avoids quoting
 *     surprises and gives us a clean `cwd`-honoring exec without a wrapper
 *     `bash -c '...'` process between us and the script.
 *   - **Truncated stdio in events.** Captured stdout/stderr are trimmed to
 *     64 KB each before we hand them back. The event log is not the right
 *     place to ship megabyte-scale `npm install` output; the supervisor logs
 *     the full text separately if it cares (Phase 7's per-task log file).
 *   - **`reject: false` + explicit field reads.** execa would otherwise throw
 *     on non-zero exit / timeout, forcing a try/catch dance just to peel the
 *     fields back out. With `reject: false` we get a uniform result object
 *     and shape the GateResult-style return inline. `result.timedOut` is the
 *     authoritative timeout signal; `result.exitCode` is null when the
 *     process was killed by signal (including the timeout SIGTERM).
 *   - **start/end events bracket every real run.** Exactly one
 *     `task.bootstrap.start` and one `task.bootstrap.end`, both carrying the
 *     `taskId`. The end event additionally carries `ok`, `exitCode`,
 *     `durationMs`, `timedOut` so post-mortem tooling has the full outcome
 *     without correlating to a separate log file. Emission happens via the
 *     supplied `EventWriter` (Task 7.1), which auto-stamps `ts`.
 */

export interface RunBootstrapOpts {
  /** Absolute path to the worktree where the script runs. */
  absWorktree: string;
  /**
   * Bash script content (multi-line ok). The script is written verbatim to a
   * tmp file and exec'd directly, so it MUST carry its own shebang line if it
   * relies on a specific interpreter. Empty or whitespace-only content is a
   * no-op — bootstrap is optional.
   */
  script: string;
  /** Hard wall-clock kill (passed to execa as `timeout: timeoutSec * 1000`). */
  timeoutSec: number;
  /** Phase 7 events writer; receives the bracketing start/end events. */
  eventWriter: EventWriter;
  /** Tagged onto every emitted event for post-mortem filtering by task. */
  taskId: string;
}

export interface RunBootstrapResult {
  /** True iff exit 0 AND not killed by timeout. */
  ok: boolean;
  /** Numeric exit code, or null when the process was killed by signal. */
  exitCode: number | null;
  /** Wall-clock duration of the spawn (excludes assert / tmp-file overhead). */
  durationMs: number;
  /** True iff execa terminated the process for exceeding `timeoutSec`. */
  timedOut: boolean;
  /** Captured stdout, truncated to ~64 KB to keep the event payload small. */
  stdout: string;
  /** Captured stderr, truncated to ~64 KB to keep the event payload small. */
  stderr: string;
}

// 64 KB cap on stdio carried in events. Real bootstraps (npm install, cargo
// fetch) routinely produce more than this; the supervisor's per-task log
// captures the untruncated output. The event log is for structure, not bulk.
const STDIO_TRUNCATE_BYTES = 64 * 1024;

/** Truncate `s` to `STDIO_TRUNCATE_BYTES`, appending a marker noting the cut. */
function truncate(s: string): string {
  if (s.length <= STDIO_TRUNCATE_BYTES) return s;
  return (
    s.slice(0, STDIO_TRUNCATE_BYTES) +
    `\n[... truncated ${s.length - STDIO_TRUNCATE_BYTES} bytes]\n`
  );
}

export async function runBootstrap(opts: RunBootstrapOpts): Promise<RunBootstrapResult> {
  // Boundary asserts FIRST — before any side effect (event emit, tmp file
  // create) so a misuse leaves no trace in the run log or filesystem.
  assertAbs(opts.absWorktree);
  assertId(opts.taskId);

  // Empty / whitespace-only script: bootstrap is optional, no-op cleanly.
  // Do NOT emit start/end events — a task that didn't bootstrap shouldn't
  // appear in the post-mortem with a phantom bootstrap span.
  if (!opts.script.trim()) {
    return {
      ok: true,
      exitCode: 0,
      durationMs: 0,
      timedOut: false,
      stdout: '',
      stderr: '',
    };
  }

  await opts.eventWriter.emit({
    kind: 'task.bootstrap.start',
    taskId: opts.taskId,
  });

  // Random suffix avoids collision when two supervisor processes (different
  // runs) bootstrap simultaneously into the same os.tmpdir().
  const tmpScript = path.resolve(
    os.tmpdir(),
    `oa-bootstrap-${process.pid}-${randomBytes(4).toString('hex')}.sh`,
  );
  await fs.writeFile(tmpScript, opts.script, 'utf8');
  await fs.chmod(tmpScript, 0o755);

  const start = Date.now();
  let exitCode: number | null = null;
  let timedOut = false;
  let stdout = '';
  let stderr = '';
  try {
    // shell:false — the script carries its own shebang. Spawning directly
    // avoids quoting surprises and the extra `bash -c` wrapper process.
    // reject:false — we want the result object even on non-zero / timeout,
    // so we can shape the return inline rather than catching to peel fields.
    const result = await execa(tmpScript, [], {
      cwd: opts.absWorktree,
      shell: false,
      reject: false,
      all: false,
      timeout: opts.timeoutSec * 1000,
    });
    // execa's exitCode is `number | undefined`; normalize undefined → null
    // (signal-killed including timeout). The bool `timedOut` is the
    // authoritative "killed by our timeout" signal.
    exitCode = typeof result.exitCode === 'number' ? result.exitCode : null;
    timedOut = result.timedOut === true;
    stdout = typeof result.stdout === 'string' ? result.stdout : '';
    stderr = typeof result.stderr === 'string' ? result.stderr : '';
  } finally {
    // Best-effort cleanup. A leaked tmp file is strictly preferable to
    // masking the real bootstrap failure with an unlink error.
    try {
      await fs.unlink(tmpScript);
    } catch {
      /* ignore */
    }
  }
  const durationMs = Date.now() - start;

  const ok = exitCode === 0 && !timedOut;
  const out: RunBootstrapResult = {
    ok,
    exitCode,
    durationMs,
    timedOut,
    stdout: truncate(stdout),
    stderr: truncate(stderr),
  };

  await opts.eventWriter.emit({
    kind: 'task.bootstrap.end',
    taskId: opts.taskId,
    ok: out.ok,
    exitCode: out.exitCode,
    durationMs: out.durationMs,
    timedOut: out.timedOut,
  });

  return out;
}
