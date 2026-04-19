/**
 * intakeSubmit — the end-to-end Phase 4.4 entry point.
 *
 * Wires together the four Phase 4 helpers (`parseTopLevelSteps`,
 * `materializeReferences`, `renderHandoff`, `inbox.add`) plus the schema
 * validators into a single transactional-ish call: take the Q&A-shim input,
 * mint a taskId, lay down the six per-task files, and append to the inbox.
 *
 * Ordering is deliberate. Sources of failure that the caller can fix without
 * touching the disk (parser rejections, empty-title carry-forward, schema
 * validation) all run BEFORE we touch the filesystem so a malformed submission
 * leaves no orphan `tasks/<id>/` folder behind. Reference materialization is
 * the only step that can fail with a partial folder on disk — we accept that
 * for v0 (orphan task folders are cleaned up via `oa archive`); revisit if
 * intake gets re-entrant.
 *
 * Carry-forwards from earlier reviews:
 *   - Task 4.1 review: empty-title parsed steps are a user error, not a thing
 *     we silently materialize. Reject with a clear message that points at the
 *     offending step number.
 *   - Task 4.3 review: HANDOFF.md's renderer trusts string fields to be
 *     "markdown-safe". Until IntakeSchema tightens those bounds (TODO in
 *     handoff.ts), we rely on the schema parse below to at least reject
 *     wrong-type inputs.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { writeFileAtomic, writeJsonAtomic } from '../atomicJson.js';
import { newTaskId } from '../ids.js';
import { taskDir } from '../paths.js';
import {
  IntakeSchema,
  StepsSchema,
  type Intake,
  type Step,
} from '../schemas.js';
import * as inbox from '../stores/inbox.js';
import { parseTopLevelSteps } from './parseSteps.js';
import { materializeReferences, type ReferenceInput } from './references.js';
import { renderHandoff } from './handoff.js';

/**
 * Input shape for `intakeSubmit`. Mirrors `IntakeSchema` minus the fields the
 * submitter mints (`id`, `createdAt`) and minus `references` (which arrive as
 * un-materialized `ReferenceInput[]` and are widened here). Adds
 * `sourcePlanMd`, the raw markdown that produced the parsed steps.
 */
export interface IntakeSubmitInput {
  title: string;
  source: Intake['source'];
  project: Intake['project'];
  executor: Intake['executor'];
  reviewer: Intake['reviewer'];
  bootstrap: Intake['bootstrap'];
  verify: Intake['verify'];
  strategy: Intake['strategy'];
  references: ReferenceInput[];
  sourcePlanMd: string;
}

export interface IntakeSubmitResult {
  taskId: string;
  taskFolder: string;
}

