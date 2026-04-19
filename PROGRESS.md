# OvernightAgent — Implementation Progress

**Snapshot at:** Task 7.3 fix-up commit `200829b` on `dev`
**Total commits on dev:** 56 (2 design + 54 implementation)
**Workspace tests:** 372 passing (oa-core 361, oa-adapter-claude 6, oa-cli 3, 2 adapter smoke)

---

## Phase-level

| # | Phase | Status | Commits | Notes |
|---|---|---|---|---|
| 0 | Repo & tooling scaffold | ✅ done | 4 sub-tasks (with fix-loops on 0.2, 0.3, 0.4) | pnpm@9.15.4, Node 22+, TS 6, Vitest 4, ESLint 8 (flat-config migration deferred) |
| 1 | oa-core foundations | ✅ done | 6 sub-tasks (with fix-loop on 1.1, 1.4, 1.5) | paths/atomicJson/home/lock/schemas/ids; established conventions |
| 2 | Worktree manager | ✅ done | 5 sub-tasks (with fix-loops on 2.1, 2.2, 2.3, 2.4) | create/rewindToHead/remove/commitsSince + hardening |
| 3 | Inbox/queue/plan stores | ✅ done | 3 sub-tasks (with fix-loops on 3.1, 3.3) | Shared `withInboxLock` for plan seal atomicity |
| 4 | Intake pipeline | ✅ done | 4 sub-tasks (with fix-loop on 4.3) | parseSteps/references/handoff/submit |
| 5 | AgentAdapter + claude | ✅ done | 4 sub-tasks (clean) | types/spawnHeadless/claude/registry |
| 6 | Verify pipeline + fix loop | ✅ done | 7 sub-tasks (with small fix-up on 6.5 schemas) | tail/gates/reviewer/context/state/fixLoop + integration test |
| **7** | **Supervisor / daemon / socket / resume** | **3/8** | runPlan landed with hardening fix-up | Daemon, pidfile, socket, resume still pending |
| 8 | oa-cli surface | ⬜ pending | 10 sub-tasks queued | Each command wraps oa-core APIs |
| 9 | SUMMARY.md renderer | ⬜ pending | 3 sub-tasks queued | events reader + renderer + auto-render hook |
| 10 | codex + opencode adapters | ⬜ pending | 3 sub-tasks queued | Mirror oa-adapter-claude shape |
| 11 | Per-host shims | ⬜ pending | 3 sub-tasks queued | Resource files only — no JS |
| 12 | End-to-end + docs | ⬜ pending | 4 sub-tasks queued | e2e tests + README + final verification |

---

## Phase 7 task-level detail

| Task | Status | Commit(s) | Notes |
|---|---|---|---|
| 7.1 | events.jsonl writer | ✅ | `846e644` | Notable: caught real concurrency bug — Node's `FileHandle.appendFile` is NOT internally serialized despite POSIX O_APPEND; chained-promise FIFO fix |
| 7.2 | Bootstrap runner | ✅ | `41d615b` | Empty script no-ops; tmp script chmod 755 + cleanup in finally; widened TaskBootstrapEnd schema variant |
| 7.3 | Supervisor outer loop | ✅ | `0ea961e` + fix-up `200829b` | 668 LOC source + 550 LOC tests + 6 integration scenarios. Fix-up addressed 8 Important review items (try/finally, abort checks, blocked-step exit, run.error emission, dedicated step.timeout/stdoutCapHit events, etc.) |
| 7.4 | Daemonization | ⬜ next | — | `child_process.spawn` with `detached:true`, pidfile on startup, signal handlers |
| 7.5 | Pidfile lifecycle | ⬜ | — | `acquire/release/isStale` with `process.kill(pid, 0)` liveness check |
| 7.6 | Control socket | ⬜ | — | Unix domain socket per ADR-0012 (supersedes SIGUSR1 from ADR-0010); JSON request/reply; cleans stale sock file |
| 7.7 | Wire socket into supervisor | ⬜ | — | `stop {now:false}` → graceful abort; `stop {now:true}` → SIGTERM agent; `status` → live state |
| 7.8 | Resume protocol | ⬜ | — | Detect stale pidfile, rewindToHead in-flight worktrees, mark steps pending, re-enter outer loop |

---

## Carry-forwards into Phase 7.4-7.8

Captured on Task #15 (Phase 7) description in the tracker. Pasted here for reference:

(a) Supervisor startup sweeps `<runDir>/*.tmp.<oldpid>.*` orphan temp files (left by crashed `writeJsonAtomic` calls).

(b) `writeJsonAtomic` should grow `{mode?: number}` option when config holds secret-adjacent values (e.g., `0o600` for files containing API keys).

(c) Consider opt-in `{fsync?: true}` on writeJsonAtomic for queue/checkpoint writes that need power-loss durability.

(d) Supervisor MUST pass an explicit `onCompromised` handler to proper-lockfile so unhandled mtime-refresh throws don't crash the long-running daemon.

(e) `worktree.rewindToHead`'s PRECONDITION: caller must reap the prior attempt's process tree (no live file handles under absRoot) before calling. Windows would EBUSY; macOS/Linux would orphan.

