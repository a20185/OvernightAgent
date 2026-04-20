# ADR-0008 — `oa-status` and `oa-review` fenced-block tail-message protocol

**Status:** Accepted
**Date:** 2026-04-18
**Related:** design § 5.2; ADR-0004 (verify pipeline), ADR-0009 (adapter)

## Context

The verify pipeline needs a structured signal from the agent indicating completion
status (and from the reviewer, the issue list). Headless CLI invocations of
claude/codex/opencode produce free-form output and do not enforce a structured
return shape. We need a protocol the supervisor can rely on without per-agent
output parsing.

## Decision

Define two fenced-block formats. The context injector appends the matching
protocol block to every prompt instructing the agent to end its response with it.
The verify pipeline parses the **last** matching block in stdout — this tolerates
agents that print intermediate fenced examples.

**Worker agent end-of-run block:**

````
```oa-status
{"status":"done|blocked","summary":"one-line summary","notes":"optional multi-line"}
```
````

- `status: "done"` → eligible to pass the tail gate.
- `status: "blocked"` → tail gate passes but step is marked
  `blocked-needs-human` immediately, with `notes` recorded as the reason.
- Missing or malformed (no fenced block, invalid JSON, unknown status) →
  `step.verify.tail.fail`.

**Reviewer agent end-of-run block:**

````
```oa-review
{"issues":[{"priority":"P0|P1|P2","file":"...","line":123,"finding":"...","suggestion":"..."}]}
```
````

- Empty `issues` array means clean review.
- Issues with `priority` matching `reviewFixLoop.blockOn` (default `["P0","P1"]`)
  fail the review gate and feed the fix loop (per ADR-0004).
- Missing or malformed → `step.verify.review.fail`.

## Consequences

- Positive: agent-agnostic; trivial parser (regex for the last fenced block of
  a known kind); tolerant of agents that show intermediate fenced examples.
- Negative: depends on agent compliance with the prompt instruction; mitigated
  because non-compliance is caught by the tail gate and triggers a retry within
  the fix-loop budget (or a clear `blocked-needs-human` outcome).
- Neutral: the protocol blocks were originally slated to live as standalone
  files (`oa-core/prompts/protocol-status.md` and `protocol-review.md`) but
  are currently inlined as constants in `verify/context.ts` (status block)
  and `verify/review.ts` (review block). Deferred extraction — acceptable
  for v0 since the blocks are short and seldom edited. Revisit when
  localization or per-adapter customization becomes a real requirement.

## Alternatives Considered

- **Per-agent structured-output flags** (e.g., `claude --output-format
  stream-json`). Adopted opportunistically by adapters where supported via the
  `capabilities()` flag, but the fenced-block protocol remains the lowest common
  denominator and the canonical signal.
- **Sentinel filenames the agent writes** (e.g., `.oa-status.json`). Rejected:
  more state to clean up; harder to verify came from this attempt vs a prior
  one.
- **Tool-call interception.** Rejected: not portable across the three executors.

## Notes

Adapters that genuinely surface a structured stream (`supportsStructuredOutput:
true`) may pre-validate compliance and fail-fast, but they must still produce a
parseable tail block in stdout to satisfy the supervisor's verify pipeline.
