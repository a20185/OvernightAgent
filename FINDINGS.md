# OvernightAgent — Implementation Findings

Lessons, gotchas, and design refinements discovered during the 37 tasks completed so far. Useful when resuming or making analogous decisions in remaining tasks.

---

## What worked well

### TDD discipline + sabotage checks

Every task in this codebase had failing-test-then-passing-test evidence in the implementer's report. On load-bearing assertions (~10 of the tasks), the reviewer asked the implementer to verify by **temporarily breaking the production code and observing that the test fails** — then restore. This caught real test gaps multiple times:

- Task 1.4 (locks): in-process serialization test passes even when cross-process locking is broken (proper-lockfile has an internal `locks` map). Review caught this; cross-process forked-child test added.
- Task 6.5 (progress mutators): mtime-equality test alone wouldn't catch a regression that swapped `writeJsonAtomic` for an in-place rewrite. Inode-equality assertion added.
- Task 7.1 (events writer): naive `appendFile` per emit failed the 50-concurrent-emit ordering test. Chained-promise FIFO fix.
- Task 7.3 (supervisor): drop a junk file between attempts inside the worker callback, probe for it on attempt 2 — proves the rewind happens via the production code path, not synthetic.
- Task 7.5 (pidfile lifecycle): the initial in-process race test was too weak; replacing it with two real Node children importing the built `dist` helper exposed path-resolution mistakes in the harness and ultimately pinned the true single-winner guarantee.
- Task 7.6 (control socket): the initial happy-path socket tests passed even though a second `serve()` could unlink a live socket path and silently steal future clients. A focused regression test that started two servers on the same path forced the implementation to distinguish stale leftovers from live listeners.
- Task 7.7 (supervisor control wiring): the first green implementation still left a narrow abort-registration race and assumed a throwing `onSpawned` callback would be harmless. A focused hardening pass pinned both edges: install abort listeners before exposing live control, and kill/reap the child before rethrowing.

### File-path-wrapped errors

When schemas reject corrupt on-disk JSON, wrap the Zod error with the file path. Three tasks adopted this pattern (1.2 atomicJson, 3.1 inbox, 3.3 plan); makes operator debugging far easier than a bare Zod stack.

```ts
try {
  return InboxSchema.parse(raw);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  throw new Error(`inbox file at ${p} is corrupted: ${msg}`, { cause: err });
}
```

### Namespace re-exports keep the public API clean

Established pattern in `src/index.ts`: `export * as worktree from './worktree.js'`, `export * as inbox from './stores/inbox.js'`, etc. Callers do `import { worktree, inbox } from 'oa-core'; worktree.create(...); inbox.add(...)`. Avoids name collisions across modules and keeps the index file tractable as the surface grows.

### Strict by default; passthrough deliberately

Every closed-shape on-disk JSON schema uses `.strict()` (Inbox, Queue, Plan, Intake, Steps, Config, Reference variants, OaStatus, OaReview). EventSchema's variants use `.passthrough()` because Phase 7's writer is still firming up payload fields; will tighten in late Phase 7 / Phase 8 per the carry-forward.

### Atomic write helpers shared across the codebase

`writeJsonAtomic` (temp + rename) was added in Task 1.2; `writeFileAtomic` (same pattern for plain text) was added in Task 6.5 and Task 4.4's local copy was retroactively replaced. Single helper, used everywhere, crash-safe by construction.

### ADRs as first-class deliverables

Per the user's `feedback_record_adrs.md` memory. Every architectural decision during brainstorming got an ADR; two more (0012, 0013) landed during implementation when novel decisions appeared. Reviewers consistently cross-checked ADR text against the implementation and flagged drift.

---

## Real bugs caught by reviewers

The two-stage review (spec compliance → code quality) found bugs the implementer didn't see:

### Critical-severity finds

- **Task 0.3** (package scaffolds): per-package `tsconfig.json` had `rootDir: "."` + `include: ["src", "test"]`, which caused `tsc` to put output at `dist/src/index.js` instead of `dist/index.js` where `package.json`'s `main` field pointed. Cross-package imports would have failed silently the moment they were attempted. Fix: `rootDir: "src"`, `include: ["src"]`.
- **Task 1.5** (Zod schemas): ReferenceSchema's discriminated union variants weren't `.strict()`. A `kind: "dir"` reference could carry a `copiedTo` field (which is a `kind: "file"`-only invariant), and Zod would silently strip it. Fix: `.strict()` on each variant + regression tests.
- **Task 2.2** (worktree create): the `fs.access` pre-EXISTS check on the worktree dir wasn't just defensive — it was load-bearing. `git worktree add` happily colonizes an empty dir, so without the pre-check a stale empty `worktreeDir(taskId)` (from a prior aborted run or manual mkdir) would be silently used. The original comment misrepresented the rationale.

