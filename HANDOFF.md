# OvernightAgent — Session Handoff

**Prior checkpoint commit:** `4160ee8` (Task 7.7 — supervisor responds to control socket)
**Branch:** `dev` (cut from `master`; design docs are on `master`)
**Latest completed task:** 7.7 — wire control socket into supervisor
**Verification:** `pnpm -r build` + `pnpm -r test` green — 396 passing across 5 packages (oa-core 385 + oa-adapter-claude 6 + oa-cli 3 + 2 adapter smoke tests)

---

## What this is

OvernightAgent (`oa`) is a Node/TypeScript CLI that lets coding agents (claude / codex / opencode) work unattended overnight on a queue of task plans. Design + 13 ADRs are at `docs/plans/2026-04-18-overnight-agent-taskmanager-design.md` and `docs/adr/`. Implementation plan is at `docs/plans/2026-04-18-overnight-agent-taskmanager-implementation.md`.

Implementation is being executed via the `superpowers:subagent-driven-development` workflow: per-task implementer subagent → spec compliance review → code quality review → fix-up loop → next task.

---

## Where we are

**37 of 64 sub-tasks complete (~58%).** Phases 0–6 are fully done; Phase 7 is at 7/8.

| Phase | Subject | Status |
|---|---|---|
| 0 | Repo & tooling scaffold | ✅ 4/4 |
| 1 | oa-core foundations (paths, atomic JSON, home, lock, schemas, ids) | ✅ 6/6 |
| 2 | Worktree manager | ✅ 5/5 |
| 3 | Inbox / queue / plan stores | ✅ 3/3 |
| 4 | Intake parser, materializer, references, intakeSubmit | ✅ 4/4 |
| 5 | AgentAdapter interface + claude adapter + registry | ✅ 4/4 |
| 6 | Context injector, verify pipeline, fix loop | ✅ 7/7 |
| **7** | **Supervisor, daemon, control socket, resume** | **7/8** (events writer, bootstrap, runPlan, daemonization, pidfile lifecycle, control socket, supervisor socket wiring done) |
| 8 | oa-cli surface | pending |
| 9 | SUMMARY.md renderer | pending |
| 10 | codex + opencode adapters | pending |
| 11 | Per-host shims | pending |
| 12 | End-to-end + docs | pending |

See `PROGRESS.md` for per-task detail and `FINDINGS.md` for lessons + carry-forwards.

---

## Next 3 tasks (Phase 7 close-out + Phase 8 kickoff)

Specs live in `docs/plans/2026-04-18-overnight-agent-taskmanager-implementation.md` § Phase 7. Critical carry-forwards from earlier reviews are captured on each task's description in the task tracker (use `TaskList` to see them on resume).

Recent Phase 7 landings:
- `packages/oa-core/src/supervisor/daemon.ts` — detached launcher with entry-path preflight, separate append-mode stdio fds, `child.unref()`, and explicit launcher-exit seam
- `packages/oa-core/src/supervisor/pidfile.ts` — `proper-lockfile`-guarded `acquire/release/isStale` helper; stale cleanup and atomic rewrite happen inside the critical section
- `packages/oa-core/src/supervisor/entry.ts` — child entry now routes through the helper, emits JSONL-safe `run.error`/`daemon.signal` output, only releases after ownership is established, forwards test adapter injection into `runPlan`, and removes process signal handlers on normal exit
- `packages/oa-core/src/supervisor/controlSocket.ts` — length-prefixed JSON request/reply over AF_UNIX with `schemaVersion: 1`, safe stale-socket cleanup, and explicit rejection of live-socket path takeover
- `packages/oa-core/src/supervisor/runPlan.ts` — opens the control socket on startup, serves live `status`, maps graceful/force stop to the active adapter spawn, treats user aborts as resumable `pending`, and resolves worker/reviewer adapters from the registry by default
- `packages/oa-core/src/adapter/spawn.ts` — live-control handoff now happens after abort-listener wiring, and a throwing `onSpawned` callback tears the child down before rethrowing
- `packages/oa-core/test/supervisor/daemon.integration.test.ts` — real-entry integration coverage for missing-entry fast-fail, launcher exit, pidfile creation, liveness, signal handling, JSON event emission, and cleanup
- `packages/oa-core/test/supervisor/{pidfile,entry,controlSocket}.test.ts` — pidfile contention, startup-signal ordering, and real socket round-trip/regression coverage
- `packages/oa-core/test/supervisor/{runPlan,entry}.integration.test.ts` — live status/stop coverage for worker and reviewer phases, pending-step resume semantics, and regression coverage that supervisor-entry signal handlers do not leak across in-process runs

1. **Task 7.8 — Resume protocol** (per ADR-0003). Detect stale pidfile + plan status `running` with no live daemon. For each task whose state is `running` (or any of its steps is `running`), call `worktree.rewindToHead`. Mark in-flight steps back to `pending`. Emit `run.resume {rewoundSteps}`. Re-enter the outer loop at the first non-`done` task.
2. **Phase 8 kickoff — CLI surface.** Once Phase 7 closes, land `oa run/status/stop/tail` first so the new daemon control path is operator-visible before the rest of the CLI fills in.
3. **Phase 8 follow-on — operator commands.** After the control-path commands, fill in `oa intake/queue/plan/rerun/archive` so the daemon lifecycle has a usable end-to-end operator surface.

After Phase 7 closes, Phase 8 (CLI surface — 10 sub-tasks for `oa intake/queue/plan/run/status/stop/tail/rerun/archive`) is next.

---

## How to resume

```sh
cd /Users/souler/Nextcloud/test/OvernightAgent
git status                           # should be clean on `dev`
git log --oneline -5                 # confirm tip includes the Task 7.7 landing + fix-up
pnpm install                         # idempotent
pnpm -r build && pnpm -r test        # all 5 packages, 396 tests, all green
```

