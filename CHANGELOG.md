# Changelog

All notable changes to the OvernightAgent monorepo are recorded here. We follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and SemVer across all `@soulerou/*` packages.

## [0.2.0] — 2026-04-20

### Added

- **Compact-recovery hook** (ADR-0015) — Claude Code `SessionStart[matcher=compact]` hook re-injects task context after auto-compaction. Installed via `oa shims install --host claude` using sentinel-based idempotent upsert.
- **Stall detection** (ADR-0015) — `VerifyConfig.attempts` now accepts `{ soft, hard }` thresholds. At the soft boundary, a `step.stall` event fires once per step and a stall warning is injected into the fix-loop prompt.
- **Graduated error budget** (ADR-0015) — `PlanSchema.errorBudget` adds plan-level `warnAfter` / `stopAfter` gates that emit `plan.budget.warn` / `plan.budget.exhausted` events and skip remaining tasks on exhaustion.
- **macOS sandbox-exec profile** (ADR-0016) — `oa run --sandbox` wraps each adapter spawn in a kernel-level Seatbelt sandbox. Profile rendered per-attempt with configurable `extraAllowPaths`. Non-macOS platforms fail fast.
- **Environment variables** — supervisor exports `OA_TASK_DIR` and `OA_CURRENT_PROMPT` to every adapter spawn, consumed by the compact-recovery hook and the `.oa-current-prompt.md` worktree symlink.

### Changed

- `VerifyConfig.attempts` now normalizes bare integers to `{ soft, hard }` (additive; back-compat).
- `TaskStatus` enum extended with `skipped` value for budget-abort terminal state.
- Event stream extended from 28 to 31 typed kinds (`step.stall`, `plan.budget.warn`, `plan.budget.exhausted`).
- `oa shims install` now merges Claude Code hooks into `.claude/settings.json` via sentinel-based upsert.
- SUMMARY renderer shows stall markers and budget-exhausted abort banner.

### Fixed

- Stale `.oa-current-prompt.md` symlink is cleaned up on resume/rewind.

## [0.1.0] — 2026-04-20

### Added

- Initial public release of `@soulerou/{oa-core, oa-cli, oa-adapter-claude, oa-adapter-codex, oa-adapter-opencode}`.
- See `README.md` and ADR-0001 through ADR-0014 for the feature set at v0.1.0.
