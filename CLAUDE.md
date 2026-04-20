# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

OvernightAgent (`oa`) — a Node 22+/TypeScript 6 pnpm monorepo implementing a CLI that runs coding agents (claude / codex / opencode) unattended against a queue of task plans. The supervisor drives each step through an **isolated git worktree**, a **four-gate verify pipeline** (tail protocol → commit-since-start → user command → AI reviewer), a **fix-loop** with reviewer-finding injection, a structured **`events.jsonl`** stream, **clean resume** after crash, and an auto-rendered **`SUMMARY.md`**. See `README.md` for the feature-level overview.

## Common commands

All commands run from repo root unless noted.

```sh
pnpm install
pnpm -r build                       # compile every package (oa-cli also bundles shims)
pnpm -r test                        # vitest run, all packages (~435 tests)
pnpm -r lint                        # eslint src + test
pnpm -r typecheck                   # tsc -p . --noEmit

# CLI iteration without rebuild
pnpm --filter @soulerou/oa-cli dev -- intake list         # runs src/cli.ts via tsx

# Scoped work (workspace specs use the scoped name)
pnpm --filter @soulerou/oa-core test
pnpm --filter @soulerou/oa-core exec vitest run path/to/file.test.ts
pnpm --filter @soulerou/oa-core exec vitest run -t "name substring"

# Link oa onto PATH after build
pnpm --filter @soulerou/oa-cli link --global

# Release
pnpm release:verify                 # four-gate verify across all packages
pnpm release:dry-run                # see what `pnpm publish` would upload
pnpm release                        # verify + `pnpm -r publish --access public`
pnpm version:patch                  # bump all 5 packages to next patch, no tag
```

Verification gate before claiming a phase done: `pnpm -r typecheck && pnpm -r lint && pnpm -r build && pnpm -r test` — all four must be green. Or: `pnpm release:verify` for the same sweep.

## Architecture (read these to be productive)

**Packages (all `type: module`, compiled to `dist/`, published as `@soulerou/*`):**

| Package | What lives there |
|---|---|
| `packages/oa-core` → `@soulerou/oa-core` | Schemas (Zod), paths/home/ids, atomic JSON, worktree manager, intake parser, adapter registry, verify pipeline, fix-loop, events reader/writer, supervisor (`runPlan`/`resumePlan`), daemon launcher, pidfile, control socket, SUMMARY renderer |
| `packages/oa-cli` → `@soulerou/oa-cli` | Commander CLI; every subcommand is a thin wrapper around a `@soulerou/oa-core` API. Entry: `src/cli.ts`. Also bundles the host-agent shims into `dist/shims/` via `scripts/bundle-shims.mjs` at build time, and exposes them at install time via `oa shims install`. |
| `packages/oa-adapter-{claude,codex,opencode}` → `@soulerou/oa-adapter-*` | Headless adapters implementing the `AgentAdapter` interface (ADR-0009). |
| `packages/oa-shims/{claude,codex,opencode}/{commands,skills}/` | **Pure markdown** slash-command + skill resource files for each host. Source of what `@soulerou/oa-cli` bundles. Not published as separate packages (ADR-0014). |

**Supervisor flow** lives in `oa-core/src/supervisor/` — `bootstrap.ts` → `runPlan.ts` / `resume.ts` → `daemon.ts` → `entry.ts` (checks `OA_RESUME=1` to branch into `resumePlan`) → `pidfile.ts` + `controlSocket.ts`. Adapters are resolved via a **lazy registry** in `oa-core/src/adapter/registry.ts` — dynamic `import('@soulerou/oa-adapter-<id>')`. `oa-core`'s test mocks the adapter packages via `vi.mock` so there's no workspace devDep cycle (ADR-0014).

**State root** is `$OA_HOME` (default `$HOME/.oa/`). All per-task, per-plan, per-run state lives under there — see the "State layout" tree in README. Every JSON shape carries `schemaVersion: 1` and is written via `writeJsonAtomic` / `writeFileAtomic` (temp + rename).

**Event stream** (`runs/<planId>/events.jsonl`) is the single source of truth for what happened — SUMMARY.md is rendered from it, `oa status` reads it when the socket is down, and `oa tail` follows it live. 28 typed event kinds, Zod-validated via `EventSchema`.

## House rules (enforced, not optional)

- **Absolute paths at every worktree / path-construction boundary.** `assertAbs(p)` is the runtime contract. ESLint bans bare `path.join` (and destructured `join`) in `**/worktree*.ts` + `**/paths*.ts` — wrap as `path.resolve(path.join(...))` or just use `path.resolve` directly. See ADR-0002 + ADR-0013. Memory entry: `feedback_worktree_absolute_paths.md`.
- **Atomic writes only.** `writeJsonAtomic` / `writeFileAtomic`. Never call `fs.writeFile` on the final path.
- **`verbatimModuleSyntax` + `module: NodeNext`.** Relative imports inside `src/` must spell the `.js` extension even though the file on disk is `.ts`. E.g. `import { foo } from './bar.js'`.
- **`tsc --build . --force`** (not `tsc -p . --force`) for forced rebuilds — several packages run this via `pretest` to defeat stale incremental state.
- **TDD per task.** Failing test → minimal impl → passing test → single commit. For load-bearing assertions, sabotage-check: break the prod code, confirm the test goes red, restore.
- **ADRs are load-bearing.** When changing behavior in an area with an ADR, cross-check the ADR and update it (or add a new one) in the same change. Memory entry: `feedback_record_adrs.md`. 14 ADRs live in `docs/adr/`.
- **Schemas are `.strict()`** for closed shapes — extra fields are a test failure, not a silent pass.

## Testing conventions

- Tests live in `packages/<pkg>/test/` alongside the package. Pattern: `**/test/**/*.test.ts` (see `vitest.config.ts`).
- Integration tests create a tmp `$OA_HOME` inside `os.tmpdir()` and `rm -rf` it in `afterEach`. Do not write to the developer's real `~/.oa/`.
- Cross-process tests fork **real Node children** (not mocks) to exercise file-lock contention, pidfile ownership, and socket lifecycle.
- Adapter tests stub the external binary (each adapter package ships a fixture `claude`/`codex`/`opencode` shell script on `PATH`); the registry test uses `vi.mock` to stand in for the adapter packages so `@soulerou/oa-core` has no devDep arrows back into its consumers (ADR-0014).

## Known v0 constraints to respect

1. `parallel.max > 1` is schema-accepted but the supervisor runs tasks **sequentially**. Don't assume concurrent task execution.
2. `runs/<planId>/reviewer-default-prompt.md` is materialized once per run — safe under v0 sequential, would race under parallel. Add a per-task suffix before enabling parallel mode.
3. ADR-0008 mentions `oa-core/prompts/protocol-status.md` + `protocol-review.md` — these are currently **inlined as constants** in `verify/context.ts` + `verify/review.ts`. The ADR acknowledges the deferral.
4. `parseSessionIdFromStreamJson` is permissive (accepts any JSON line with a string `session_id`). Tighten when codex/opencode settle on their own init events.

## Docs map

- `README.md` — user-facing overview, CLI reference, install.
- `HANDOFF.md` / `PROGRESS.md` — session audit trail; phase-by-phase completion.
- `docs/plans/2026-04-18-overnight-agent-taskmanager-design.md` — full §1–§8 system design.
- `docs/plans/2026-04-18-overnight-agent-taskmanager-implementation.md` — the 13-phase roadmap this repo was built against.
- `docs/adr/0001`–`0014` — every major decision with context + alternatives. ADR-0014 is the publish + shim-bundling decision.
