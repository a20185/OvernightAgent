import * as path from 'node:path';
import { readJson, writeFileAtomic, writeJsonAtomic } from '../atomicJson.js';
import { assertAbs } from '../paths.js';
import {
  ProgressDocSchema,
  type ProgressDoc,
  type StepProgress,
  type StepStatusT,
} from '../schemas.js';

/**
 * Task 6.5 — PROGRESS mutator (`<taskFolder>/_progress.json` + PROGRESS.md).
 *
 * Two-file invariant. Source of truth is `_progress.json` — a Zod-validated
 * structured doc the supervisor reads/writes via `mark()` and `read()`.
 * `PROGRESS.md` is a derived, human-readable rendering, regenerated from
 * `_progress.json` on every `mark()` call. Tests assert the markdown's mtime
 * advances on every call so the supervisor can rely on the file as a
 * "last touched" signal for downstream consumers (status renderers, etc.).
 *
 * The Phase 7 supervisor calls `mark(taskFolder, n, 'running')` at step start
 * and `mark(taskFolder, n, 'done')` (or `'failed'` / `'blocked'`) at step end.
 * Every call upserts the entry keyed by `n` — same `n` overwrites in place,
 * new `n` appends. This means the doc grows monotonically with the plan; the
 * supervisor never deletes entries.
 *
 * Why a JSON twin instead of parsing the markdown back: the markdown table is
 * a presentation layer (column widths, ordering, dashes for missing fields).
 * Round-tripping a markdown table back into structured data is fragile and
 * couples the writer to a specific layout. A JSON source of truth lets us
 * change the rendering without breaking readers, and the schema gives us a
 * loud failure mode for hand-edited corruption.
 *
 * Atomicity: both files are written via the temp+rename atomic helpers so a
 * crash mid-mark can't leave a half-written `_progress.json`. The two writes
 * are NOT a single transaction — a crash between the JSON write and the MD
 * write would leave them transiently inconsistent — but the JSON is the
 * source of truth and PROGRESS.md regenerates idempotently from it on the
 * next `mark()`, so the inconsistency is self-healing.
 */

const PROGRESS_JSON = '_progress.json';
const PROGRESS_MD = 'PROGRESS.md';
const EMPTY_DOC: ProgressDoc = { schemaVersion: 1, steps: [] };

/** Absolute path of `_progress.json` inside `taskFolderAbs`. */
function jsonPath(taskFolderAbs: string): string {
  return path.resolve(taskFolderAbs, PROGRESS_JSON);
}

/** Absolute path of `PROGRESS.md` inside `taskFolderAbs`. */
function mdPath(taskFolderAbs: string): string {
  return path.resolve(taskFolderAbs, PROGRESS_MD);
}

/**
 * Internal: load + validate `_progress.json`. Returns a fresh empty doc when
 * the file is absent. Wraps schema/parse errors with the file path so an
 * operator who hand-edits the JSON gets a clear pointer to the offending
 * file. Mirrors the pattern in `stores/inbox.ts::readInbox`.
 */
async function loadDoc(taskFolderAbs: string): Promise<ProgressDoc> {
  assertAbs(taskFolderAbs);
  const p = jsonPath(taskFolderAbs);
  const raw = await readJson<unknown>(p);
  if (raw === null) return { ...EMPTY_DOC, steps: [] };
  try {
    return ProgressDocSchema.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`progress file at ${p} is corrupted: ${msg}`, { cause: err });
  }
}

/**
 * Renders the PROGRESS.md table. Pure: same input → byte-identical output.
 *
 * Format is a 5-column GitHub-flavored markdown table (`#`, Status, Attempt,
 * Detail, Updated). Missing optional fields render as an em-dash (`—`) so
 * the column never contains the literal text "undefined". Steps are sorted
 * by `n` ascending so the rendering is order-independent of the JSON's
 * `steps` array — the JSON preserves insertion order, but the table should
 * read as a step-numbered timeline regardless.
 *
 * Empty doc renders the header rows with no data rows below — agents reading
 * a brand-new PROGRESS.md should see the table structure (so they understand
 * the format) without any phantom rows.
 */
function renderMarkdown(doc: ProgressDoc): string {
  const header = [
    '# PROGRESS',
    '',
    '| # | Status | Attempt | Detail | Updated |',
    '|---|--------|---------|--------|---------|',
  ];
  const sorted = [...doc.steps].sort((a, b) => a.n - b.n);
  const rows = sorted.map((s) => {
    const attempt = s.attempt !== undefined ? String(s.attempt) : '—';
    const detail = s.detail !== undefined && s.detail !== '' ? s.detail : '—';
    return `| ${String(s.n)} | ${s.status} | ${attempt} | ${detail} | ${s.updatedAt} |`;
  });
  return [...header, ...rows].join('\n') + '\n';
}

/**
 * Upserts the entry for step `n` with the given `status` (and optional
 * `detail`), updates `updatedAt` to now, writes `_progress.json` atomically,
 * then re-renders and writes `PROGRESS.md` atomically.
 *
 * `attempt` is preserved across calls — if the step already had an `attempt`
 * recorded (e.g. from a prior `running`-with-attempt write), a subsequent
 * `done` call won't clobber it. The supervisor is expected to set `attempt`
 * via a future overload or a separate mutator if needed; the v0 API keeps
 * the surface minimal and lets the supervisor write attempt info via
 * `detail` if they need it surfaced to the agent.
 */
export async function mark(
  taskFolderAbs: string,
  n: number,
  status: StepStatusT,
  detail?: string,
): Promise<void> {
  assertAbs(taskFolderAbs);
  const doc = await loadDoc(taskFolderAbs);

  const now = new Date().toISOString();
  const idx = doc.steps.findIndex((s) => s.n === n);
  if (idx >= 0) {
    const prev = doc.steps[idx]!;
    const next: StepProgress = {
      n,
      status,
      ...(prev.attempt !== undefined ? { attempt: prev.attempt } : {}),
      ...(detail !== undefined ? { detail } : {}),
      updatedAt: now,
    };
    doc.steps[idx] = next;
  } else {
    const next: StepProgress = {
      n,
      status,
      ...(detail !== undefined ? { detail } : {}),
      updatedAt: now,
    };
    doc.steps.push(next);
  }

  // Re-validate before write — defense in depth against accidental drift in
  // the upsert above.
  ProgressDocSchema.parse(doc);

  await writeJsonAtomic(jsonPath(taskFolderAbs), doc);
  await writeFileAtomic(mdPath(taskFolderAbs), renderMarkdown(doc));
}

/**
 * Returns the current ProgressDoc. Returns the empty doc when
 * `_progress.json` is absent. Throws a path-wrapped error when the file
 * exists but doesn't match `ProgressDocSchema`.
 */
export async function read(taskFolderAbs: string): Promise<ProgressDoc> {
  return loadDoc(taskFolderAbs);
}

// Re-export the inferred types so consumers can import them from this module
// directly (mirrors how `stores/inbox.ts` re-exports its types implicitly via
// the schemas re-export in index.ts). The canonical schemas remain in
// `schemas.ts`; this module owns the runtime mutator behavior.
export type { ProgressDoc, StepProgress } from '../schemas.js';
