# OvernightAgent — Implementation Progress

**Snapshot at:** Post-v0 completion
**Total commits on dev:** 67 at this checkpoint
**Workspace tests:** 426 passing across 5 packages

---

## Phase-level

| # | Phase | Status | Commits | Notes |
|---|---|---|---|---|
| 0 | Repo & tooling scaffold | ✅ done | 4 sub-tasks | pnpm@9.15.4, Node 22+, TS 6, Vitest 4, ESLint 8 |
| 1 | oa-core foundations | ✅ done | 6 sub-tasks | paths/atomicJson/home/lock/schemas/ids |
| 2 | Worktree manager | ✅ done | 5 sub-tasks | create/adopt/rewindToHead/remove/commitsSince |
| 3 | Inbox/queue/plan stores | ✅ done | 3 sub-tasks | Shared `withInboxLock` for plan seal atomicity |
| 4 | Intake pipeline | ✅ done | 4 sub-tasks | parseSteps/references/handoff/submit |
| 5 | AgentAdapter + claude | ✅ done | 4 sub-tasks | types/spawnHeadless/claude/registry |
| 6 | Verify pipeline + fix loop | ✅ done | 7 sub-tasks | tail/gates/reviewer/context/state/fixLoop + integration test |
| 7 | Supervisor / daemon / socket / resume | ✅ done | 8 sub-tasks | runPlan + daemonization + pidfile + control socket + resume |
| 8 | oa-cli surface | ✅ done | 1 bundled commit | 10 subcommands + integration tests |
| 9 | SUMMARY.md renderer | ✅ done | 1 bundled commit | events reader + renderer + auto-render hook + `oa summary` |
| 10 | codex + opencode adapters | ✅ done | 1 bundled commit | both adapters + registry tests |
| 11 | Per-host shims | ✅ done | 1 bundled commit | resource files (markdown), 3 host bundles |
| 12 | End-to-end + docs | ✅ done | 1 bundled commit | CLI e2e + README + ADR alignment + final verification |

---

## Phase 7 task-level detail (reference; final)

| Task | Status | Commit(s) | Notes |
|---|---|---|---|
| 7.1 | events.jsonl writer | ✅ | `846e644` | Chained-promise FIFO to serialize appends |
| 7.2 | Bootstrap runner | ✅ | `41d615b` | Empty script no-ops; tmp script chmod 755 + cleanup |
| 7.3 | Supervisor outer loop | ✅ | `0ea961e` + fix-up `200829b` | 8 review items addressed in fix-up |
| 7.4 | Daemonization | ✅ | `4be272f` | detachAndRun + entry scaffold + 3 review fix-ups |
| 7.5 | Pidfile lifecycle | ✅ | `18cec8b` | proper-lockfile + startup-ownership regression test |
| 7.6 | Control socket | ✅ | `2b8d50d` + `cc1e094` | length-prefixed JSON + live-socket preservation |
| 7.7 | Wire socket into supervisor | ✅ | `4160ee8` + `1b5c03b` | live status, graceful/force stop, entry signal cleanup |
| 7.8 | Resume protocol | ✅ | `af5a740` | rewind + orphan sweep + adopt-or-create + skip-done |

---

## Phase 8 task-level detail

All landed in commit `beb4adf`:

| Task | Status | Subject |
|---|---|---|
| 8.1 | ✅ | `oa intake submit --payload|--payload-file` |
| 8.2 | ✅ | `oa intake list|show|rm` |
| 8.3 | ✅ | `oa queue add|ls|rm|clear` |
| 8.4 | ✅ | `oa plan create|show|ls` |
| 8.5 | ✅ | `oa run [--detach] [--dry-run]` |
| 8.6 | ✅ | `oa stop [--now]` |
| 8.7 | ✅ | `oa status [--json]` |
| 8.8 | ✅ | `oa tail [--raw] [--once]` |
| 8.9 | ✅ | `oa rerun <planId> [--detach]` (OA_RESUME=1 wired) |
| 8.10 | ✅ | `oa archive <id>` |

---

## Phase 9 task-level detail

All landed in commit `06bec6f`:

