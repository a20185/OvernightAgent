import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { oaHome } from '../paths.js';
import { readJson, writeJsonAtomic } from '../atomicJson.js';
import { withInboxLock } from '../locks.js';
import { newPlanId } from '../ids.js';
import {
  PlanSchema,
  InboxSchema,
  type Plan,
  type Inbox,
  type PlanStatusT,
} from '../schemas.js';

/**
 * PlanStore — read/write API over `<oaHome>/plans/<planId>.json`.
 *
 * Each plan is its own per-file document validated by `PlanSchema`. There is
 * NO shared registry file: plans land as immutable per-file artifacts at
 * `<oaHome>/plans/<planId>.json` so concurrent seals never contend on a
 * single hot file. The directory is the registry; `list()` enumerates it.
 *
 * Lifecycle:
 *  - `create()` is the seal moment: it mints a `planId`, validates that every
 *    referenced taskListId is present in the inbox, flips those inbox entries
 *    to `'queued'`, and persists the plan with `status: 'sealed'`. All three
 *    side effects (inbox read, inbox write, plan write) happen inside ONE
 *    `withInboxLock` acquisition so concurrent seals/adds serialize.
 *  - `setStatus()` is the only post-seal mutation. Plans are otherwise
 *    immutable (id, createdAt, taskListIds, overrides do not change).
 *  - `get()` / `list()` are optimistic reads; they do NOT take the inbox
 *    lock. Plans are isolated per-file; `writeJsonAtomic` guarantees readers
 *    never observe a half-written file.
 *
 * Bootstrap: callers MUST run `ensureHomeLayout()` once at startup. This
 * module does not defensively `mkdir` `<oaHome>/plans/` — that's the
 * carry-forward from Task 1.3's review. `writeJsonAtomic` will still
 * `mkdir -p` the parent of the plan file itself, so a missing plans/ dir is
 * tolerated for `create`, but `list()` of a missing plans/ dir simply
 * returns the empty array per the spec.
 */

/** Absolute path of the plans directory. */
function plansDir(): string {
  return path.resolve(oaHome(), 'plans');
}

/** Absolute path of a single plan file. */
function planPath(planId: string): string {
  return path.resolve(plansDir(), `${planId}.json`);
}

/** Absolute path of the inbox file (mirrored from inbox.ts so create() can
 * touch tasks.json directly without taking on a circular import to the
 * inbox store module). */
function inboxPath(): string {
  return path.resolve(oaHome(), 'tasks.json');
}

/**
 * Loads and validates a single plan file. Throws "plan file not found" if
 * absent (the caller's `get()` translates that to `null`); throws a
 * file-path-wrapped error if the on-disk content does not match `PlanSchema`.
 *
 * Parse failures embed the absolute path so an operator who hand-edits a
 * plan file into an invalid shape doesn't have to grep for which file Zod
 * is complaining about. Original Zod error preserved on `cause`.
 */
async function readPlanFile(p: string): Promise<Plan> {
  const raw = await readJson<unknown>(p);
  if (raw === null) throw new Error(`plan file not found: ${p}`);
  try {
    return PlanSchema.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`plan file at ${p} is corrupted: ${msg}`, { cause: err });
  }
}

/**
 * Loads and validates the inbox file directly (NOT via `inbox.list()` /
 * `inbox.setStatus()`).
 *
 * Why not delegate to InboxStore? Because `create()` runs this read INSIDE
 * `withInboxLock`, and proper-lockfile is non-reentrant: any call back into
 * `inbox.setStatus` (which itself takes `withInboxLock`) would silently
 * block for the full 5-second retry budget and then reject with `ELOCKED`.
 * The seal path therefore mirrors the inbox read/write helpers locally
 * rather than re-entering through the public store API. See `create()` for
 * the load-bearing version of this comment.
 *
 * Returns a fresh empty inbox shape if the file does not yet exist. Throws
 * if the file exists but does not match `InboxSchema`, with the file path
 * embedded.
 */
async function readInboxRaw(): Promise<Inbox> {
  const p = inboxPath();
  const raw = await readJson<unknown>(p);
  if (raw === null) return { schemaVersion: 1, tasks: [] };
  try {
    return InboxSchema.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`inbox file at ${p} is corrupted: ${msg}`, { cause: err });
  }
}

/** Inputs accepted by `create()`. `overrides` defaults to `{}` (PlanSchema
 * requires the field; all fields inside the overrides object are optional). */
export interface CreatePlanOpts {
  taskListIds: string[];
  overrides?: Plan['overrides'];
}

