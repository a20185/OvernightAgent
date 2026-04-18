# ADR-0007 — Tiered references: copy files, by-path for directories

**Status:** Accepted
**Date:** 2026-04-18
**Related:** design § 3.3, § 4.1; ADR-0006 (context injection)

## Context

Intake collects user-supplied reference docs/dirs/memory entries to be made
available to the executor. An initial proposal copied everything into
`tasks/<id>/references/` for reproducibility. The user flagged the cost concern:

> *"I'm not sure if copied on large folder costs a lot of time. What do you
> think?"*

We need reproducibility without paying O(directory-size) at intake time.

## Decision

Tiered policy by reference kind:

- **`kind: "file"`** — copy into `tasks/<id>/references/` and record `sha256` of
  the copied content. Single files are cheap; copy guarantees the run is
  reproducible even if the original moves or changes.
- **`kind: "dir"`** — **do not copy**. Record the absolute path. If the path is
  inside a git repository, also record `gitRepo` (repo root) and `gitHead`
  (current HEAD SHA at intake time). At run time, the context injector resolves
  the path; if the recorded SHA exists and differs from the repo's current HEAD,
  emit `reference.driftDetected` into events.jsonl and proceed (non-blocking by
  default). A `references.strict: true` toggle promotes drift to a hard fail.
- **`kind: "memory"`** — record the absolute path plus a `sha256` hash of the
  content. Memory entries are small.

No size guardrail in v0 — the file/dir split handles the dominant cost. A size-
warn threshold can be added later if abuse appears.

## Consequences

- Positive: O(1) intake regardless of directory size; reproducibility preserved
  for files; drift on dirs is observable (and optionally enforceable).
- Negative: dir contents at run time may differ from intake time; mitigated by
  the SHA recording and drift event.
- Neutral: the context injector must know how to render dir references (e.g.,
  by listing the path and including a tree summary or `git diff` summary in the
  prompt — exact rendering deferred to impl).

## Alternatives Considered

- **Copy everything.** Rejected per user cost concern.
- **Symlink instead of copy.** Rejected: symlinks break in worktree contexts and
  across machines, and editing the symlink target affects originals.
- **`git archive` snapshot for in-repo dirs.** Rejected for v0: extra snapshot
  storage and decompression cost; SHA recording achieves equivalent
  observability for cheaper.
- **Always reference-by-path with snapshot-at-run-time.** Rejected for files:
  a single file copy is cheaper than a snapshot subsystem and gives stronger
  reproducibility.

## Notes

`references.strict` is a per-taskList toggle inheriting from `config.json` defaults.
Memory references in v0 are paths into `~/.claude/projects/.../memory/` files
created by the auto memory system; OA does not own that store.
