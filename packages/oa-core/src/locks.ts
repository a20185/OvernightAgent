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
 * - `realpath: false` is required because the lock target
 *   (`<oaHome>/tasks.json.lock`) does not exist before `lock()` runs and
 *   `proper-lockfile`'s default `realpath: true` would `fs.realpath` it
 *   and fail with ENOENT.
 *
 * `lockfilePath` points at the same path as the lock target. We pass an
 * existing sentinel file as the first argument (created on demand below)
 * so `proper-lockfile` is happy and the lock directory it actually places
 * is the canonical `<oaHome>/tasks.json.lock`.
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
 * The caller is responsible for ensuring `oaHome()` exists (run
 * `ensureHomeLayout()` once at startup — see Task 1.3).
 */
export async function withInboxLock<T>(fn: () => Promise<T>): Promise<T> {
  const lockTarget = inboxLockPath();
  // `proper-lockfile.lock(file)` requires `file` to exist on disk (with
  // `realpath: false` it's still `stat`-ed for the inode check). The lock
  // target itself is a sentinel — its contents are irrelevant — so create
  // it on demand if missing.
  await fs.mkdir(path.dirname(lockTarget), { recursive: true });
  try {
    const fh = await fs.open(lockTarget, 'a');
    await fh.close();
  } catch {
    // Best-effort: if the touch fails, let `lockfile.lock` surface the
    // real error below.
  }
  const release = await lockfile.lock(lockTarget, LOCK_OPTS);
  try {
    return await fn();
  } finally {
    await release();
  }
}
