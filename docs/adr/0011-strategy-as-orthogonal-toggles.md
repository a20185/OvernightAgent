# ADR-0011 — Strategy as orthogonal toggles; no named presets in v0

**Status:** Accepted
**Date:** 2026-04-18
**Related:** design § 3.3 (intake.strategy), § 4.5

## Context

The user originally named several "control strategies" (commit-after-single-task,
parallel-first, review-fix-loop). These could be modeled as a single enum, as
named presets bundling toggles, or as orthogonal toggles directly. Each
"strategy" the user named is conceptually independent — you can want
commit-per-step AND review-fix-loop AND sequential at the same time.

## Decision

Each behavior is its own field on `intake.strategy` (with global defaults in
`config.json.defaults`). No named presets in v0.

- `commitMode`: `"per-step" | "per-taskList" | "none"`
- `onFailure`: `"halt" | "skip" | "markBlocked"`
- `reviewFixLoop`: `{ enabled: bool, maxLoops: int (default 5),
  blockOn: ["P0","P1"] }`
- `parallel`: `{ enabled: bool, max: int }` (intra-plan fan-out only in v0)
- `stepTimeoutSec`: int (default 1800)
- `stepStdoutCapBytes`: int (default 52428800)
- `verify.requireCommit`: bool (default true)
- `verify.requireTailMessage`: bool (default true)

The intake Step 3 Q&A walks the user through each toggle with the global default
pre-filled, so the common case is Enter-through.

## Consequences

- Positive: most expressive model; no hidden coupling between unrelated
  behaviors; toggles map cleanly to JSON; trivial to extend with new toggles
  without breaking existing intake payloads.
- Negative: more questions in the intake Q&A than a single-preset model would
  ask; mitigated by sensible defaults and Enter-through.
- Neutral: presets can be added later as sugar over toggles without breaking
  existing plans (deferred).

## Alternatives Considered

- **Single enum strategy.** Rejected: forces fake exclusivity between
  independent ideas (e.g., commit-per-step vs review-fix-loop are not mutually
  exclusive).
- **Named presets bundling toggles.** Deferred — useful sugar but adds a layer
  before the underlying model is proven in use.
- **Per-step strategy overrides.** Deferred — global per-taskList is sufficient
  for v0; introducing per-step config inflates `steps.json` complexity.

## Notes

Adding a new toggle requires (a) extending the schema with a sensible default in
`config.json`, (b) extending the intake Q&A in each shim, and (c) wiring it
through the supervisor. No core abstraction changes are needed.
