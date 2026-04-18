# OvernightAgent TaskManager — v0 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Inside each task follow `@superpowers:test-driven-development` (write failing test → run → minimal impl → run → commit). Run `@superpowers:verification-before-completion` before marking any phase done.

**Goal:** Ship `oa` v0 — a Node/TS CLI that intakes coding-agent task plans, lets the user seal an OvernightExecutionPlan, then drives claude/codex/opencode unattended with worktree-per-taskList isolation, a four-gate verify pipeline + review-fix loop, structured event logs, clean resume after interruption, and a morning SUMMARY.md.

**Architecture:** pnpm monorepo. `oa-core` owns data model, schemas, intake parser, queue/plan/inbox stores, worktree manager, supervisor, verify pipeline, fix-loop, events log, prompt assembly, daemon control socket. `oa-cli` is the Commander tree. Three adapter packages (`oa-adapter-claude|codex|opencode`) implement a single `AgentAdapter` interface for headless invocation. Per-host shims under `oa-shims/` ship slash commands (`/oa-intake`, `/oa-queue`, `/oa-plan`, `/oa-status`).

**Tech Stack:** Node 20+, TypeScript 5, pnpm workspaces, Vitest (unit + integration), Commander, Zod (schemas), `proper-lockfile` (file locks), `simple-git` (git ops), `execa` (subprocess), `chalk` (CLI colors), built-in `node:net` (control socket), built-in `node:child_process` (detached daemon).

**Key references:** Read these before any task.
- Design: `docs/plans/2026-04-18-overnight-agent-taskmanager-design.md`
- ADRs: `docs/adr/0001..0012` (12 decisions, immutable)
- Memory: `~/.claude/projects/-Users-souler-Nextcloud-test-OvernightAgent/memory/feedback_worktree_absolute_paths.md` (absolute-path discipline is non-negotiable for any worktree code)

**Hard rules.** All paths in worktree-touching code must be absolute and asserted at API boundaries with `assert(path.isAbsolute(p))`. Atomic JSON writes only (write-then-rename). Every JSON file carries `schemaVersion`. Single-writer convention for per-task state files (PROGRESS, FINDINGS) — no locks but no concurrent writers either. New architectural decisions during implementation get an ADR (continue numbering from 0013).

---

## Phase 0 — Repo & tooling scaffold

Goal: empty packages compile, lint, and run an empty test suite. No business logic yet.

### Task 0.1: Initialize pnpm workspace at the repo root

**Files:**
- Create: `package.json` (root, private workspace)
- Create: `pnpm-workspace.yaml`
- Create: `.nvmrc` (`20`)
- Create: `.gitignore`

**Step 1: Write root `package.json`**
```json
{
  "name": "overnight-agent",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "lint": "pnpm -r lint",
    "typecheck": "pnpm -r typecheck"
  },
  "engines": { "node": ">=20" },
  "packageManager": "pnpm@9"
}
```

**Step 2: Write `pnpm-workspace.yaml`**
```yaml
packages:
  - "packages/*"
  - "packages/oa-shims/*"
```

**Step 3: Write `.gitignore`** — at minimum `node_modules`, `dist`, `coverage`, `.DS_Store`, `*.log`, `*.tsbuildinfo`.

**Step 4: Write `.nvmrc`** — `20`.

**Step 5: Run `pnpm install`** — should succeed with no packages, just write a lockfile.

**Step 6: Commit** — `chore: initialize pnpm workspace`.

### Task 0.2: Add shared TypeScript + Vitest + ESLint config

**Files:**
- Create: `tsconfig.base.json`
- Create: `vitest.config.ts`
- Create: `.eslintrc.cjs`
- Create: `.prettierrc.json`
- Add devDeps to root `package.json`: `typescript`, `vitest`, `@vitest/coverage-v8`, `eslint`, `@typescript-eslint/parser`, `@typescript-eslint/eslint-plugin`, `prettier`, `tsx`.

**Step 1: `tsconfig.base.json`** — strict, ES2022 target, NodeNext module, `declaration: true`, `composite: true`, `forceConsistentCasingInFileNames: true`.

**Step 2: ESLint config** — TypeScript parser, recommended rules. Add a custom rule banning `path.join(...)` without `path.resolve` wrapping in files matching `**/worktree*.ts` and `**/paths*.ts`. (If too clever for v0, fall back to runtime asserts only — capture as ADR-0013 if reduced.)

**Step 3: Vitest config** — node environment, `include: ['packages/**/test/**/*.test.ts']`, `coverage.provider: 'v8'`.

**Step 4: Run `pnpm install`** — confirm devDeps land.

**Step 5: Run `pnpm typecheck && pnpm lint && pnpm test`** — all should be no-ops that exit 0.

**Step 6: Commit** — `chore: shared ts/vitest/eslint config`.

### Task 0.3: Scaffold each package with empty exports

**Files (per package):**
- Create: `packages/<name>/package.json`
- Create: `packages/<name>/tsconfig.json` (extends base)
- Create: `packages/<name>/src/index.ts` (just `export {}`)
- Create: `packages/<name>/test/smoke.test.ts` (`it('compiles', () => expect(true).toBe(true))`)

