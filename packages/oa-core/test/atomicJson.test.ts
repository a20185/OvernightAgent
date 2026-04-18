import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { readJson, writeJsonAtomic } from '../src/atomicJson.js';

let TMP: string;

beforeEach(async () => {
  TMP = path.resolve(os.tmpdir(), 'oa-test-' + Math.random().toString(36).slice(2));
  await fs.mkdir(TMP, { recursive: true });
});

afterEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

describe('writeJsonAtomic', () => {
  it('creates parent directories recursively when missing', async () => {
    const target = path.resolve(TMP, 'a/b/c/file.json');
    await writeJsonAtomic(target, { hello: 'world' });
    const raw = await fs.readFile(target, 'utf8');
    expect(JSON.parse(raw)).toEqual({ hello: 'world' });
  });

  it('writes via .tmp.<pid>.<rand> then renames atomically', async () => {
    // ESM namespace members of node:fs/promises are non-configurable, so we
    // can't vi.spyOn(fs, 'rename') to capture the temp path argument directly.
    // Instead we observe the temp file on disk: kick off many concurrent
    // writes (each with a non-trivial payload so the writeFile->rename window
    // is observable), scan the directory while they're in flight, and assert:
    //   1. At least one temp file with name `<basename>.tmp.<pid>.<hex>` is
    //      visible mid-flight (proves writeJsonAtomic uses a temp file with
    //      the documented naming pattern).
    //   2. After all writes settle, no .tmp.* leftovers remain (proves rename,
    //      not copy + unlink).
    //   3. The final filename exists at the target.
    const target = path.resolve(TMP, 'config.json');
    const dir = path.dirname(target);
    const tmpRe = new RegExp(`^config\\.json\\.tmp\\.${process.pid}\\.[0-9a-f]+$`);

    let observedTmp: string | null = null;
    const writes: Array<Promise<void>> = [];
    for (let i = 0; i < 20; i++) {
      writes.push(writeJsonAtomic(target, { a: i, payload: 'x'.repeat(4096) }));
    }
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && observedTmp === null) {
      const entries = await fs.readdir(dir).catch(() => [] as string[]);
      const match = entries.find((e) => tmpRe.test(e));
      if (match) observedTmp = match;
    }
    await Promise.all(writes);

    expect(observedTmp).not.toBeNull();
    expect(observedTmp).toMatch(tmpRe);

    const after = await fs.readdir(dir);
    expect(after.filter((e) => /\.tmp\./.test(e))).toEqual([]);
    expect(after).toContain('config.json');
  });

  it('overwrites an existing file with exactly the new content (no half-merge)', async () => {
    const target = path.resolve(TMP, 'overwrite.json');
    // Pre-populate target with bogus partial content (not even valid JSON).
    await fs.writeFile(target, '{"partial":', 'utf8');
    await writeJsonAtomic(target, { final: true, n: 42 });
    const raw = await fs.readFile(target, 'utf8');
    expect(JSON.parse(raw)).toEqual({ final: true, n: 42 });
  });

  it('rejects relative paths', async () => {
    await expect(writeJsonAtomic('relative/path.json', { a: 1 })).rejects.toThrow(
      /non-absolute path/,
    );
  });
});

describe('readJson', () => {
  it('rejects relative paths', async () => {
    await expect(readJson('relative/path.json')).rejects.toThrow(/non-absolute path/);
  });

  it('returns null when file does not exist (ENOENT)', async () => {
    const target = path.resolve(TMP, 'missing.json');
    const result = await readJson<{ x: number }>(target);
    expect(result).toBeNull();
  });

  it('parses and returns the JSON value when present', async () => {
    const target = path.resolve(TMP, 'present.json');
    await fs.writeFile(target, JSON.stringify({ greet: 'hi', n: 7 }), 'utf8');
    const result = await readJson<{ greet: string; n: number }>(target);
    expect(result).toEqual({ greet: 'hi', n: 7 });
  });

  it('throws on invalid JSON', async () => {
    const target = path.resolve(TMP, 'bad.json');
    await fs.writeFile(target, '{not valid json', 'utf8');
    await expect(readJson(target)).rejects.toThrow();
  });
});

describe('round-trip', () => {
  it('writeJsonAtomic + readJson returns the same value', async () => {
    const target = path.resolve(TMP, 'rt/file.json');
    const value = { a: 1, b: 'two', c: [1, 2, 3], d: { nested: true } };
    await writeJsonAtomic(target, value);
    const read = await readJson<typeof value>(target);
    expect(read).toEqual(value);
  });
});
