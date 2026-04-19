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
 * Atomically writes the `content` string to `absPath`.
 *
 * Strategy mirrors `writeJsonAtomic`: temp file (`<absPath>.tmp.<pid>.<rand>`)
 * in the same directory, then `fs.rename` over the target. Within a single
 * filesystem `rename(2)` is atomic, so concurrent readers see either the old
 * file or the new file — never a partial write. Parent directories are
 * created as needed.
 *
 * Use this for any non-JSON file that needs crash-safety (HANDOFF.md,
 * PROGRESS.md, FINDINGS.md, source-plan.md, per-step prompt.md, etc.).
 * For JSON values, prefer `writeJsonAtomic` — it handles serialization too.
 */
export async function writeFileAtomic(absPath: string, content: string): Promise<void> {
  assertAbs(absPath);
  const dir = path.dirname(absPath);
  await fs.mkdir(dir, { recursive: true });
  const tmpName = `${path.basename(absPath)}.tmp.${process.pid}.${randomBytes(TMP_RAND_BYTES).toString('hex')}`;
  const tmpPath = path.resolve(dir, tmpName);
  await fs.writeFile(tmpPath, content, 'utf8');
  await fs.rename(tmpPath, absPath);
}

/**
 * Atomically writes `value` as pretty-printed JSON to `absPath`.
 *
 * Thin wrapper over `writeFileAtomic` that handles JSON serialization. The
 * temp+rename guarantees are inherited verbatim from `writeFileAtomic`.
 */
export async function writeJsonAtomic(absPath: string, value: unknown): Promise<void> {
  await writeFileAtomic(absPath, JSON.stringify(value, null, PRETTY_INDENT));
}
