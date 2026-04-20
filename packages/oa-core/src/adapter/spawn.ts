import * as fs from 'node:fs';
import { execa } from 'execa';
import { assertAbs } from '../paths.js';
import type { AgentRunControl, AgentRunResult } from './types.js';

/**
 * Inputs to the headless subprocess primitive. All path fields must be
 * absolute (asserted at the top of `spawnHeadless`); `signal` is the
 * supervisor-provided graceful-stop channel; `timeoutSec` and `stdoutCapBytes`
 * are the hard wall-clock and byte budgets the helper enforces with
 * SIGTERM-then-SIGKILL.
 *
 * `env` is *merged with* `process.env` rather than replacing it — agents
 * routinely need PATH, HOME, and friends to find their own tools.
 */
export interface SpawnOpts {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  timeoutSec: number;
  stdoutCapBytes: number;
  stdoutPath: string;
  stderrPath: string;
  signal: AbortSignal;
  onSpawned?: (control: SpawnControl) => void;
  /** Absolute path to a sandbox-exec profile. Darwin-only; throws on other platforms. */
  sandboxProfile?: string;
}

export type SpawnControl = AgentRunControl;

const SIGKILL_GRACE_MS = 500;

/**
 * Resolves the final command and args, wrapping with `sandbox-exec -f <profile>`
 * when `sandboxProfile` is provided. Exported for direct unit-testing of the
 * argv-mangling logic without spawning a real subprocess.
 *
 * @throws If `sandboxProfile` is set on a non-darwin platform.
 */
export function resolveSpawnArgs(
  command: string,
  args: string[],
  sandboxProfile: string | undefined,
): { command: string; args: string[] } {
  if (sandboxProfile === undefined) {
    return { command, args };
  }
  if (process.platform !== 'darwin') {
    throw new Error(`sandbox-exec requested but unavailable on ${process.platform}`);
  }
  assertAbs(sandboxProfile);
  return {
    command: 'sandbox-exec',
    args: ['-f', sandboxProfile, command, ...args],
  };
}

/**
 * Low-level subprocess primitive every adapter wraps.
 *
 * Lifecycle: open stdout/stderr capture files (truncating any prior content),
 * spawn the child via execa, fan-out stdout/stderr `data` events to the
 * capture files while tallying bytes, arm a wall-clock timeout and an
 * AbortSignal listener, await the child's exit, then clean up timers, signal
 * listeners and file descriptors before returning.
 *
 * Three "killers" can race to terminate the child: timeout, stdout-cap, and
 * the supervisor's AbortSignal. The first one to fire is recorded in
 * `killedBy`; subsequent killers are no-ops because each kill path checks the
 * `killedBy` latch and skips. `exitCode` is the child's actual exit code on
 * natural exit, or `null` whenever any killer fired (per `AgentRunResult`'s
 * documented contract).
 *
 * `sessionId` is intentionally not set here — adapters parse it from their
 * agent's headless output and overlay it on the returned result.
 */
