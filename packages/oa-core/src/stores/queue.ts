import * as path from 'node:path';
import { oaHome } from '../paths.js';
import { readJson, writeJsonAtomic } from '../atomicJson.js';
import { withInboxLock } from '../locks.js';
import { assertId } from '../ids.js';
import { QueueSchema, type Queue } from '../schemas.js';

/**
 * QueueStore — read/write API over `<oaHome>/queue.json`.
 *
 * The queue is a transient pre-seal staging list of taskListIds (design §3
 * / §4.2). Users `add` and `remove` ids during the curate phase; PlanStore
 * later seals a snapshot of the queue into an immutable plan and `clear`s
 * the queue. The on-disk shape is `{ schemaVersion: 1, taskListIds: string[] }`
 * per `QueueSchema`. Every read validates via `QueueSchema.parse` and throws
 * on invalid content; every write goes through `writeJsonAtomic` so concurrent
 * readers never observe a half-written file.
 *
 * Concurrency model:
 *  - Mutations (`add`, `remove`, `clear`) wrap their full read-modify-write
 *    inside `withInboxLock` — deliberately the SAME lock InboxStore uses,
 *    not a sibling `withQueueLock`. Phase 3.3's PlanStore.create() needs to
 *    atomically read+modify the inbox AND the queue together; sharing the
 *    lock makes that one-acquire trivial, while two locks would force a
 *    consistent acquisition order to avoid deadlock — premature complexity
 *    for v0. Queue ops are infrequent (user-driven curate flow), so
 *    contention against inbox writes is acceptable.
 *  - Reads (`list`, `snapshot`) are deliberately optimistic and do NOT take
 *    the lock. The design's single-writer-via-supervisor convention means a
 *    slightly stale read is acceptable; the lock cost on every list/snapshot
 *    would be a real perf hit for code paths (status renderers, polling)
 *    that don't need transactional consistency.
 *
 * Bootstrap: callers MUST run `ensureHomeLayout()` once at startup. This
 * module does not defensively `mkdir` the home dir — that's the carry-forward
 * from Task 1.3's review. `writeJsonAtomic` will still `mkdir -p` the parent
 * of `queue.json` itself, which is the same dir, so a missing oaHome is
 * tolerated for `add`/`clear`, but reads of a missing queue.json simply
 * return the empty queue shape per the spec.
 */

/** Absolute path of the queue file. */
function queuePath(): string {
  return path.resolve(oaHome(), 'queue.json');
}

/** Empty queue seed. Spread before mutating to avoid sharing the array. */
const EMPTY_QUEUE: Queue = { schemaVersion: 1, taskListIds: [] };

/**
 * Loads and validates the queue file. Returns a fresh empty queue (with a
 * fresh, mutable `taskListIds` array) if the file does not yet exist. Throws
 * if the file exists but does not match `QueueSchema`.
 *
 * Parse failures are re-thrown with the file path embedded so an operator
 * who hand-edits `queue.json` into an invalid shape doesn't have to grep
 * for which file Zod is complaining about. The original Zod error is
 * preserved on `cause`.
 */
async function readQueue(): Promise<Queue> {
  const p = queuePath();
  const raw = await readJson<unknown>(p);
  if (raw === null) return { ...EMPTY_QUEUE, taskListIds: [] };
  try {
    return QueueSchema.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`queue file at ${p} is corrupted: ${msg}`, { cause: err });
  }
}

/**
 * Returns every queued taskListId currently on disk, in insertion order.
 * The returned array is a defensive copy — callers may mutate it without
 * affecting the next read.
 */
export async function list(): Promise<string[]> {
  const q = await readQueue();
  return [...q.taskListIds];
}

/**
 * Returns a defensive copy of the current queue. Semantically identical to
 * `list()` today; exposed as a separate method so PlanStore.create() can
 * declare its intent (sealing the queue into a plan) at the call site.
 * Mutating the returned array MUST NOT affect the next `list()` call.
 */
export async function snapshot(): Promise<string[]> {
  const q = await readQueue();
  return [...q.taskListIds];
}

/**
 * Appends `taskIds` to the queue. Ids already present in the queue are
 * silently skipped (deduped). Validates every id via `assertId` BEFORE
 * taking the lock so a single bad id never blocks other writers — the
 * call either rejects synchronously-ish (via the for-loop throw) and
 * leaves the queue untouched, or acquires the lock and applies all
 * non-duplicate ids in one atomic write.
 *
 * Wraps the read-modify-write in `withInboxLock` (shared with InboxStore;
 * see module-level rationale).
 */
export async function add(taskIds: string[]): Promise<void> {
  // Validate ALL ids before taking the lock. A bad id throwing inside the
  // critical section would still leave the queue unmodified (we'd throw
  // before writeJsonAtomic), but it would needlessly hold the lock for the
  // duration of the read + parse. Validating up-front keeps the lock
  // window minimal and gives the caller an "all-or-nothing" contract:
  // either every id is valid and gets added (deduped), or none does.
  for (const id of taskIds) assertId(id);

  await withInboxLock(async () => {
    const q = await readQueue();
    const existing = new Set(q.taskListIds);
    for (const id of taskIds) {
      if (!existing.has(id)) {
        q.taskListIds.push(id);
        existing.add(id);
      }
    }
    await writeJsonAtomic(queuePath(), q);
  });
}

/**
 * Removes a single id from the queue. Throws if the id is not present.
 * Wraps the read-modify-write in `withInboxLock`.
 */
export async function remove(taskId: string): Promise<void> {
  await withInboxLock(async () => {
    const q = await readQueue();
    const idx = q.taskListIds.indexOf(taskId);
    if (idx === -1) throw new Error(`task not found in queue: ${taskId}`);
    q.taskListIds.splice(idx, 1);
    await writeJsonAtomic(queuePath(), q);
  });
}

/**
 * Empties the queue. Idempotent: a second `clear()` after a first is a
 * no-op write of the same empty document. Wraps the write in `withInboxLock`.
 */
export async function clear(): Promise<void> {
  await withInboxLock(async () => {
    await writeJsonAtomic(queuePath(), { schemaVersion: 1, taskListIds: [] });
  });
}