### Important-severity finds

- **Task 0.2** (ESLint config): `no-restricted-imports` with `importNames: ['join']` flags namespace imports too (`import * as path from 'node:path'`), which is the very pattern ADR-0013 recommends. Fix: replace with `no-restricted-syntax` selector matching only the destructured-import shape.
- **Task 0.4** (oa-cli): The `pretest` hook runs `tsc` but with `composite: true` + persistent `tsconfig.tsbuildinfo`, removing only `dist/` causes `tsc` to no-op. Tests then fail in a confusing way. Fix: `tsc --build . --force` (the `--force` flag requires `--build` mode in TS6, not `-p`).
- **Task 1.4** (locks): The cross-process serialization test gap above. proper-lockfile's in-process `locks` map intercepts second-same-process `lockfile.lock` calls before any FS work — so an in-process test passes even when mkdir-based locking is broken.
- **Task 1.5** (schemas): `parseInt` on `git rev-list --count` output could return NaN if git ever emits a warning to stdout before the count. NaN compares false to any threshold, silently failing the verify gate as "no commits". Fix: `Number.isFinite` guard.
- **Task 2.4** (worktree.commitsSince): same NaN concern; same guard added.
- **Task 7.5** (pidfile lifecycle): the first helper version used a check-then-overwrite write path, which let two contenders both “succeed” under contention. Review forced the live/stale check and rewrite into a single `proper-lockfile` critical section. A second review also caught the startup-signal bug where `runSupervisorEntry` could release another daemon's pidfile before ownership was established; fixed with an `ownsPidfile` gate plus a focused entry regression test.
- **Task 7.6** (control socket): the first `serve()` implementation unlinked any pre-existing socket path before bind. That satisfied the stale-socket test but let a second live server steal the pathname from the first daemon, breaking future clients without ever surfacing `EADDRINUSE`. Fix: probe the existing socket path first, only unlink on connect-failure (`ECONNREFUSED` / `ENOTSOCK` / `ENOENT`), and pin the behavior with a live-socket regression test.
- **Task 7.7** (supervisor entry wiring): `runSupervisorEntry()` installed `process.once('SIGTERM'/'SIGINT')` handlers but did not remove them on a normal return. Repeated in-process entry runs could leak one-shot signal handlers until some later unrelated signal fired, producing stray `daemon.signal` output and risking cross-test interference. Fix: retain handler refs, remove them in an outer `finally`, and pin listener-count restoration in `entry.integration.test.ts`.
- **Task 7.7** (spawn handoff): the stop path originally called `onSpawned` before the abort listener was fully wired and did not reap the child if `onSpawned` itself threw. That left a tiny missed-abort window and an orphan-process edge during live-control setup. Fix: register abort first, then invoke `onSpawned`, and kill/reap before surfacing the callback error.

### Real schema/contract drift

- **Task 7.3** (supervisor): emitted `step.verify.tail.fail` for ALL killed-worker cases, even though EventSchema had dedicated `step.timeout` and `step.stdoutCapHit` variants. Schema-implementation drift; reviewer asked: emit both or delete the unused variants. Fix: emit dedicated event AS WELL AS the unified tail.fail.
- **Task 6.5** (progress): added `StepProgressSchema` and `ProgressDocSchema` as plain `z.object(...)` instead of `.strict()`. Other schemas in the same file used `.strict()`. Fix: align with convention.
- **Task 7.4** (daemonization): three separate review loops caught launch-contract drift the happy-path test missed: first, the launcher reused one fd for both stdout/stderr even though the spec pinned two separate `fs.openSync(..., 'a')` calls; then the child entry wrote plain-text `console.error` into `events.jsonl`; finally the detached launcher could exit `0` even when the child entry path was missing, letting Node dump a raw `MODULE_NOT_FOUND` stack into the log. Fix: exact stdio shape, JSONL-safe `run.error`/`daemon.signal` output, and preflight `fs.accessSync` on the entry path before detaching.

---

## Recurring gotchas

### Path resolution / macOS quirks

