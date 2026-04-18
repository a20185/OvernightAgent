import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import lockfile from 'proper-lockfile';
import { oaHome } from './paths.js';

/**
 * Lock options for the inbox file lock.
 *
 * - `retries=49` with a flat 100ms backoff (~5 s of patience) matches the
 *   spec's "5s wait + 100ms retry" budget.
 * - `stale=10s` lets `proper-lockfile` reclaim a lock whose owner crashed.
 *   Tune later if real workloads need a different threshold.
 * - `realpath: false` skips `fs.realpath` on the lock target. The target may
 *   not exist when `lock()` runs (proper-lockfile creates the `<target>.lock`
 *   directory, not the target itself), and `realpath` would otherwise
 *   ENOENT-fail before `mkdir` ever happens.
 */
const LOCK_OPTS = {
  retries: { retries: 49, minTimeout: 100, maxTimeout: 100, factor: 1 },
  stale: 10_000,
  realpath: false,
} as const;

/** Absolute path of the inbox lock target: `<oaHome>/tasks.json.lock`. */
function inboxLockPath(): string {
  return path.resolve(oaHome(), 'tasks.json.lock');
}

/**
 * Acquires an exclusive lock on `<oaHome>/tasks.json.lock`, runs `fn`, then
 * releases the lock. Always releases — even if `fn` throws — so the next
 * caller is never blocked by an unhandled rejection.
 *
 * The lock is process-wide AND cross-process: `proper-lockfile` uses an
 * `mkdir`-based lock directory under the hood, which is atomic on POSIX
 * filesystems. Default wait budget is ~5s (49 retries × 100ms); after that
 * `proper-lockfile` rejects with `ELOCKED` and the rejection bubbles to the
 * caller.
 *
 * Callers should ensure `oaHome()` exists once at startup via
 * `ensureHomeLayout()` (Task 1.3). We still `mkdir` the parent here as
 * defense-in-depth: tests bypass `ensureHomeLayout`, and a stale-init
 * scenario could race with a concurrent home-layout teardown.
 *
 * NOTE on the lock-target file: proper-lockfile@4.1.2's `acquireLock` calls
 * `fs.mkdir(<target>.lock)` directly (lockfile.js:25-82) and does NOT stat
 * the target. With `realpath: false`, `resolveCanonicalPath` is a pure
 * `path.resolve` (lockfile.js:16-18). We therefore do not need to touch a
 * sentinel file before locking. If a future proper-lockfile version
 * reintroduces a target-stat probe, this comment will go stale and tests
 * will surface the regression.
 */
export async function withInboxLock<T>(fn: () => Promise<T>): Promise<T> {
  const lockTarget = inboxLockPath();
  await fs.mkdir(path.dirname(lockTarget), { recursive: true });
  const release = await lockfile.lock(lockTarget, LOCK_OPTS);
  try {
    return await fn();
  } finally {
    await release();
  }
}
