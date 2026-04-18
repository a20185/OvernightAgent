# ADR-0006 — Env-bootstrap once per taskList; context injection every step

**Status:** Accepted
**Date:** 2026-04-18
**Related:** design § 4.5; ADR-0003 (rewind), ADR-0008 (protocol)

## Context

The intake spec lists "startup scripts (such as git checkout / worktree
initialization / dependency installs)" plus a need to give the executing agent
the right reference docs, accumulated findings, and progress state. These two
are different concerns the user explicitly distinguished:

> *"If you mean env-bootstrap, then is Option 1; If Context inject, that is
> every step."*

## Decision

Two distinct mechanisms with two different cadences.

**Env-bootstrap — once per taskList, before its first step.**
- Single shell script declared at intake (`intake.bootstrap.script`).
- Executed in the freshly-created worktree's cwd.
- Exit 0 = continue to first step.
- Non-zero = `task.bootstrap.end{ok:false}`, mark task `bootstrap-failed`,
  apply `onFailure` policy.
- Output captured into events.jsonl. Time bounded by `bootstrap.timeoutSec`.
- `oa` itself owns worktree creation and base-branch checkout; the user's script
  owns project-specific setup (deps, tools, indexing).

**Context injection — every step, every attempt.**
- The supervisor's per-step injector assembles a fresh prompt before each
  `adapter.run` call. Inputs:
  - `tasks/<id>/HANDOFF.md` (rolled-up intake context).
  - `tasks/<id>/PROGRESS.md` (current per-step state).
  - `tasks/<id>/FINDINGS.md` (accumulated learnings from prior steps).
  - The current step's `spec` from `steps.json`.
  - Git context: branch, last commit, status (always clean post-rewind).
  - References: file copies under `tasks/<id>/references/` plus dir-references
    by absolute path with recorded git HEAD (per ADR-0007).
  - `open_review_issues` if this attempt is a fix-loop iteration.
  - The required tail-message protocol block (per ADR-0008).
- Written to `runs/<planId>/steps/<taskId>/<n>/<attempt>/prompt.md` and passed
  to `adapter.run` by absolute path.

## Consequences

- Positive: bootstrap heavy work runs once; per-step prompts always reflect
  current state without relying on agent memory across invocations; fix-loop
  iterations naturally pick up the last reviewer's issues without separate
  plumbing.
- Negative: prompt assembly cost runs on every attempt — acceptable, it's local
  IO + string concatenation.
- Neutral: the context injector is the single place that decides "what does the
  agent see"; new context inputs (e.g., a deferred memory-store reference) plug
  in there.

## Alternatives Considered

- **Bootstrap re-run before every step.** Rejected: slow if it does heavy work
  like `npm install`; pushes idempotency burden on the user's script.
- **Multi-phase bootstrap with `pre-clone`/`post-clone`/`pre-step`/`post-step`
  hooks.** Deferred to post-v0 — YAGNI for the v0 scope.
- **Fixed prompt template per agent without injection.** Rejected: would force
  the agent to discover state on its own each invocation.

## Notes

`HANDOFF.md` is generated at intake time from `intake.json`; the injector reads
it but does not regenerate it. PROGRESS.md and FINDINGS.md are mutated by the
supervisor between steps (single writer — no locks needed).
