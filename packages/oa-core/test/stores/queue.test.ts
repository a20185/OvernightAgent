import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ensureHomeLayout } from '../../src/home.js';
import * as queue from '../../src/stores/queue.js';
import { newTaskId } from '../../src/ids.js';

let TMP_HOME: string;
let ORIG_HOME: string | undefined;

beforeEach(async () => {
  ORIG_HOME = process.env.OA_HOME;
  TMP_HOME = path.resolve(os.tmpdir(), 'oa-test-queue-' + Math.random().toString(36).slice(2));
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

describe('QueueStore', () => {
  it('list() and snapshot() return [] when no queue.json exists', async () => {
    expect(await queue.list()).toEqual([]);
    expect(await queue.snapshot()).toEqual([]);
  });

  it('round-trip: add(ids) then list() returns them in insertion order', async () => {
    const a = newTaskId();
    const b = newTaskId();
    await queue.add([a, b]);

    const all = await queue.list();
    expect(all).toEqual([a, b]);
  });

  it('add() dedupes ids already present in the queue', async () => {
    const a = newTaskId();
    const b = newTaskId();
    await queue.add([a]);
    await queue.add([a, b]);

    const all = await queue.list();
    expect(all).toEqual([a, b]);
  });

  it('add() rejects an invalid id and leaves the queue unchanged', async () => {
    const valid = newTaskId();
    await queue.add([valid]);

    // Validation must happen for every id before any mutation runs — otherwise
    // a partially applied add would leave the on-disk state inconsistent with
    // the throw. Try a few representative bad shapes.
    const bads = ['../bad', '/etc/passwd', '', '.', '..'];
    for (const bad of bads) {
      const fresh = newTaskId();
      await expect(queue.add([fresh, bad])).rejects.toThrow(/invalid id/);
      // Queue is exactly what it was before the failing call: only `valid`.
      expect(await queue.list()).toEqual([valid]);
    }
  });

  it('remove() drops an existing id; list() no longer includes it', async () => {
    const a = newTaskId();
    await queue.add([a]);
    await queue.remove(a);
    expect(await queue.list()).toEqual([]);
  });

  it('remove() on a missing id throws', async () => {
    await expect(queue.remove('nonexistent')).rejects.toThrow(/not found/);
  });

  it('clear() empties the queue', async () => {
    const a = newTaskId();
    const b = newTaskId();
    await queue.add([a, b]);
    await queue.clear();
    expect(await queue.list()).toEqual([]);
  });

  it('snapshot() returns a defensive copy that callers cannot use to mutate state', async () => {
    const a = newTaskId();
    const b = newTaskId();
    await queue.add([a, b]);

    const snap = await queue.snapshot();
    expect(snap).toEqual([a, b]);

    // Mutate the returned array; the next list() must be unaffected.
    snap.push('sneaky');
    snap.splice(0, snap.length);

    expect(await queue.list()).toEqual([a, b]);
  });

  it('serializes 3 concurrent add() calls (lock prevents lost writes)', async () => {
    const setA = [newTaskId(), newTaskId()];
    const setB = [newTaskId(), newTaskId()];
    const setC = [newTaskId(), newTaskId()];

    // Without serialization the read-modify-write windows would overlap and
    // at least one id would be lost. Lock must serialize them so the final
    // queue is the union of all three sets.
    await Promise.all([queue.add(setA), queue.add(setB), queue.add(setC)]);

    const all = await queue.list();
    const expected = new Set<string>([...setA, ...setB, ...setC]);
    expect(all).toHaveLength(expected.size);
    expect(new Set(all)).toEqual(expected);
  });

  it('reports the file path when queue.json is corrupted', async () => {
    // Sabotage: hand-write an obviously invalid queue so QueueSchema.parse
    // fails. The wrapper must include the absolute path of queue.json in
    // the thrown message so an operator knows which file to fix.
    const queueFile = path.resolve(TMP_HOME, 'queue.json');
    await fs.writeFile(queueFile, JSON.stringify({ taskListIds: 'not-an-array' }), 'utf8');

    await expect(queue.list()).rejects.toThrow(queueFile);
    await expect(queue.list()).rejects.toThrow(/corrupted/);
  });
});