**Packages to scaffold:** `oa-core`, `oa-cli`, `oa-adapter-claude`, `oa-adapter-codex`, `oa-adapter-opencode`. Shims (`oa-shims/claude`, `/codex`, `/opencode`) get folders only (no node packages — they ship as resource files).

**Step 1:** For each package, write `package.json` with `name`, `version: "0.0.0"`, `main: "dist/index.js"`, `types: "dist/index.d.ts"`, scripts (`build: "tsc -p ."`, `test: "vitest run"`, `lint: "eslint src test"`, `typecheck: "tsc -p . --noEmit"`).
**Step 2:** For each package, write `tsconfig.json` extending base, `outDir: "dist"`, `rootDir: ".", "include": ["src", "test"]`.
**Step 3:** For each package, write the empty `src/index.ts` and the smoke `test/smoke.test.ts`.
**Step 4:** Run `pnpm -r build && pnpm -r test` — every package compiles and the smoke test passes.
**Step 5:** Commit — `chore: scaffold all packages with smoke tests`.

### Task 0.4: Wire `oa-cli` bin

**Files:**
- Modify: `packages/oa-cli/package.json` add `"bin": { "oa": "./dist/cli.js" }`.
- Create: `packages/oa-cli/src/cli.ts` (minimal `#!/usr/bin/env node` Commander stub with `--version`).
- Create: `packages/oa-cli/test/cli.test.ts` (spawn `node dist/cli.js --version`, assert exit 0 and version printed).

**Step 1:** Write the minimal Commander stub: `program.name('oa').version(pkg.version).parse(process.argv)`.
**Step 2:** Add `tsx` script for dev: `"dev": "tsx src/cli.ts"`.
**Step 3:** `pnpm --filter oa-cli build && pnpm --filter oa-cli test`.
**Step 4:** Commit — `feat(cli): bootstrap commander stub with --version`.

---

## Phase 1 — `oa-core` foundations

Goal: paths, atomic JSON, file lock, OAHome resolution, schemas — all the primitives later phases depend on.

### Task 1.1: `paths` module with absolute-path assertions

**Files:**
- Create: `packages/oa-core/src/paths.ts`
- Create: `packages/oa-core/test/paths.test.ts`

**Behavior:** `assertAbs(p: string): asserts p is string` throws `Error('non-absolute path: ' + p)` if not absolute. `oaHome(): string` returns `process.env.OA_HOME ?? path.join(os.homedir(), '.config/overnight-agent')`. `taskDir(taskId)`, `runDir(planId)`, `worktreeDir(taskId)`, `pidfile(planId)`, `socketPath(planId)`, etc. — all return absolute paths and assert their inputs (where applicable).

**Step 1:** Write failing tests:
```ts
it('assertAbs throws on relative', () => expect(() => assertAbs('a/b')).toThrow());
it('assertAbs accepts absolute', () => expect(() => assertAbs('/a/b')).not.toThrow());
it('oaHome respects OA_HOME', () => { process.env.OA_HOME='/tmp/oa'; expect(oaHome()).toBe('/tmp/oa'); });
it('taskDir returns absolute', () => expect(path.isAbsolute(taskDir('t_1'))).toBe(true));
it('runDir returns absolute', ...);
```
**Step 2:** Run, see fail.
**Step 3:** Implement.
**Step 4:** Run, see pass.
**Step 5:** Commit — `feat(core): paths helper with absolute-path assertions`.

### Task 1.2: Atomic JSON writer

**Files:**
- Create: `packages/oa-core/src/atomicJson.ts`
- Create: `packages/oa-core/test/atomicJson.test.ts`

**Behavior:** `readJson<T>(absPath): Promise<T | null>` (null if missing). `writeJsonAtomic(absPath, value): Promise<void>` writes to `<path>.tmp.<pid>.<rand>` then `fs.rename` atomically. Asserts absolute path. Creates parent dirs as needed.

**Step 1:** Failing tests:
- writes a new file under a missing parent dir
- overwrites an existing file atomically (no partial reads — verify by stat-ing pre-rename)
- rejects relative paths
- returns null when file absent
**Step 2:** Run, see fail.
**Step 3:** Implement.
**Step 4:** Run, see pass.
**Step 5:** Commit — `feat(core): atomic JSON read/write`.

### Task 1.3: `oaHome` bootstrapper

**Files:**
- Create: `packages/oa-core/src/home.ts`
- Test: `packages/oa-core/test/home.test.ts`

**Behavior:** `ensureHomeLayout(): Promise<void>` creates `oaHome()`, `tasks/`, `plans/`, `runs/`, `worktrees/`, and writes a default `config.json` (per design §3.1) if absent. Idempotent.

**Step 1:** Failing test using a tmp dir as `OA_HOME`: assert all subdirs exist and config has the documented schema.
**Step 2-4:** Run-fail, implement (use design §3.1 JSON verbatim as the default), run-pass.
**Step 5:** Commit — `feat(core): ensureHomeLayout`.

### Task 1.4: Inbox file lock helper

**Files:**
- Create: `packages/oa-core/src/locks.ts`
- Test: `packages/oa-core/test/locks.test.ts`
- Add dep: `proper-lockfile`.

