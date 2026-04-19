import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as findings from '../../src/state/findings.js';

/**
 * Task 6.5 — FINDINGS.md mutator tests.
 *
 * Append-only plain markdown (no JSON twin). Tests cover the empty-file
 * bootstrap, the append-preserving-prior-content invariant, the missing-file
 * read shortcut, and the absolute-path guard.
 */

let TMP: string;

beforeEach(async () => {
  TMP = path.resolve(os.tmpdir(), 'oa-test-findings-' + Math.random().toString(36).slice(2));
  await fs.mkdir(TMP, { recursive: true });
});

afterEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

describe('findings.append', () => {
  it('creates FINDINGS.md if absent', async () => {
    await findings.append(TMP, 'first finding');
    const stat = await fs.stat(path.resolve(TMP, 'FINDINGS.md'));
    expect(stat.isFile()).toBe(true);
    const body = await fs.readFile(path.resolve(TMP, 'FINDINGS.md'), 'utf8');
    expect(body).toContain('first finding');
  });

  it('adds to existing content (preserves prior summaries)', async () => {
    await findings.append(TMP, 'first finding');
    await findings.append(TMP, 'second finding');

    const body = await fs.readFile(path.resolve(TMP, 'FINDINGS.md'), 'utf8');
    expect(body).toContain('first finding');
    expect(body).toContain('second finding');
    // Order is preserved.
    expect(body.indexOf('first finding')).toBeLessThan(body.indexOf('second finding'));
  });

  it('rejects relative folder', async () => {
    await expect(findings.append('relative/path', 'x')).rejects.toThrow(/non-absolute path/);
  });
});

describe('findings.read', () => {
  it('returns "" when FINDINGS.md is absent', async () => {
    const body = await findings.read(TMP);
    expect(body).toBe('');
  });

  it('returns content after append', async () => {
    await findings.append(TMP, 'hello world');
    const body = await findings.read(TMP);
    expect(body).toContain('hello world');
  });

  it('rejects relative folder', async () => {
    await expect(findings.read('relative/path')).rejects.toThrow(/non-absolute path/);
  });
});
