# NightShift-inspired Hardening Implementation Plan (v0.2.0)

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Borrow four reliability/safety primitives from the NightShift skill — post-compact context re-injection, stall detection with soft/hard attempt thresholds, plan-level graduated error budget, and an opt-in macOS sandbox-exec profile around the agent invocation — to close known gaps in our long-running overnight flow.

**Architecture:**
- Claude-Code-only hook bundled into `@soulerou/oa-cli`'s shim tree; `oa shims install` gains an idempotent upsert-merge into `.claude/settings.json`.
- Stall, error-budget, and sandbox features all land in `@soulerou/oa-core` (supervisor / schemas / spawn primitive) and therefore support **claude, codex, and opencode** identically.
- All runtime changes are **additive + back-compat** via defaulted schema fields; existing sealed plans from v0.1.0 read and execute unchanged.
- Two ADRs split by theme: ADR-0015 covers the harness-side reliability changes (hook + stall + budget); ADR-0016 covers the sandbox safety change alone, because its blast radius is largest.

**Tech Stack:** TypeScript 6 (NodeNext + verbatimModuleSyntax), Node ≥22, pnpm 9, Zod 4, vitest 4, commander 14, execa 9, simple-git 3. macOS (Darwin 24+) for the sandbox path.

**Prerequisites:**
- Fresh branch cut from `main` at commit `1197971` (v0.1.0 release landing) or later.
- `pnpm -r typecheck && lint && build && test` green before starting — 435 tests, same baseline as the v0.1.0 release commit.
- npm `@soulerou` scope already owned; `NPM_TOKEN` granular token with 2FA-bypass already in `~/.npmrc`.

---

## Adapter / platform compatibility matrix

| Feature | claude | codex | opencode | macOS | Linux |
|---|:-:|:-:|:-:|:-:|:-:|
| Compact-recovery hook (Phase 2) | ✅ | n/a¹ | n/a¹ | ✅ | ✅² |
| Stall detection (Phase 3) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Graduated error budget (Phase 4) | ✅ | ✅ | ✅ | ✅ | ✅ |
| macOS sandbox-exec (Phase 5) | ✅ | ✅ | ✅ | ✅ | ❌³ |

¹ codex and opencode use single-shot `exec`/`run` invocations with no mid-session auto-compaction, so the problem the hook solves doesn't apply. The **env vars** set by the supervisor (`OA_TASK_DIR`, `OA_CURRENT_PROMPT`) are propagated to all three adapters unconditionally.
² Hook markup is Claude Code feature; where Claude Code runs, the hook runs, regardless of OS.
³ Linux Landlock or AppArmor equivalents are a post-v0.2 follow-up; `oa run --sandbox` fails fast on non-macOS with a clear error rather than silently doing nothing.

---

## Global conventions for every task

- **TDD, red-green-commit.** Each task below follows: write failing test → run, observe red → implement the minimum → run, observe green → commit. No implementation code before a failing test. For load-bearing assertions (marked 🔒 in the task), sabotage the production code temporarily, confirm the test goes red, then restore — this proves the test actually guards the invariant.
- **Absolute paths.** Anything that touches worktree or path construction obeys ADR-0002: `path.resolve`, `assertAbs`, no bare `path.join`. ESLint enforces on `**/worktree*.ts` + `**/paths*.ts`.
- **Atomic writes.** New on-disk artifacts (sandbox `.sb` profiles, merged `settings.json`) use `writeJsonAtomic` / `writeFileAtomic`. No `fs.writeFile` on final paths.
- **Schema versioning.** New fields added to existing schemas keep `schemaVersion: 1`; the shape is additive. Any breaking change would bump to `schemaVersion: 2` with a migration — which is explicitly **not** part of this plan.
- **Commit cadence.** One commit per task. Format matches existing repo convention: `feat(scope): one-line subject`, with a 2–4 line body when non-obvious, and the `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` trailer.

---

## Phase 0 — Branch and version setup

### Task 0.1: Cut the v0.2 work branch

**Files:**
- None (git only).

**Step 1:** Verify clean tree. Run `git -C /Users/souler/Nextcloud/test/OvernightAgent status --porcelain`. Expected: empty output.
**Step 2:** Create branch. Run `git -C /Users/souler/Nextcloud/test/OvernightAgent switch -c feat/v0.2-nightshift-hardening`.
**Step 3:** Verify. Run `git branch --show-current`. Expected: `feat/v0.2-nightshift-hardening`.

No commit here — branch creation is free.

### Task 0.2: Add a `CHANGELOG.md` at repo root

**Files:**
- Create: `CHANGELOG.md`

**Step 1:** No test — pure docs scaffold.
**Step 2:** Write the file:

