import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ensureHomeLayout } from '../../src/home.js';
import * as inbox from '../../src/stores/inbox.js';
import { newTaskId } from '../../src/ids.js';
import type { InboxTask } from '../../src/schemas.js';

let TMP_HOME: string;
let ORIG_HOME: string | undefined;

beforeEach(async () => {
  ORIG_HOME = process.env.OA_HOME;
  TMP_HOME = path.resolve(os.tmpdir(), 'oa-test-inbox-' + Math.random().toString(36).slice(2));
  process.env.OA_HOME = TMP_HOME;
  // Stores assume `ensureHomeLayout()` was called at startup (per Task 1.3
  // carry-forward). Tests honor that contract explicitly so we never rely on
  // defensive bootstrapping inside the store.
  await ensureHomeLayout();
});

afterEach(async () => {
  if (ORIG_HOME === undefined) delete process.env.OA_HOME;
  else process.env.OA_HOME = ORIG_HOME;
  await fs.rm(TMP_HOME, { recursive: true, force: true });
});

function makeEntry(overrides: Partial<InboxTask> = {}): InboxTask {
  const id = overrides.id ?? newTaskId();
  return {
    id,
    title: 'sample task',
    status: 'pending',
    createdAt: new Date().toISOString(),
    sourceAgent: 'claude',
    projectDir: '/tmp/some-project',
    folder: `tasks/${id}`,
    ...overrides,
  };
}

describe('InboxStore', () => {
  it('list() returns [] when no tasks.json exists, get() returns null', async () => {
    expect(await inbox.list()).toEqual([]);
    expect(await inbox.get('any-id')).toBeNull();
  });

  it('round-trip: add(entry) then list() includes it and get(id) returns it', async () => {
    const entry = makeEntry();
    await inbox.add(entry);

    const all = await inbox.list();
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(entry);

    const fetched = await inbox.get(entry.id);
    expect(fetched).toEqual(entry);
  });

  it('add() with a duplicate id throws', async () => {
    const entry = makeEntry();
    await inbox.add(entry);
    await expect(inbox.add(entry)).rejects.toThrow(/already exists/);

    // Internal state still intact (single copy, untouched).
    const all = await inbox.list();
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(entry);
  });

  it('add() multiple distinct entries: list() returns them in insertion order', async () => {
    const a = makeEntry({ title: 'first' });
    const b = makeEntry({ title: 'second' });
    const c = makeEntry({ title: 'third' });

    await inbox.add(a);
    await inbox.add(b);
    await inbox.add(c);

    const all = await inbox.list();
    expect(all.map((t) => t.id)).toEqual([a.id, b.id, c.id]);
    expect(all.map((t) => t.title)).toEqual(['first', 'second', 'third']);
  });

  it('setStatus() updates an existing task', async () => {
    const entry = makeEntry();
    await inbox.add(entry);
    await inbox.setStatus(entry.id, 'queued');

    const fetched = await inbox.get(entry.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.status).toBe('queued');
  });

  it('setStatus() on a missing id throws', async () => {
    await expect(inbox.setStatus('nonexistent', 'queued')).rejects.toThrow(/not found/);
  });

  it('remove() drops the entry: get() returns null and list() does not include it', async () => {
    const a = makeEntry({ title: 'keeper' });
    const b = makeEntry({ title: 'doomed' });
    await inbox.add(a);
    await inbox.add(b);

    await inbox.remove(b.id);

    expect(await inbox.get(b.id)).toBeNull();
    const all = await inbox.list();
    expect(all.map((t) => t.id)).toEqual([a.id]);
  });

  it('remove() on a missing id throws', async () => {
    await expect(inbox.remove('nonexistent')).rejects.toThrow(/not found/);
  });

  it('serializes 3 concurrent add() calls (lock prevents lost writes)', async () => {
    const entries = [makeEntry(), makeEntry(), makeEntry()];

    // Without serialization the read-modify-write windows would overlap and
    // at least one entry would be lost. Lock must serialize them.
    await Promise.all(entries.map((e) => inbox.add(e)));

    const all = await inbox.list();
    expect(all).toHaveLength(3);
    expect(new Set(all.map((t) => t.id))).toEqual(new Set(entries.map((e) => e.id)));
  });

  it('serializes concurrent setStatus() calls (no torn write)', async () => {
    const entry = makeEntry();
    await inbox.add(entry);

    // 3 concurrent setStatus calls. Each one must completely overwrite the
    // previous; the final on-disk status is one of the three (last writer
    // wins) but never a torn / interleaved combo. The file must remain
    // valid JSON parsable by InboxSchema and the entry must still exist.
    const targets = ['queued', 'running', 'done'] as const;
    await Promise.all(targets.map((s) => inbox.setStatus(entry.id, s)));

    const fetched = await inbox.get(entry.id);
    expect(fetched).not.toBeNull();
    expect(targets).toContain(fetched!.status);

    // Inbox still has exactly the one entry — no duplicates from races.
    const all = await inbox.list();
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe(entry.id);
  });
});
