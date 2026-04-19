import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ensureHomeLayout } from '../../src/home.js';
import * as inbox from '../../src/stores/inbox.js';
import * as plan from '../../src/stores/plan.js';
import { newTaskId } from '../../src/ids.js';
import type { InboxTask } from '../../src/schemas.js';

let TMP_HOME: string;
let ORIG_HOME: string | undefined;

beforeEach(async () => {
  ORIG_HOME = process.env.OA_HOME;
  TMP_HOME = path.resolve(os.tmpdir(), 'oa-test-plan-' + Math.random().toString(36).slice(2));
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

describe('PlanStore', () => {
  it('create() seals a plan and flips inbox tasks to queued', async () => {
    const a = makeEntry();
    const b = makeEntry();
    await inbox.add(a);
    await inbox.add(b);

    const created = await plan.create({ taskListIds: [a.id, b.id] });

    expect(created.id).toMatch(/^p_/);
    expect(created.status).toBe('sealed');
    expect(created.taskListIds).toEqual([a.id, b.id]);
    expect(typeof created.createdAt).toBe('string');
    expect(() => new Date(created.createdAt).toISOString()).not.toThrow();

    // Plan file persisted at <oaHome>/plans/<planId>.json.
    const planFile = path.resolve(TMP_HOME, 'plans', `${created.id}.json`);
    const onDisk = JSON.parse(await fs.readFile(planFile, 'utf8'));
    expect(onDisk.id).toBe(created.id);
    expect(onDisk.status).toBe('sealed');
    expect(onDisk.taskListIds).toEqual([a.id, b.id]);
    expect(onDisk.schemaVersion).toBe(1);

    // Inbox tasks both flipped to queued.
    const fa = await inbox.get(a.id);
    const fb = await inbox.get(b.id);
    expect(fa?.status).toBe('queued');
    expect(fb?.status).toBe('queued');
  });

  it('create() rejects an empty taskListIds array', async () => {
    await expect(plan.create({ taskListIds: [] })).rejects.toThrow(/empty/);
  });

  it('create() rejects when any taskListId is missing from the inbox', async () => {
    const a = makeEntry();
    await inbox.add(a);

    await expect(
      plan.create({ taskListIds: [a.id, 'nonexistent-id'] }),
    ).rejects.toThrow(/nonexistent-id/);
  });

  it('create() is atomic on missing-id failure: NO inbox flips, NO plan file', async () => {
    const a = makeEntry();
    await inbox.add(a);

    // Snapshot the plans directory contents before the failing call.
    const plansDir = path.resolve(TMP_HOME, 'plans');
    const before = (await fs.readdir(plansDir)).filter((e) => e.endsWith('.json'));

    await expect(
      plan.create({ taskListIds: [a.id, 'missing-task-id'] }),
    ).rejects.toThrow();

    // a's status is unchanged (still pending) — the early-validation aborted
    // BEFORE any inbox mutation could happen.
    const fa = await inbox.get(a.id);
    expect(fa?.status).toBe('pending');

    // No new plan file was written.
    const after = (await fs.readdir(plansDir)).filter((e) => e.endsWith('.json'));
    expect(after).toEqual(before);
  });

  it('get() returns null when the plan is missing', async () => {
    expect(await plan.get('p_2026-04-18_zzzz')).toBeNull();
  });

  it('get() returns the sealed plan after create()', async () => {
    const a = makeEntry();
    await inbox.add(a);
    const created = await plan.create({ taskListIds: [a.id] });

    const fetched = await plan.get(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.taskListIds).toEqual([a.id]);
    expect(fetched!.status).toBe('sealed');
  });

  it('list() returns every persisted plan', async () => {
    const a = makeEntry();
    const b = makeEntry();
    const c = makeEntry();
    await inbox.add(a);
    await inbox.add(b);
    await inbox.add(c);

    const p1 = await plan.create({ taskListIds: [a.id] });
    const p2 = await plan.create({ taskListIds: [b.id] });
    const p3 = await plan.create({ taskListIds: [c.id] });

    const all = await plan.list();
    expect(all).toHaveLength(3);
    expect(new Set(all.map((p) => p.id))).toEqual(new Set([p1.id, p2.id, p3.id]));
  });

  it('list() skips non-.json files in the plans directory', async () => {
    const a = makeEntry();
    await inbox.add(a);
    const created = await plan.create({ taskListIds: [a.id] });

    // Drop a non-.json sibling; list() must ignore it (no parse attempt, no
    // throw) and only surface the real plan.
    const stray = path.resolve(TMP_HOME, 'plans', 'random.txt');
    await fs.writeFile(stray, 'not-a-plan', 'utf8');

    const all = await plan.list();
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe(created.id);
  });

  it('list() throws with file-path context when a plan file is corrupted', async () => {
    // Hand-write a syntactically invalid plan file and make sure the wrapped
    // error carries the absolute path so the operator knows what to fix.
    const bogusPath = path.resolve(TMP_HOME, 'plans', 'p_bogus.json');
    await fs.writeFile(bogusPath, JSON.stringify({ schemaVersion: 1 }), 'utf8');

    await expect(plan.list()).rejects.toThrow(bogusPath);
    await expect(plan.list()).rejects.toThrow(/corrupted/);
  });

  it('setStatus() transitions a created plan; throws on a missing planId', async () => {
    const a = makeEntry();
    await inbox.add(a);
    const created = await plan.create({ taskListIds: [a.id] });

    await plan.setStatus(created.id, 'running');
    const after = await plan.get(created.id);
    expect(after?.status).toBe('running');

    await expect(plan.setStatus('p_2026-04-18_zzzz', 'done')).rejects.toThrow();
  });

  it('atomic seal under concurrent inbox.add + plan.create (carry-forward)', async () => {
    // Seed inbox with task t_1 (pending). Then race a second inbox.add (t_2)
    // against plan.create([t_1]). Both touch tasks.json; sharing the inbox
    // lock must serialize them, with no torn writes.
    const t1 = makeEntry();
    const t2 = makeEntry();
    await inbox.add(t1);

    await Promise.all([inbox.add(t2), plan.create({ taskListIds: [t1.id] })]);

    // Final inbox state: t1 queued (sealed into the plan), t2 still pending.
    const ft1 = await inbox.get(t1.id);
    const ft2 = await inbox.get(t2.id);
    expect(ft1?.status).toBe('queued');
    expect(ft2?.status).toBe('pending');

    // Exactly one plan exists, sealed, referencing [t1].
    const plans = await plan.list();
    expect(plans).toHaveLength(1);
    expect(plans[0]!.taskListIds).toEqual([t1.id]);
    expect(plans[0]!.status).toBe('sealed');
  });
});