export async function intakeSubmit(input: IntakeSubmitInput): Promise<IntakeSubmitResult> {
  // ---- Phase A: pre-disk validation ----------------------------------------
  // Everything in this phase must run before we mkdir the task folder so a
  // malformed submission leaves no on-disk trace.

  // 1. Parse the source plan. Empty plan → reject.
  const parsed = parseTopLevelSteps(input.sourcePlanMd);
  if (parsed.steps.length === 0) {
    throw new Error('no top-level steps found in source plan');
  }

  // 2. Reject empty-title parsed steps (Task 4.1 carry-forward). The parser
  //    happily produces `title: ''` for malformed bullets like `- [ ] ` —
  //    that's a user authoring bug, not something we materialize silently.
  for (const step of parsed.steps) {
    if (step.title === '') {
      throw new Error(
        `parsed step ${step.n} has empty title — fix the source plan`,
      );
    }
  }

  // 3. Schema-validate the intake shape BEFORE we create the task folder.
  //    We can't yet supply the materialized references (materialization needs
  //    the folder to exist for file-kind copies), so we validate a "preview"
  //    intake with `references: []`. Every other field is final at this point;
  //    after materialization we re-validate the full intake (including refs)
  //    before any disk write — see Phase C.
  //
  //    Why two parses instead of one late parse: this lets a malformed
  //    `executor`/`strategy`/etc. submission fail BEFORE we touch the disk,
  //    matching the task-spec contract that schema violations leave no orphan
  //    `tasks/<id>/` folder behind.
  const createdAt = new Date().toISOString();
  const taskId = newTaskId();
  const previewIntake: Intake = {
    schemaVersion: 1,
    id: taskId,
    title: input.title,
    createdAt,
    source: input.source,
    project: input.project,
    executor: input.executor,
    reviewer: input.reviewer,
    bootstrap: input.bootstrap,
    verify: input.verify,
    strategy: input.strategy,
    references: [],
  };
  IntakeSchema.parse(previewIntake);

  // ---- Phase B: create folder, materialize refs ----------------------------
  // From here on, an exception may leave a partial `tasks/<id>/` folder behind.
  // Acceptable for v0 (orphans are cleaned via `oa archive`); document at the
  // call site if this changes.

  const taskFolder = taskDir(taskId);
  await fs.mkdir(taskFolder, { recursive: true });

  // Materialize references (copies file refs into `<taskFolder>/references/`,
  // captures sha256 / git metadata per kind). Throws on missing/wrong-type
  // sources with a kind-labeled error message.
  const materialized = await materializeReferences(taskFolder, input.references);

  // ---- Phase C: build & validate the final documents -----------------------
  // BOTH schema parses (full intake, steps doc) run BEFORE any of the on-disk
  // write calls below, so a schema violation in the steps doc doesn't leave a
  // half-written intake.json (and vice versa). The intake parse here can only
  // fail on a reference-shape violation — pre-disk validation already cleared
  // every other field — but we re-parse the whole document for two reasons:
  //   1. it's the canonical witness that what we're about to serialize matches
  //      the schema byte-for-byte, and
  //   2. defense in depth against future edits that widen the preview shape.

  const intake: Intake = { ...previewIntake, references: materialized };
  IntakeSchema.parse(intake);

  // Convert ParsedStep → Step. Spec policy: store `parsedStep.spec` VERBATIM,
  // including the marker line (the leading `- [ ]` / `1.` prefix). Rationale:
  // HANDOFF.md and the eventual per-step prompt benefit from the full original
  // markdown context (sub-bullets, code fences) intact, and the marker line
  // itself is informative for the agent — it sees its own checkbox-list
  // context. Stripping the marker would also force the renderer to know how
  // to reconstruct it for display, which is needless coupling.
  // verify and expectedOutputs default to (null, []) per design §3.4; later
  // intake-Q&A passes will fill these via a separate edit path.
  const steps: Step[] = parsed.steps.map((p) => ({
    n: p.n,
    title: p.title,
    spec: p.spec,
    verify: null,
    expectedOutputs: [],
  }));
  const stepsDoc = { schemaVersion: 1 as const, steps };
  StepsSchema.parse(stepsDoc);

  // ---- Phase D: write all six files ----------------------------------------
  // Order is meaningful: intake.json first (it's the canonical record), then
  // the supporting docs, then the empty progress/findings sentinels. HANDOFF
  // is rendered last because it consumes the validated `intake` + `steps`.

  await writeJsonAtomic(path.resolve(taskFolder, 'intake.json'), intake);
  await writeFileAtomic(path.resolve(taskFolder, 'source-plan.md'), input.sourcePlanMd);
  await writeJsonAtomic(path.resolve(taskFolder, 'steps.json'), stepsDoc);
  await writeFileAtomic(
    path.resolve(taskFolder, 'HANDOFF.md'),
    renderHandoff(intake, steps),
  );
  await writeFileAtomic(path.resolve(taskFolder, 'PROGRESS.md'), '');
  await writeFileAtomic(path.resolve(taskFolder, 'FINDINGS.md'), '');

  // ---- Phase E: append inbox entry (under the inbox lock) ------------------
  // `inbox.add` wraps its read-modify-write inside `withInboxLock`, so
  // concurrent `intakeSubmit` calls serialize correctly here even though the
  // file writes above were independent.
  await inbox.add({
    id: taskId,
    title: input.title,
    status: 'pending',
    createdAt,
    sourceAgent: input.source.agent,
    projectDir: input.project.dir,
    folder: `tasks/${taskId}`,
  });

  return { taskId, taskFolder };
}
