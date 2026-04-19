import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import { pidfile } from '../paths.js';
import { writeFileAtomic } from '../atomicJson.js';

const LOCK_OPTS = {
  retries: { retries: 0, minTimeout: 0, maxTimeout: 0, factor: 1 },
  stale: 10_000,
  realpath: false,
} as const;

function parsePid(raw: string): number | null {
  const pid = Number(raw.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

async function readPid(planId: string): Promise<number | null> {
  try {
    const raw = await fs.readFile(pidfile(planId), 'utf8');
    return parsePid(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function readPidSync(planId: string): number | null {
  try {
    const raw = readFileSync(pidfile(planId), 'utf8');
    return parsePid(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Supervisor pidfile lifecycle helper.
 *
 * `acquire()` serializes claims with a narrow pidfile lock, then performs the
 * stale/live check and atomic write inside that critical section. `release()`
 * unlinks best-effort so shutdown stays idempotent. `isStale()` treats a
 * missing pidfile as stale so callers can bootstrap recovery flows without a
 * separate existence check.
 */
export async function acquire(planId: string): Promise<void> {
  const pidPath = pidfile(planId);
  await fs.mkdir(path.dirname(pidPath), { recursive: true });
  const releaseLock = await lockfile.lock(pidPath, LOCK_OPTS);
  try {
    const existingPid = await readPid(planId);
    if (existingPid !== null) {
      if (isPidAlive(existingPid)) {
        throw new Error(`pidfile already owned by live pid: ${existingPid}`);
      }
      await fs.unlink(pidPath).catch((err) => {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      });
    }

    await writeFileAtomic(pidPath, `${process.pid}\n`);
  } finally {
    await releaseLock();
  }
}

export async function release(planId: string): Promise<void> {
  try {
    await fs.unlink(pidfile(planId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

export function isStale(planId: string): boolean {
  const existingPid = readPidSync(planId);
  if (existingPid === null) return true;
  return !isPidAlive(existingPid);
}