Then continue the workflow:
1. Re-enter the `superpowers:subagent-driven-development` skill (or just dispatch implementer subagents directly with the per-task spec).
2. Next task is **Task 7.8 (Resume protocol)**.
3. The Phase 7 task description (in the task tracker) still carries 10 carry-forwards from prior reviews — re-read those before dispatching to keep the resume contract intact.

---

## Key files to know

**Source (oa-core):**
- `packages/oa-core/src/paths.ts` — assertAbs + path helpers (every absolute-path API in the codebase asserts via this)
- `packages/oa-core/src/atomicJson.ts` — `readJson`, `writeJsonAtomic`, `writeFileAtomic` (all temp+rename for crash safety)
- `packages/oa-core/src/locks.ts` — `withInboxLock` (proper-lockfile, cross-process, NOT reentrant — see Phase 7 carry-forward)
- `packages/oa-core/src/home.ts` — `ensureHomeLayout`, `DEFAULT_CONFIG`
- `packages/oa-core/src/schemas.ts` — Every on-disk JSON shape + EventSchema discriminated union (28 event kinds)
- `packages/oa-core/src/ids.ts` — `newTaskId`/`newPlanId`, `assertId`
- `packages/oa-core/src/slug.ts` — branch-safe name fragment slugifier
- `packages/oa-core/src/worktree.ts` — `worktree.create/rewindToHead/remove/commitsSince` (matches ESLint `**/worktree*.ts` + `**/paths*.ts` override that bans bare `path.join`)
- `packages/oa-core/src/stores/{inbox,queue,plan}.ts` — read-modify-write JSON stores under `withInboxLock`
- `packages/oa-core/src/intake/{parseSteps,references,handoff,submit}.ts` — intake pipeline
- `packages/oa-core/src/adapter/{types,spawn,registry}.ts` — AgentAdapter contract + headless spawn + dynamic loader
- `packages/oa-core/src/verify/{tail,gates,review,context,fixLoop}.ts` — verify pipeline
- `packages/oa-core/src/state/{progress,findings}.ts` — per-task state mutators
- `packages/oa-core/src/events/writer.ts` — events.jsonl writer (chained-promise FIFO for in-process ordering)
- `packages/oa-core/src/supervisor/{bootstrap,runPlan,daemon,pidfile,entry,controlSocket}.ts` — supervisor runtime pieces (runPlan + detached launcher/entry + pidfile lifecycle + control socket wiring done; resume next)

**Adapters:**
- `packages/oa-adapter-claude/src/index.ts` — `adapter: AgentAdapter` for claude (headless via `claude -p`)
- `packages/oa-adapter-codex/src/index.ts` — empty `export {}` (Phase 10)
- `packages/oa-adapter-opencode/src/index.ts` — empty `export {}` (Phase 10)

**CLI:**
- `packages/oa-cli/src/cli.ts` — `oa --version` stub only (Phase 8 fills in subcommands)

**Reference inner-loop:**
- `packages/oa-core/test/innerLoop.integration.test.ts` (Task 6.7) — production-shaped supervisor loop in test form. The runPlan production code follows this shape closely.

---

## Hard rules to keep honoring

These are non-negotiable conventions established and re-verified through the Task 7.7 fix-up:

1. **Absolute paths everywhere in worktree-touching code.** Every public API asserts via `assertAbs(p)` at the boundary. ESLint override on `**/worktree*.ts` + `**/paths*.ts` bans bare `path.join` (must use `path.resolve` or `path.resolve(path.join(...))`). See ADR-0002 + ADR-0013.
2. **Atomic JSON writes only.** All on-disk mutations use `writeJsonAtomic` (temp + rename). Schema-versioned, atomic visibility, last-writer-wins on concurrent writes.
3. **`schemaVersion: 1` on every on-disk JSON shape.** Validates via Zod with `.strict()` for closed shapes (most), `.passthrough()` for forward-compatible event variants (will be tightened in Phase 7+ per carry-forward).
4. **TDD per task.** Failing test → implement → passing test → commit. Every task in this codebase has the failing-then-passing evidence in the implementer's report. Reviewers run sabotage checks (e.g., temporarily breaking the production code to confirm the test catches it) on load-bearing assertions.
5. **Single commit per task.** Conventional-commits message format. Commit message body explains *why* the task exists; doc-comments explain *what* and *how*.
6. **Per-step subagent dispatch.** Per the subagent-driven-development workflow: implementer subagent → spec reviewer → code quality reviewer → fix-up loop → next task. No batching; each task gets a fresh implementer.
7. **Reviewers find real bugs.** ~30% of tasks needed a fix-up commit after review. Common categories: silent passthrough on discriminated unions, NaN-on-parse vulnerabilities, lock non-reentrancy footguns, missing JSDoc contracts, schema drift from convention. The discipline pays off.

---

## Git tip + branch state

- `dev` is ahead of `master` by 61 commits once the Task 7.7 fix-up commit lands. `master` has 2 commits (the design + ADR docs).
- No remote configured. All work is local.
- Working tree should be clean after the Task 7.7 fix-up commit lands.
- Latest checkpoint commit message:

```
fix(core): clean up supervisor entry signal handlers
```

---

## Memory entries used during this session

The user's `~/.claude/projects/-Users-souler-Nextcloud-test-OvernightAgent/memory/` directory holds two pinned memories that informed major decisions:

- `feedback_worktree_absolute_paths.md` — The reason worktree code asserts absolute paths everywhere.
- `feedback_record_adrs.md` — The reason ADRs are first-class deliverables alongside the design doc.

These remain accurate and relevant.
