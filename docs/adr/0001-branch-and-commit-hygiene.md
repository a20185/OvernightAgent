# ADR-0001 — Branch per taskList; commit per step with structured trailer

**Status:** Accepted
**Date:** 2026-04-18
**Related:** design § 2.2, § 4.5; ADR-0002 (worktree)

## Context

Overnight runs may produce many commits across many taskLists. The user must wake
up to a repo state that is (a) easy to review, (b) easy to introspect with `git log`,
and (c) safe to delete or merge per taskList without affecting unrelated work.
Re-entry on resume must also be able to identify which commits belong to which
plan / task / step.

## Decision

- Each taskList runs on its own branch named `oa/<taskSlug>-<shortid>`, created
  off the user-specified base branch when the worktree is created.
- When `commitMode = per-step`, each successful step produces exactly one commit
  with a structured trailer block:

  ```
  <one-line summary from agent's tail message>

  <optional body>

  oa-plan: p_<id>
  oa-task: t_<id>
  oa-step: <n>
  oa-attempt: <k>
  ```

- The trailer is parseable from `git log --format=%(trailers)` and is the
  authoritative provenance signal for resume and reporting.

## Consequences

- Positive: per-taskList branches are trivially mergeable, deletable, or rebaseable
  in isolation. Trailers let `oa` reconstruct progress purely from git history if
  PROGRESS.md is lost.
- Negative: many short branches accumulate; deferred `oa archive` can sweep them.
- Neutral: branch names need a slug-generation rule (TBD at impl time).

## Alternatives Considered

- **Single shared branch for the whole plan.** Rejected: cross-taskList commits
  intermix; harder to review / revert.
- **Tag-based provenance instead of trailers.** Rejected: tags are noisier and
  harder to query than trailer fields.
- **Push and open draft PRs per taskList in v0.** Deferred to post-v0 per user
  scope decision.

## Notes

`pushOnFinish` and draft-PR creation are recorded in the design backlog and will be
addressed in a future ADR when implemented.
