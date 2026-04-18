# ADR-0003 — Clean rewind to HEAD before re-running an interrupted step

**Status:** Accepted
**Date:** 2026-04-18
**Related:** design § 4.5, § 4.6; ADR-0002 (worktree)

## Context

When an in-flight step is interrupted (laptop sleep, ctrl+c, crash, `oa stop --now`),
the worktree may contain partial uncommitted work from the failed attempt. Three
options for the next attempt: (a) ask the agent to continue from the half-done
state, (b) try to resume the agent's own session, (c) wipe the worktree to the
last commit and start the step fresh.

User stated explicitly: *"I really want a clean state before re-run."*

## Decision

Before re-invoking the agent for any non-`done` step, the supervisor calls
`worktreeManager.rewindToHead(absRoot)` which executes:

```
git reset --hard HEAD
git clean -fdx
```

inside the worktree. This is **safe by construction** because the worktree is
oa-owned (per ADR-0002) — the user has no work-in-progress to lose. Prior committed
steps remain intact.

The next attempt's HANDOFF context (assembled by the per-step injector, ADR-0006)
includes a flag indicating: "previous attempt aborted, working tree wiped to last
commit, prior committed steps intact."

## Consequences

- Positive: deterministic per-step starting state; eliminates "is this stale work
  mine?" reasoning failures by the agent; resume is symmetric with first-attempt.
- Negative: throws away whatever progress an interrupted attempt made before its
  last commit. Acceptable because per-step commits make most progress durable.
- Neutral: the rewind is recorded in `events.jsonl` as part of the
  `run.resume { rewoundSteps: [...] }` event for auditability.

## Alternatives Considered

- **Tell the agent it's a retry without rewinding.** Rejected: fragile reasoning,
  half-done state confuses the agent, hard to verify.
- **Resume the agent's own session via `--resume`.** Rejected for v0: per-agent
  code paths, weird state if the recorded session log no longer matches the
  worktree (e.g., another step has committed since).
- **Per-attempt branch / cherry-pick reattach.** Rejected: complex, not worth the
  cost when worktrees are cheap to reset.

## Notes

If the user later wants to preserve interrupted work for inspection, the `events.jsonl`
events identify which step+attempt was killed and `git reflog` retains the dropped
state for the standard reflog window.
