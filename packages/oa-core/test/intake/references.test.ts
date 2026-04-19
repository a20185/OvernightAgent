import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { simpleGit } from 'simple-git';
import { materializeReferences } from '../../src/intake/references.js';
import type {
  ReferenceInput,
  MaterializedRef,
} from '../../src/intake/references.js';
import { ReferenceSchema } from '../../src/schemas.js';

/**
 * Spins up a throwaway git repo with a single commit on `main`. Returns the
 * absolute repo path. Mirrors the helper in worktree.test.ts so the
 * dir-in-git tests have a real toplevel + HEAD to assert against.
 */
async function makeTempGitRepo(): Promise<string> {
  const dir = path.resolve(
    os.tmpdir(),
    'oa-test-refs-git-' + Math.random().toString(36).slice(2),
  );
  await fs.mkdir(dir, { recursive: true });
  const git = simpleGit(dir);
  await git.init({ '--initial-branch': 'main' });
  await git.addConfig('user.email', 'test@example.com');
  await git.addConfig('user.name', 'Test');
  await fs.writeFile(path.resolve(dir, 'README.md'), '# test\n');
  await git.add('README.md');
  await git.commit('initial');
  return dir;
}

async function makeTempDir(prefix: string): Promise<string> {
  const dir = path.resolve(
    os.tmpdir(),
    `oa-test-refs-${prefix}-` + Math.random().toString(36).slice(2),
  );
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function sha256OfBuffer(buf: Buffer | string): string {
  const h = createHash('sha256');
  h.update(buf);
  return h.digest('hex');
}

let TASK_FOLDER: string;
const CLEANUP: string[] = [];

beforeEach(async () => {
  TASK_FOLDER = await makeTempDir('task');
  CLEANUP.push(TASK_FOLDER);
});

afterEach(async () => {
  while (CLEANUP.length > 0) {
    const p = CLEANUP.pop();
    if (p) await fs.rm(p, { recursive: true, force: true });
  }
});

describe('materializeReferences — file kind', () => {
  it('copies a file into <taskFolder>/references/ and returns copiedTo + sha256', async () => {
    const srcDir = await makeTempDir('src');
    CLEANUP.push(srcDir);
    const srcAbs = path.resolve(srcDir, 'spec.md');
    const content = '# my spec\nhello world\n';
    await fs.writeFile(srcAbs, content, 'utf8');
    const expectedSha = sha256OfBuffer(content);

    const out = await materializeReferences(TASK_FOLDER, [
      { kind: 'file', src: srcAbs },
    ]);

    expect(out).toHaveLength(1);
    const ref = out[0];
    expect(ref).toBeDefined();
    if (!ref || ref.kind !== 'file') throw new Error('expected file ref');
    expect(ref.kind).toBe('file');
    expect(ref.src).toBe(srcAbs);
    expect(ref.copiedTo).toBe('references/spec.md');
    expect(ref.sha256).toBe(expectedSha);

    // The copied file actually exists on disk with matching content.
    const copiedAbs = path.resolve(TASK_FOLDER, ref.copiedTo);
    const copiedContent = await fs.readFile(copiedAbs, 'utf8');
    expect(copiedContent).toBe(content);

    // Schema parity: returned object validates against ReferenceSchema.
    expect(() => ReferenceSchema.parse(ref)).not.toThrow();
  });

  it('disambiguates filename collisions with -2/-3 counter suffix', async () => {
    const srcDir = await makeTempDir('src-collide');
    CLEANUP.push(srcDir);
    const srcA = path.resolve(srcDir, 'spec.md');
    const srcB = path.resolve(srcDir, 'sub-b', 'spec.md');
    const srcC = path.resolve(srcDir, 'sub-c', 'spec.md');
    await fs.mkdir(path.dirname(srcB), { recursive: true });
    await fs.mkdir(path.dirname(srcC), { recursive: true });
    await fs.writeFile(srcA, 'A\n');
    await fs.writeFile(srcB, 'B\n');
    await fs.writeFile(srcC, 'C\n');

    const out = await materializeReferences(TASK_FOLDER, [
      { kind: 'file', src: srcA },
      { kind: 'file', src: srcB },
      { kind: 'file', src: srcC },
    ]);

    expect(out).toHaveLength(3);
    const a = out[0], b = out[1], c = out[2];
    if (!a || a.kind !== 'file') throw new Error('expected file ref a');
    if (!b || b.kind !== 'file') throw new Error('expected file ref b');
    if (!c || c.kind !== 'file') throw new Error('expected file ref c');
    expect(a.copiedTo).toBe('references/spec.md');
    expect(b.copiedTo).toBe('references/spec-2.md');
    expect(c.copiedTo).toBe('references/spec-3.md');

    // Disk witnesses: each suffixed copy has its source's content.
    expect(await fs.readFile(path.resolve(TASK_FOLDER, a.copiedTo), 'utf8')).toBe('A\n');
    expect(await fs.readFile(path.resolve(TASK_FOLDER, b.copiedTo), 'utf8')).toBe('B\n');
    expect(await fs.readFile(path.resolve(TASK_FOLDER, c.copiedTo), 'utf8')).toBe('C\n');
  });

  it('rejects relative src for kind:file', async () => {
    await expect(
      materializeReferences(TASK_FOLDER, [
        { kind: 'file', src: 'relative/path/spec.md' },
      ]),
    ).rejects.toThrow(/non-absolute path/);
  });

  it('throws on a missing source file', async () => {
    const srcDir = await makeTempDir('src-missing');
    CLEANUP.push(srcDir);
    const missingAbs = path.resolve(srcDir, 'nope.md');
    await expect(
      materializeReferences(TASK_FOLDER, [
        { kind: 'file', src: missingAbs },
      ]),
    ).rejects.toThrow(/reference file not found/);
  });
});

describe('materializeReferences — dir kind', () => {
  it('records gitRepo + gitHead for a dir inside a git repo, does NOT copy contents', async () => {
    const repoDir = await makeTempGitRepo();
    CLEANUP.push(repoDir);
    // Use a subdir of the repo to prove we resolve the toplevel even when
    // src isn't the repo root.
    const subdir = path.resolve(repoDir, 'sub');
    await fs.mkdir(subdir, { recursive: true });
    await fs.writeFile(path.resolve(subdir, 'note.md'), 'note\n');

    const expectedHead = (await simpleGit(repoDir).revparse(['HEAD'])).trim();

    const out = await materializeReferences(TASK_FOLDER, [
      { kind: 'dir', src: subdir },
    ]);

    expect(out).toHaveLength(1);
    const ref = out[0];
    if (!ref || ref.kind !== 'dir') throw new Error('expected dir ref');
    expect(ref.src).toBe(subdir);
    // gitRepo should be the repo toplevel; on macOS the toplevel may be the
    // realpath (e.g. `/private/var/...` instead of `/var/...`). Accept either
    // by checking the basename match.
    expect(ref.gitRepo).toBeDefined();
    expect(path.basename(ref.gitRepo as string)).toBe(path.basename(repoDir));
    expect(ref.gitHead).toBe(expectedHead);

    // No references/ dir should be created since there are no file refs.
    await expect(fs.access(path.resolve(TASK_FOLDER, 'references'))).rejects.toThrow();

    // Schema parity.
    expect(() => ReferenceSchema.parse(ref)).not.toThrow();
  });

  it('omits gitRepo + gitHead when the dir is NOT inside a git repo', async () => {
    const dir = await makeTempDir('non-git');
    CLEANUP.push(dir);
    await fs.writeFile(path.resolve(dir, 'a.txt'), 'a\n');

    const out = await materializeReferences(TASK_FOLDER, [
      { kind: 'dir', src: dir },
    ]);

    expect(out).toHaveLength(1);
    const ref = out[0];
    if (!ref || ref.kind !== 'dir') throw new Error('expected dir ref');
    expect(ref.src).toBe(dir);
    expect(ref.gitRepo).toBeUndefined();
    expect(ref.gitHead).toBeUndefined();
    // Strict schema: extra keys would be rejected; this also doubles as a
    // shape contract assertion.
    expect(() => ReferenceSchema.parse(ref)).not.toThrow();
    // Object should NOT carry the keys at all.
    expect(Object.prototype.hasOwnProperty.call(ref, 'gitRepo')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(ref, 'gitHead')).toBe(false);
  });

  it('rejects relative src for kind:dir', async () => {
    await expect(
      materializeReferences(TASK_FOLDER, [
        { kind: 'dir', src: 'relative/dir' },
      ]),
    ).rejects.toThrow(/non-absolute path/);
  });

  it('throws on a missing dir', async () => {
    const missing = path.resolve(os.tmpdir(), 'oa-test-refs-missing-' + Math.random().toString(36).slice(2));
    await expect(
      materializeReferences(TASK_FOLDER, [
        { kind: 'dir', src: missing },
      ]),
    ).rejects.toThrow(/reference dir not found/);
  });
});

describe('materializeReferences — memory kind', () => {
  it('returns sha256 and does NOT copy the file', async () => {
    const memDir = await makeTempDir('mem');
    CLEANUP.push(memDir);
    const memAbs = path.resolve(memDir, 'feedback_x.md');
    const content = 'remember: prefer pnpm\n';
    await fs.writeFile(memAbs, content, 'utf8');
    const expectedSha = sha256OfBuffer(content);

    const out = await materializeReferences(TASK_FOLDER, [
      { kind: 'memory', src: memAbs },
    ]);

    expect(out).toHaveLength(1);
    const ref = out[0];
    if (!ref || ref.kind !== 'memory') throw new Error('expected memory ref');
    expect(ref.src).toBe(memAbs);
    expect(ref.sha256).toBe(expectedSha);

    // No references/ dir created — memory refs are by-path only.
    await expect(fs.access(path.resolve(TASK_FOLDER, 'references'))).rejects.toThrow();

    expect(() => ReferenceSchema.parse(ref)).not.toThrow();
  });

  it('rejects relative src for kind:memory', async () => {
    await expect(
      materializeReferences(TASK_FOLDER, [
        { kind: 'memory', src: 'relative/mem.md' },
      ]),
    ).rejects.toThrow(/non-absolute path/);
  });
});

describe('materializeReferences — mixed batch', () => {
  it('returns refs in input order with the correct shape per kind', async () => {
    // Set up three sources: a file, a git dir, and a memory file.
    const fileSrcDir = await makeTempDir('mixed-file');
    CLEANUP.push(fileSrcDir);
    const fileAbs = path.resolve(fileSrcDir, 'spec.md');
    await fs.writeFile(fileAbs, 'spec\n');
    const fileSha = sha256OfBuffer('spec\n');

    const gitRepo = await makeTempGitRepo();
    CLEANUP.push(gitRepo);
    const expectedHead = (await simpleGit(gitRepo).revparse(['HEAD'])).trim();

    const memDir = await makeTempDir('mixed-mem');
    CLEANUP.push(memDir);
    const memAbs = path.resolve(memDir, 'm.md');
    await fs.writeFile(memAbs, 'm\n');
    const memSha = sha256OfBuffer('m\n');

    const inputs: ReferenceInput[] = [
      { kind: 'memory', src: memAbs },
      { kind: 'file', src: fileAbs },
      { kind: 'dir', src: gitRepo },
    ];

    const out: MaterializedRef[] = await materializeReferences(TASK_FOLDER, inputs);

    expect(out).toHaveLength(3);
    // Order is preserved.
    expect(out.map((r) => r.kind)).toEqual(['memory', 'file', 'dir']);

    const memRef = out[0];
    const fileRef = out[1];
    const dirRef = out[2];
    if (!memRef || memRef.kind !== 'memory') throw new Error('expected memory ref');
    if (!fileRef || fileRef.kind !== 'file') throw new Error('expected file ref');
    if (!dirRef || dirRef.kind !== 'dir') throw new Error('expected dir ref');

    expect(memRef.src).toBe(memAbs);
    expect(memRef.sha256).toBe(memSha);

    expect(fileRef.src).toBe(fileAbs);
    expect(fileRef.copiedTo).toBe('references/spec.md');
    expect(fileRef.sha256).toBe(fileSha);

    expect(dirRef.src).toBe(gitRepo);
    expect(dirRef.gitHead).toBe(expectedHead);

    // Whole array round-trips through the schema.
    for (const r of out) {
      expect(() => ReferenceSchema.parse(r)).not.toThrow();
    }
  });
});