| Task | Status | Subject |
|---|---|---|
| 9.1 | ✅ | events/reader.ts + tests (ENOENT → [], onInvalid hook) |
| 9.2 | ✅ | summary/render.ts + snapshot tests (tolerates unknown event kinds) |
| 9.3 | ✅ | `oa summary` command + auto-render on plan end (runPlan finally) |

---

## Phase 10 task-level detail

All landed in commit `9dd45dc`:

| Task | Status | Subject |
|---|---|---|
| 10.1 | ✅ | oa-adapter-codex (`codex exec --model --prompt-file`) |
| 10.2 | ✅ | oa-adapter-opencode (`opencode run --model --prompt-file`) |
| 10.3 | ✅ | registry.test.ts covers all three adapters |

---

## Phase 11 task-level detail

All landed in commit `5e46476`:

| Task | Status | Subject |
|---|---|---|
| 11.1 | ✅ | Claude Code shim (`oa-shims/claude/`) |
| 11.2 | ✅ | Codex shim (`oa-shims/codex/`) |
| 11.3 | ✅ | opencode shim (`oa-shims/opencode/`) |

---

## Phase 12 task-level detail

All landed in commit `19525e7`:

| Task | Status | Subject |
|---|---|---|
| 12.1 | ✅ | CLI-level e2e (`oa-cli/test/e2e.test.ts`); full supervisor e2e by oa-core integration tests |
| 12.2 | ✅ | Resume e2e covered by `oa-core/test/supervisor/resume.integration.test.ts` |
| 12.3 | ✅ | Top-level README.md (lifecycle, layout, architecture, limits) |
| 12.4 | ✅ | Final verification: typecheck + lint + build + test all green |

---

## Test counts by package (final)

| Package | Files | Tests |
|---|---|---|
| oa-core | 39 | 400 |
| oa-adapter-claude | 2 | 6 |
| oa-adapter-codex | 1 | 2 |
| oa-adapter-opencode | 1 | 2 |
| oa-cli | 4 | 16 |
| **Total** | **47** | **426** |

---

## Open ADRs

13 ADRs at `docs/adr/`. All `Status: Accepted`. ADR-0012 supersedes the
SIGUSR1 portion of ADR-0010. ADR-0013 added during Task 0.2. ADR-0008
updated during Phase 12 to document the protocol-block inlining deferral.

| # | Title | Status |
|---|---|---|
| 0001 | Branch and commit hygiene | Accepted |
| 0002 | Worktree per taskList + absolute paths | Accepted |
| 0003 | Clean rewind on resume | Accepted |
| 0004 | Verification pipeline + fix loop | Accepted |
| 0005 | Runs as events.jsonl + summary | Accepted |
| 0006 | Context injection per step | Accepted |
| 0007 | References tiered handling | Accepted |
| 0008 | Agent tail-message protocol | Accepted (prompt-file extraction deferred) |
| 0009 | AgentAdapter interface | Accepted |
| 0010 | Process model — detached supervisor | Accepted (SIGUSR1 superseded by ADR-0012) |
| 0011 | Strategy as orthogonal toggles | Accepted |
| 0012 | Daemon control via Unix socket | Accepted |
| 0013 | ESLint path-discipline enforcement gaps | Accepted |

---

## Post-v0 follow-ups (captured from carry-forwards)

1. Break the `oa-core` ↔ `oa-adapter-*` workspace cycle via `vi.mock()`
   in registry tests. Blocks `npm publish`.
2. Extract `oa-core/prompts/protocol-status.md` + `protocol-review.md`
   from their inlined constants (per ADR-0008 note).
3. Tighten `parseSessionIdFromStreamJson` to require `subtype === 'init'`
   once codex / opencode stabilize.
4. Schema-bound `intake.executor.extraArgs` (regex, secret-pattern
   rejection) to close the ps-listing / argv-leak concern.
5. Consider `worktree.removeSafe()` for a future operator archive path.
6. Per-task suffix on `reviewer-default-prompt.md` once `parallel.max > 1`
   is a real code path.
7. `writeJsonAtomic({mode?: number, fsync?: true})` for secret-adjacent
   and power-loss-sensitive writes (pidfile, queue).
8. Plan partial-failure recovery scan (orphan queued tasks not in any
   plan) on supervisor startup.