**Behavior:** `withInboxLock<T>(fn): Promise<T>` acquires a lock on `oaHome()/tasks.json.lock`, runs `fn`, releases. Default 5s wait + 100ms retry.

**Step 1:** Failing test: two concurrent `withInboxLock` calls run sequentially (record start/end timestamps, assert non-overlap).
**Step 2-4:** Run-fail, implement, run-pass.
**Step 5:** Commit — `feat(core): file lock for inbox writes`.

### Task 1.5: Zod schemas for every JSON file

**Files:**
- Create: `packages/oa-core/src/schemas.ts`
- Test: `packages/oa-core/test/schemas.test.ts`
- Add dep: `zod`.

**Schemas:** `ConfigSchema`, `InboxSchema` (tasks.json), `IntakeSchema` (intake.json — every field from design §3.3), `StepsSchema`, `PlanSchema`, `QueueSchema`, plus a discriminated-union `EventSchema` covering every event kind from design §3.6.

Every schema includes `schemaVersion: z.literal(1)`.

**Step 1:** Failing tests:
- valid sample for each schema parses cleanly
- missing `schemaVersion` rejects
- a sample with unknown event kind rejects
- one positive + one negative case per schema
**Step 2-4:** Run-fail, implement, run-pass.
**Step 5:** Commit — `feat(core): zod schemas for all on-disk JSON`.

### Task 1.6: ID generator (taskId, planId)

**Files:** `packages/oa-core/src/ids.ts` + test.

**Behavior:** `newTaskId(): "t_<YYYY-MM-DD>_<base36>"`, `newPlanId(): "p_<YYYY-MM-DD>_<base36>"`. 4-char random suffix. Pure function (inject clock + rng for deterministic tests).

TDD as above. Commit — `feat(core): id generator`.

---

## Phase 2 — Worktree manager

Goal: the absolute-path-enforced wrapper around git worktree ops, per ADR-0002.

### Task 2.1: `slug()` helper for branch-safe name fragments

**Files:** `packages/oa-core/src/slug.ts` + test.

Lowercase, replace non-alnum with `-`, collapse repeats, trim leading/trailing `-`, cap length 32. Tests for unicode, empty input, all-symbols.
Commit — `feat(core): slug helper for branch names`.

### Task 2.2: `WorktreeManager.create()`

**Files:**
- Create: `packages/oa-core/src/worktree.ts`
- Test: `packages/oa-core/test/worktree.test.ts`
- Add dep: `simple-git`.

**Behavior:** `create({taskId, repoDir (abs), baseBranch, taskTitle}): Promise<{absRoot, branch}>`. Asserts both absolute paths. Branch name: `oa/<slug(taskTitle)>-<taskId.slice(-6)>`. Worktree path: `worktreeDir(taskId)`. Errors propagate from git.

**Test setup:** integration test that runs against a temp git repo (`git init`, commit a file, then call `create()` and assert worktree exists at the expected absolute path with the expected branch checked out).

**Step 1:** Failing test that creates a temp repo, calls create, asserts result.
**Step 2-4:** Run-fail, implement using `simple-git`, run-pass.
**Step 5:** Commit — `feat(core): WorktreeManager.create with absolute-path enforcement`.

### Task 2.3: `WorktreeManager.rewindToHead()` (ADR-0003)

**Files:** extend `worktree.ts` + test.

**Behavior:** `rewindToHead(absRoot): Promise<void>` — runs `git reset --hard HEAD && git clean -fdx` in the worktree. Asserts absolute path.

**Test:** create a worktree, dirty it (write untracked file + modify tracked file), call rewindToHead, assert tree is clean and last commit is unchanged.

TDD as above. Commit — `feat(core): rewindToHead for clean-state-before-retry`.

### Task 2.4: `WorktreeManager.remove()` + `commitsSince()`

**Files:** extend `worktree.ts` + test.

`remove(absRoot)`: `git worktree remove --force <absRoot>` and `git branch -D <branchName>`. Asserts absolute path.
`commitsSince(absRoot, sha): Promise<number>`: `git rev-list <sha>..HEAD --count`. Asserts absolute path.

TDD. Commit — `feat(core): worktree remove and commitsSince`.

### Task 2.5: Worktree manager hardening — assertion guards on every public method

**Files:** small refactor + test.

Add a single test: every exported method called with a relative path argument throws. Use a parameterized test enumerating each method.
Commit — `test(core): worktree manager rejects relative paths everywhere`.

---

## Phase 3 — Inbox, queue, plan stores

Goal: the durable state for the user's tasks and sealed plans.

### Task 3.1: `InboxStore` (tasks.json)

**Files:**
- Create: `packages/oa-core/src/stores/inbox.ts`
- Test: `packages/oa-core/test/stores/inbox.test.ts`

**API:** `list(): Promise<TaskIndexEntry[]>`, `get(taskId): Promise<TaskIndexEntry | null>`, `add(entry): Promise<void>`, `setStatus(taskId, status): Promise<void>`, `remove(taskId): Promise<void>`. All wrap mutations in `withInboxLock`.

