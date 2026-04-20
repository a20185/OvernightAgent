import * as fs from 'node:fs/promises';
import { assertAbs } from '../paths.js';

/**
 * Task 9.1 — events.jsonl reader.
 *
 * Streams and JSON-parses every line of `<runDir>/events.jsonl`. The writer
 * (Task 7.1) emits one JSON object per line, auto-stamped with `ts`; the
 * reader returns those objects unvalidated so the summary renderer and
 * `oa status --source=events` can tolerate forward-compatible payload drift.
 *
 * Contract:
 *  - `absPath` must be absolute.
 *  - Missing file returns `[]` — this reader is called from `oa status`
 *    against plans that may never have produced an events log (sealed but
 *    never run, crash before writer opened).
 *  - Malformed lines are emitted to `onInvalid` (default: stderr) and
 *    skipped. The canonical production writer only produces valid JSON, so
 *    a malformed line is either a half-written crash remnant (truncated
 *    last line) or external pollution — both recoverable.
 *  - No Zod validation here: call sites that need strict shape use
 *    `EventSchema.parse` on the result, but the renderer tolerates unknown
 *    kinds for forward compat.
 */
export interface ReadAllOpts {
  absPath: string;
  onInvalid?: (lineNumber: number, line: string, err: unknown) => void;
}

export async function readAll(opts: ReadAllOpts): Promise<Array<Record<string, unknown>>> {
  assertAbs(opts.absPath);
  let raw: string;
  try {
    raw = await fs.readFile(opts.absPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const lines = raw.split('\n');
  const onInvalid =
    opts.onInvalid ??
    ((n: number, line: string, err: unknown): void => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`events.jsonl line ${String(n)} invalid (${msg}): ${line}\n`);
    });
  const out: Array<Record<string, unknown>> = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.length === 0) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        out.push(parsed as Record<string, unknown>);
      } else {
        onInvalid(i + 1, line, new Error('not a JSON object'));
      }
    } catch (err) {
      onInvalid(i + 1, line, err);
    }
  }
  return out;
}
