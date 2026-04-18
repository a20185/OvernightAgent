import * as path from 'node:path';
import { oaHome } from '../paths.js';
import { readJson, writeJsonAtomic } from '../atomicJson.js';
import { withInboxLock } from '../locks.js';
import { InboxSchema, type Inbox, type InboxTask, type TaskStatusT } from '../schemas.js';

/**
 * InboxStore — read/write API over `<oaHome>/tasks.json`.
 *
 * The on-disk shape is `{ schemaVersion: 1, tasks: InboxTask[] }` per
 * `InboxSchema` (design §3.2). Every read validates via `InboxSchema.parse`
 * and throws on invalid content; every write goes through `writeJsonAtomic`
 * so concurrent readers never observe a half-written file.
 *
 * Concurrency model:
 *  - Mutations (`add`, `setStatus`, `remove`) wrap their full
 *    read-modify-write inside `withInboxLock`, so even concurrent in-process
 *    or cross-process callers serialize and never lose updates.
 *  - Reads (`list`, `get`) are deliberately optimistic and do NOT take the
 *    lock. The design's single-writer-via-supervisor convention means a
 *    slightly stale read is acceptable; the lock cost on every list/get
 *    would be a real perf hit for code paths (status renderers, polling)
 *    that don't need transactional consistency.
 *
 * Bootstrap: callers MUST run `ensureHomeLayout()` once at startup. This
 * module does not defensively `mkdir` the home dir — that's the carry-forward
 * from Task 1.3's review. `writeJsonAtomic` will still `mkdir -p` the parent
 * of `tasks.json` itself, which is the same dir, so a missing oaHome is
 * tolerated for `add`, but reads of a missing tasks.json simply return the
 * empty inbox shape per the spec.
 */

/** Absolute path of the inbox file. */
function inboxPath(): string {
  return path.resolve(oaHome(), 'tasks.json');
}

/** Empty inbox seed. Spread before mutating to avoid sharing the array. */
const EMPTY_INBOX: Inbox = { schemaVersion: 1, tasks: [] };

/**
 * Loads and validates the inbox file. Returns a fresh empty inbox (with a
 * fresh, mutable `tasks` array) if the file does not yet exist. Throws if
 * the file exists but does not match `InboxSchema`.
 */
async function readInbox(): Promise<Inbox> {
  const raw = await readJson<unknown>(inboxPath());
  if (raw === null) return { ...EMPTY_INBOX, tasks: [] };
  return InboxSchema.parse(raw);
}

/** Returns every inbox entry currently on disk (validated). */
export async function list(): Promise<InboxTask[]> {
  const inbox = await readInbox();
  return inbox.tasks;
}

/** Returns the entry for `taskId`, or `null` if no such entry exists. */
export async function get(taskId: string): Promise<InboxTask | null> {
  const inbox = await readInbox();
  return inbox.tasks.find((t) => t.id === taskId) ?? null;
}

/**
 * Appends `entry` to the inbox. Throws if a task with the same id already
 * exists. Wraps the read-modify-write in `withInboxLock`.
 */
export async function add(entry: InboxTask): Promise<void> {
  await withInboxLock(async () => {
    const inbox = await readInbox();
    if (inbox.tasks.some((t) => t.id === entry.id)) {
      throw new Error(`task already exists in inbox: ${entry.id}`);
    }
    inbox.tasks.push(entry);
    await writeJsonAtomic(inboxPath(), inbox);
  });
}

/**
 * Updates an existing task's `status`. Throws if no such task exists. Wraps
 * the read-modify-write in `withInboxLock`.
 */
export async function setStatus(taskId: string, status: TaskStatusT): Promise<void> {
  await withInboxLock(async () => {
    const inbox = await readInbox();
    const task = inbox.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`task not found in inbox: ${taskId}`);
    task.status = status;
    await writeJsonAtomic(inboxPath(), inbox);
  });
}

/**
 * Removes the entry with `taskId`. Throws if no such task exists. Wraps the
 * read-modify-write in `withInboxLock`.
 */
export async function remove(taskId: string): Promise<void> {
  await withInboxLock(async () => {
    const inbox = await readInbox();
    const idx = inbox.tasks.findIndex((t) => t.id === taskId);
    if (idx === -1) throw new Error(`task not found in inbox: ${taskId}`);
    inbox.tasks.splice(idx, 1);
    await writeJsonAtomic(inboxPath(), inbox);
  });
}
