import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as progress from '../../src/state/progress.js';

/**
 * Task 6.5 — PROGRESS.md mutator tests.
 *
 * Two-file invariant: every `mark()` updates `_progress.json` (the
 * Zod-validated source of truth) AND regenerates `PROGRESS.md` (the
 * human-readable rendering). Tests cover the upsert path, the
 * regeneration-on-every-call invariant, the empty-folder bootstrap, and
 * the absolute-path guard inherited from `assertAbs`.
 *
 * Per-test tmpdir as `taskFolder` — these are per-task ops, not store ops,
 * so we don't need ensureHomeLayout / OA_HOME plumbing.
 */

let TMP: string;

beforeEach(async () => {
  TMP = path.resolve(os.tmpdir(), 'oa-test-progress-' + Math.random().toString(36).slice(2));
  await fs.mkdir(TMP, { recursive: true });
});

afterEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

describe('progress.mark', () => {
  it('creates _progress.json AND PROGRESS.md on empty folder', async () => {
    await progress.mark(TMP, 1, 'running');

    const jsonStat = await fs.stat(path.resolve(TMP, '_progress.json'));
    expect(jsonStat.isFile()).toBe(true);

    const mdStat = await fs.stat(path.resolve(TMP, 'PROGRESS.md'));
    expect(mdStat.isFile()).toBe(true);

    const md = await fs.readFile(path.resolve(TMP, 'PROGRESS.md'), 'utf8');
    expect(md).toContain('# PROGRESS');
    expect(md).toContain('running');

    const json = JSON.parse(await fs.readFile(path.resolve(TMP, '_progress.json'), 'utf8'));
    expect(json.schemaVersion).toBe(1);
    expect(json.steps).toHaveLength(1);
    expect(json.steps[0].n).toBe(1);
    expect(json.steps[0].status).toBe('running');
    expect(typeof json.steps[0].updatedAt).toBe('string');
  });

  it('upserts an existing step (same n, new status)', async () => {
    await progress.mark(TMP, 2, 'running', 'attempt 1');
    await progress.mark(TMP, 2, 'done', 'finished');

    const doc = await progress.read(TMP);
    expect(doc.steps).toHaveLength(1);
    expect(doc.steps[0]?.n).toBe(2);
    expect(doc.steps[0]?.status).toBe('done');
    expect(doc.steps[0]?.detail).toBe('finished');
  });

  it('adds a new step entry when n differs', async () => {
    await progress.mark(TMP, 1, 'done');
    await progress.mark(TMP, 2, 'running');

    const doc = await progress.read(TMP);
    expect(doc.steps).toHaveLength(2);
    expect(doc.steps.map((s) => s.n).sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it('regenerates PROGRESS.md on every mark (mtime changes)', async () => {
    await progress.mark(TMP, 1, 'running');
    const md = path.resolve(TMP, 'PROGRESS.md');
    const firstStat = await fs.stat(md);
    const firstContent = await fs.readFile(md, 'utf8');

    // Sleep enough that mtime resolution (which can be 1s on some FSes) ticks.
    await new Promise((r) => setTimeout(r, 1100));

    await progress.mark(TMP, 1, 'done');
    const secondStat = await fs.stat(md);
    const secondContent = await fs.readFile(md, 'utf8');

    expect(secondStat.mtimeMs).toBeGreaterThan(firstStat.mtimeMs);
    expect(secondContent).not.toBe(firstContent);
    expect(secondContent).toContain('done');
  });

  it('rejects relative folder', async () => {
    await expect(progress.mark('relative/path', 1, 'running')).rejects.toThrow(
      /non-absolute path/,
    );
  });
});

describe('progress.read', () => {
  it('returns empty doc when _progress.json is absent', async () => {
    const doc = await progress.read(TMP);
    expect(doc).toEqual({ schemaVersion: 1, steps: [] });
  });

  it('returns a valid doc after mark', async () => {
    await progress.mark(TMP, 3, 'failed', 'segfault');
    const doc = await progress.read(TMP);
    expect(doc.schemaVersion).toBe(1);
    expect(doc.steps).toHaveLength(1);
    expect(doc.steps[0]?.n).toBe(3);
    expect(doc.steps[0]?.status).toBe('failed');
    expect(doc.steps[0]?.detail).toBe('segfault');
  });

  it('rejects relative folder', async () => {
    await expect(progress.read('relative/path')).rejects.toThrow(/non-absolute path/);
  });

  it('throws a path-wrapped error when _progress.json is corrupted', async () => {
    await fs.writeFile(path.resolve(TMP, '_progress.json'), '{not valid', 'utf8');
    await expect(progress.read(TMP)).rejects.toThrow();
  });
});