(f) Make `worktree.remove()` idempotent for partial-cleanup retry (catch "is not a working tree"/"does not exist" from worktree-remove and proceed to branch -D).

(g) Consider `removeSafe(info)` non-force variant if a manual operator-driven archive CLI lands.

(h) Plan partial-failure recovery scan (orphan queued tasks not in any plan).

(i) Phase 6 inner-loop reference at `test/innerLoop.integration.test.ts` shows the v0 loop shape — supervisor must add: rewindToHead between attempts (ADR-0003), one AbortSignal per step/task for control-socket cancel, per-attempt issue history (not just last) in events log, tail-fail short-circuits before reviewer (intentional — comment), stepStartSha policy (one captured at step start; persists across fix-loop attempts). **PARTIALLY APPLIED IN 7.3** — 7.3's hardening fix-up addressed several of these; the rest land in 7.7-7.8.

(j) Default reviewer prompt path collision under future parallel mode (Phase 8+): currently materialized at `<runDir>/reviewer-default-prompt.md` which would race between concurrent tasks. Add per-task suffix when parallel lands.

---

## Carry-forwards into Phase 8 (CLI surface)

Captured on Task #16 (Phase 8) description in the tracker:

(none yet — Phase 8 description is the original plan text without additions)

---

## Carry-forwards into Phase 11 (per-host shims)

Captured on Task #19:

(a) Verify `claude -p <inline-text>` actually works against an installed claude — consider stdin/`--prompt-file` to avoid `ps`-listing leaks and argv length limits.

(b) Revisit `parseSessionIdFromStreamJson` once codex+opencode adapters land — tighten to require `subtype === 'init'` if permissive parser doesn't pay off.

---

## Carry-forwards into Phase 12 (e2e + docs)

Captured on Task #20:

(a) Break the oa-core ↔ oa-adapter-* workspace cycle before publish — npm/registry rejects circular deps. Recommended: use `vi.mock()` in registry.test.ts to fake adapter packages; live-load test for claude can stay if claude is the only legitimate need.

(b) Task 5.3 follow-ups: verify `claude -p <inline>` against installed claude (consider stdin/--prompt-file for ps-leak/ARG_MAX safety); decide whether to tighten parseSessionIdFromStreamJson once codex+opencode land.

(c) Task 6.3+6.4 ADR alignment: ADR-0008 promises protocol blocks live in `oa-core/prompts/protocol-status.md` and `protocol-review.md` but they're currently inlined as constants in context.ts and review.ts. Either extract to those files or update ADR-0008 to match the inlined-constant reality.

---

## Carry-forwards from Task 7.3 review (NOT yet applied; should be when Tasks 7.4-7.8 wire the daemon)

Suggestions level (from the Task 7.3 code-quality review):

- Extract `worktree.resetToSha(absRoot, sha)` so `runStep` calls the worktree namespace instead of open-coding `git reset --hard <sha> && git clean -fdx` between attempts.
- Add `attempt?: number` overload to `progress.mark()` so the typed `_progress.json::attempt` field stops being write-never. Currently the typed field is dead code; supervisor passes attempt info via `detail` string.
- Centralize the `28800` (8h) default `planBudgetSec` constant somewhere shared (currently duplicated as a magic number in runPlan).
- Document `RunStop.reason` enum extension if `'halted-on-failure'` is ever needed.
- Make `reviewer-default-prompt.md` per-task-suffixed for future parallel-mode safety.
- Document worktree lifecycle decoupling at the top of `runPlan` (worktrees outlive the supervisor; cleanup is a separate `oa archive` operation).
- Document the asymmetry: "abort leaves remaining tasks at queued; budget marks them as budget-exhausted".

---

## Test counts by package (snapshot)

| Package | Files | Tests |
|---|---|---|
| oa-core | 30 | 361 |
| oa-adapter-claude | 2 | 6 |
| oa-adapter-codex | 1 | 1 (smoke) |
| oa-adapter-opencode | 1 | 1 (smoke) |
| oa-cli | 2 | 3 |
| **Total** | **36** | **372** |

---

## Open ADRs

12 ADRs at `docs/adr/`. All `Status: Accepted`. ADR-0012 (control socket) supersedes the SIGUSR1 part of ADR-0010 (process model). ADR-0013 (eslint enforcement gaps) added during Task 0.2.

| # | Title | Status |
|---|---|---|
| 0001 | Branch and commit hygiene | Accepted |
| 0002 | Worktree per taskList + absolute paths | Accepted |
| 0003 | Clean rewind on resume | Accepted |
| 0004 | Verification pipeline + fix loop | Accepted |
| 0005 | Runs as events.jsonl + summary | Accepted |
| 0006 | Context injection per step | Accepted |
| 0007 | References tiered handling | Accepted |
| 0008 | Agent tail-message protocol | Accepted (with prompt-file extraction TODO — see Phase 12 carry-forward (c)) |
| 0009 | AgentAdapter interface | Accepted |
| 0010 | Process model — detached supervisor | Accepted (SIGUSR1 portion superseded by ADR-0012) |
| 0011 | Strategy as orthogonal toggles | Accepted |
| 0012 | Daemon control via Unix socket | Accepted |
| 0013 | ESLint path-discipline enforcement gaps | Accepted |
