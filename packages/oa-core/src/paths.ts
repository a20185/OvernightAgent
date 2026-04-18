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
  // TODO(task-1.6): assertId(taskId) — id validation lands with the ID generator;
  // until then, callers must pass ids minted by oa-core only.
  const p = path.resolve(oaHome(), 'tasks', taskId);
  if (!path.isAbsolute(p)) {
    throw new Error(`taskDir produced non-absolute path: ${p}`);
  }
  return p;
}

/** `<oaHome>/runs/<planId>`, absolute. */
export function runDir(planId: string): string {
  // TODO(task-1.6): assertId(planId) — id validation lands with the ID generator;
  // until then, callers must pass ids minted by oa-core only.
  const p = path.resolve(oaHome(), 'runs', planId);
  if (!path.isAbsolute(p)) {
    throw new Error(`runDir produced non-absolute path: ${p}`);
  }
  return p;
}

/** `<oaHome>/worktrees/<taskId>`, absolute. */
export function worktreeDir(taskId: string): string {
  // TODO(task-1.6): assertId(taskId) — id validation lands with the ID generator;
  // until then, callers must pass ids minted by oa-core only.
  const p = path.resolve(oaHome(), 'worktrees', taskId);
  if (!path.isAbsolute(p)) {
    throw new Error(`worktreeDir produced non-absolute path: ${p}`);
  }
  return p;
}

/** `<runDir>/oa.pid`, absolute. */
export function pidfile(planId: string): string {
  // TODO(task-1.6): assertId(planId) — id validation lands with the ID generator;
  // until then, callers must pass ids minted by oa-core only.
  const p = path.resolve(runDir(planId), 'oa.pid');
  if (!path.isAbsolute(p)) {
    throw new Error(`pidfile produced non-absolute path: ${p}`);
  }
  return p;
}

/**
 * `<runDir>/oa.sock`, absolute.
 *
 * NOTE: AF_UNIX socket paths are limited to 104 bytes on macOS and 108 on
 * Linux. If `oaHome()` is deep (long username, custom OA_HOME), the resolved
 * path may exceed the limit and `bind()` will fail with ENAMETOOLONG. Phase 7
 * (supervisor) must fall back to a short path under /tmp when the canonical
 * path doesn't fit. Track in ADR/Phase 7.
 */
export function socketPath(planId: string): string {
  // TODO(task-1.6): assertId(planId) — id validation lands with the ID generator;
  // until then, callers must pass ids minted by oa-core only.
  const p = path.resolve(runDir(planId), 'oa.sock');
  if (!path.isAbsolute(p)) {
    throw new Error(`socketPath produced non-absolute path: ${p}`);
  }
  return p;
}