/**
 * Seals a new plan from the given `taskListIds`.
 *
 * Atomicity model — load-bearing carry-forward from Task 3.1's review:
 *
 *   proper-lockfile is NOT reentrant — calling inbox.setStatus from inside
 *   withInboxLock will silently block 5s and ELOCKED. PlanStore.create()
 *   must acquire withInboxLock directly and read+modify+write tasks.json
 *   content itself (bypassing inbox.setStatus). Multi-task setStatus must
 *   happen in ONE atomic update.
 *
 * The seal therefore takes the inbox lock ONCE and performs all three I/O
 * ops (read inbox, validate ids, write inbox, write plan) inside that
 * single critical section. Concurrent `inbox.add()` / `queue.add()` calls
 * share the same lock and serialize naturally.
 *
 * Atomic-on-validation-failure: every taskListId is checked against the
 * just-read inbox snapshot BEFORE any mutation. If any id is missing the
 * call throws and neither tasks.json nor any plan file is written.
 *
 * TODO(phase-7): there is a microsecond-wide partial-failure window between
 * the inbox writeJsonAtomic and the plan-file writeJsonAtomic. A crash in
 * that window leaves the inbox flipped to 'queued' but no plan file
 * referencing those tasks. The supervisor's startup recovery (phase 7)
 * should detect "queued tasks not present in any sealed plan" and either
 * recover them or warn the operator. For v0 the window is acceptable —
 * the seal path is run by an interactive user, not a high-throughput
 * batch process.
 */
export async function create(opts: CreatePlanOpts): Promise<Plan> {
  if (opts.taskListIds.length === 0) {
    throw new Error('taskListIds cannot be empty');
  }
  const dedup = new Set(opts.taskListIds);
  if (dedup.size !== opts.taskListIds.length) {
    throw new Error('taskListIds contains duplicates');
  }

  const planId = newPlanId();
  const plan: Plan = {
    schemaVersion: 1,
    id: planId,
    createdAt: new Date().toISOString(),
    status: 'sealed',
    taskListIds: [...opts.taskListIds],
    overrides: opts.overrides ?? {},
  };

  await withInboxLock(async () => {
    // proper-lockfile is NOT reentrant — calling inbox.setStatus from inside
    // withInboxLock will silently block 5s and ELOCKED. PlanStore.create()
    // must acquire withInboxLock directly and read+modify+write tasks.json
    // content itself (bypassing inbox.setStatus). Multi-task setStatus must
    // happen in ONE atomic update.
    const inboxFile = inboxPath();
    const inbox = await readInboxRaw();

    // Validate FIRST so a missing id aborts before any mutation. The two
    // writes below must be all-or-nothing from the caller's perspective:
    // either every id flips to 'queued' AND the plan file lands, or
    // neither side effect happens.
    const missing: string[] = [];
    for (const id of opts.taskListIds) {
      if (!inbox.tasks.some((t) => t.id === id)) missing.push(id);
    }
    if (missing.length > 0) {
      throw new Error(`taskListIds not in inbox: ${missing.join(', ')}`);
    }

    // All ids present — flip their statuses to 'queued' on the in-memory
    // snapshot, then commit both files. Inbox first so a crash between the
    // two writes leaves the inbox describing tasks that have no plan
    // (recoverable) rather than a plan referencing tasks the inbox still
    // calls 'pending' (confusing).
    //
    // NOTE: this flips from any source status → 'queued', not strictly pending →
    // queued. Re-sealing a done/failed task is permitted and silently downgrades
    // it to queued. The store accepts any source status; the supervisor (Phase 7)
    // owns lifecycle correctness — same precedent as inbox.setStatus.
    const idsToFlip = new Set(opts.taskListIds);
    for (const task of inbox.tasks) {
      if (idsToFlip.has(task.id)) task.status = 'queued';
    }
    await writeJsonAtomic(inboxFile, inbox);
    await writeJsonAtomic(planPath(planId), plan);
  });

  return plan;
}

/**
 * Loads a plan by id. Returns `null` if no file exists at
 * `<oaHome>/plans/<planId>.json`; throws on parse / I/O errors with the
 * file-path-wrapped error from `readPlanFile`.
 */
export async function get(planId: string): Promise<Plan | null> {
  try {
    return await readPlanFile(planPath(planId));
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('plan file not found')) {
      return null;
    }
    throw err;
  }
}

/**
 * Returns every plan persisted under `<oaHome>/plans/`. Skips non-`.json`
 * entries silently (they may be stray files, in-flight tmp writes from
 * `writeJsonAtomic`, or operator notes). If the plans directory does not
 * exist yet, returns `[]`.
 *
 * Throws on the FIRST corrupted plan file with a file-path-wrapped error
 * (via `readPlanFile`); we deliberately do not aggregate errors so the
 * operator sees the highest-priority broken file immediately.
 */
export async function list(): Promise<Plan[]> {
  const dir = plansDir();
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const plans: Plan[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    plans.push(await readPlanFile(path.resolve(dir, entry)));
  }
  return plans;
}

/**
 * Updates a plan's status in place. The only mutation allowed on a sealed
 * plan — every other field is immutable from `create()` onward. Throws
 * with the file-path-wrapped error from `readPlanFile` if the plan does
 * not exist or is corrupted.
 *
 * Does NOT take `withInboxLock`. Plans are per-file artifacts isolated from
 * tasks.json; concurrent setStatus on different planIds touch disjoint
 * files and `writeJsonAtomic` provides per-file atomicity. Concurrent
 * setStatus on the SAME planId follow last-writer-wins, which matches
 * inbox.setStatus's contract.
 *
 * No transition validation — caller (supervisor or CLI) owns lifecycle
 * correctness. Same contract as inbox.setStatus.
 */
export async function setStatus(planId: string, status: PlanStatusT): Promise<void> {
  const p = planPath(planId);
  const plan = await readPlanFile(p);
  plan.status = status;
  await writeJsonAtomic(p, plan);
}