- `/tmp` on macOS is a symlink to `/private/tmp`. Tests that use `os.tmpdir()` and shell out to `pwd` or any tool that resolves the symlink need to accept either form. Several tests handle this (Task 6.2 verifyCmd, Task 4.2 references-dir-in-git).
- AF_UNIX socket paths cap at 104 bytes on macOS / 108 on Linux. Documented in `socketPath`'s JSDoc (Task 1.1) so Phase 7's daemon knows to fall back to a shorter `/tmp/oa-<planId>.sock` path if `oaHome` is deep.

### Node + TypeScript versioning

- `with { type: 'json' }` import attribute requires Node **22.0+**. We target Node `>=22` (set in Task 0.4 fix-up; was originally `>=20` until claude-cli's `cli.ts` needed the import attribute).
- TS6 + `verbatimModuleSyntax` + `module: NodeNext` requires `.js` extensions on relative imports in source (e.g. `from './foo.js'` even though the source is `.ts`). New contributors will hit this; brief mention in the README would help (Phase 12 task).
- TS6's `--force` flag requires `--build` mode (not `-p`). Hit this in Task 0.4 fix-up.
- Under `pnpm --filter <pkg> test`, `process.cwd()` is the package root, not the repo root. Task 7.5's cross-process pidfile test initially tried to import `packages/oa-core/dist/...` from `process.cwd()` and silently pointed at a nonexistent path. For child-process tests that need built output, resolve from `import.meta.url`, not the shell cwd.

### proper-lockfile is NOT reentrant

Discovered in Task 3.1 review. `withInboxLock(async () => { await inbox.setStatus(...); })` would silently deadlock for 5s then `ELOCKED` — because `inbox.setStatus` itself calls `withInboxLock`. Critical carry-forward to Task 3.3 (PlanStore.create()): when sealing a plan, must read+modify+write tasks.json directly inside the outer lock, NOT call `inbox.setStatus`. Phase 7 daemon must pass explicit `onCompromised` to proper-lockfile so unhandled mtime-refresh throws don't crash the daemon.

### execa, signal, and shell

- For multi-word verify commands like `pnpm test && pnpm lint`, `shell: true` is necessary — without it `&&` and pipes are treated as literal arguments. Task 6.2.
- `reject: false` on execa keeps await-resolution linear instead of throw-on-non-zero-exit. Established convention since Task 5.2.
- Manual `SIGKILL` grace period (`setTimeout(SIGKILL, 500)`) belt-and-suspenders alongside execa's `forceKillAfterDelay: 500`. Observed in Task 5.2 spawn helper.
- If a detached child writes to a structured JSONL log, every stderr/stdout failure path must also be structured JSON. Otherwise a single startup error corrupts the whole event stream. Task 7.4 hardened this by emitting `run.error` / `daemon.signal` JSON lines from the child entry and by preflighting the entry path before spawn so Node never gets the chance to print a raw `MODULE_NOT_FOUND` stack into `events.jsonl`.
- For abort-driven child control, use add-then-check, not check-then-add. Task 7.7's hardening fix-up closed the race where a stop request could land between `if (!signal.aborted)` and `addEventListener(...)`, leaving the child alive until some later timeout or natural exit.
- If the live-control `onSpawned` callback can throw, tear the child down before bubbling the error. Task 7.7 otherwise had a path where supervisor setup could fail synchronously while the spawned agent kept running.

### Workspace cycle in the adapter registry

`oa-adapter-claude` deps `oa-core`. The adapter registry (Task 5.4) needs to dynamically `import('oa-adapter-claude')`, which requires oa-core to have it as a (dev)dependency — creating a cyclic workspace dep. pnpm warns but resolves it via symlinks; all builds and tests pass. **Will block npm publish later** — captured as Phase 12 carry-forward (use `vi.mock()` in registry.test.ts to fake the adapter packages, dropping the workspace devDep entirely).

### Docs-from-elsewhere dependency

ADR-0008 promises protocol blocks live at `oa-core/prompts/protocol-status.md` + `protocol-review.md`, but they're currently inlined as constants in `verify/context.ts` (Task 6.4) and `verify/review.ts` (Task 6.3). Captured as Phase 12 carry-forward — either extract to those files or update ADR-0008.

---

## Connection-error recovery patterns

The session had ~6 implementer subagent timeouts (stream idle / `ECONNRESET`) over 63 commits. The recovery pattern that consistently worked:

1. **Don't reattempt the same prompt blindly.** First check what landed via `git status` and `git log`.
2. **If the implementer wrote files but didn't commit**, verify via tests/typecheck/lint, then commit directly with the exact message the implementer would have used. (This is a deliberate exception to "don't fix manually" — it's just landing already-correct work, not implementing.)
3. **If the implementer committed but the connection dropped after**, rejoice — git logs the truth.
4. **If the implementer hadn't started writing**, dispatch a fresh implementer with the same brief.
5. **Always check before retrying.** Several "failed" runs had actually completed the work; the report was lost but the commit landed.

Notable example: Task 3.3 (PlanStore) had two consecutive timeouts. First attempt wrote the test file but no source. Second attempt landed the source but the report was dropped. Final state: clean implementation, all gates green, committed via the controller path.

---

## Implementation conventions that emerged

These weren't in the original plan; they emerged during reviews and got applied retroactively or in subsequent tasks.

### `assertAbs` at every public-API boundary

Originally Task 1.1 only added `assertAbs` to the `paths.ts` helpers. Reviewers in subsequent tasks pushed for it on every function accepting a path argument. Now: `worktree.{create,rewindToHead,remove,commitsSince}`, `verifyGates.{verifyCommit,verifyCmd}`, `runReviewer`, `materializeReferences`, `writeJsonAtomic`, `readJson`, `writeFileAtomic`, `progress.{mark,read}`, `findings.{append,read}`, `openEventWriter`, `runBootstrap`, `intakeSubmit`, `spawnHeadless`, the claude adapter all assert.

### `assertId` on every ID-typed argument

Same pattern. Originally only `paths.ts` per Task 1.6 retrofit. Now: every function that accepts a `taskId` or `planId` calls `assertId` before any I/O. Bonus: `paths.ts` got 4 regression tests for `/etc/passwd`, `..`, `a/b`, `a\x00b`.

### Defensive output asserts in path helpers

Task 1.1's `paths.ts` helpers all do `assertAbs(out)` on their return values, not just inputs. Defensive against a future refactor that swaps `path.resolve` for `path.join` (which was banned by ESLint but the rule could regress).

### Helper-tagged error messages

Started in Task 1.1 fix-up: instead of `assertAbs(out)`, each helper does its own check with a function-named error message: `pidfile produced non-absolute path: ...`. Easier post-mortem when the supervisor's stack trace says exactly which helper produced the bad value.

### Fenced-block protocol parsing — last-fence-wins

Per ADR-0008. The `parseTail` function (Task 6.1) finds ALL fenced blocks of the given kind and returns the LAST one. Tolerates agents that print intermediate fenced blocks as protocol examples. Validated with a test where the agent prints the protocol once as a doc snippet and once as the real terminal block.

### Two-phase Zod parse for atomic-on-failure

Task 4.4's `intakeSubmit` does a "preview parse" of the intake (with `references: []`) BEFORE creating any folders, so a schema violation throws before any disk side effects. Then a "canonical parse" with the materialized references after. Pattern: validate as early as possible; only mutate disk once the input is known good.

### Source-of-truth + rendered-doc pairs

Several modules write a structured JSON file (the source of truth) AND a derived markdown rendering for human inspection:

- `progress.ts`: `_progress.json` (source) + `PROGRESS.md` (rendered)
- `intakeSubmit`: `intake.json` + `HANDOFF.md`
- `runPlan` will eventually pair `events.jsonl` with `SUMMARY.md` (Phase 9 task)

The markdown is regenerated from the JSON on every mutation; never the other way around.

### Single-writer convention for per-task state

`PROGRESS.md`, `FINDINGS.md`, and the per-task folder generally have a single writer (the supervisor). No locking needed — the convention is enforced by the daemon-per-plan + sequential-task-execution model. If parallel-task mode lands later (Phase 8+), this needs revisiting.

### Detached-process tests need cleanup hooks

Task 7.4's daemon integration test initially passed green but could leak detached background processes on a red run. The final harness tracks launched planIds and best-effort `SIGTERM`s/`SIGKILL`s them in `afterEach`. Any future detached-process or socket-server test should do the same, or CI/dev machines will accumulate orphans when assertions fail mid-test.

### "Stale cleanup" must not clobber live IPC endpoints

Task 7.6 exposed an easy Unix-socket footgun: blindly unlinking an existing socket path before `listen()` makes stale-file recovery look correct in tests, but it also lets a second live server steal the pathname from the first one. For socket/FIFO style IPC, "remove stale" needs a liveness probe first; only unlink after a failed connect proves the old endpoint is dead.

### For signal wiring, capture the registered handler instead of sending real signals in-process

Task 7.5's first entry regression test sent a real `SIGTERM` to the Vitest process, which polluted sibling tests with extra output and made debugging harder. The better pattern is to intercept `process.once('SIGTERM', handler)` and invoke the captured handler directly. It still tests ordering but avoids cross-test process-wide side effects.

Related follow-on from Task 7.7: if production code installs process-level signal handlers during a testable helper like `runSupervisorEntry()`, it also needs an explicit cleanup path for the no-signal case. `process.once(...)` only self-removes when the signal actually fires; it does NOT clean itself up when the function returns normally.

### Stub event writer pattern for tests

Originally appeared in Task 7.2 (bootstrap). Tests that need to verify event emission don't depend on a real file-backed writer:

```ts
function makeStubEventWriter() {
  const emitted: unknown[] = [];
  return { emitted, emit: async (e) => { emitted.push(e); }, close: async () => {} };
}
```

Reviewer's flag: this stub doesn't validate against `EventSchema`, so a writer-side schema mismatch wouldn't be caught by these tests. Mitigated by `schemas.test.ts`'s smoke matrix that pins each variant's required field set. The supervisor integration tests in Phase 7 should adopt `validate: true` once the writer's per-emit field set stabilizes.

---

## Performance / scale notes

### oa-core test suite is fast

385 tests in ~13 seconds (with builds). Each test file averages ~10 tests. The longest individual test runs are:

- `ELOCKED` timeout test (~5s, by design — exercises proper-lockfile's full retry budget)
- Cross-process contention tests (~1–1.5s, fork/spawn overhead)
- `runPlan` integration tests (~1.5s each, real git repos in tmpdir)

No flakes observed across the Phase 7 work once the child-import path in `pidfile.test.ts` moved off `process.cwd()`, the control-socket live-path regression was pinned in `controlSocket.test.ts`, and the entry helper started cleaning up its process signal handlers on normal return.

### EventSchema validation cost

`validate: true` on the events writer runs Zod parse per emit. Negligible for the supervisor's typical ~10 emits per step, but Phase 7's `runPlan` defaults to `validate: false` for that reason. The schema test matrix is the real coverage; per-emit validation is a CI-only canary.

### Lock contention

`withInboxLock` is shared across InboxStore, QueueStore, and PlanStore (all touch `<oaHome>/tasks.json`-adjacent files; PlanStore.create touches inbox AND plan files atomically). Under heavy concurrent CLI invocations, queue-add operations would serialize against unrelated inbox writes. Acceptable for v0 (operations are user-driven and infrequent); revisit if Phase 8's CLI ever batches.

---

## Things that could've gone better

### Test-task setup is repetitive

Every test that exercises stores or worktree creates a tmpdir + sets `OA_HOME` + calls `ensureHomeLayout()`. The boilerplate is consistent (~15 lines of `beforeEach`/`afterEach`) but appears in ~15 test files. A shared `test/util/setupTmpHome.ts` would help, but no task explicitly extracted it. Future cleanup target.

### Snapshot tests are brittle

Inline snapshots in `handoff.test.ts` (Task 4.3) and `context.test.ts` (Task 6.4) treat the snapshot as spec. Drift fails without `-u`. This is the right call — the rendered output IS the contract — but means small wording tweaks require re-snapshotting all affected tests. No way to avoid without sacrificing the spec-pinning property.

### Documentation extraction deferred

ADR-0008 promises protocol blocks live at separate files. Not extracted yet. Captured as Phase 12 carry-forward. Should land before any third party (or future maintainer) reads ADR-0008 expecting those files to exist.

### Cross-package cycle

The oa-core ↔ oa-adapter-* workspace cycle is fine for dev but blocks publish. Captured as Phase 12 carry-forward; the fix is small (`vi.mock()` in registry tests).

---

## Memory entries that informed decisions

The user's pinned memories at `~/.claude/projects/-Users-souler-Nextcloud-test-OvernightAgent/memory/` shaped the design and stayed accurate throughout:

- **`feedback_worktree_absolute_paths.md`**: every worktree-touching code path asserts absolute paths, with ESLint enforcement. Has paid off three times that I know of (the Task 0.3 dist-layout bug, the Task 2.2 silent-EXIST colonization, and several relative-path tests catching regressions).
- **`feedback_record_adrs.md`**: ADRs are first-class. 13 of them now (12 from brainstorming + 1 added during implementation when the ESLint enforcement gap was discovered). Reviewers consistently cross-check ADR text against implementation.
