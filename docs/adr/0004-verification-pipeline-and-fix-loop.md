# ADR-0004 — Four-gate verification pipeline with P0/P1 review-fix loop

**Status:** Accepted
**Date:** 2026-04-18
**Related:** design § 4.5; ADR-0008 (tail-message protocol)

## Context

A step claiming "done" is not enough. Agents may declare success without writing
code, write code that doesn't compile, or produce code that compiles but is
clearly wrong. The user wants strong gates plus an automated fix loop for
recoverable issues, with priority-based blocking and a hard cap to prevent
runaway loops.

User feedback verbatim: *"I'm wondering what happens after AI-judge failure?
Should the failure consists of P0/1/2 priorities, and a FIX-phase should be
insert into the next execution process if it has UNCLOSED P0/1 issues, keeping
that REVIEW-FIX loop until MAX_REVIEW_LOOP (maybe 5?) reached or NO NEW P0/1
issues found in the review agent's output? Maybe user can configure the prompt,
since P0/1/2 standards may varies across projects."*

## Decision

After every step attempt where the agent returns successfully (no timeout, no
stdout-cap-hit), four gates run in order. **A step is `done` only if all four
pass.**

1. **Tail-message gate.** Parse the last `oa-status` fenced block from stdout
   (per ADR-0008). Missing/malformed → `step.verify.tail.fail`.
2. **Commit-since-step-start gate.** When `verify.requireCommit` is true (default),
   require ≥1 new commit in the worktree since this step started. No commit →
   `step.verify.commit.fail`.
3. **User verify command gate.** If `intake.verify.command` is set, exec it in the
   worktree's cwd. Non-zero exit → `step.verify.cmd.fail`.
4. **AI-judge review gate.** When `reviewFixLoop.enabled`, invoke the configured
   reviewer agent (its own full executor spec) with the step diff plus the
   reviewer prompt (user-supplied or default). The reviewer must emit an
   `oa-review` fenced block listing issues with `priority: P0|P1|P2`. Issues
   matching `blockOn` (default `["P0","P1"]`) cause the step to fail this gate.

**Fix loop.** When the AI-judge gate fails with blocking issues:

- If `attempt < reviewFixLoop.maxLoops` (default 5): synthesize the next attempt
  by injecting the blocking issues into the prompt as `open_review_issues`. The
  worker agent re-runs the step (after rewind, per ADR-0003). All four gates
  re-run. Loop until no blocking issues remain or the cap is reached.
- If `attempt >= maxLoops`: mark the step `blocked-needs-human`, record the
  final issue list in PROGRESS.md and events.jsonl, and apply `onFailure` policy.

**Configurability.**
- `reviewFixLoop.maxLoops`: int (default 5).
- `reviewFixLoop.blockOn`: array of priorities (default `["P0","P1"]`).
- `reviewer.promptPath`: per-taskList override; defaults to
  `oa-core/prompts/reviewer-default.md`.
- `reviewer.{agent,model,extraArgs}`: full executor spec, defaulting from
  `config.json.defaultReviewer`.

## Consequences

- Positive: strong protection against false-success and shallow agent work;
  automated recovery for fixable issues without human-in-the-loop overnight;
  per-project priority cutoffs are configurable.
- Negative: each fix iteration is an extra worker run plus an extra reviewer run;
  cost can grow up to `maxLoops` attempts. The `stepTimeoutSec` budget bounds
  total time; the deferred token-spend cap will eventually bound cost.
- Neutral: P2 issues are recorded as advisories in PROGRESS.md and SUMMARY.md
  but never block.

## Alternatives Considered

- **Two gates only (tail + verify cmd).** Rejected by user feedback — wanted
  AI-judge with priority-based escalation.
- **Single retry without priority logic.** Rejected — doesn't match the
  P0/P1/P2 model the user explicitly asked for.
- **Block on all priorities including P2.** Rejected — would explode loop
  iterations on style nits.

## Notes

Reviewer invocation reuses the `AgentAdapter` interface (ADR-0009) — no special
codepath. The supervisor just calls `adapter.run` with the reviewer's executor
spec and a prompt containing the step diff plus the reviewer prompt plus the
`oa-review` protocol block.
