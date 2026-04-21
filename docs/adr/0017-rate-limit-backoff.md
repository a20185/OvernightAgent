# ADR-0017 — Rate-limit detection and backoff around adapter runs

**Status:** Accepted
**Date:** 2026-04-21
**Deciders:** OvernightAgent maintainers
**Related:** ADR-0009 (agent adapter interface), ADR-0004 (verification pipeline and fix-loop), ADR-0015 (harness hardening — attempts soft/hard, error budget)

## Context

LLM coding CLIs — `claude`, `codex`, `opencode` — all talk to backing APIs that enforce per-minute quotas (RPM, TPM, concurrent-request caps). Under unattended overnight use the supervisor drives a long sequence of spawns back-to-back, and a single rate-limited attempt produces a verify failure that the fix-loop responds to by spawning *another* attempt immediately. Each additional attempt bills against the same quota window, so a short API blip cascades into a run of blocked tasks — exactly what happened in p_2026-04-21_4rs6, where a parser bug was the actual cause but the failure shape was identical to what rate-limited attempts look like.

Today the supervisor has no rate-limit signal. `AgentRunResult` carries `exitCode`, `durationMs`, `timedOut`, `stdoutCapHit`, `killedBy`, `sessionId` (`packages/oa-core/src/adapter/types.ts:59-66`). A 429/overloaded error surfaces either as:

- a non-zero exit code (treated as an adapter failure; fix-loop re-spawns with reviewer context injected), or
- a zero exit code with an API-error event inside the stdout stream (treated as success by `spawnHeadless`; verify gates run on empty or malformed output and fail with a misleading `no oa-status block` / schema reason).

Both paths bypass the right response — *wait for the quota window to reset, then retry without mutating the prompt*.

ADR-0015 already introduced `attempts: { soft, hard }` for verify retries and plan-level `errorBudget` for stall/failure tolerance. Rate-limit backoff is adjacent but not the same: it handles *transport* failures, not *verify* failures. Conflating them would let a 60-second API blip exhaust the verify attempt budget and push otherwise-fine tasks into `blocked-needs-human`.

## Decision

### New optional fields on `AgentRunResult`

Extend the adapter contract without a breaking change:

```ts
export interface AgentRunResult {
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  stdoutCapHit: boolean;
  killedBy: 'timeout' | 'stdoutCap' | 'signal' | null;
  sessionId?: string;
  // ADR-0017 additions
  rateLimited?: boolean;
  retryAfterMs?: number;
}
```

`rateLimited === true` signals the adapter detected a rate-limit signature in the run. `retryAfterMs` carries a provider-supplied hint (e.g. the `retry-after` header in a claude API-error event) when one is available; absent, the supervisor falls back to the configured default wait. Both fields are optional — existing adapters that don't implement detection remain valid.

### Per-adapter detection

Detection lives in each adapter because the signal surface differs:

- **claude** (`oa-adapter-claude`): stream-json carries `{"type":"result","subtype":"error_*"}` terminal events and embedded API error objects of shape `{"type":"error","error":{"type":"rate_limit_error"|"overloaded_error",...}}`. The adapter walks the captured stdout after `spawnHeadless` returns (same post-spawn scan that already parses `session_id`), sets `rateLimited: true` on the first match, and extracts `retryAfterMs` from an accompanying `retry_after_seconds` or `retry-after` field if present.
- **codex** (`oa-adapter-codex`) and **opencode** (`oa-adapter-opencode`): no structured output — the adapter reads the captured stderr and matches `/rate.?limit|quota exceeded|429|too many requests|overloaded|try again (in|later)/i`. If matched, `rateLimited: true`; `retryAfterMs` is parsed only if a numeric hint appears in the matched line (e.g. `retry after 45s`). Otherwise left undefined.

Detection is intentionally permissive: false positives cost one extra wait; false negatives put us back where we are today. The regex is kept in one place per adapter so it can be tightened as each CLI's error-message surface stabilizes.

### Supervisor wrapper: retry before verify

The supervisor wraps `adapter.run(opts)` at the step-attempt call site. On `rateLimited: true`:

1. Emit `step.ratelimit.wait` with `waitMs`, `attempt` (the ratelimit retry count, separate from the verify attempt counter), and `source` (which signal fired).
2. Sleep `retryAfterMs ?? config.rateLimitBackoff.defaultWaitMs`. Wait is `await new Promise(r => setTimeout(r, ms))` with the supervisor's abort signal wired so `oa stop` interrupts cleanly.
3. Emit `step.ratelimit.retry` and re-invoke `adapter.run(opts)` with the **same prompt**. No fix-loop context injection, no attempt-counter bump.
4. Repeat up to `config.rateLimitBackoff.maxRetries` times.
5. On exhaustion, emit `step.ratelimit.give_up` and fall through to the current verify failure path — the step fails, the supervisor decides blocked vs. fix-loop per existing rules.

### Verify attempt counter is untouched