**Step 1:** Failing tests for each operation.
**Step 2-4:** Run-fail, implement, run-pass.
**Step 5:** Commit — `feat(core): InboxStore with locked writes`.

### Task 3.2: `QueueStore` (queue.json)

Same shape: `list()`, `add(taskIds)`, `remove(taskId)`, `clear()`, `snapshot(): Promise<string[]>` for sealing.

TDD. Commit — `feat(core): QueueStore`.

### Task 3.3: `PlanStore`

**API:** `create({taskListIds, overrides}): Promise<plan>` (writes plans/<id>.json with status `sealed`, and flips each task to `queued` via InboxStore), `get(planId)`, `list()`, `setStatus(planId, status)`. Plans immutable except status.

TDD with integration: create a plan from two queued task ids, verify both inbox entries flipped to `queued` and plan file exists.
Commit — `feat(core): PlanStore with seal semantics`.

---

## Phase 4 — Intake parser, materialization, references

Goal: the front door — parsing source `task.md`, materializing the per-task folder, handling references per ADR-0007.

### Task 4.1: Top-level step parser

**Files:** `packages/oa-core/src/intake/parseSteps.ts` + test.

**Behavior:** `parseTopLevelSteps(md: string): { steps: Step[], warnings: string[] }`. Detects top-level `- [ ]`, `- [x]`, `1.` items. Each step's `spec` includes the item line plus all indented sub-bullets/paragraphs until the next top-level item or EOF. Returns `{steps:[]}` for empty/no-top-level. Detects mixed (top-level checkbox **and** top-level heading-as-step) and emits warning.

**Tests:**
- Pure checkbox plan parses N steps.
- Pure numbered plan parses N steps.
- Sub-bullets attach to the right parent.
- Empty plan returns `[]` with warning.
- Mixed checkbox+heading at top level emits a `mixed` warning.

TDD. Commit — `feat(core): top-level step parser`.

### Task 4.2: Reference materializer (ADR-0007)

**Files:** `packages/oa-core/src/intake/references.ts` + test.

**API:** `materializeReferences(taskFolderAbs, refs: ReferenceInputs): Promise<MaterializedRef[]>`. For each input ref:
- `kind:"file"` — copy to `taskFolderAbs/references/<basename>`, compute sha256, return `{kind, src, copiedTo, sha256}`.
- `kind:"dir"` — do not copy. If inside a git repo (detect via `git -C <dir> rev-parse --show-toplevel`), record `gitRepo` + current `gitHead`. Return `{kind, src, gitRepo?, gitHead?}`.
- `kind:"memory"` — read content, sha256, return `{kind, src, sha256}`.

**Tests:** integration with a temp git repo for the dir case; assert no copy happened for dirs; assert sha256 stable for file & memory.

TDD. Commit — `feat(core): tiered reference materializer`.

### Task 4.3: HANDOFF.md generator

**Files:** `packages/oa-core/src/intake/handoff.ts` + test.

**Behavior:** `renderHandoff(intake, steps): string` — produces a markdown rollup with sections: Overview (title, project, baseBranch), Executor (agent/model), Reviewer (agent/model), Verify command, Bootstrap script, Strategy toggles, References (rendered list with paths/SHAs), Step list (one entry per parsed step). Pure function (easy to snapshot test).

**Tests:** snapshot test against a fixture intake payload.

TDD. Commit — `feat(core): HANDOFF.md generator`.

### Task 4.4: `intakeSubmit()` end-to-end

**Files:**
- Create: `packages/oa-core/src/intake/submit.ts`
- Test: `packages/oa-core/test/intake/submit.integration.test.ts`

**Behavior:** `intakeSubmit(payload): Promise<{taskId}>`:
1. Validate via `IntakeSchema`.
2. Generate `taskId`, derive `taskFolder = taskDir(taskId)`.
3. Create folder.
4. Materialize references → write into payload before persisting.
5. Write `intake.json`, `source-plan.md` (the original markdown body — must be in payload as `sourcePlanMd: string`), parsed `steps.json`.
6. Render and write `HANDOFF.md`.
7. Touch empty `PROGRESS.md` and `FINDINGS.md`.
8. Append entry to `tasks.json` via `InboxStore.add` with status `pending`.

**Test:** integration with tmp `OA_HOME` + tmp git repo as project — submit a sample payload, assert all files exist and inbox lists the new task.

TDD. Commit — `feat(core): intakeSubmit end-to-end`.

---

## Phase 5 — `AgentAdapter` interface + claude adapter

Goal: the executor abstraction (ADR-0009) plus the first concrete adapter.

### Task 5.1: Define `AgentAdapter` types in `oa-core`

**Files:** `packages/oa-core/src/adapter/types.ts` + (re-export from `index.ts`).

Copy the interface verbatim from design §5.1. Pure types — no runtime test required, but add a compile-only test that constructs a minimal mock satisfying the interface (catches accidental signature drift).

Commit — `feat(core): AgentAdapter interface + AgentRunOpts/Result types`.

### Task 5.2: Spawn helper with timeout, stdout-cap, signal

**Files:**
- Create: `packages/oa-core/src/adapter/spawn.ts`
- Test: `packages/oa-core/test/adapter/spawn.test.ts`
- Add dep: `execa`.

