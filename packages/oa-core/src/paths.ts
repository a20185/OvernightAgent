import * as path from 'node:path';
import * as os from 'node:os';

/**
 * Asserts that `p` is an absolute path. Throws otherwise.
 *
 * The `asserts p is string` clause is technically redundant here (p is already
 * typed `string`), but matches the spec and becomes load-bearing when callers
 * narrow `unknown` values upstream. See ADR-0002.
 */
export function assertAbs(p: string): asserts p is string {
  if (!path.isAbsolute(p)) {
    throw new Error('non-absolute path: ' + p);
  }
}

/**
 * Returns the OvernightAgent home directory. Reads `OA_HOME` from the
 * environment on every call (no caching) so test mutations are honored.
 * Always absolute.
 */
export function oaHome(): string {
  const home = process.env.OA_HOME ?? path.resolve(os.homedir(), '.config/overnight-agent');
  assertAbs(home);
  return home;
}

/** `<oaHome>/tasks/<taskId>`, absolute. */
export function taskDir(taskId: string): string {
  const p = path.resolve(oaHome(), 'tasks', taskId);
  assertAbs(p);
  return p;
}

/** `<oaHome>/runs/<planId>`, absolute. */
export function runDir(planId: string): string {
  const p = path.resolve(oaHome(), 'runs', planId);
  assertAbs(p);
  return p;
}

/** `<oaHome>/worktrees/<taskId>`, absolute. */
export function worktreeDir(taskId: string): string {
  const p = path.resolve(oaHome(), 'worktrees', taskId);
  assertAbs(p);
  return p;
}

/** `<runDir>/oa.pid`, absolute. */
export function pidfile(planId: string): string {
  const p = path.resolve(runDir(planId), 'oa.pid');
  assertAbs(p);
  return p;
}

/** `<runDir>/oa.sock`, absolute. */
export function socketPath(planId: string): string {
  const p = path.resolve(runDir(planId), 'oa.sock');
  assertAbs(p);
  return p;
}