A rate-limited run is not a verify attempt. It never reached the verify pipeline. Ratelimit retries don't increment `attempt` in the step's attempt directory (`step-NN/attempt-NN/`), don't emit `step.attempt.start/end`, and don't count against `verify.attempts.soft/hard`. Only the first successful adapter run (rate-limit-clear) opens an attempt directory.

This preserves ADR-0015 semantics: stall detection fires when the *verify gate* can't be satisfied; the error budget counts *tasks that couldn't make progress*. Neither should trip because of an API quota window.

### Plan schema: `rateLimitBackoff`

Add an optional override at the plan level, parallel to the existing budget knobs:

```ts
const RateLimitBackoffSchema = z.object({
  defaultWaitMs: z.number().int().positive(),   // fallback when adapter has no retry-after hint
  maxRetries: z.number().int().nonnegative(),   // 0 = detect but never retry
  maxWaitMs: z.number().int().positive().optional(), // cap on adapter-supplied retry-after hints
}).strict();
```

Added to `PlanOverridesSchema` as `rateLimitBackoff: RateLimitBackoffSchema.optional()`. Default (when unset): `{ defaultWaitMs: 60_000, maxRetries: 3 }` — one minute is a sensible RPM-window fit; three retries tolerates a brief API incident without blocking the run indefinitely.

`maxWaitMs` caps a misbehaving adapter that reports a 10-minute retry-after: useful to prevent a single step from silently eating the overnight budget.

### Three new events

All follow the existing `step.*` shape and live in `packages/oa-core/src/schemas.ts` EventSchema:

```ts
step.ratelimit.wait    { taskId, stepN, attempt, waitMs, source, retryAfterMs? }
step.ratelimit.retry   { taskId, stepN, attempt }
step.ratelimit.give_up { taskId, stepN, attempt, reason }
```

`attempt` here is the **ratelimit retry count** (1, 2, 3…), not the verify attempt. The two counters are independent. The SUMMARY renderer reads these events and displays a per-step ratelimit-wait total alongside the existing duration.

### Interaction with existing timeouts

`opts.timeoutSec` in `AgentRunOpts` is the per-invocation wall-clock cap. A rate-limit wait happens **outside** the adapter invocation, so it doesn't burn the per-step timeout. Plan-level `planBudgetSec` (wall-clock for the whole run) **does** count ratelimit waits — intentional, so a chronically rate-limited run still exits before breakfast.

### Non-detection adapters remain valid

An adapter that doesn't set `rateLimited` is treated as "no rate-limit signal available" — the supervisor skips the backoff wrapper and takes the current path. The contract is additive; the three shipped adapters gain detection in the same PR as the supervisor wrapper, but third-party adapters are not forced to migrate.

## Consequences

**Positive.**

- Short API incidents no longer cascade into `blocked-needs-human` tasks. The overnight run rides out a 1–3 minute quota window and completes.
- Detection and handling are decoupled: adapter owns the signal, supervisor owns the policy. Swapping in a smarter policy (e.g. exponential backoff, token-bucket) later is a supervisor-side change, not an adapter migration.
- Verify attempt accounting stays clean. Stall detection and error budget continue to reflect *progress failures*, not *transport failures*.
- Event stream gains explicit ratelimit visibility. `oa status` and SUMMARY.md can distinguish a run that slept 6 minutes across three waits from a run that genuinely ran for 6 minutes of work — a distinction the current event set can't express.
- Cap (`maxWaitMs`) protects against adapter-supplied retry-after values that are unreasonably large.

**Negative.**

- Two attempt counters (verify vs. ratelimit) is conceptually more to track. Mitigated by keeping them in separate event kinds and never mixing them in a single field.
- Reactive only. A plan that reliably hits its RPM cap every 4 seconds will still burn 1 minute per spawn. A proactive token-bucket pacer (see Follow-ups) would handle this better.
- The codex/opencode stderr regex is heuristic. A false positive forces a 60-second wait before a real failure is surfaced; a false negative leaves the current behavior. Neither is worse than today.
- New plan field (`rateLimitBackoff`) grows the config surface. Default values mean most users never touch it, but it is another knob to document.

**Follow-ups.**

- **Proactive token-bucket pacer**: once parallel task execution lands (known v0 constraint in CLAUDE.md), add a supervisor-side bucket (`rpm`, optional `tpm` estimate) that paces `spawnHeadless` calls before they fire. Separate ADR when implemented.
- **Tighten adapter signals**: as claude/codex/opencode stabilize their error surfaces, replace stderr regex with structured detection. The detection helper is isolated per adapter, so this is a local change per package.
- **Persist ratelimit metadata on the run**: if a run repeatedly waits, consider writing a `run.ratelimit.summary` field to SUMMARY.md so the user sees total time lost to quotas at a glance. Deferred until the event-stream data shows it's worth the index work.
- **Per-adapter default overrides**: claude's retry-after hints are richer than codex/opencode's; the defaults could be split per adapter. Deferred — a single default keeps the config simpler and the three-retry cap bounds the cost of a coarser default.
