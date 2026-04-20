# ADR-0015 — Harness hardening: compact-recovery hook, stall detection, graduated error budget

**Status:** Accepted
**Date:** 2026-04-20
**Deciders:** OvernightAgent maintainers
**Related:** ADR-0006 (context injection), ADR-0008 (tail-message protocol), ADR-0011 (strategy toggles)

## Context

Three reliability gaps surfaced after exercising the supervisor against real coding sessions:

1. **Silent compaction losing fix-loop context mid-step.** Claude Code auto-compacts long sessions when the context window fills. Compaction discards prior messages — including the injected tail-protocol instruction block (ADR-0008) and any fix-loop findings (ADR-0006) — without notifying the supervisor. The agent then continues with no memory of the verification protocol or the reviewer issues it was supposed to address, producing output that fails the tail gate or ignores findings. The supervisor has no mechanism to recover; it simply sees a verify failure and burns another attempt in the fix loop.

2. **Attempt budget gives no warning before exhaustion.** `VerifyConfig.attempts` is a bare integer. When the agent is struggling, the supervisor silently counts down from N to 0 and terminates the step as `blocked` with no intermediate signal. Operators watching `oa tail` or `SUMMARY.md` see no early indication that a step is about to exhaust its budget, losing the chance to intervene (e.g., widen the spec, increase attempts, or skip manually).

3. **Plan-wide circuit-breaker missing.** A plan with many tasks can accumulate blocked steps across the entire run with no aggregate cap. A systematic misconfiguration (e.g., a broken bootstrap script) blocks every task, and the supervisor dutifully runs through all of them — wasting compute and time. There is no plan-level threshold at which the supervisor says "enough" and stops scheduling remaining tasks.

## Decision

Adopt all three mechanisms as a coordinated set. They are independent but share the theme of preventing silent degradation.

### 1. Compact-recovery via Claude Code `SessionStart[matcher=compact]` hook

Ship a compact-recovery hook in `@soulerou/oa-cli`'s bundled shims at `dist/shims/claude/hooks/compact-recovery.json`. Installed by `oa shims install` using a sentinel-string merge strategy:

- Read `.claude/settings.json`, scan the `hooks` array for an entry tagged with the sentinel comment `# oa:hook=compact-recovery:v1`.
- If found, leave it unchanged. If not, append the new hook entry and write the file atomically (temp + rename).

The hook fires on Claude Code's `SessionStart` lifecycle event with `matcher=compact` — meaning it triggers only after an automatic compaction, not on fresh sessions. Its behavior:

- Reads `$OA_TASK_DIR/PROGRESS.md` to recover the current step's progress state.
- Points the agent at `$OA_CURRENT_PROMPT` so it re-reads the full prompt (including the tail-protocol block and any fix-loop findings from ADR-0006).
- Both `OA_TASK_DIR` and `OA_CURRENT_PROMPT` are environment variables set by the supervisor before every adapter spawn.
- When `OA_TASK_DIR` is unset (agent invoked outside OvernightAgent), the hook exits 0 immediately — a no-op.

This mechanism is Claude Code only. Codex and OpenCode use single-shot exec with no mid-session compaction, so they cannot lose context mid-step. If future codex/opencode session APIs support compaction or equivalent, the hook model can extend to them at that point.

### 2. Stall detection — soft/hard attempt thresholds

Extend `VerifyConfig.attempts` to accept either a bare number (backward-compatible) or an explicit `{ soft, hard }` object:

```ts
z.union([
  z.number().int().positive(),
  z.object({ soft: z.number().int().positive(), hard: z.number().int().positive() })
])
```

Intake-time normalization converts bare numbers:

- `N >= 2` → `{ soft: Math.max(1, Math.ceil(N * 0.6)), hard: N }`
- `N < 2` → `{ soft: N, hard: N }`

Two behaviors fire at the soft threshold:

1. **Stall-warning in context injection.** `synthesizeFixContext` (ADR-0006) appends a P0-styled block to the prompt once the current attempt index is >= soft. The block informs the agent that it is approaching the attempt ceiling and should prioritize the highest-probability fix or escalate with a `blocked` status if stuck.

2. **`step.stall` event.** A new event kind fires at most once per step (in-memory boolean guard keyed on step ID) the first time the supervisor observes an attempt >= soft. This gives `oa tail` and downstream consumers a structured signal without spamming the event stream on every subsequent attempt.

The hard threshold retains its existing semantics: attempts beyond hard are refused and the step is marked `blocked`.

### 3. Graduated error budget

Add an optional `errorBudget` field to `PlanSchema`:

```ts
errorBudget: z.object({
  warnAfter: z.number().int().positive().optional(),
  stopAfter: z.number().int().positive().optional()
}).optional()
```

Both fields default to `undefined` (no budget enforcement), so existing plans are unaffected.

**Counting semantics:**

- The budget counter increments only on `step.end` events where `status: 'blocked'`. A `task.end` with `status: 'failed'` does not tick the counter — task-level failure is already captured by `onFailure` policy (ADR-0011).
- At plan start, the supervisor re-reads `events.jsonl` for the run and counts historical blocked steps to derive the starting counter. This makes the budget durable across `oa rerun` (a rerun picks up the existing event stream and resumes from the correct count).
- After the initial scan, the counter is incremented in-memory as new `step.end(blocked)` events are appended.

**Budget events:**

- `plan.budget.warn` fires once when the counter first reaches `warnAfter` (no-op if `warnAfter` is unset).
- `plan.budget.exhausted` fires once when the counter first reaches `stopAfter`.

**Exhaustion behavior:**

When the budget is exhausted, the supervisor stops scheduling remaining tasks. All tasks still in `pending` status receive a terminal transition to `skipped` (a new `TaskStatus` value). `SUMMARY.md` renders an abort banner indicating the budget was exhausted and listing the skipped tasks.

**Rerun footgun (documented):** If a user invokes `oa rerun` on a plan that previously exhausted its budget, the budget counter is recalculated from `events.jsonl` and the plan immediately re-exhausts. To actually retry, the user must either increase `stopAfter` in the intake or create a new plan. This behavior is documented in the CLI help text for `oa rerun`.

## Consequences

**Positive.**

- Compact-recovery eliminates a silent data-loss failure mode for the most common host agent (Claude Code), recovering protocol context and fix-loop findings without manual intervention.
- Stall detection gives operators an early warning signal and gives the agent itself a chance to self-correct before exhausting its attempt budget.
- Error budget provides a plan-wide circuit-breaker, preventing systematic failures from wasting compute across dozens of tasks.
- All three features are backward-compatible: existing plans without the new fields behave exactly as before.

**Negative.**

- Schema surface grows (`VerifyConfig.attempts` becomes a union type, `PlanSchema` gains `errorBudget`, `TaskStatus` gains `skipped`). Each addition is optional or backward-compatible, but the overall surface area increases.
- The sentinel-string merge in `oa shims install` is more complex than a simple file copy — it reads, parses, searches, conditionally appends, and atomically writes. Mis-formatted `settings.json` could cause a merge failure (mitigated: install errors are caught and reported, not silent).
- The rerun-same-budget footgun requires documentation and user awareness.

**Follow-ups.**

- Linux Landlock-based sandbox for adapter subprocesses (separate ADR when implemented).
- On-by-default sandbox mode for all host agents.
- Hook support for codex/opencode if and when they gain session APIs with compaction or equivalent mid-session context loss.
- Per-task error budget overrides (deferred — plan-level is sufficient for initial release).
