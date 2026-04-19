# OvernightAgent — Session Handoff

**Last commit:** `200829b` (Task 7.3 fix-up — supervisor outer loop hardened)
**Branch:** `dev` (cut from `master`; design docs are on `master`)
**Total commits on `dev`:** 56 (2 design + 54 implementation)
**Tests:** 372 passing across 5 packages (oa-core 361 + oa-adapter-claude 6 + oa-cli 3 + 2 adapter smoke tests)

---

## What this is

OvernightAgent (`oa`) is a Node/TypeScript CLI that lets coding agents (claude / codex / opencode) work unattended overnight on a queue of task plans. Design + 12 ADRs are at `docs/plans/2026-04-18-overnight-agent-taskmanager-design.md` and `docs/adr/`. Implementation plan is at `docs/plans/2026-04-18-overnight-agent-taskmanager-implementation.md`.

Implementation is being executed via the `superpowers:subagent-driven-development` workflow: per-task implementer subagent → spec compliance review → code quality review → fix-up loop → next task.

---

## Where we are

**33 of 64 sub-tasks complete (~52%).** Phases 0–6 are fully done; Phase 7 is at 3/8.

| Phase | Subject | Status |
|---|---|---|
| 0 | Repo & tooling scaffold | ✅ 4/4 |
| 1 | oa-core foundations (paths, atomic JSON, home, lock, schemas, ids) | ✅ 6/6 |
| 2 | Worktree manager | ✅ 5/5 |
| 3 | Inbox / queue / plan stores | ✅ 3/3 |
| 4 | Intake parser, materializer, references, intakeSubmit | ✅ 4/4 |
| 5 | AgentAdapter interface + claude adapter + registry | ✅ 4/4 |
| 6 | Context injector, verify pipeline, fix loop | ✅ 7/7 |
| **7** | **Supervisor, daemon, control socket, resume** | **3/8** (events writer, bootstrap, runPlan done) |
| 8 | oa-cli surface | pending |
| 9 | SUMMARY.md renderer | pending |
| 10 | codex + opencode adapters | pending |
| 11 | Per-host shims | pending |
| 12 | End-to-end + docs | pending |

See `PROGRESS.md` for per-task detail and `FINDINGS.md` for lessons + carry-forwards.

---

## Next 5 tasks (Phase 7 remainder)

Specs live in `docs/plans/2026-04-18-overnight-agent-taskmanager-implementation.md` § Phase 7. Critical carry-forwards from earlier reviews are captured on each task's description in the task tracker (use `TaskList` to see them on resume).

1. **Task 7.4 — Daemonization.** `detachAndRun(planId)`: `child_process.spawn(process.execPath, [supervisorEntry, planId], {detached: true, stdio: ['ignore', fd, fd]})` then `unref()` and exit launcher. Daemon writes pidfile on startup, traps SIGTERM/SIGINT for graceful stop. Spec is at the implementation plan (Task 7.4 section).
2. **Task 7.5 — Pidfile lifecycle.** `acquire(planId)` writes pidfile atomically, refuses if live pid present (`process.kill(pid, 0)`); `release(planId)` unlinks; `isStale(planId)` returns true if pidfile exists but pid is dead.
3. **Task 7.6 — Control socket** (per ADR-0012, supersedes the SIGUSR1 part of ADR-0010). Unix domain socket at `<runDir>/oa.sock`. Server: length-prefixed JSON request/reply. Client: `request(absPath, message)`. Message types in v0: `stop {now: bool}`, `status {}`. Cleans up stale socket file before bind.
4. **Task 7.7 — Wire control socket into supervisor.** Open the socket on supervisor startup. On `stop {now:false}` raise the abort signal. On `stop {now:true}` SIGTERM the in-flight adapter spawn directly. On `status` return live state struct.
5. **Task 7.8 — Resume protocol** (per ADR-0003). Detect stale pidfile + plan status `running` with no live daemon. For each task whose state is `running` (or any of its steps is `running`), call `worktree.rewindToHead`. Mark in-flight steps back to `pending`. Emit `run.resume {rewoundSteps}`. Re-enter the outer loop at the first non-`done` task.

After Phase 7 closes, Phase 8 (CLI surface — 10 sub-tasks for `oa intake/queue/plan/run/status/stop/tail/rerun/archive`) is next.

---

## How to resume

```sh
cd /Users/souler/Nextcloud/test/OvernightAgent
git status                           # should be clean on `dev`
git log --oneline -5                 # confirm tip is 200829b
pnpm install                         # idempotent
pnpm -r build && pnpm -r test        # all 5 packages, 372 tests, all green
```

Then continue the workflow:
1. Re-enter the `superpowers:subagent-driven-development` skill (or just dispatch implementer subagents directly with the per-task spec).
2. Next task is **Task 7.4 (Daemonization)**.
3. The Phase 7 task description (in the task tracker) carries 10 carry-forwards from prior reviews — re-read those before dispatching to keep the contract intact.

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
- `packages/oa-core/src/supervisor/{bootstrap,runPlan}.ts` — supervisor (just runPlan so far; daemon/socket/resume next)

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

These are non-negotiable conventions established and verified across 56 commits:

1. **Absolute paths everywhere in worktree-touching code.** Every public API asserts via `assertAbs(p)` at the boundary. ESLint override on `**/worktree*.ts` + `**/paths*.ts` bans bare `path.join` (must use `path.resolve` or `path.resolve(path.join(...))`). See ADR-0002 + ADR-0013.
2. **Atomic JSON writes only.** All on-disk mutations use `writeJsonAtomic` (temp + rename). Schema-versioned, atomic visibility, last-writer-wins on concurrent writes.
3. **`schemaVersion: 1` on every on-disk JSON shape.** Validates via Zod with `.strict()` for closed shapes (most), `.passthrough()` for forward-compatible event variants (will be tightened in Phase 7+ per carry-forward).
4. **TDD per task.** Failing test → implement → passing test → commit. Every task in this codebase has the failing-then-passing evidence in the implementer's report. Reviewers run sabotage checks (e.g., temporarily breaking the production code to confirm the test catches it) on load-bearing assertions.
5. **Single commit per task.** Conventional-commits message format. Commit message body explains *why* the task exists; doc-comments explain *what* and *how*.
6. **Per-step subagent dispatch.** Per the subagent-driven-development workflow: implementer subagent → spec reviewer → code quality reviewer → fix-up loop → next task. No batching; each task gets a fresh implementer.
7. **Reviewers find real bugs.** ~30% of tasks needed a fix-up commit after review. Common categories: silent passthrough on discriminated unions, NaN-on-parse vulnerabilities, lock non-reentrancy footguns, missing JSDoc contracts, schema drift from convention. The discipline pays off.

---

## Git tip + branch state

- `dev` is ahead of `master` by 54 commits. `master` has 2 commits (the design + ADR docs).
- No remote configured. All work is local.
- Working tree is clean.
- Last commit message:

```
200829b fix(core/supervisor): hardening — try/finally, abort checks, blocked-step exit, run.error emission
```

---

## Memory entries used during this session

The user's `~/.claude/projects/-Users-souler-Nextcloud-test-OvernightAgent/memory/` directory holds two pinned memories that informed major decisions:

- `feedback_worktree_absolute_paths.md` — The reason worktree code asserts absolute paths everywhere.
- `feedback_record_adrs.md` — The reason ADRs are first-class deliverables alongside the design doc.

These remain accurate and relevant.
