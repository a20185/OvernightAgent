import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { simpleGit } from 'simple-git';
import { create, rewindToHead, remove, commitsSince } from '../src/worktree.js';
import { newTaskId, worktreeDir } from '../src/index.js';

/**
 * Spins up a throwaway git repo with a single commit on `main`. Returns the
 * absolute repo path. Caller is responsible for cleanup via fs.rm.
 */
async function makeTempRepo(): Promise<string> {
  const dir = path.resolve(os.tmpdir(), 'oa-test-repo-' + Math.random().toString(36).slice(2));
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

let TMP_REPO: string;
let TMP_HOME: string;
let ORIG_HOME: string | undefined;

beforeEach(async () => {
  ORIG_HOME = process.env.OA_HOME;
  TMP_REPO = await makeTempRepo();
  TMP_HOME = path.resolve(os.tmpdir(), 'oa-test-home-' + Math.random().toString(36).slice(2));
  await fs.mkdir(path.resolve(TMP_HOME, 'worktrees'), { recursive: true });
  process.env.OA_HOME = TMP_HOME;
});

afterEach(async () => {
  if (ORIG_HOME === undefined) delete process.env.OA_HOME;
  else process.env.OA_HOME = ORIG_HOME;
  await fs.rm(TMP_REPO, { recursive: true, force: true });
  await fs.rm(TMP_HOME, { recursive: true, force: true });
});

describe('WorktreeManager.create', () => {
  it('creates a worktree at the canonical absolute path', async () => {
    const taskId = newTaskId();
    const expectedAbsRoot = worktreeDir(taskId);
    const result = await create({
      taskId,
      repoDir: TMP_REPO,
      baseBranch: 'main',
      taskTitle: 'My Cool Task',
    });
    expect(result.absRoot).toBe(expectedAbsRoot);
    // repoDir is carried through so the persisted artifact is self-contained
    // (Task 2.4's `remove()` will use it for `git -C <repoDir> branch -D`).
    expect(result.repoDir).toBe(TMP_REPO);
    // The worktree directory must exist on disk after the git call.
    const stat = await fs.stat(result.absRoot);
    expect(stat.isDirectory()).toBe(true);
  });

  it('creates and checks out the new branch in the worktree', async () => {
    const taskId = newTaskId();
    const result = await create({
      taskId,
      repoDir: TMP_REPO,
      baseBranch: 'main',
      taskTitle: 'My Cool Task',
    });
    // git -C <absRoot> rev-parse --abbrev-ref HEAD must return the new branch.
    const wtGit = simpleGit(result.absRoot);
    const head = (await wtGit.revparse(['--abbrev-ref', 'HEAD'])).trim();
    expect(head).toBe(result.branch);
  });

  // Per task description, the format spec is `/^oa\/[a-z0-9-]+-[a-z0-9]{6}$/`,
  // but the spec also defines `shortid = taskId.slice(-6)` and our taskIds are
  // `t_YYYY-MM-DD_xxxx` — so `slice(-6)` includes the literal `_` separator
  // before the 4-char random suffix. We assert against a regex that accepts
  // `_` in the trailing component to reflect what `slice(-6)` actually
  // produces; tightening the slice (e.g. last 4 of `xxxx` only) is left for a
  // future task per the v0 carry-forward note.
  it('produces a branch name matching the documented oa/<frag>-<shortid> shape', async () => {
    const taskId = newTaskId();
    const result = await create({
      taskId,
      repoDir: TMP_REPO,
      baseBranch: 'main',
      taskTitle: 'My Cool Task',
    });
    expect(result.branch).toMatch(/^oa\/[a-z0-9-]+-[a-z0-9_]{6}$/);
  });

  it("falls back to 'untitled' when taskTitle slugs to empty", async () => {
    const taskId = newTaskId();
    const result = await create({
      taskId,
      repoDir: TMP_REPO,
      baseBranch: 'main',
      taskTitle: '!!!',
    });
    const shortId = taskId.slice(-6);
    expect(result.branch).toBe(`oa/untitled-${shortId}`);
    // Re-asserts the format: no leading dash, valid git refname pattern.
    expect(result.branch).toMatch(/^oa\/[a-z0-9-]+-[a-z0-9_]{6}$/);
  });

  it('rejects relative repoDir via assertAbs', async () => {
    await expect(
      create({
        taskId: newTaskId(),
        repoDir: 'relative/repo',
        baseBranch: 'main',
        taskTitle: 'x',
      }),
    ).rejects.toThrow(/non-absolute path/);
  });

  it('rejects malformed taskId via assertId', async () => {
    await expect(
      create({
        taskId: 'not a real id',
        repoDir: TMP_REPO,
        baseBranch: 'main',
        taskTitle: 'x',
      }),
    ).rejects.toThrow(/invalid id/);
  });

  it('rejects empty baseBranch', async () => {
    await expect(
      create({
        taskId: newTaskId(),
        repoDir: TMP_REPO,
        baseBranch: '',
        taskTitle: 'x',
      }),
    ).rejects.toThrow(/baseBranch/);
  });

  it('rejects non-string taskTitle', async () => {
    await expect(
      create({
        taskId: newTaskId(),
        repoDir: TMP_REPO,
        baseBranch: 'main',
        // @ts-expect-error testing runtime guard against non-string sneaking past TS
        taskTitle: undefined,
      }),
    ).rejects.toThrow(/taskTitle must be a string/);
  });

  it('surfaces "task id collision" when worktree dir already exists (EEXIST, empty)', async () => {
    const taskId = newTaskId();
    const absRoot = worktreeDir(taskId);
    // Pre-create the worktree directory so the next create() trips EEXIST.
    // Note: an EMPTY pre-existing dir is the dangerous case — `git worktree
    // add` would silently colonize it without our pre-check (see worktree.ts).
    await fs.mkdir(absRoot, { recursive: true });
    await expect(
      create({
        taskId,
        repoDir: TMP_REPO,
        baseBranch: 'main',
        taskTitle: 'collide',
      }),
    ).rejects.toThrow(/task id collision/);
  });

  it('surfaces collision error when worktree dir exists and is non-empty', async () => {
    const taskId = newTaskId();
    const absRoot = worktreeDir(taskId);
    await fs.mkdir(absRoot, { recursive: true });
    await fs.writeFile(path.resolve(absRoot, 'stale-marker'), 'leftover');
    await expect(
      create({
        taskId,
        repoDir: TMP_REPO,
        baseBranch: 'main',
        taskTitle: 'x',
      }),
    ).rejects.toThrow(/task id collision/);
  });

  it('wraps git errors with task/branch context when baseBranch does not exist', async () => {
    await expect(
      create({
        taskId: newTaskId(),
        repoDir: TMP_REPO,
        baseBranch: 'doesnotexist',
        taskTitle: 'x',
      }),
    ).rejects.toThrow(/git worktree add failed for taskId=/);
  });
});

describe('WorktreeManager.rewindToHead', () => {
  it('rejects relative path via assertAbs', async () => {
    await expect(rewindToHead('relative/path')).rejects.toThrow(/non-absolute path/);
  });

  it('restores a dirty worktree to the last commit (tracked+untracked+gitignored)', async () => {
    const taskId = newTaskId();
    const { absRoot } = await create({
      taskId,
      repoDir: TMP_REPO,
      baseBranch: 'main',
      taskTitle: 'rewind test',
    });
    const gitInWorktree = simpleGit(absRoot);

    // Commit a .gitignore that hides `dist/`. This makes the dist/build.js
    // assertion below a true witness for the `-x` flag: without `-x`,
    // `git clean -fd` would skip gitignored entries and dist/build.js would
    // survive the rewind. Without this commit, `-fd` and `-fdx` are
    // observationally indistinguishable on this test (review carry-forward).
    await fs.writeFile(path.resolve(absRoot, '.gitignore'), 'dist/\n', 'utf8');
    await gitInWorktree.add('.gitignore');
    await gitInWorktree.commit('add gitignore');

    // Capture HEAD SHA AFTER the gitignore commit (HEAD = the gitignore
    // commit itself); rewind must NOT move HEAD off this point.
    const headBefore = (await gitInWorktree.revparse(['HEAD'])).trim();

    // Dirty the worktree three ways:
    //   1. modify a tracked file
    //   2. add an untracked file (exercises plain clean)
    //   3. add a gitignored dir of build-output junk (exercises -d AND -x)
    const readmePath = path.resolve(absRoot, 'README.md');
    const origContent = await fs.readFile(readmePath, 'utf8');
    await fs.writeFile(readmePath, 'MODIFIED\n', 'utf8');
    await fs.writeFile(path.resolve(absRoot, 'new-untracked.txt'), 'hello', 'utf8');
    await fs.mkdir(path.resolve(absRoot, 'dist'), { recursive: true });
    await fs.writeFile(path.resolve(absRoot, 'dist/build.js'), 'x', 'utf8');

    // Sanity: tree IS dirty before the call — otherwise the assertions below
    // could pass for the wrong reason. Note: dist/ is gitignored so it
    // contributes only via the modified README + the untracked txt; that's
    // still > 0 bytes of porcelain output.
    const statusBefore = await gitInWorktree.raw(['status', '--porcelain']);
    expect(statusBefore.length).toBeGreaterThan(0);

    await rewindToHead(absRoot);

    // (a) clean tree
    const statusAfter = await gitInWorktree.raw(['status', '--porcelain']);
    expect(statusAfter.trim()).toBe('');
    // (b) tracked file restored
    expect(await fs.readFile(readmePath, 'utf8')).toBe(origContent);
    // (c) untracked file gone (-f)
    await expect(fs.access(path.resolve(absRoot, 'new-untracked.txt'))).rejects.toThrow();
    // (d) gitignored dir gone — this is the `-x` witness. With `-fd` (no -x)
    // this assertion would FAIL because `dist/` is ignored.
    await expect(fs.access(path.resolve(absRoot, 'dist/build.js'))).rejects.toThrow();
    // (e) HEAD unchanged — we rewind to HEAD, we do not move it.
    const headAfter = (await gitInWorktree.revparse(['HEAD'])).trim();
    expect(headAfter).toBe(headBefore);
  });

  it('is a no-op on an already-clean worktree', async () => {
    const taskId = newTaskId();
    const { absRoot } = await create({
      taskId,
      repoDir: TMP_REPO,
      baseBranch: 'main',
      taskTitle: 'clean test',
    });
    await expect(rewindToHead(absRoot)).resolves.toBeUndefined();
    const git = simpleGit(absRoot);
    const status = await git.raw(['status', '--porcelain']);
    expect(status.trim()).toBe('');
  });

  // Pins the create→rewind transition specifically. Similar in spirit to
  // "no-op on clean worktree" above, but explicitly captures HEAD before/after
  // to defend against a future regression that might (e.g.) accidentally
  // call `git reset --hard HEAD~1` instead of `HEAD`.
  it('is a no-op immediately after create() (fresh worktree)', async () => {
    const taskId = newTaskId();
    const { absRoot } = await create({
      taskId,
      repoDir: TMP_REPO,
      baseBranch: 'main',
      taskTitle: 'fresh',
    });
    const git = simpleGit(absRoot);
    const headBefore = (await git.revparse(['HEAD'])).trim();
    await expect(rewindToHead(absRoot)).resolves.toBeUndefined();
    const status = await git.raw(['status', '--porcelain']);
    expect(status.trim()).toBe('');
    const headAfter = (await git.revparse(['HEAD'])).trim();
    expect(headAfter).toBe(headBefore);
  });
});

describe('WorktreeManager.remove', () => {
  it('rejects relative absRoot via assertAbs', async () => {
    await expect(
      remove({ absRoot: 'relative/abs', repoDir: '/abs/repo', branch: 'oa/x-abc123' }),
    ).rejects.toThrow(/non-absolute path/);
  });

  it('rejects relative repoDir via assertAbs', async () => {
    await expect(
      remove({ absRoot: '/abs/wt', repoDir: 'relative/repo', branch: 'oa/x-abc123' }),
    ).rejects.toThrow(/non-absolute path/);
  });

  it('rejects empty branch', async () => {
    await expect(
      remove({ absRoot: '/abs/wt', repoDir: '/abs/repo', branch: '' }),
    ).rejects.toThrow(/branch must be/);
  });

  it('removes the worktree directory and the branch from the source repo', async () => {
    const taskId = newTaskId();
    const info = await create({
      taskId,
      repoDir: TMP_REPO,
      baseBranch: 'main',
      taskTitle: 'remove test',
    });
    // Pre-state: worktree dir exists; branch is in source repo's branch list.
    await fs.access(info.absRoot);
    const repoGit = simpleGit(TMP_REPO);
    const branchesBefore = await repoGit.branch();
    expect(branchesBefore.all).toContain(info.branch);

    await remove(info);

    // (a) worktree dir removed from disk
    await expect(fs.access(info.absRoot)).rejects.toThrow();
    // (b) branch deleted from source repo's branch list
    const branchesAfter = await repoGit.branch();
    expect(branchesAfter.all).not.toContain(info.branch);
  });

  it('wraps git errors with branch/path context when called twice', async () => {
    const taskId = newTaskId();
    const info = await create({
      taskId,
      repoDir: TMP_REPO,
      baseBranch: 'main',
      taskTitle: 'double remove',
    });
    await remove(info);
    // Second call: worktree no longer exists, branch no longer exists — git
    // will error and we should wrap it with context (the branch + absRoot).
    await expect(remove(info)).rejects.toThrow(/worktree remove failed/);
  });
});

describe('WorktreeManager.commitsSince', () => {
  it('rejects relative absRoot via assertAbs', async () => {
    await expect(commitsSince('relative/path', 'abc')).rejects.toThrow(/non-absolute path/);
  });

  it('rejects empty sha', async () => {
    await expect(commitsSince('/abs/path', '')).rejects.toThrow(/sha must be/);
  });

  it('returns 0 for HEAD..HEAD on a fresh worktree', async () => {
    const taskId = newTaskId();
    const { absRoot } = await create({
      taskId,
      repoDir: TMP_REPO,
      baseBranch: 'main',
      taskTitle: 'count head',
    });
    expect(await commitsSince(absRoot, 'HEAD')).toBe(0);
  });

  it('returns N after N new commits in the worktree', async () => {
    const taskId = newTaskId();
    const { absRoot } = await create({
      taskId,
      repoDir: TMP_REPO,
      baseBranch: 'main',
      taskTitle: 'count n',
    });
    const git = simpleGit(absRoot);
    // Worktree-local git config so .commit() doesn't trip on missing identity.
    await git.addConfig('user.email', 'test@example.com');
    await git.addConfig('user.name', 'Test');
    const baseSha = (await git.revparse(['HEAD'])).trim();

    for (let i = 0; i < 3; i++) {
      await fs.writeFile(path.resolve(absRoot, `file-${i}.txt`), String(i), 'utf8');
      await git.add('.');
      await git.commit(`commit ${i}`);
    }

    const n = await commitsSince(absRoot, baseSha);
    expect(n).toBe(3);
    expect(typeof n).toBe('number');
  });

  // Phase 6 verify-pipeline confidence: a stale/unknown sha must surface as a
  // wrapped error (not a silent 0). `deadbeef`x5 is a syntactically valid
  // SHA-shaped string that won't exist in any history.
  it('rejects with wrapped error on a stale/unknown sha', async () => {
    const taskId = newTaskId();
    const { absRoot } = await create({
      taskId,
      repoDir: TMP_REPO,
      baseBranch: 'main',
      taskTitle: 'stale sha test',
    });
    await expect(
      commitsSince(absRoot, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'),
    ).rejects.toThrow(/commitsSince failed/);
  });
});

// Meta-test: enumerates EVERY exported method on the worktree namespace and
// asserts each one rejects relative paths in its path-typed argument(s). The
// individual methods all have their own per-arg assertion tests above; this
// systematically prevents a future export from accidentally landing without
// absolute-path enforcement, OR an accidental removal of an existing
// `assertAbs` call. Adding a new public method to `worktree.ts` should be a
// one-line addition to `cases` below; failing to do so is the intended forcing
// function (this file will need updating, prompting reviewer attention).
describe('WorktreeManager — every public method rejects relative paths (hardening)', () => {
  const cases: Array<[string, () => Promise<unknown>]> = [
    [
      'create — relative repoDir',
      () =>
        create({
          taskId: newTaskId(),
          repoDir: 'relative/path',
          baseBranch: 'main',
          taskTitle: 'x',
        }),
    ],
    [
      'rewindToHead — relative absRoot',
      () => rewindToHead('relative/path'),
    ],
    [
      'remove — relative absRoot',
      () => remove({ absRoot: 'relative/abs', repoDir: '/abs/repo', branch: 'oa/x-abc123' }),
    ],
    [
      'remove — relative repoDir',
      () => remove({ absRoot: '/abs/wt', repoDir: 'relative/repo', branch: 'oa/x-abc123' }),
    ],
    [
      'commitsSince — relative absRoot',
      () => commitsSince('relative/path', 'abc'),
    ],
  ];

  it.each(cases)('%s', async (_name, invoke) => {
    await expect(invoke()).rejects.toThrow(/non-absolute path/);
  });
});