export async function spawnHeadless(opts: SpawnOpts): Promise<AgentRunResult> {
  // Sandbox-exec argv wrapping — must happen before any fork so the platform
  // check rejects synchronously on non-darwin hosts.
  const resolved = resolveSpawnArgs(opts.command, opts.args, opts.sandboxProfile);

  assertAbs(opts.cwd);
  assertAbs(opts.stdoutPath);
  assertAbs(opts.stderrPath);

  // Truncate-on-open ('w'): a re-spawn after a killed prior run must not
  // append onto stale capture data. The fds stay open for the entire process
  // lifetime; the `try/finally` at the bottom closes both on every code path
  // (natural exit, kill, throw) so we never leak descriptors.
  const stdoutFd = fs.openSync(opts.stdoutPath, 'w');
  const stderrFd = fs.openSync(opts.stderrPath, 'w');

  // First-killer-wins latch. We record only the first reason a killer fired so
  // racing killers (e.g. stdout-cap and signal arriving in the same tick)
  // don't clobber each other. The `kill()` helper short-circuits on the
  // second call so we don't double-SIGTERM the child either.
  let killedBy: AgentRunResult['killedBy'] = null;
  let timedOut = false;
  let stdoutCapHit = false;
  let stdoutBytes = 0;

  const start = Date.now();

  const subprocess = execa(resolved.command, resolved.args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdout: 'pipe',
    stderr: 'pipe',
    // We deliberately do NOT pass `signal: opts.signal` to execa: we want to
    // observe the abort ourselves so we can stamp `killedBy: 'signal'` and
    // schedule the SIGKILL grace consistently with the other killers.
    // Same reason for not using execa's `timeout` option.
    reject: false,
    // Some agents fork helpers; killing only the lead PID would orphan them.
    // forceKillAfterDelay handles the SIGTERM→SIGKILL transition for us.
    forceKillAfterDelay: SIGKILL_GRACE_MS,
  });

  const kill = (reason: NonNullable<AgentRunResult['killedBy']>): void => {
    if (killedBy !== null) return;
    killedBy = reason;
    if (reason === 'timeout') timedOut = true;
    if (reason === 'stdoutCap') stdoutCapHit = true;
    try {
      subprocess.kill('SIGTERM');
    } catch {
      // Process may already be dead (race with natural exit) — that's fine.
    }
    // Belt-and-braces: execa's forceKillAfterDelay should fire SIGKILL on its
    // own, but if execa's tracking is off (e.g. child re-parented) we fall
    // back to a manual SIGKILL after the same grace window.
    setTimeout(() => {
      try {
        subprocess.kill('SIGKILL');
      } catch {
        // ditto — already-exited race is benign.
      }
    }, SIGKILL_GRACE_MS).unref();
  };

  subprocess.stdout?.on('data', (chunk: Buffer) => {
    // Sync write keeps capture-file ordering deterministic and avoids the
    // ordering hazards of interleaved async writes when the cap is hit
    // mid-chunk. The fd is closed exactly once in the `finally` below.
    try {
      fs.writeSync(stdoutFd, chunk);
    } catch {
      // fd may be closed if a prior killer raced ahead and we're already
      // unwinding; swallow rather than crash the data handler.
    }
    stdoutBytes += chunk.length;
    if (stdoutBytes >= opts.stdoutCapBytes) {
      kill('stdoutCap');
    }
  });

  subprocess.stderr?.on('data', (chunk: Buffer) => {
    try {
      fs.writeSync(stderrFd, chunk);
    } catch {
      // Same race as stdout — see comment above.
    }
  });

  const timeoutHandle = setTimeout(() => {
    kill('timeout');
  }, opts.timeoutSec * 1000);
  // Don't keep the event loop alive solely for the timeout; the awaited
  // subprocess promise is the real anchor.
  timeoutHandle.unref();

  const onAbort = (): void => kill('signal');
  opts.signal.addEventListener('abort', onAbort, { once: true });
  if (opts.signal.aborted) {
    // Add-then-check closes the race where the signal flips between a
    // pre-check and listener registration.
    opts.signal.removeEventListener('abort', onAbort);
    kill('signal');
  }

  let naturalExitCode: number | null = null;
  let onSpawnedError: unknown;
  try {
    try {
      opts.onSpawned?.({
        killNow: () => kill('signal'),
      });
    } catch (err) {
      // If the caller rejects the live-control handoff, tear the child down
      // before rethrowing so we don't leave an orphan behind.
      onSpawnedError = err;
      kill('signal');
      await subprocess.catch(() => undefined);
    }
    if (onSpawnedError !== undefined) throw onSpawnedError;

    // `reject: false` means execa resolves on every termination path (natural
    // exit, signal, timeout). If execa still throws here, that's an actual
    // launch/runtime failure (for example ENOENT on `command`) and should
    // propagate to the caller.
    const result = await subprocess;
    naturalExitCode = result.exitCode ?? null;
  } finally {
    clearTimeout(timeoutHandle);
    opts.signal.removeEventListener('abort', onAbort);
    try {
      fs.closeSync(stdoutFd);
    } catch {
      // already closed — possible only on extreme races; nothing to do.
    }
    try {
      fs.closeSync(stderrFd);
    } catch {
      // ditto
    }
  }

  return {
    exitCode: killedBy === null ? naturalExitCode : null,
    durationMs: Date.now() - start,
    timedOut,
    stdoutCapHit,
    killedBy,
  };
}
