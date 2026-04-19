import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { writeFileAtomic } from '../atomicJson.js';
import { assertAbs } from '../paths.js';

/**
 * Task 6.5 — FINDINGS mutator (`<taskFolder>/FINDINGS.md`).
 *
 * Append-only plain markdown. No JSON twin: findings are free-form
 * agent-authored prose (one summary per successful step), not structured
 * data the supervisor needs to query. The Phase 7 supervisor calls
 * `append(taskFolder, tail.summary)` after every successful step — each
 * append adds a new dated section so an operator skimming the file can
 * trace findings back to specific runs.
 *
 * Atomicity: each append is a read + concat + atomic write. Two concurrent
 * appends would race on the read step and one would lose its content; we
 * accept that for v0 because the supervisor is single-writer per task. If a
 * future fan-out wants concurrent appends to the same task's findings, wrap
 * the call in a per-task lock (mirroring `withInboxLock`).
 *
 * Format: each appended summary is preceded by a level-2 timestamp header.
 * The header doubles as a section delimiter so future renderers can split
 * the file into per-step entries without parsing the prose body.
 *
 * Empty `summary` is allowed — the dated header still appears, marking that
 * the step ran. Treating empty as a no-op would silently drop information
 * (the agent submitted an empty `summary` field, and the supervisor would
 * want to see that fact in the file).
 */

const FINDINGS_MD = 'FINDINGS.md';

/** Absolute path of `FINDINGS.md` inside `taskFolderAbs`. */
function findingsPath(taskFolderAbs: string): string {
  return path.resolve(taskFolderAbs, FINDINGS_MD);
}

/**
 * Reads the current contents of FINDINGS.md, or `''` if absent. ENOENT
 * shortcuts to empty so a brand-new task folder doesn't need to seed the
 * file — `intakeSubmit` does seed it (with empty content), but defensive
 * callers shouldn't have to know that.
 */
export async function read(taskFolderAbs: string): Promise<string> {
  assertAbs(taskFolderAbs);
  try {
    return await fs.readFile(findingsPath(taskFolderAbs), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

/**
 * Appends `summary` as a new dated section to FINDINGS.md, atomically.
 * Creates the file if absent.
 *
 * Format of the appended block:
 *
 * ```
 * \n## <ISO timestamp>\n<summary>\n
 * ```
 *
 * The leading newline ensures the new header is separated from any prior
 * content (the empty-file case adds a benign leading blank line; harmless
 * for markdown renderers).
 */
export async function append(taskFolderAbs: string, summary: string): Promise<void> {
  assertAbs(taskFolderAbs);
  const prev = await read(taskFolderAbs);
  const ts = new Date().toISOString();
  const block = `\n## ${ts}\n${summary}\n`;
  const next = prev + block;
  await writeFileAtomic(findingsPath(taskFolderAbs), next);
}
