# ADR-0002 — Worktree per taskList; absolute paths everywhere

**Status:** Accepted
**Date:** 2026-04-18
**Related:** design § 2.2, § 3.7; ADR-0001 (branches), ADR-0003 (rewind)

## Context

Two requirements collide:

1. The same repo may appear in multiple queued taskLists. They must not clobber
   each other's working trees.
2. The user has been bitten before by file-ops bugs in worktree contexts where the
   same filename exists in multiple checkouts and a relative path or glob silently
   resolved to the wrong tree. Quote: *"there are lots of badcases when creating &
   managing worktrees and some file-glob issues when the same file exists in
   multiple worktrees."*

## Decision

- Each taskList runs in its own oa-owned worktree at
  `~/.config/overnight-agent/worktrees/<taskId>/`, created off the user-specified
  base branch on a new branch (per ADR-0001).
- The worktree manager exposes a small public API:
  `create({taskId, repoDir, baseBranch}) → { absRoot, branch }`,
  `rewindToHead(absRoot)`, `remove(absRoot)`.
- **All paths in the worktree manager's public API are absolute.** Every input is
  asserted with `path.isAbsolute(p)` at the boundary; non-absolute input is a
  programming error and throws.
- `oa-core` provides path-handling helpers that callers in supervisor / verify /
  context-injector use; those helpers also assert absolute paths at their entry
  points.

## Consequences

- Positive: parallel taskLists never collide; resume is straightforward; the
  absolute-path discipline eliminates a known class of cross-worktree clobbering.
- Negative: extra disk usage (one full checkout per taskList); cleanup deferred
  to `oa archive`.
- Neutral: callers must `path.resolve()` user-supplied paths before crossing the
  worktree-manager boundary.

## Alternatives Considered

- **Run in the user's existing checkout.** Rejected: collisions on parallel runs;
  destroys user's local state on rewind.
- **Tolerate relative paths internally.** Rejected by user feedback (see Context).
- **Per-step worktree.** Rejected: rebuild cost too high; taskLists need a
  consistent working tree across steps.

## Notes

Saved memory: `feedback_worktree_absolute_paths.md` documents the user-stated
rule that drove the assertion choice.
