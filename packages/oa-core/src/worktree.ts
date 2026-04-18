import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import { assertAbs, worktreeDir } from './paths.js';
import { assertId } from './ids.js';
import { slug } from './slug.js';

/**
 * Inputs for `create()`. All paths are absolute (asserted at the boundary)
 * and `taskId` is validated against the canonical id grammar.
 */
export interface CreateWorktreeOpts {
  /** Canonical task id; validated via `assertId`. */
  taskId: string;
  /** Absolute path to the source repo (must contain a `.git` dir or worktree). */
  repoDir: string;
  /** Existing branch the new worktree branches FROM (e.g. `'main'`). */
  baseBranch: string;
  /** Free-form title; slugged into the branch fragment. May be empty. */
  taskTitle: string;
}

/** Result of a successful `create()` call. */
export interface WorktreeInfo {
  /** Absolute path to the new worktree's working tree root. */
  absRoot: string;
  /** Newly created branch checked out in the worktree. */
  branch: string;
  /**
   * Absolute path to the source repo the worktree was branched from. Carried
   * through so the persisted artifact is self-contained — Task 2.4's `remove()`
   * needs `git -C <repoDir> branch -D <branch>` and shouldn't have to recover
   * `repoDir` via separate plumbing.
   */
  repoDir: string;
}

/**
 * Creates a new git worktree at `worktreeDir(taskId)` checked out on a fresh
 * branch named `oa/<slug(taskTitle)|'untitled'>-<taskId.slice(-6)>`. Branches
 * FROM `baseBranch` (which must already exist in the source repo).
 *
 * Boundary contract:
 *  - `taskId` must be a legal id (`assertId`).
 *  - `repoDir` must be absolute (`assertAbs`).
 *  - `baseBranch` must be a non-empty string.
 *  - `taskTitle` must be a string (empty is fine; falls back to `'untitled'`).
 *
 * Collision handling: if the worktree directory already exists, surfaces a
 * clear `"worktree already exists at <absRoot> — task id collision"` error
 * rather than auto-retrying with a fresh id (per Task 1.6 review carry-
 * forward; auto-retry would surprise callers and obscure data-loss risks).
 *
 * Errors from git (missing baseBranch, repoDir not a git repo, etc.) are
 * wrapped with task/branch context so an operator grepping logs in Phase 7's
 * supervisor can identify the offending taskId without joining streams. The
 * underlying error is preserved as `cause`.
 *
 * NOTE: kept as a standalone export for v0; callers can `worktree.create(...)`
 * via the namespace re-export from `index.ts`. Future revisions may consolidate
 * create + rewindToHead + remove into a `WorktreeManager` class.
 */
export async function create(opts: CreateWorktreeOpts): Promise<WorktreeInfo> {
  assertId(opts.taskId);
  assertAbs(opts.repoDir);
  if (typeof opts.baseBranch !== 'string' || opts.baseBranch.length === 0) {
    throw new Error('baseBranch must be a non-empty string');
  }
  if (typeof opts.taskTitle !== 'string') {
    throw new Error('taskTitle must be a string');
  }

  const fragment = slug(opts.taskTitle) || 'untitled';
  const shortId = opts.taskId.slice(-6);
  const branch = `oa/${fragment}-${shortId}`;
  const absRoot = worktreeDir(opts.taskId);

  // `git worktree add` will not create intermediate directories above the
  // worktree root. Ensure `<oaHome>/worktrees/` exists; the test harness
  // pre-creates it but production callers should not have to.
  await fs.mkdir(path.dirname(absRoot), { recursive: true });

  // EEXIST collision check. NOTE: `git worktree add` only refuses if the
  // target dir is non-empty; an empty dir is silently used. Without this
  // pre-check, a stale empty `worktreeDir(taskId)` (from an aborted run,
  // partial cleanup, or manual mkdir) would be colonized rather than rejected.
  // We surface a clear error rather than auto-retrying with a fresh id
  // (Task 1.6 review carry-forward) — silent renames obscure data-loss risk.
  // `fs.access` is intentional here: we can't punt to git's EEXIST because
  // git accepts empty dirs.
  let exists = false;
  try {
    await fs.access(absRoot);
    exists = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (exists) {
    throw new Error(`worktree already exists at ${absRoot} — task id collision`);
  }

  const git = simpleGit(opts.repoDir);
  try {
    await git.raw(['worktree', 'add', '-b', branch, absRoot, opts.baseBranch]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `git worktree add failed for taskId=${opts.taskId} ` +
        `(branch=${branch}, base=${opts.baseBranch}): ${msg}`,
      { cause: err },
    );
  }

  return { absRoot, branch, repoDir: opts.repoDir };
}