```markdown
# Changelog

All notable changes to the OvernightAgent monorepo are recorded here. We follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and SemVer across all `@soulerou/*` packages.

## [Unreleased]

### Added
- (placeholder — populated per task during v0.2 work)

## [0.1.0] — 2026-04-20

### Added
- Initial public release of `@soulerou/{oa-core, oa-cli, oa-adapter-claude, oa-adapter-codex, oa-adapter-opencode}`.
- See `README.md` and ADR-0001 through ADR-0014 for the feature set at v0.1.0.
```

**Step 3:** Commit.

```sh
git add CHANGELOG.md
git commit -m "docs: add CHANGELOG.md with 0.1.0 baseline"
```

---

## Phase 1 — Record the architectural decisions

### Task 1.1: Write ADR-0015 — Harness hardening (compact-recovery + stall + error-budget)

**Files:**
- Create: `docs/adr/0015-harness-hardening-post-compact-stall-budget.md`

**Step 1:** No test — ADRs are written artifacts, not code.
**Step 2:** Draft the ADR covering three changes as one theme ("NightShift-inspired hardening"). Required sections per the repo's ADR style (see ADR-0009 / 0014 as templates):

- **Status / Date / Deciders / Related** (ADR-0006 context injection, ADR-0008 tail-message protocol, ADR-0011 strategy toggles).
- **Context** — the three problems with concrete examples (silent compaction losing fix-loop context mid-step; attempt budget gives no warning before exhaustion; plan-wide circuit-breaker missing).
- **Decision** — three sub-sections:
  1. **Compact-recovery via Claude Code `SessionStart[matcher=compact]` hook.** Ships in `@soulerou/oa-cli`'s `dist/shims/claude/hooks/compact-recovery.json`. Installed by `oa shims install` via a **sentinel-string merge** (search `.claude/settings.json` hooks for the literal `# oa:hook=compact-recovery:v1` inside each entry's `command`; filter + append + atomic write). Hook content reads `$OA_TASK_DIR/PROGRESS.md` and points the agent at `$OA_CURRENT_PROMPT`; both env vars are set by the supervisor before every adapter spawn and propagate to all three adapters. The hook is a no-op (`exit 0`) when `OA_TASK_DIR` is unset. Claude Code only.
  2. **Stall detection — soft/hard attempt thresholds.** `VerifyConfig.attempts` becomes `z.union([z.number().int().positive(), z.object({ soft, hard })])` with an intake-time normalization transform. Bare number `N` → `{ soft: Math.max(1, Math.ceil(N * 0.6)), hard: N }` when `N >= 2`, else `{ soft: N, hard: N }`. `synthesizeFixContext` (ADR-0006) appends a P0 stall-warning block once attempt ≥ soft. A new event kind `step.stall` fires **at most once per step** (in-memory guard in `runPlan`) when first crossing soft.
  3. **Graduated error budget.** New optional `PlanSchema.errorBudget: { warnAfter?: number; stopAfter?: number }` (both default `undefined` — no cap). Counter ticks **only on `step.end(status: 'blocked')`**; `task.end(status: 'failed')` is excluded (the user's call — it reflects bootstrap/verify-cmd failures which are orthogonal). Counter is derived by re-reading `events.jsonl` at plan start + incremented in-memory afterward, so `oa rerun` of a budget-exhausted plan will abort at the same point unless the budget is bumped (intended, documented). Two new event kinds `plan.budget.warn` / `plan.budget.exhausted`. When exhausted, remaining pending tasks get terminal status `skipped` (new value on `TaskStatus`) and the SUMMARY renderer shows an abort banner.
- **Consequences** — positive (catches three real failure modes), negative (schema surface grows; rerun-same-budget footgun), follow-ups (Linux landlock, on-by-default sandbox, hook support for future codex/opencode session APIs).

**Step 3:** Commit.

```sh
git add docs/adr/0015-harness-hardening-post-compact-stall-budget.md
git commit -m "docs(adr): ADR-0015 — harness hardening (compact-recovery + stall + budget)"
```

### Task 1.2: Write ADR-0016 — macOS sandbox-exec profile

**Files:**
- Create: `docs/adr/0016-macos-sandbox-exec-profile.md`

**Step 1:** No test.
**Step 2:** Draft. Key sections:

- **Status:** Accepted. **Date:** 2026-04-20. **Related:** ADR-0002 (worktree absolute paths), ADR-0015.
- **Context** — worktree = git isolation, not fs isolation. A drifted agent can read `~/.ssh/id_rsa`, write `~/.zshrc`, etc. NightShift's `sandbox-exec -f` gives kernel-level fs restriction on macOS for zero per-call overhead.
- **Decision** —
  - New subsystem `@soulerou/oa-core/src/sandbox/`: `template.sb` + `render.ts`.
  - Profile rendered per attempt into `<runDir>/<taskId>/step-NN/attempt-NN/sandbox.sb` (parallel-safe; follows existing per-attempt dir convention).
  - Wrapped at `spawnHeadless` level: if `opts.sandboxProfile` set and `process.platform === 'darwin'`, prepend argv with `['sandbox-exec', '-f', opts.sandboxProfile]`. One integration point, three adapters benefit.
  - Scope: wraps only the adapter run. `bootstrap.script`, `verify.cmd`, git ops run outside the sandbox.
  - Opt-in for v0.2: flag `oa run --sandbox` OR intake field `intake.sandbox.enabled: boolean`. On by default in v0.3 (revisit after usage data).
  - Extensibility v0.2: `intake.sandbox.extraAllowPaths: string[]` — each entry inlined as `(allow file-read* file-write* (subpath "<path>"))`. No arbitrary sexp escape in v0.2.
  - Non-macOS: supervisor fails fast before the plan starts (not per-task) with `sandbox requested but unsupported on <platform>` — do not partially run.
- **Consequences** — positive (kernel-level safety, orthogonal to git isolation), negative (macOS-only in v0.2, template maintenance as tool ecosystems shift homes), follow-ups (Linux Landlock, on-by-default in v0.3).

**Step 3:** Commit.

```sh
git add docs/adr/0016-macos-sandbox-exec-profile.md
git commit -m "docs(adr): ADR-0016 — macOS sandbox-exec profile around adapter runs"
```

---

## Phase 2 — Compact-recovery hook (Claude Code only)

### Task 2.1: Create the compact-recovery hook fragment

**Files:**
- Create: `packages/oa-shims/claude/hooks/compact-recovery.json`

**Step 1:** No test yet — this is a static resource that Phase 2's merge tests will consume.
**Step 2:** Write the hook fragment as a standalone JSON file (merged into `settings.json` by `oa shims install`):

```json
{
  "SessionStart": [
    {
      "matcher": "compact",
      "hooks": [
        {
          "type": "command",
          "command": "# oa:hook=compact-recovery:v1\nbash -c 'if [ -z \"${OA_TASK_DIR:-}\" ]; then exit 0; fi; echo \"=== OvernightAgent post-compact recovery ===\"; echo \"Your Claude Code session was just auto-compacted mid-run. The full per-attempt prompt (tail-protocol, fix-loop findings, references) is at $OA_CURRENT_PROMPT — re-read it before continuing.\"; if [ -f \"$OA_TASK_DIR/PROGRESS.md\" ]; then echo; echo \"## PROGRESS.md\"; cat \"$OA_TASK_DIR/PROGRESS.md\"; fi; echo; echo \"Find the next [ ] item in PROGRESS.md and resume work on that step. Do not start over from the top.\"'"
        }
      ]
    }
  ]
}
```

The leading `# oa:hook=compact-recovery:v1` comment is the sentinel that lets the merge function recognize our entry on re-install and upsert it idempotently.

**Step 3:** Commit.

```sh
git add packages/oa-shims/claude/hooks/compact-recovery.json
git commit -m "feat(shims): add Claude Code compact-recovery hook fragment (ADR-0015)"
```

### Task 2.2: Extend `bundle-shims.mjs` to copy the hooks/ tree

**Files:**
- Modify: `packages/oa-cli/scripts/bundle-shims.mjs` — add `'hooks'` to the `SUBDIRS` list.
- Test (indirect): `packages/oa-cli/test/shims.test.ts` (existing fake source tree already includes `commands/` + `claude/skills/`; we'll extend in task 2.4).

**Step 1:** Write a failing test in `test/shims.test.ts`'s `describe('installShims')` block that expects a `hooks/` file to be installed alongside `commands/`. Test gist:

```ts
it('bundles and respects a claude hooks/ tree when installing into project scope', async () => {
  const hooksSrc = path.resolve(sourceRoot, 'claude', 'hooks');
  await fs.mkdir(hooksSrc, { recursive: true });
  await fs.writeFile(
    path.resolve(hooksSrc, 'compact-recovery.json'),
    JSON.stringify({ SessionStart: [{ matcher: 'compact', hooks: [{ type: 'command', command: '# oa:hook=compact-recovery:v1\nexit 0' }] }] }),
    'utf8',
  );
  const results = await installShims({ host: 'claude', sourceRoot, home, cwd, log: () => {} });
  const merged = JSON.parse(await fs.readFile(path.resolve(cwd, '.claude', 'settings.json'), 'utf8'));
  expect(merged.hooks.SessionStart[0].hooks[0].command).toContain('oa:hook=compact-recovery:v1');
  expect(results[0]!.copied).toContain(path.resolve(cwd, '.claude', 'settings.json'));
});
```

**Step 2:** Run: `pnpm --filter @soulerou/oa-cli test -- shims.test.ts`. Expected: FAIL (the test references merge logic that doesn't exist yet, and `SUBDIRS` doesn't include `hooks`).
**Step 3:** Add `'hooks'` to `SUBDIRS` in `bundle-shims.mjs`. Rebuild with `pnpm --filter @soulerou/oa-cli build`.
**Step 4:** Test still fails because the merge logic itself is missing — deliberately. Proceed to Task 2.3.
**Step 5:** No commit yet — bundle change + merge logic land together in Task 2.3's commit.

### Task 2.3: Implement sentinel-based `settings.json` merge in `installShims`

**Files:**
- Modify: `packages/oa-cli/src/commands/shims.ts` — add a new `mergeClaudeSettings` helper invoked by `installOne` when the host is `claude` and a bundled `hooks/` tree is present.
- Modify: `packages/oa-cli/test/shims.test.ts` — complete the failing test from Task 2.2 + add two more.

**Step 1:** Expand the failing test plus write two more:

```ts
it('upserts an existing oa:hook entry on re-install without duplicating', async () => {
  // pre-seed settings.json with a prior version of our hook + a user's own hook
  const settingsPath = path.resolve(cwd, '.claude', 'settings.json');
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify({
    hooks: {
      SessionStart: [
        { matcher: 'compact', hooks: [{ type: 'command', command: '# oa:hook=compact-recovery:v0\necho old' }] },
        { matcher: 'startup', hooks: [{ type: 'command', command: 'echo user-wrote-this' }] },
      ],
    },
  }, null, 2), 'utf8');
  // ...build fake hooks/ source tree as in Task 2.2...
  await installShims({ host: 'claude', sourceRoot, home, cwd, log: () => {} });
  const merged = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
  // our v0 was replaced by v1 — count of matcher:compact entries stays 1
  const compactEntries = merged.hooks.SessionStart.filter((e: any) => e.matcher === 'compact');
  expect(compactEntries).toHaveLength(1);
  expect(compactEntries[0].hooks[0].command).toContain('oa:hook=compact-recovery:v1');
  // user's own startup hook preserved
  const startup = merged.hooks.SessionStart.filter((e: any) => e.matcher === 'startup');
  expect(startup).toHaveLength(1);
  expect(startup[0].hooks[0].command).toBe('echo user-wrote-this');
});

it('creates settings.json atomically when absent', async () => {
  // no pre-existing file. install should create .claude/settings.json from scratch.
  // assert: file exists, parses as JSON, contains our hook, no temp file left behind
});
```

**Step 2:** Run: `pnpm --filter @soulerou/oa-cli test -- shims.test.ts`. Expected: 3 FAILs.
**Step 3:** Implement `mergeClaudeSettings(existingAbsPath, newHookObj)`:
- Read existing `settings.json` if present; default to `{}`. Handle ENOENT cleanly.
- For each key in `newHookObj` (e.g. `SessionStart`), ensure `existing.hooks[key]` is an array. Filter existing entries: keep if NONE of the entry's `hooks[].command` strings contain `# oa:hook=<id>:` — where `<id>` is extracted from the new entry's command. Append the new entry.
- Write via `writeFileAtomic` (import from `@soulerou/oa-core`).
- In `installOne`, after the `commands/` + `skills/` copy, scan `<hostSrc>/hooks/*.json` and for each file call `mergeClaudeSettings(settingsPath, JSON.parse(file))`.
- 🔒 load-bearing: the filter must survive a v-bump — `# oa:hook=compact-recovery:v1` and `# oa:hook=compact-recovery:v9999` both count as ours.

**Step 4:** Run: `pnpm --filter @soulerou/oa-cli test`. Expected: all 3 PASS + existing 25 still green → 28 total.
**Step 5:** Commit.

```sh
git add packages/oa-cli/src/commands/shims.ts packages/oa-cli/test/shims.test.ts packages/oa-cli/scripts/bundle-shims.mjs
git commit -m "feat(cli): oa shims install merges Claude Code hooks via sentinel upsert (ADR-0015)"
```

### Task 2.4: Supervisor sets `OA_TASK_DIR` and `OA_CURRENT_PROMPT` in adapter env

**Files:**
- Modify: `packages/oa-core/src/supervisor/runPlan.ts` — in the per-attempt spawn path, extend the `env` field passed to `adapter.run(opts)`.
- Test: `packages/oa-core/test/supervisor/runPlan.integration.test.ts` (existing) OR a new small focused unit-ish test on the env assembly helper.

**Step 1:** Write a failing test that runs a fixture adapter which echoes `process.env` to its stdout, and asserts `OA_TASK_DIR` + `OA_CURRENT_PROMPT` are both present with correct absolute values. Use the existing `test/fixtures/bin/claude` pattern from the claude adapter test as a template.

**Step 2:** Run: `pnpm --filter @soulerou/oa-core test -- runPlan`. Expected: the new test fails with "expected env to contain OA_TASK_DIR" (or similar).

**Step 3:** Locate the `adapter.run` call site in `runPlan.ts` (the per-attempt branch). Extend `env` to spread the caller's env + two additions:

```ts
env: {
  ...opts.env,
  OA_TASK_DIR: paths.taskDir(taskId),                    // absolute, oa-core/paths.ts
  OA_CURRENT_PROMPT: attemptPromptPath,                  // absolute, already computed above
},
```

`attemptPromptPath` is the same string passed as `promptPath` to `adapter.run` — just pass it twice.

**Step 4:** Run: `pnpm --filter @soulerou/oa-core test -- runPlan`. Expected: PASS.

**Step 5:** Commit.

```sh
git add packages/oa-core/src/supervisor/runPlan.ts packages/oa-core/test/supervisor/*.ts
git commit -m "feat(core): export OA_TASK_DIR + OA_CURRENT_PROMPT env vars to adapters (ADR-0015)"
```

### Task 2.5: Maintain `.oa-current-prompt.md` symlink in the worktree root

**Files:**
- Modify: `packages/oa-core/src/supervisor/runPlan.ts` — after `assemblePrompt` writes `attempt-NN/prompt.md`, create/update the symlink at `<worktree>/.oa-current-prompt.md` → absolute `prompt.md` path.
- Modify: `packages/oa-core/src/supervisor/resume.ts` — remove stale symlink as part of the rewind.
- Test: `packages/oa-core/test/supervisor/runPlan.integration.test.ts` — add assertions on the symlink after an attempt.

**Step 1:** Write a failing assertion inside the existing per-attempt integration test: after `attempt.start`, assert `<worktree>/.oa-current-prompt.md` exists and `fs.readlink(...)` returns a path that ends with the expected `attempt-NN/prompt.md` suffix.

**Step 2:** Run tests: FAIL.

**Step 3:** Implement. Import `node:fs/promises` if not already. After `assemblePrompt` returns:

```ts
const symlinkPath = path.resolve(worktreePath, '.oa-current-prompt.md');
await fs.rm(symlinkPath, { force: true });    // safe whether file/symlink/missing
await fs.symlink(attemptPromptPath, symlinkPath);
```

Absolute paths throughout (assertAbs both).

In `resume.ts`, during per-task rewind, `fs.rm(<worktree>/.oa-current-prompt.md, { force: true })` so a stale symlink doesn't mislead the post-compact hook on the new attempt's first session.

**Step 4:** Run tests: PASS. Also re-run full `pnpm -r test` to ensure no integration test regressed on the new file.

**Step 5:** Commit.

```sh
git add packages/oa-core/src/supervisor/runPlan.ts packages/oa-core/src/supervisor/resume.ts packages/oa-core/test/
git commit -m "feat(core): maintain .oa-current-prompt.md symlink in worktree (ADR-0015)"
```

### Task 2.6: Phase 2 smoke + README update

**Files:**
- Modify: `README.md` — add a bullet under the "Host-agent shims" section describing the new hook.
- Modify: `packages/oa-shims/claude/README.md` — describe the hook + re-running `oa shims install` to upgrade.

**Step 1:** No code test (docs only). Smoke by running the built CLI end-to-end:

```sh
pnpm --filter @soulerou/oa-cli build
TMP=$(mktemp -d /tmp/oa-hook-smoke-XXXX)
cd "$TMP"
node /Users/souler/Nextcloud/test/OvernightAgent/packages/oa-cli/dist/cli.js shims install --host claude
cat "$TMP/.claude/settings.json"    # expect a SessionStart[compact] entry with oa:hook=compact-recovery:v1
cd / && rm -rf "$TMP"
```

**Step 2:** Update README and shim README.
**Step 3:** Commit.

```sh
git add README.md packages/oa-shims/claude/README.md
git commit -m "docs: describe compact-recovery hook + oa shims install upgrade path"
```

---

## Phase 3 — Stall detection (adapter-agnostic)

### Task 3.1: Extend `VerifyConfig.attempts` schema to `number | {soft,hard}` with normalization

**Files:**
- Modify: `packages/oa-core/src/schemas.ts` — the `VerifyConfig` object.
- Test: `packages/oa-core/test/schemas.test.ts` — extend the existing table-driven intake schema tests.

**Step 1:** Write failing tests:

```ts
it('accepts a bare number and normalizes soft=ceil(n*0.6), hard=n', () => {
  const parsed = VerifyConfigSchema.parse({ attempts: 5 /* other required fields */ });
  expect(parsed.attempts).toEqual({ soft: 3, hard: 5 });
});
it('accepts explicit {soft, hard} and preserves it', () => {
  const parsed = VerifyConfigSchema.parse({ attempts: { soft: 2, hard: 7 } /* ... */ });
  expect(parsed.attempts).toEqual({ soft: 2, hard: 7 });
});
it('rejects soft >= hard in explicit form', () => {
  expect(() => VerifyConfigSchema.parse({ attempts: { soft: 5, hard: 5 } })).toThrow(/soft must be < hard/);
});
it('when hard = 1, keeps soft = 1 (no warning possible)', () => {
  const parsed = VerifyConfigSchema.parse({ attempts: 1 });
  expect(parsed.attempts).toEqual({ soft: 1, hard: 1 });
});
```

**Step 2:** Run: FAIL (`attempts` still a bare number).
**Step 3:** Implement. Use a Zod union + `.transform`:

```ts
const AttemptsSchema = z.union([
  z.number().int().positive(),
  z.object({ soft: z.number().int().positive(), hard: z.number().int().positive() })
    .refine((o) => o.soft < o.hard, { message: 'soft must be < hard' }),
]).transform((raw) => {
  if (typeof raw === 'number') {
    if (raw <= 1) return { soft: raw, hard: raw };
    return { soft: Math.max(1, Math.ceil(raw * 0.6)), hard: raw };
  }
  return raw;
});
```

Use in `VerifyConfig`. Anywhere consuming `attempts: number` (grep `attempts`) updates to `.hard`. Most callers already read `attempts` as "the cap" — swap to `attempts.hard`.

**Step 4:** Run full oa-core tests: expect PASS. Likely some downstream tests need `attempts.hard` fixups — fix them in this task.
**Step 5:** Commit.

```sh
git add packages/oa-core/src/schemas.ts packages/oa-core/test/ packages/oa-core/src/
git commit -m "feat(core): VerifyConfig.attempts now supports soft/hard thresholds (ADR-0015)"
```

### Task 3.2: Add `step.stall` event kind

**Files:**
- Modify: `packages/oa-core/src/events/schema.ts` (or wherever `EventSchema` lives — check `src/schemas.ts` / `src/events/`).
- Test: `packages/oa-core/test/events/schema.test.ts`.

**Step 1:** Failing test asserting `EventSchema.parse({ ts: '...', kind: 'step.stall', taskId: 't1', stepN: 1, attempt: 3, soft: 3, hard: 5 })` returns a parsed event of matching shape.

**Step 2:** Run: FAIL.
**Step 3:** Add a new discriminated-union member to `EventSchema`:

```ts
z.object({
  kind: z.literal('step.stall'),
  ts: z.string().datetime(),
  taskId: IdSchema,
  stepN: z.number().int().nonneg(),
  attempt: z.number().int().positive(),
  soft: z.number().int().positive(),
  hard: z.number().int().positive(),
}).strict(),
```

**Step 4:** Run: PASS. Event-count doc in README/CLAUDE.md already says "28 typed event kinds" — we'll update to 29 in Phase 6.
**Step 5:** Commit.

```sh
git add packages/oa-core/src/ packages/oa-core/test/
git commit -m "feat(core): add step.stall event kind (ADR-0015)"
```

### Task 3.3: Inject stall warning into fix-loop context when attempt ≥ soft

**Files:**
- Modify: `packages/oa-core/src/verify/fixLoop.ts` (home of `synthesizeFixContext`).
- Test: `packages/oa-core/test/verify/fixLoop.test.ts`.

**Step 1:** Failing test:

```ts
it('prepends a P0 stall warning when attempt >= soft', () => {
  const ctx = synthesizeFixContext({
    attempt: 3, thresholds: { soft: 3, hard: 5 },
    issues: [{ priority: 'P1', title: 'x', rationale: 'y' }],
  });
  expect(ctx.blocks[0]!.kind).toBe('stall-warning');
  expect(ctx.blocks[0]!.priority).toBe('P0');
  expect(ctx.blocks[0]!.text).toMatch(/STALL WARNING/);
  expect(ctx.blocks[0]!.text).toMatch(/attempt 3.*5/);
});
it('does not inject a stall warning when attempt < soft', () => {
  const ctx = synthesizeFixContext({
    attempt: 2, thresholds: { soft: 3, hard: 5 }, issues: [],
  });
  expect(ctx.blocks.find((b) => b.kind === 'stall-warning')).toBeUndefined();
});
```

**Step 2:** Run: FAIL (the function signature doesn't currently take `thresholds`).
**Step 3:** Extend `synthesizeFixContext` signature with `thresholds: { soft: number; hard: number }`. Inside, before appending existing issue blocks:

```ts
if (opts.attempt >= opts.thresholds.soft) {
  blocks.push({
    kind: 'stall-warning',
    priority: 'P0',
    text: `⚠️ STALL WARNING: this is attempt ${opts.attempt} of ${opts.thresholds.hard}. ` +
          `${opts.thresholds.hard - opts.attempt} attempts remain before the step is marked BLOCKED. ` +
          `If the prior strategy isn't working, change approach materially — don't just re-run the same commands.`,
  });
}
```

Update all callers (supervisor's inner loop) to pass `thresholds: verifyConfig.attempts`.

**Step 4:** Run: PASS + all downstream supervisor tests still green.
**Step 5:** 🔒 Sabotage check: delete the `blocks.push({ kind: 'stall-warning', ... })` — rerun test, observe red; restore.
**Step 6:** Commit.

```sh
git add packages/oa-core/src/verify/fixLoop.ts packages/oa-core/test/verify/
git commit -m "feat(core): inject P0 stall warning into fix-loop at soft threshold (ADR-0015)"
```

### Task 3.4: Emit `step.stall` once per step on threshold crossing

**Files:**
- Modify: `packages/oa-core/src/supervisor/runPlan.ts` — per-step state tracks `stallEmitted: Set<string>` keyed by `taskId:stepN`.
- Test: `packages/oa-core/test/supervisor/runPlan.integration.test.ts` — with a fixture adapter that forces failure on every attempt up to the hard cap.

**Step 1:** Failing test — run a plan with `attempts: { soft: 2, hard: 4 }` against an always-failing adapter. Assert the resulting `events.jsonl` contains exactly **one** `step.stall` event, with `attempt=2` (first crossing).

**Step 2:** Run: FAIL.
**Step 3:** Implement:

```ts
const stallKey = `${taskId}:${stepN}`;
if (attempt >= soft && !stallEmitted.has(stallKey)) {
  await events.emit({ kind: 'step.stall', taskId, stepN, attempt, soft, hard });
  stallEmitted.add(stallKey);
}
```

Place right before the `assemblePrompt` → `adapter.run` sequence for each attempt.

**Step 4:** Run: PASS.
**Step 5:** 🔒 Sabotage check: remove the `stallEmitted.add(...)` line; rerun test, observe the event emitted N-soft+1 times; restore.
**Step 6:** Commit.

```sh
git add packages/oa-core/src/supervisor/runPlan.ts packages/oa-core/test/supervisor/
git commit -m "feat(core): emit step.stall at most once per step on threshold crossing (ADR-0015)"
```

### Task 3.5: SUMMARY renderer surfaces stalled-but-recovered steps

**Files:**
- Modify: `packages/oa-core/src/summary/render.ts`.
- Test: `packages/oa-core/test/summary/render.test.ts`.

**Step 1:** Failing test: given an event stream with a `step.stall` followed by a `step.end(done)` for the same `(taskId, stepN)`, the rendered SUMMARY's step row has a `⚠ stalled` marker next to the step title. Given a stream where `step.stall` is followed by `step.end(blocked)`, the marker is `⚠ stalled→blocked`.

**Step 2:** Run: FAIL.
**Step 3:** Extend the renderer. In the per-step accumulator already used for the morning report, track a `stallRecovered: boolean` per `(taskId, stepN)`. On render, if stall + `done` → append `⚠ stalled`; if stall + `blocked` → append `⚠ stalled→blocked`.
**Step 4:** Run: PASS.
**Step 5:** Commit.

```sh
git add packages/oa-core/src/summary/render.ts packages/oa-core/test/summary/
git commit -m "feat(core): SUMMARY marks steps that stalled before recovery or blocking (ADR-0015)"
```

---

## Phase 4 — Graduated error budget

### Task 4.1: Add `skipped` to `TaskStatus`

**Files:**
- Modify: `packages/oa-core/src/schemas.ts` — `TaskStatus` z.enum.
- Test: `packages/oa-core/test/schemas.test.ts` — already has a table of valid statuses; extend.

**Step 1:** Failing test asserting `TaskStatus.parse('skipped')` returns `'skipped'`.
**Step 2:** Run: FAIL.
**Step 3:** Add `'skipped'` to the enum list.
**Step 4:** Run: PASS.
**Step 5:** Commit.

```sh
git add packages/oa-core/src/schemas.ts packages/oa-core/test/schemas.test.ts
git commit -m "feat(core): add 'skipped' task status for budget-abort terminal state (ADR-0015)"
```

### Task 4.2: Add `PlanSchema.errorBudget` optional field

**Files:**
- Modify: `packages/oa-core/src/schemas.ts` — `PlanSchema`.
- Test: `packages/oa-core/test/schemas.test.ts`.

**Step 1:** Failing tests:
- An existing sealed plan on disk (v0.1.0 shape, no `errorBudget`) parses successfully and emerges with `errorBudget === undefined`.
- Both `{ warnAfter: 2 }` alone and `{ stopAfter: 5 }` alone are legal.
- `{ warnAfter: 5, stopAfter: 3 }` is rejected (warn must be ≤ stop).

**Step 2:** Run: FAIL.
**Step 3:** Implement:

```ts
errorBudget: z.object({
  warnAfter: z.number().int().nonneg().optional(),
  stopAfter: z.number().int().nonneg().optional(),
}).refine(
  (b) => b.warnAfter === undefined || b.stopAfter === undefined || b.warnAfter <= b.stopAfter,
  { message: 'warnAfter must be <= stopAfter' },
).optional(),
```

**Step 4:** Run: PASS.
**Step 5:** Commit.

```sh
git add packages/oa-core/src/schemas.ts packages/oa-core/test/schemas.test.ts
git commit -m "feat(core): add plan.errorBudget { warnAfter, stopAfter } schema (ADR-0015)"
```

### Task 4.3: Add `plan.budget.warn` + `plan.budget.exhausted` event kinds

**Files:**
- Modify: `packages/oa-core/src/events/schema.ts` (same file as 3.2).
- Test: `packages/oa-core/test/events/schema.test.ts`.

**Step 1:** Two failing tests, mirroring Task 3.2 — validate both kinds with expected payload (`blockedCount`, `threshold`).
**Step 2:** Run: FAIL.
**Step 3:** Add both members to the discriminated union.
**Step 4:** Run: PASS.
**Step 5:** Commit.

```sh
git add packages/oa-core/src/ packages/oa-core/test/events/
git commit -m "feat(core): add plan.budget.{warn,exhausted} event kinds (ADR-0015)"
```

### Task 4.4: Counter + circuit in `runPlan`

**Files:**
- Modify: `packages/oa-core/src/supervisor/runPlan.ts`.
- Test: `packages/oa-core/test/supervisor/runPlan.integration.test.ts`.

**Step 1:** Failing integration test — 3 tasks, each with a fixture adapter guaranteed to block. Plan `errorBudget: { warnAfter: 1, stopAfter: 2 }`. Expected events after the run: `step.end(blocked)` for tasks 1 + 2; `plan.budget.warn` (blockedCount=1, threshold=1); `plan.budget.exhausted` (blockedCount=2, threshold=2); task 3 has no `task.start` event; task 3's final status in tasks index is `skipped`; plan status is `partial` (or a new dedicated `aborted-budget-exhausted` — decide on `partial` for minimal schema change).

**Step 2:** Run: FAIL.
**Step 3:** Implement:
- At plan start, scan existing events.jsonl for pre-existing `step.end(blocked)` count (durability across `oa rerun`).
- Maintain `blockedCount` in memory, incrementing on each `step.end(blocked)` emit.
- After each task's `task.end`, check thresholds. If `blockedCount === warnAfter` (exact match so we emit once), emit `plan.budget.warn`. If `blockedCount >= stopAfter`, emit `plan.budget.exhausted`, break the outer task loop.
- After the break, for each remaining pending task: update its task-status to `skipped` via the inbox/task-progress writer; do NOT emit synthetic `task.start`/`task.end` events (clearer audit trail — the SUMMARY renderer reads the `skipped` status directly from the task index, not from events).

**Step 4:** Run: PASS.
**Step 5:** 🔒 Sabotage check: remove the `break` after `plan.budget.exhausted` — observe task 3 running + failing; restore.
**Step 6:** Commit.

```sh
git add packages/oa-core/src/supervisor/runPlan.ts packages/oa-core/test/supervisor/
git commit -m "feat(core): plan-level error budget aborts remaining tasks at stopAfter (ADR-0015)"
```

### Task 4.5: SUMMARY aborted-plan banner + skipped-task row

**Files:**
- Modify: `packages/oa-core/src/summary/render.ts`.
- Test: `packages/oa-core/test/summary/render.test.ts`.

**Step 1:** Failing test: given an event stream with `plan.budget.exhausted`, the rendered SUMMARY opens with a `⛔ PLAN ABORTED — error budget exhausted (N/M blocked)` banner and includes a per-task section listing `skipped` tasks with a `skipped (budget exhausted)` annotation.

**Step 2:** Run: FAIL.
**Step 3:** Implement: renderer detects the budget-exhausted event, prepends a banner section before the standard task tables; `skipped` tasks rendered with the annotation.

**Step 4:** Run: PASS.
**Step 5:** Commit.

```sh
git add packages/oa-core/src/summary/render.ts packages/oa-core/test/summary/
git commit -m "feat(core): SUMMARY banner + skipped annotation for budget-aborted plans (ADR-0015)"
```

---

## Phase 5 — macOS sandbox-exec profile

### Task 5.1: Sandbox template + renderer

**Files:**
- Create: `packages/oa-core/src/sandbox/template.sb`
- Create: `packages/oa-core/src/sandbox/render.ts`
- Create: `packages/oa-core/test/sandbox/render.test.ts`

**Step 1:** Failing renderer tests:

```ts
it('renders worktree + home into the template with both homebrew prefixes', () => {
  const out = renderSandboxProfile({
    worktreeAbs: '/abs/worktrees/foo',
    homeAbs: '/Users/souler',
    extraAllowPaths: [],
  });
  expect(out).toMatch(/\(allow file-read\* file-write\* \(subpath "\/abs\/worktrees\/foo"\)\)/);
  expect(out).toMatch(/\(allow file-read\* \(subpath "\/opt\/homebrew"\)\)/);
  expect(out).toMatch(/\(allow file-read\* \(subpath "\/usr\/local"\)\)/);
  expect(out).toMatch(/\(allow file-read\* \(subpath "\/Users\/souler\/\.claude"\)\)/);
});
it('emits one extraAllowPaths line per entry with subpath syntax', () => {
  const out = renderSandboxProfile({
    worktreeAbs: '/abs/w',
    homeAbs: '/Users/u',
    extraAllowPaths: ['/opt/data', '/Users/u/.shared-cache'],
  });
  expect(out).toMatch(/\(subpath "\/opt\/data"\)/);
  expect(out).toMatch(/\(subpath "\/Users\/u\/\.shared-cache"\)/);
});
it('throws if worktreeAbs or homeAbs are not absolute', () => {
  expect(() => renderSandboxProfile({ worktreeAbs: 'rel', homeAbs: '/h', extraAllowPaths: [] })).toThrow(/absolute/);
});
```

**Step 2:** Run: FAIL.
**Step 3:** Write `template.sb` as a base profile with `{{WORKTREE}}`, `{{HOME}}`, `{{EXTRA_ALLOWS}}` placeholders. Include:
- Default deny.
- Allow process fork/exec, signal self.
- Read-only access to `/usr`, `/bin`, `/Library`, `/opt/homebrew`, `/usr/local`, `/private/tmp`, `/private/var`, `/dev`, `/etc`, `/var`.
- Read+write on the worktree (`{{WORKTREE}}`) and `/tmp` + `/private/tmp`.
- Read on `{{HOME}}/.claude`, `{{HOME}}/.npm-global`, `{{HOME}}/.config`, `{{HOME}}/.bun`, `{{HOME}}/.nvm`, `{{HOME}}/.cargo`, `{{HOME}}/.rustup`.
- Network outbound to TCP `*:443`.
- `system-socket`, `sysctl-read`, `mach-lookup`.
- `{{EXTRA_ALLOWS}}` placeholder line.

Write `render.ts` as a small function: `assertAbs(worktreeAbs); assertAbs(homeAbs);` and for each `extraAllowPaths` entry `assertAbs`. Read the template via `new URL('./template.sb', import.meta.url)` (bundled as an asset in the build — we need to include `.sb` in the `files` allowlist and ensure tsc copies it, which it won't by default — so manually copy in a small `prebuild` step or inline the template as a string literal in `render.ts`).

Decision: **inline the template as a template literal in `render.ts`** to avoid build/package complications. The `template.sb` file in this task is reference-only, mirroring the inlined string.

**Step 4:** Run: PASS.
**Step 5:** Commit.

```sh
git add packages/oa-core/src/sandbox/ packages/oa-core/test/sandbox/
git commit -m "feat(core): render macOS sandbox-exec profile from worktree + home (ADR-0016)"
```

### Task 5.2: Add `intake.sandbox` schema

**Files:**
- Modify: `packages/oa-core/src/schemas.ts` — `IntakeSchema`.
- Test: `packages/oa-core/test/schemas.test.ts`.

**Step 1:** Failing tests:
- Legacy intake without `sandbox` field parses to `sandbox: undefined`.
- `sandbox: { enabled: true }` valid, `extraAllowPaths: []` default.
- `sandbox: { enabled: true, extraAllowPaths: ['/opt/data'] }` valid.
- `sandbox: { enabled: true, extraAllowPaths: ['relative'] }` **rejected** (must be absolute).
- `sandbox: { enabled: false }` valid (explicitly disabled).

**Step 2:** Run: FAIL.
**Step 3:** Implement:

```ts
sandbox: z.object({
  enabled: z.boolean(),
  extraAllowPaths: z.array(z.string().refine((p) => path.isAbsolute(p), { message: 'extraAllowPaths must be absolute' })).optional().default([]),
}).optional(),
```

**Step 4:** Run: PASS.
**Step 5:** Commit.

```sh
git add packages/oa-core/src/schemas.ts packages/oa-core/test/schemas.test.ts
git commit -m "feat(core): intake.sandbox { enabled, extraAllowPaths } schema (ADR-0016)"
```

### Task 5.3: Materialize sandbox profile per attempt + thread into `AgentRunOpts`

**Files:**
- Modify: `packages/oa-core/src/adapter/types.ts` — add optional `sandboxProfile?: string` to `AgentRunOpts`.
- Modify: `packages/oa-core/src/supervisor/runPlan.ts` — before each adapter spawn, if `intake.sandbox?.enabled && platform === 'darwin'`, render + write `<attemptDir>/sandbox.sb` via `writeFileAtomic`, and set `opts.sandboxProfile` to the absolute path.
- Test: `packages/oa-core/test/supervisor/runPlan.integration.test.ts`.

**Step 1:** Failing test: plan with `intake.sandbox.enabled: true`; assert the rendered `.sb` file appears at the expected per-attempt path and that `adapter.run` was called with `sandboxProfile` set to that absolute path. Use the existing fixture-adapter spy pattern.

**Step 2:** Run: FAIL.
**Step 3:** Implement type change + runPlan materialization.
**Step 4:** Run: PASS.
**Step 5:** Commit.

```sh
git add packages/oa-core/src/adapter/types.ts packages/oa-core/src/supervisor/runPlan.ts packages/oa-core/test/supervisor/
git commit -m "feat(core): materialize per-attempt sandbox.sb and pass to adapters (ADR-0016)"
```

### Task 5.4: Wrap argv with `sandbox-exec -f` in `spawnHeadless`

**Files:**
- Modify: `packages/oa-core/src/adapter/spawn.ts`.
- Test: `packages/oa-core/test/adapter/spawn.test.ts`.

**Step 1:** Failing tests:
- When `opts.sandboxProfile` absent → argv unchanged.
- When `sandboxProfile` set on darwin → argv becomes `['sandbox-exec', '-f', <profile>, <original command>, ...<original args>]`; `command` becomes `'sandbox-exec'`.
- When `sandboxProfile` set on non-darwin → throws `sandbox-exec requested but unavailable on <platform>`.

**Step 2:** Run: FAIL.
**Step 3:** Implement. In `spawnHeadless`, first branch:

```ts
let finalCmd = opts.command;
let finalArgs = opts.args;
if (opts.sandboxProfile !== undefined) {
  if (process.platform !== 'darwin') {
    throw new Error(`sandbox-exec requested but unavailable on ${process.platform}`);
  }
  assertAbs(opts.sandboxProfile);
  finalCmd = 'sandbox-exec';
  finalArgs = ['-f', opts.sandboxProfile, opts.command, ...opts.args];
}
// ... rest of spawn uses finalCmd/finalArgs
```

For platform detection in tests, use `vi.stubGlobal('process', { ...process, platform: 'linux' })` or spy on `process.platform` via `Object.defineProperty`.

**Step 4:** Run: PASS.
**Step 5:** Commit.

```sh
git add packages/oa-core/src/adapter/spawn.ts packages/oa-core/test/adapter/
git commit -m "feat(core): spawnHeadless wraps argv with sandbox-exec when profile provided (ADR-0016)"
```

### Task 5.5: Fail-fast in `runPlan` when sandbox requested on non-darwin

**Files:**
- Modify: `packages/oa-core/src/supervisor/runPlan.ts` — at plan start, if any intake requests sandbox and platform is not darwin, throw before any task starts.
- Test: `packages/oa-core/test/supervisor/runPlan.integration.test.ts`.

**Step 1:** Failing test: run a plan with `intake.sandbox.enabled: true` with `process.platform` mocked to `'linux'`. Assert the function throws with message matching `/sandbox.*unsupported.*linux/i` **before** writing any events to the run's `events.jsonl`.

**Step 2:** Run: FAIL.
**Step 3:** Implement the pre-flight check.
**Step 4:** Run: PASS.
**Step 5:** Commit.

```sh
git add packages/oa-core/src/supervisor/runPlan.ts packages/oa-core/test/supervisor/
git commit -m "feat(core): runPlan fails fast when sandbox requested on non-macOS (ADR-0016)"
```

### Task 5.6: CLI `oa run --sandbox` flag

**Files:**
- Modify: `packages/oa-cli/src/commands/run.ts` — add `--sandbox` option.
- Test: `packages/oa-cli/test/commands.test.ts`.

**Step 1:** Failing test asserting that running `oa run --sandbox <planId>` forwards `{ sandbox: true }` to the underlying `runPlan` invocation (via an injected-mock pattern if needed, or via spy on the `runPlan` import).

**Step 2:** Run: FAIL.
**Step 3:** Implement: `.option('--sandbox', 'wrap each adapter spawn in macOS sandbox-exec (requires intake.sandbox.enabled or overrides it)')`. The flag's semantics: if set, override `intake.sandbox.enabled = true` for every task in the plan at runtime (not by mutating the sealed plan).

**Step 4:** Run: PASS.
**Step 5:** Commit.

```sh
git add packages/oa-cli/src/commands/run.ts packages/oa-cli/test/commands.test.ts
git commit -m "feat(cli): oa run --sandbox opt-in flag for macOS sandbox-exec (ADR-0016)"
```

### Task 5.7: macOS-gated smoke test — real `sandbox-exec` boundaries

**Files:**
- Create: `packages/oa-core/test/sandbox/sandbox-exec.integration.test.ts`

**Step 1:** Write a darwin-gated test:

```ts
import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { renderSandboxProfile } from '../../src/sandbox/render.js';

