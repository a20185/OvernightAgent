import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { assertAbs } from './paths.js';

const PRETTY_INDENT = 2;
const TMP_RAND_BYTES = 4;

/**
 * Reads and parses a JSON file at `absPath`.
 *
 * Returns `null` if the file is missing (`ENOENT`). Throws on parse errors and
 * any other I/O error. The returned value is an unsafe cast to `T` — Zod
 * schemas (Task 1.5) provide real validation downstream.
 */
export async function readJson<T>(absPath: string): Promise<T | null> {
  assertAbs(absPath);
  let raw: string;
  try {
    raw = await fs.readFile(absPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return JSON.parse(raw) as T;
}

/**
 * Atomically writes `value` as pretty-printed JSON to `absPath`.
 *
 * Strategy: write to `<absPath>.tmp.<pid>.<rand>` in the same directory, then
 * `fs.rename` over the target. `rename(2)` within a single filesystem is
 * atomic, so concurrent readers see either the old file or the new file —
 * never a partially written one. Parent directories are created as needed.
 */
export async function writeJsonAtomic(absPath: string, value: unknown): Promise<void> {
  assertAbs(absPath);
  const dir = path.dirname(absPath);
  await fs.mkdir(dir, { recursive: true });
  const tmpName = `${path.basename(absPath)}.tmp.${process.pid}.${randomBytes(TMP_RAND_BYTES).toString('hex')}`;
  const tmpPath = path.resolve(dir, tmpName);
  const body = JSON.stringify(value, null, PRETTY_INDENT);
  await fs.writeFile(tmpPath, body, 'utf8');
  await fs.rename(tmpPath, absPath);
}