**Behavior:** `spawnHeadless(opts: SpawnOpts): Promise<AgentRunResult>` — wraps execa with: open `stdoutPath`/`stderrPath` for write, pipe child stdout to it while counting bytes, kill with SIGTERM if `>= stdoutCapBytes`, kill on `timeoutSec` elapsed, kill on `signal.aborted`. Returns the result struct.

**Tests:** integration tests that spawn `node -e '...'`:
- normal exit → exitCode 0, durationMs > 0, no kill flags.
- runs past timeout → `timedOut: true`, `killedBy: "timeout"`, exitCode null.
- writes > stdoutCapBytes → `stdoutCapHit: true`, `killedBy: "stdoutCap"`.
- abort signal fires → `killedBy: "signal"`.

TDD. Commit — `feat(core): headless spawn with timeout/cap/signal`.

### Task 5.3: `oa-adapter-claude` implementation

**Files:**
- Create: `packages/oa-adapter-claude/src/index.ts`
- Test: `packages/oa-adapter-claude/test/claude.test.ts`

**Behavior:** Implements `AgentAdapter` for `id: "claude"`. `defaultModel: "opus"`. `capabilities: { supportsSessionId: true, supportsStructuredOutput: true }`. `run(opts)` reads `opts.promptPath`, invokes `claude -p "<promptText>" --model <model> --output-format stream-json [...extraArgs]` via `spawnHeadless`. Captures sessionId from stream-json events when surfaced.

Verify exact flag set against the installed CLI at impl time — record any required adjustments as ADR-0013 if the headless interface differs from documented.

**Tests:** with `claude` mocked via PATH-shimmed test bin (a tiny shell script in `test/fixtures/bin/claude` that echoes a known stream-json), confirm:
- `run()` returns expected shape
- sessionId is parsed when present in the mocked output
- absolute-path assertion fires for relative `cwd` / `promptPath`

TDD. Commit — `feat(adapter-claude): headless claude AgentAdapter`.

### Task 5.4: Adapter registry

**Files:** `packages/oa-core/src/adapter/registry.ts` + test.

**Behavior:** `getAdapter(id): Promise<AgentAdapter>` — dynamic `import("oa-adapter-<id>")`, instantiates and caches the singleton. Throws on unknown id.

TDD with the claude adapter as the live target plus a stubbed `oa-adapter-codex` returning a sentinel.
Commit — `feat(core): adapter registry with dynamic loading`.

---

## Phase 6 — Context injector, verify pipeline, fix loop

Goal: the heart of the inner loop (per design §4.5).

### Task 6.1: Tail-message parser (ADR-0008)

**Files:** `packages/oa-core/src/verify/tail.ts` + test.