const darwinOnly = process.platform === 'darwin' ? describe : describe.skip;

darwinOnly('sandbox-exec boundaries (macOS only)', () => {
  it('allows writes inside the declared worktree and denies outside', async () => {
    const tmp = await fs.mkdtemp(path.resolve(os.tmpdir(), 'oa-sandbox-'));
    const worktree = path.resolve(tmp, 'wt');
    const outside = path.resolve(tmp, 'outside');
    await fs.mkdir(worktree, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    const profile = renderSandboxProfile({ worktreeAbs: worktree, homeAbs: os.homedir(), extraAllowPaths: [] });
    const profilePath = path.resolve(tmp, 'p.sb');
    await fs.writeFile(profilePath, profile, 'utf8');

    // allowed
    await execa('sandbox-exec', ['-f', profilePath, 'touch', path.resolve(worktree, 'ok.txt')]);
    await expect(fs.access(path.resolve(worktree, 'ok.txt'))).resolves.toBeUndefined();

    // denied
    await expect(
      execa('sandbox-exec', ['-f', profilePath, 'touch', path.resolve(outside, 'denied.txt')]),
    ).rejects.toThrow();
    await expect(fs.access(path.resolve(outside, 'denied.txt'))).rejects.toThrow();

    await fs.rm(tmp, { recursive: true, force: true });
  });
});
```

**Step 2:** On darwin: run and expect PASS. On non-darwin: the suite is `describe.skip`ped.
**Step 3:** Commit.

```sh
git add packages/oa-core/test/sandbox/sandbox-exec.integration.test.ts
git commit -m "test(sandbox): darwin-gated integration — inside/outside worktree boundaries (ADR-0016)"
```

---

## Phase 6 — Docs, version bump, release

### Task 6.1: Update `README.md`, `CLAUDE.md`, `HANDOFF.md`

**Files:**
- Modify: `README.md` (Features, CLI reference — add `oa run --sandbox`, events count 28 → 32).
- Modify: `CLAUDE.md` (sandbox mention, event kinds, new env-var contract, compact-recovery mention under shims).
- Modify: `HANDOFF.md` (v0.2.0 status, ADR-0015 + ADR-0016 references, test count).

**Step 1:** Manual review. No code test.
**Step 2:** Writes.
**Step 3:** Commit.

```sh
git add README.md CLAUDE.md HANDOFF.md
git commit -m "docs: README/CLAUDE.md/HANDOFF for v0.2.0 (ADR-0015 + 0016)"
```

### Task 6.2: Update `CHANGELOG.md` with `[0.2.0]` entry

**Files:**
- Modify: `CHANGELOG.md`

**Step 1:** Move bullets from `[Unreleased]` into a new `[0.2.0] — YYYY-MM-DD` section. Sub-sections: Added (4 features), Changed (schema extensions that are back-compat), Fixed (symlink cleanup on resume). Link to both ADRs.
**Step 2:** Commit.

```sh
git add CHANGELOG.md
git commit -m "docs(changelog): 0.2.0 — compact-recovery, stall, budget, sandbox-exec"
```

### Task 6.3: Bump all five packages to `0.2.0`

**Files:**
- Modify: all 5 `packages/*/package.json` via `pnpm version:minor`.

**Step 1:** No test.
**Step 2:** Run from repo root: `pnpm version:minor` — this executes `pnpm -r exec npm version minor --no-git-tag-version` per the v0.1.0 setup, bumping each of the 5 packages to `0.2.0`.
**Step 3:** Verify: `grep '"version"' packages/*/package.json` — all five show `"0.2.0"`.
**Step 4:** Commit.

```sh
git add packages/*/package.json
git commit -m "chore(release): bump all @soulerou/* packages to 0.2.0"
```

### Task 6.4: Final verification sweep

**Files:**
- None (verification only).

**Step 1:** Clear tmp sockets from prior test runs (known flake mitigation, per FINDINGS.md):

```sh
rm -rf /var/folders/*/T/oa-test-* 2>/dev/null || true
```

**Step 2:** Run `pnpm release:verify`. Expected: all four gates (typecheck, lint, build, test) green across all 5 packages. Test count should rise from 435 to roughly 455+ (new tests added in each phase; expected net: +20 to +25).

**Step 3:** Run `pnpm release:dry-run`. Expected: 5 tarballs prepared for `@soulerou/*@0.2.0`, no errors.

### Task 6.5: Publish to npm

**Files:**
- None (publish only).

**Step 1:** Confirm working tree is clean: `git status --porcelain` → empty.
**Step 2:** Run `pnpm release` (= `release:verify && release:publish`). Expected: pnpm publishes all 5 scoped packages using the cached `NPM_TOKEN`.
**Step 3:** Verify: `for p in oa-core oa-cli oa-adapter-{claude,codex,opencode}; do npm view @soulerou/$p version; done`. Expected: all show `0.2.0`.

### Task 6.6: Tag + merge

**Files:**
- None (git only).

**Step 1:** Tag: `git tag v0.2.0 -m "v0.2.0 — NightShift-inspired hardening (ADR-0015 + ADR-0016)"`.
**Step 2:** Merge branch into main: `git switch main && git merge --ff-only feat/v0.2-nightshift-hardening`.
**Step 3:** Push commits + tag when user explicitly asks (per the repo's "don't push without request" rule in CLAUDE.md).

---

## Testing summary by phase

| Phase | New tests | Key invariants (🔒 sabotage-checked) |
|---|---:|---|
| 2 | ~4 | Settings-merge preserves user hooks; sentinel survives v-bump; symlink points at the current attempt. |
| 3 | ~6 | Soft/hard normalization; stall-warning injected at `attempt >= soft`; `step.stall` emitted exactly once per step. |
| 4 | ~5 | Budget aborts at `stopAfter` (not `stopAfter+1`); skipped-task status surfaces in tasks index + SUMMARY. |
| 5 | ~8 | Renderer rejects relative paths; argv is wrapped only on darwin + only when profile is present; non-darwin fail-fast happens before any event write. |
| Total | ~23 | Final test count target: ~458. |

---

## Rollback plan (per phase)

- Phase 2 regresses Claude Code hook: users run `oa shims install --host claude --force` again once we ship a fix; the sentinel guarantees the merge upserts cleanly.
- Phase 3/4 regresses: `VerifyConfig.attempts` and `PlanSchema.errorBudget` are additive; a v0.2.1 point release that narrows the schema back is safe — existing on-disk v0.2.0 plans still parse.
- Phase 5 regresses (e.g. sandbox too restrictive for a common toolchain): `oa run` without `--sandbox` is unaffected; set `intake.sandbox.enabled: false` to opt every task out.
- Nuclear rollback: `npm deprecate @soulerou/<pkg>@0.2.0 "use 0.1.0 until <issue>"` and republish patched 0.2.1. Don't `npm unpublish` unless the 72h window is still open and the version is demonstrably broken.

---

## Out of scope for this plan

- Linux Landlock / AppArmor equivalents to sandbox-exec (post-v0.2 follow-up).
- Codex/opencode session-compaction hooks (requires upstream features that don't exist in their headless modes today).
- `oa shims uninstall` (v0.3).
- On-by-default sandbox (v0.3 after usage data).
- Arbitrary sexp escape hatch in sandbox profile (v0.3+ if needed).
