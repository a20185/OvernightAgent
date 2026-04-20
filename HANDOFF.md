# OvernightAgent — Session Handoff

**Final checkpoint commit:** `19525e7` (Phase 12 — docs + e2e + ADR alignment)
**Branch:** `dev` (cut from `master`; design docs are on `master`)
**Status:** All 64 sub-tasks across Phases 0–12 complete. v0 ships.
**Verification:** `pnpm -r typecheck && pnpm -r lint && pnpm -r build && pnpm -r test` all green — 426 tests across 5 packages.

---

## What this is

OvernightAgent (`oa`) is a Node/TypeScript CLI that lets coding agents
(claude / codex / opencode) work unattended overnight on a queue of task
plans. Every task runs in an isolated git worktree with a four-gate verify
pipeline, review-fix loop, structured event logs, clean resume after
interruption, and a morning SUMMARY.md.

Design + 13 ADRs are at `docs/plans/2026-04-18-overnight-agent-taskmanager-design.md`
and `docs/adr/`. Implementation plan is at
`docs/plans/2026-04-18-overnight-agent-taskmanager-implementation.md`.

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

**CLI (oa-cli):** 11 commands registered in `packages/oa-cli/src/cli.ts`:
- `intake submit|list|show|rm`
- `queue add|ls|rm|clear`
- `plan create|show|ls`
- `run [planId] [--detach] [--dry-run]`
- `stop [planId] [--now]`
- `status [planId] [--json]`
- `tail [planId] [--raw] [--once]`
- `rerun <planId> [--detach]`
- `archive <id>`
- `summary <planId> [--stdout]`

**Adapters:** All three headless adapters wired through
`oa-core/src/adapter/registry.ts`:
- `oa-adapter-claude`: `claude -p <prompt> --model <M> --output-format stream-json`
- `oa-adapter-codex`: `codex exec --model <M> --prompt-file <abs>`
- `oa-adapter-opencode`: `opencode run --model <M> --prompt-file <abs>`

**Supervisor:** `oa-core/src/supervisor/`
- `bootstrap.ts`, `runPlan.ts`, `resume.ts`, `daemon.ts`, `entry.ts`,
  `pidfile.ts`, `controlSocket.ts`. The entry reads `OA_RESUME=1` and
  delegates to `resumePlan` instead of `runPlan`.

**Summary / events:** `oa-core/src/events/{writer.ts,reader.ts}` +
`oa-core/src/summary/render.ts`. Auto-rendered on every plan end.

**Shims:** `packages/oa-shims/{claude,codex,opencode}/commands/` — pure
markdown resource files for each host's slash-command installer.

---

## Quick verify

```sh
cd /Users/souler/Nextcloud/test/OvernightAgent
pnpm install
pnpm -r build && pnpm -r test        # 426 tests, all green
node packages/oa-cli/dist/cli.js --help
```

---

## Known v0 limits (captured from carry-forwards)

1. **Workspace cycle:** `oa-core` devDeps the adapter packages for the
   registry. `pnpm` resolves via symlinks; blocks `npm publish`. Fix is
   deferred to post-v0: replace the devDeps + real import with `vi.mock`
   in `registry.test.ts` and a stub-only load path.
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
- `feedback_record_adrs.md` — 13 ADRs total; reviewers consistently
  cross-check ADR text against implementation.
