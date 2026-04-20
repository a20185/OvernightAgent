# OvernightAgent — Session Handoff

**Final checkpoint commit:** v0.2.0 hardening (ADR-0015 + ADR-0016)
**Post-v0.1 release prep:** scope rename + cycle break + bundled shims (ADR-0014).
**Branch:** `main`
**Status:** All 64 sub-tasks across Phases 0–12 plus v0.2 hardening features complete. v0.2.0 ready for npm publish.
**Verification:** `pnpm -r typecheck && pnpm -r lint && pnpm -r build && pnpm -r test` all green — 488 tests across 5 packages.

---

## What this is

OvernightAgent (`oa`) is a Node/TypeScript CLI that lets coding agents
(claude / codex / opencode) work unattended overnight on a queue of task
plans. Every task runs in an isolated git worktree with a four-gate verify
pipeline, review-fix loop, structured event logs, clean resume after
interruption, and a morning SUMMARY.md.

Design + 16 ADRs are at `docs/plans/2026-04-18-overnight-agent-taskmanager-design.md`
and `docs/adr/`. Implementation plan is at
`docs/plans/2026-04-18-overnight-agent-taskmanager-implementation.md`.
ADR-0015 covers harness hardening (compact-recovery hook, stall detection,
error budget). ADR-0016 covers macOS sandbox-exec isolation.

---

## Phase completion

| Phase | Subject | Status |
|---|---|---|
| 0 | Repo & tooling scaffold | ✅ 4/4 |
| 1 | oa-core foundations | ✅ 6/6 |
| 2 | Worktree manager | ✅ 5/5 |
| 3 | Inbox / queue / plan stores | ✅ 3/3 |
| 4 | Intake pipeline | ✅ 4/4 |
| 5 | AgentAdapter + claude adapter + registry | ✅ 4/4 |
| 6 | Context injector, verify pipeline, fix loop | ✅ 7/7 |
| 7 | Supervisor, daemon, control socket, resume | ✅ 8/8 |
| 8 | oa-cli surface (10 commands) | ✅ 10/10 |
| 9 | SUMMARY.md renderer + events reader | ✅ 3/3 |
| 10 | codex + opencode adapters | ✅ 3/3 |
| 11 | Per-host shims | ✅ 3/3 |
| 12 | End-to-end + docs | ✅ 4/4 |

---

## Key artifacts

**CLI (`@soulerou/oa-cli`):** 12 commands registered in `packages/oa-cli/src/cli.ts`:
- `intake submit|list|show|rm`
- `queue add|ls|rm|clear`
- `plan create|show|ls`
- `run [planId] [--detach] [--dry-run] [--sandbox]`
- `stop [planId] [--now]`
- `status [planId] [--json]`
- `tail [planId] [--raw] [--once]`
- `rerun <planId> [--detach]`
- `archive <id>`
- `summary <planId> [--stdout]`
- `shims install [--host claude|codex|opencode|all] [--scope project|user] [--dry-run] [--force]`

**Adapters:** All three headless adapters wired through
`@soulerou/oa-core`'s `src/adapter/registry.ts` (dynamic import of
`@soulerou/oa-adapter-<id>`):
- `@soulerou/oa-adapter-claude`: `claude -p <prompt> --model <M> --output-format stream-json`
- `@soulerou/oa-adapter-codex`: `codex exec --model <M> --prompt-file <abs>`
- `@soulerou/oa-adapter-opencode`: `opencode run --model <M> --prompt-file <abs>`

**Supervisor:** `oa-core/src/supervisor/`
- `bootstrap.ts`, `runPlan.ts`, `resume.ts`, `daemon.ts`, `entry.ts`,
  `pidfile.ts`, `controlSocket.ts`. The entry reads `OA_RESUME=1` and
  delegates to `resumePlan` instead of `runPlan`.

**Summary / events:** `oa-core/src/events/{writer.ts,reader.ts}` +
`oa-core/src/summary/render.ts`. Auto-rendered on every plan end.

**Shims:** `packages/oa-shims/{claude,codex,opencode}/{commands,skills}/` —
pure markdown resource files for each host. At `@soulerou/oa-cli` build
time, `scripts/bundle-shims.mjs` copies the tree into
`packages/oa-cli/dist/shims/<host>/`, and `oa shims install` copies from
there to host-specific target dirs at user install time. ADR-0014.

---

## v0.2 hardening features (ADR-0015 + ADR-0016)

| Feature | Location | What |
|---|---|---|
| Compact-recovery hook | `packages/oa-shims/claude/hooks/` | `SessionStart[compact]` hook re-injects task context after Claude Code auto-compaction; installed via sentinel-based merge into `.claude/settings.json` |
| Stall detection | `oa-core/src/supervisor/runPlan.ts` | Soft/hard attempt thresholds; `step.stall` event fires once per step at soft boundary; stall warning injected into prompt |
| Error budget | `oa-core/src/supervisor/runPlan.ts` | `PlanSchema.errorBudget` with `warnAfter` / `stopAfter`; emits `plan.budget.warn` + `plan.budget.exhausted` events; skips remaining tasks on exhaustion |
| Sandbox-exec | `oa-core/src/sandbox/` | Seatbelt profile template + renderer; wraps adapter argv via `spawnHeadless` on macOS; `oa run --sandbox` flag; fail-fast on non-macOS |
| Env vars | `oa-core/src/supervisor/runPlan.ts` | `OA_TASK_DIR` + `OA_CURRENT_PROMPT` set per adapter spawn for compact-recovery hook |

---

## Quick verify

```sh
cd /Users/souler/Nextcloud/test/OvernightAgent
pnpm install
pnpm -r build && pnpm -r test        # 488 tests, all green
node packages/oa-cli/dist/cli.js --help
pnpm release:dry-run                 # see what would be published
```

---

## Known v0 limits (captured from carry-forwards)

1. ~~**Workspace cycle:** `oa-core` devDeps the adapter packages for the
   registry.~~ **Resolved in ADR-0014** (2026-04-20): `registry.test.ts`
   now uses `vi.mock` for the three adapter packages, and the devDeps
   were dropped. Publish-blocking cycle is gone.
2. **Reviewer prompt race:** `<runDir>/reviewer-default-prompt.md` is
   materialized once per run; would collide if `parallel.max > 1` is
   ever actually implemented. Add per-task suffix when parallel mode
   lands.
3. **Protocol blocks inlined:** ADR-0008 promises
   `oa-core/prompts/protocol-status.md` + `protocol-review.md` but the
   blocks are currently inlined in `verify/context.ts` + `verify/review.ts`.
   ADR-0008 has been updated to acknowledge the deferral.
4. **parseSessionIdFromStreamJson:** Permissive — accepts any JSON line
   with a string `session_id`. Tighten to `subtype === 'init'` once codex
   and opencode settle on their own session reporting.
5. **extraArgs passthrough:** Adapter argv spreads `intake.executor.extraArgs`
   verbatim. Known security note (see adapter JSDocs); schema-level bounds
   are a future ADR.

---

## Memory entries

- `feedback_worktree_absolute_paths.md` — every worktree-touching code path
  asserts absolute paths, ESLint enforced. Paid off three times during
  implementation.
- `feedback_record_adrs.md` — 16 ADRs total; reviewers consistently
  cross-check ADR text against implementation.
