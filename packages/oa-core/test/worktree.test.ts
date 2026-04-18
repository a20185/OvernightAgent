import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { simpleGit } from 'simple-git';
import { create } from '../src/worktree.js';
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
