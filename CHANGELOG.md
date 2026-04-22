# Changelog

All notable changes to the OvernightAgent monorepo are recorded here. We follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and SemVer across all `@soulerou/*` packages.

## [0.4.1] — 2026-04-22

### Added

- **`step.verify.tail.fail` carries diagnostic stdout snippet** — new optional `outputBytes` (total bytes the child wrote) and `outputTail` (last ~1 KiB, utf8) fields let post-mortems see whether the agent emitted a malformed block, forgot it entirely, or was cut off mid-output without having to open `stdout.log`. Emitted from both sites: killed-worker tail-fail (timeout / stdout-cap / signal) and verify-tail-gate miss. Fields are optional and additive — existing event consumers are unaffected.

## [0.4.0] — 2026-04-22

### Added

- **Live heartbeat observability** — adapters emit `AgentHeartbeat` as they parse the child's output stream; supervisor forwards each to `events.jsonl` as `step.heartbeat`. Claude stream-json classifies `session.init` / `api.retry` / `tool.use` / `assistant.delta` (debounced 45 s, first emit immediate) / `ratelimited`; codex text output classifies `assistant.delta` + `ratelimited`. A supervisor-side 60 s dead-air watchdog emits a synthetic heartbeat when no adapter signal has fired, so "wedged child" is distinguishable from "slow child" in post-mortem reading. Opt-in per call-site via `AgentRunOpts.onHeartbeat`.
- **Defer-to-FINDINGS on fix-loop exhaustion** — when the review-fix loop runs out of attempts with blocking issues still open, remaining findings are appended to the task's `FINDINGS.md` (along with a `step.findings.deferred` event) instead of hard-blocking the task. The next step's prompt reads "Findings so far" and can address the deferred items.
- **`intake.verify.requireCommit`** — plan-level toggle for the commit-since-step-start gate. Validation-only steps (e.g. "verify existing infra meets spec X") now correctly produce no diff without wedging forever.
- **`SpawnOpts.onStdoutLine` / `onStderrLine`** — generic per-line taps on `spawnHeadless` so adapters can observe child output in real time. Raw bytes still go to capture files unchanged; handler exceptions are isolated so a parser bug can't crash the spawn.
- **Event stream extended** from 34 to 36 typed kinds (`step.heartbeat`, `step.findings.deferred`).

### Changed

- `spawnHeadless` sets `stdin: 'ignore'` on every child — fixes a hang where `codex exec` would opportunistically read piped stdin and block on EOF, timing out every reviewer call.
- Codex adapter uses a positional prompt argument (was: `--prompt-file`, which codex exec does not accept). Default model bumped to `gpt-5.4`.
- Claude adapter's rate-limit detector matches `type=result` with `is_error=true api_error_status=429` in addition to the prior subtype patterns (Claude CLI v2.x emits rate-limit exits with `subtype:"success"`).
- `oa status` / `oa tail` select the latest plan by `createdAt` instead of readdir order — plan IDs carry a random suffix so alphabetic order is not chronological.
- `oa tail` pretty view filters `step.heartbeat` events to keep the interactive stream readable; `--raw` passes everything through verbatim for analysis with jq.

### Fixed

- Review-fix-loop exhaustion no longer wedges the task with `blocked-needs-human`; deferred findings are captured explicitly and the task can continue (see "Defer-to-FINDINGS" above).

## [0.3.0] — 2026-04-21

### Added

- **Rate-limit backoff** (ADR-0017) — adapter-level detection + supervisor-side retry wrapper. Claude's stream-json `rate_limit_error` / `overloaded_error` events and codex/opencode stderr `429` / quota / overloaded phrases trigger `step.ratelimit.wait` / `.retry` / `.give_up` events. Supervisor sleeps on any provider-supplied `retry-after` hint (or the configured default) and re-invokes the same prompt without advancing the verify attempt counter.
- **Plan override `rateLimitBackoff: { defaultWaitMs, maxRetries, maxWaitMs? }`** — tune the default 60 s / 3 retries per run.

### Fixed

- `parseTail` now unwraps claude stream-json transcripts before the `oa-status` / `oa-review` fence regex runs, so the tail gate sees real user-visible output instead of JSON-escaped newlines.

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