**Behavior:** `parseTail(stdoutText, kind: "oa-status" | "oa-review"): {ok, value? , reason?}`. Finds the **last** fenced ```kind block, parses JSON, validates against the appropriate Zod sub-schema. Returns reason on failure.

**Tests:** pure function tests covering: missing block, invalid JSON, valid status, multiple blocks (last wins), reviewer with empty/non-empty issues.

TDD. Commit — `feat(core): tail-message parser for oa-status / oa-review`.

### Task 6.2: Verify gates — tail + commit + cmd

**Files:** `packages/oa-core/src/verify/gates.ts` + test.

**Behavior:** Three pure-ish functions:
- `verifyTail(stdoutText) → GateResult`
- `verifyCommit(absWorktree, stepStartSha) → GateResult` (uses worktree manager's `commitsSince`)
- `verifyCmd(absWorktree, command) → GateResult` (uses execa with `cwd`, exit 0 = ok)

Each returns `{ok: bool, eventKind: string, detail?: any}`.

TDD with a temp git repo for the commit gate and shell `true`/`false` for the cmd gate.
Commit — `feat(core): verify gates (tail/commit/cmd)`.

### Task 6.3: Reviewer invocation + review gate

**Files:** `packages/oa-core/src/verify/review.ts` + test.

**Behavior:** `runReviewer({adapter, model, extraArgs, promptPath, stepDiff, blockOn}): Promise<{issues: ReviewIssue[], blocking: ReviewIssue[]}>`. Composes a reviewer prompt: `<promptPath content> + step diff (git diff <stepStartSha>..HEAD) + protocol-review block`. Writes to a tmp prompt file (absolute path). Calls `adapter.run`. Parses `oa-review` tail block. Filters by `blockOn`.

**Test:** mock adapter returning a hand-crafted stdout file with a known `oa-review` block; assert correct parsing and filtering.

TDD. Commit — `feat(core): reviewer invocation and gate`.

### Task 6.4: Context injector (ADR-0006)

**Files:** `packages/oa-core/src/verify/context.ts` + test.

**Behavior:** `assemblePrompt(input): string` — pure function taking `{handoff, progress, findings, stepSpec, gitContext, references, openReviewIssues?, isRetry?}` and returning the prompt body, ending with the protocol-status block. Stable section order.

**Tests:** snapshot test against a fixture; one test verifying retry includes the "previous attempt aborted" phrasing; one verifying open review issues are formatted with priority + file + finding.

TDD. Commit — `feat(core): per-step context injector`.

### Task 6.5: PROGRESS.md and FINDINGS.md mutators

**Files:** `packages/oa-core/src/state/progress.ts`, `findings.ts` + tests.

`progress.mark(taskFolderAbs, stepN, status, detail?)` rewrites PROGRESS.md from a current snapshot. `findings.append(taskFolderAbs, summary)` appends a dated entry. Both atomic via `writeJsonAtomic` for the JSON twin (an internal `_progress.json` source-of-truth) and a stable markdown rendering for human reading.

TDD. Commit — `feat(core): PROGRESS/FINDINGS mutators`.

### Task 6.6: Fix-loop synthesizer

**Files:** `packages/oa-core/src/verify/fixLoop.ts` + test.

**Behavior:** Pure function `synthesizeFixContext(blockingIssues): { openReviewIssues: ReviewIssue[] }`. v0 just passes through — extension point for richer summarization later.

TDD (trivial). Commit — `feat(core): fix-loop synthesizer (v0 passthrough)`.

### Task 6.7: Inner-loop integration test

**Files:** `packages/oa-core/test/innerLoop.integration.test.ts`

Wire context injector → mock adapter → verify gates → fix loop together for one step in a temp git repo. Assert: a single attempt happy-path completes; a tail-fail attempt retries; an AI-judge with P1 issues triggers a fix attempt; max-loops exhaustion marks `blocked-needs-human`.

This is the largest integration test in Phase 6. Mock adapter is a function-driven stub.
Commit — `test(core): inner-loop integration`.

---

## Phase 7 — Supervisor, daemonization, control socket, resume

Goal: the orchestrator that drains a plan, with daemonization (ADR-0010 + ADR-0012) and resume (ADR-0003).

### Task 7.1: Events writer

**Files:** `packages/oa-core/src/events/writer.ts` + test.

**Behavior:** `EventWriter(absPath)` — opens append stream, `emit(kind, fields)` writes one JSON line with `ts` + `kind` + fields. Validates against `EventSchema` in dev mode (skip validation in prod for speed). `close()` flushes and closes.

TDD. Commit — `feat(core): events.jsonl writer`.

### Task 7.2: Bootstrap runner

**Files:** `packages/oa-core/src/supervisor/bootstrap.ts` + test.

**Behavior:** `runBootstrap({absWorktree, script, timeoutSec, eventWriter, taskId})`: writes script to tmp file, exec via execa with timeout, capture stdout/stderr to events. Returns `{ok: bool, exitCode, durationMs}`.

TDD with shell `true`/`false` and a sleep for timeout.
Commit — `feat(core): bootstrap runner`.

### Task 7.3: Supervisor outer loop (sequential v0)

**Files:**
- Create: `packages/oa-core/src/supervisor/runPlan.ts`
- Test: `packages/oa-core/test/supervisor/runPlan.integration.test.ts`

**Behavior:** `runPlan({planId, signal})` — loads plan, for each `taskId`: load intake/steps, create worktree, record `stepStartSha`, run bootstrap (if any), enter inner loop for each step, mark task end. Honors `planBudgetSec`. Emits `run.start` / `task.start` / `task.end` / `run.stop` events. Catches signal abort to stop gracefully.

This task is large but its sub-pieces are tested. The integration test wires real WorktreeManager + a mock adapter against a tmp git repo and asserts all events appear in the right order for a 1-task / 2-step plan.

TDD with a thin stub adapter that always succeeds.
Commit — `feat(core): supervisor outer loop (sequential)`.

### Task 7.4: Daemonization

**Files:**
- Create: `packages/oa-core/src/supervisor/daemon.ts`
- Test: `packages/oa-core/test/supervisor/daemon.integration.test.ts`

**Behavior:** `detachAndRun(planId)` — `child_process.spawn(process.execPath, [supervisorEntry, planId], { detached:true, stdio:[ 'ignore', fs.openSync(eventsLogPath,'a'), fs.openSync(eventsLogPath,'a')] })`, then `child.unref()` and exit. The supervisor entry writes the pidfile on startup, traps SIGTERM/SIGINT for graceful stop.

**Tests:** integration test that detaches a tiny supervisor entry that just writes a marker file and exits, then asserts the launcher returned and the marker eventually appeared.

TDD. Commit — `feat(core): detached daemon spawner`.

### Task 7.5: Pidfile lifecycle

**Files:** `packages/oa-core/src/supervisor/pidfile.ts` + test.

**Behavior:** `acquire(planId)` — write pidfile atomically; refuse if a live pid already exists (`process.kill(pid, 0)` doesn't throw). `release(planId)` — unlink. `isStale(planId): boolean` — read pidfile, kill 0 → false if alive, true otherwise.

TDD. Commit — `feat(core): pidfile lifecycle`.

### Task 7.6: Control socket (ADR-0012)

**Files:**
- Create: `packages/oa-core/src/supervisor/controlSocket.ts`
- Test: `packages/oa-core/test/supervisor/controlSocket.test.ts`

**Behavior:** Server side: `serve(absPath, handlers): Server` listens on a Unix domain socket, reads length-prefixed JSON, dispatches by `type`, replies, closes per message. Cleans up on close. Unlinks stale socket file before bind. Client side: `request(absPath, message): Promise<reply>`.

Message types: `stop {now: bool}`, `status {}`. v0 ships these two.

**Tests:** integration where server is started, client sends each type, asserts replies. Test stale-socket cleanup by leaving a leftover socket file before serve().

TDD. Commit — `feat(core): daemon control socket`.

### Task 7.7: Wire control socket into supervisor

Extend `runPlan` and `daemon` to: open the control socket on startup; on `stop {now:false}` raise the abort signal; on `stop {now:true}` SIGTERM the in-flight adapter spawn directly; on `status` return the live state struct.

Add tests: launch a tiny supervisor against a mock adapter that loops, send stop, verify it exits.
Commit — `feat(core): supervisor responds to control socket`.

### Task 7.8: Resume protocol (ADR-0003)

**Files:** `packages/oa-core/src/supervisor/resume.ts` + test.

**Behavior:** `resumePlan(planId)` — same as `runPlan` but first: detect stale pidfile (clean up); for every task whose stored state is `running` or any of its steps is `running`, call `WorktreeManager.rewindToHead`; mark in-flight steps back to `pending`; emit `run.resume {rewoundSteps}`; then enter outer loop skipping `done` tasks/steps.

**Tests:** integration that runs a plan, kills the daemon mid-step (simulate by abort signal + leftover pidfile), then resumes and asserts the rewound step is re-executed.

TDD. Commit — `feat(core): resume with clean rewind`.

---

## Phase 8 — `oa-cli` surface

Goal: every command in design §2.2 wired through to oa-core.

Each task: write a Commander subcommand, a CLI integration test (spawn `node dist/cli.js <args>` with `OA_HOME` pointed at tmp), and commit.

### Task 8.1: `oa intake submit --payload <json>`

Reads JSON from `--payload <inline>` or `--payload-file <abs>`. Validates schema. Calls `intakeSubmit`. Prints the new `taskId`.
Commit — `feat(cli): oa intake submit`.

### Task 8.2: `oa intake list|show|rm`

`list` = inbox listing in a table (`chalk` columns), filterable by `--status`. `show <id>` = pretty-print intake.json + steps.json. `rm <id>` = remove from inbox; prompt unless `-y`.
Commit — `feat(cli): oa intake list/show/rm`.

### Task 8.3: `oa queue add|ls|rm|clear`

Wraps `QueueStore`. `add` accepts multiple ids.
Commit — `feat(cli): oa queue commands`.

### Task 8.4: `oa plan create|show|ls`

`create` accepts `--from-queue` (default) or `--tasks <ids>`, plus `--budget`, `--parallel`. Prints sealed plan summary.
Commit — `feat(cli): oa plan commands`.

### Task 8.5: `oa run [--detach] [--dry-run]`

Foreground = call `runPlan` directly. `--detach` = call `detachAndRun`, print pid + paths. `--dry-run` = print taskList ordering and skip execution.
Commit — `feat(cli): oa run`.

### Task 8.6: `oa stop [--now]`

Resolve plan’s socket path; send `stop` message. If socket connect fails, fall back to SIGTERM via pidfile.
Commit — `feat(cli): oa stop`.

### Task 8.7: `oa status [<planId>] [--json]`

Default: status of latest running plan. Sends `status` message via socket; if no running daemon, derives state from latest events.jsonl. `--json` for slash-command shims.
Commit — `feat(cli): oa status`.

### Task 8.8: `oa tail [<planId>] [--raw]`

`tail -f` over events.jsonl with pretty rendering by default; `--raw` prints lines verbatim.
Commit — `feat(cli): oa tail`.

### Task 8.9: `oa rerun <planId>`

Calls `resumePlan`. Same `--detach` option.
Commit — `feat(cli): oa rerun`.

### Task 8.10: `oa archive <id>`

Move `tasks/<id>/` or `runs/<id>/` to a sibling `_archive/` directory. Update inbox status.
Commit — `feat(cli): oa archive`.

---

## Phase 9 — `SUMMARY.md` renderer

Goal: the morning report (design §6).

### Task 9.1: Events reader

**Files:** `packages/oa-core/src/events/reader.ts` + test.
`readAll(planId): Promise<Event[]>`. Streams file, parses each line, skips invalid lines (logging to stderr). Used by both `oa status` and the summary renderer.
Commit — `feat(core): events.jsonl reader`.

### Task 9.2: SUMMARY.md renderer

**Files:** `packages/oa-core/src/summary/render.ts` + snapshot test against a fixture event log.

Sections: per-taskList outcome table (status/duration/commits/blocked reason), per-step status with fix-loop counts, open P0/P1 issues, links (relative paths) to per-step prompt.md / stdout.log.
Commit — `feat(core): SUMMARY.md renderer`.

### Task 9.3: `oa summary <planId>` command + auto-render on plan completion

Wire renderer into `runPlan` final cleanup so SUMMARY.md is always written on plan end (even on stop). Add `oa summary <planId>` to regenerate on demand.
Commit — `feat(cli): oa summary; auto-render on plan end`.

---

## Phase 10 — codex + opencode adapters

### Task 10.1: `oa-adapter-codex`

Mirror Phase 5.3 structure. Invocation shape (verify against installed CLI at impl time):
`codex exec --model <model> -- <promptPath>` or whatever current headless flag set is.

Capture sessionId if codex surfaces one. If not: `supportsSessionId: false`.

TDD with a shimmed `codex` test bin.
Commit — `feat(adapter-codex): headless codex AgentAdapter`.

### Task 10.2: `oa-adapter-opencode`

Same pattern. Invocation shape verified at impl time.
Commit — `feat(adapter-opencode): headless opencode AgentAdapter`.

### Task 10.3: Adapter registry test against all three

Extend the registry test to load each adapter and assert `id` + `defaultModel`.
Commit — `test(core): registry returns all three adapters`.

---

## Phase 11 — Per-host shims (`oa-shims/`)

Goal: ship the slash commands and skill bundles users install into their host agents.

Each shim is a directory of resource files (markdown/JSON). No JS to compile. `pnpm install` copies them via a small build script if needed.

### Task 11.1: Claude Code shim

**Files (under `packages/oa-shims/claude/`):**
- `commands/oa-intake.md` — slash-command spec that:
  - accepts `<path>` or inline content
  - parses top-level steps and rejects on zero
  - conducts the Step 2 Q&A (project dir, base branch, references, FINDINGS seed)
  - conducts the Step 3 Q&A (executor, reviewer, bootstrap, verify, strategy toggles)
  - assembles the JSON payload and runs `oa intake submit --payload-file <tmp>`
- `commands/oa-queue.md` — show pending tasks + queue, multi-select add/remove → `oa queue ...`
- `commands/oa-plan.md` — preview + seal → `oa plan create --from-queue ...`
- `commands/oa-status.md` — `oa status --json` then formatted render
- `skills/oa-intake/SKILL.md` — the underlying skill referenced by `oa-intake.md` if Claude Code skills surface separately
- `README.md` — installation steps

Validate the markdown against Claude Code's slash-command schema by linking the file into a local `.claude/commands/` and running it once interactively.

Commit — `feat(shims-claude): /oa-intake /oa-queue /oa-plan /oa-status`.

### Task 11.2: Codex shim

Same scope, in Codex's slash-command format. Codex specifics verified at impl time.
Commit — `feat(shims-codex): slash commands`.

### Task 11.3: Opencode shim

Same scope, opencode binding format.
Commit — `feat(shims-opencode): slash commands`.

---

## Phase 12 — End-to-end + docs

### Task 12.1: End-to-end smoke against a fake agent

**Files:** `packages/oa-cli/test/e2e/fakeAgent.test.ts`

Set up: tmp `OA_HOME`, tmp git repo, a `FAKE_AGENT` script on PATH that emits a successful `oa-status` block and creates a commit. Run: `oa intake submit` (with hand-crafted payload pointing at the fake adapter), `oa queue add`, `oa plan create`, `oa run` (foreground), assert events log, SUMMARY.md, branch + commit shape, trailer fields.

Commit — `test(e2e): full happy path with fake agent`.

### Task 12.2: End-to-end resume test

Run a plan with a fake adapter that hangs; force-stop with `oa stop --now`; assert worktree state; `oa rerun`; assert resume + clean re-execution; assert events.jsonl shows `run.resume` with rewound step.
Commit — `test(e2e): resume after force-stop`.

### Task 12.3: Top-level README + docs polish

Write `README.md` documenting: install (`pnpm install -g oa-cli`), shim install steps per host agent, the intake → queue → plan → run lifecycle, where state lives, common operations, links to design + ADRs.

Commit — `docs: top-level README`.

### Task 12.4: Final verification pass

Run `@superpowers:verification-before-completion` skill: `pnpm typecheck && pnpm lint && pnpm test` across the workspace; smoke `oa --version`; manually exercise `oa intake submit` → `oa run --dry-run` against a real fake agent payload; review SUMMARY.md output.

If anything fails, do not mark done — fix and re-run.

Commit any final fixups with descriptive messages.

---

## Cross-cutting reminders

- **Absolute paths.** Every new public function in worktree-touching modules must `assertAbs` its path inputs. Add a test for it, parameterized over the API surface.
- **ADRs.** Capture any architectural decision made during implementation as `docs/adr/0013-*.md` and onward (one per decision). Don't bundle multiple decisions into one ADR.
- **TDD.** No implementation commit without a preceding failing test commit (or a test+impl commit pair if the test is trivial).
- **YAGNI.** v0 deferred items (design §8) are explicitly out of scope. Do not implement them speculatively.
- **DRY for events / paths.** Event kinds and path constructors live in one module each; do not duplicate string literals.

---

## Out of scope for this plan (deferred per design §8)

These do not appear above and must not be added during v0 implementation: `pushOnFinish` + draft-PR creation, pause-as-distinct-state, token-spend caps, cross-plan parallelism, auto-prune of runs, teardown scripts, multi-phase bootstrap hooks, plugin loader for third-party adapters, remote/SSH execution, cron/scheduling, email/webhook/macOS notifications, cloud sync.
