# ADR-0014 — Scoped npm publish, workspace-cycle break, and bundled shims

**Status:** Accepted
**Date:** 2026-04-20
**Deciders:** OvernightAgent maintainers
**Related:** HANDOFF known limits (1) "Workspace cycle", README Install section

## Context

Post-v0 we want to distribute `oa` via npm so users can `pnpm add -g @soulerou/oa-cli` instead of cloning the repo. Three things were in the way:

1. **Unscoped, private package names.** All 5 workspace packages had `name: oa-*` and `private: true`. Publishing unscoped names to npm requires the name to be globally unique (it isn't — `oa-core` is already taken) and shipping under an owner-neutral name also makes governance ambiguous.

2. **Workspace dependency cycle.** `oa-core`'s `devDependencies` listed the three adapter packages (`oa-adapter-{claude,codex,opencode}`), solely so the registry test could `import('oa-adapter-<id>')` and exercise real dynamic loading. The adapters in turn `dependencies`-depend on `oa-core`. pnpm resolves this via symlinks and tests pass locally, but `npm publish` refuses: a published `oa-core` tarball referencing `oa-adapter-claude` as a devDep creates a cyclic dependency graph across registry packages, and at registration time `oa-core` cannot exist yet. Captured as v0 known-limit #1 in `HANDOFF.md`.

3. **Shim distribution.** The three host shim trees (`packages/oa-shims/{claude,codex,opencode}/`) are plain markdown, not JS. The repo-cloned install path was `ln -s "$(pwd)/packages/oa-shims/<host>/commands"/*.md .claude/commands/`, which only works when the user has the source tree. An npm user needs a different path.

## Decision

Adopt all three of the following as a set. Each depends on the others.

### 1. Scope everything under `@soulerou`

Rename the 5 code packages to `@soulerou/oa-core`, `@soulerou/oa-cli`, `@soulerou/oa-adapter-claude`, `@soulerou/oa-adapter-codex`, `@soulerou/oa-adapter-opencode`. The CLI binary name stays `oa`. Start public versions at `0.1.0`. Every code package gets:

- `publishConfig.access: "public"` (scoped packages default to private otherwise)
- `files: ["dist", "README.md", "LICENSE"]` (strict allowlist — excludes `src`, `test`, `tsconfig*`, `node_modules`)
- `engines.node: ">=22"` (already the repo-root requirement; make it per-package so npm warns on install)
- `repository.directory` (points npm UI at the per-package subtree on GitHub)
- Per-package `README.md` + a copy of the root `LICENSE` (npm packs each package directory in isolation; root files aren't auto-included)

### 2. Break the registry devDep cycle with `vi.mock`

Rewrite `oa-core/test/adapter/registry.test.ts` to stub the three adapter packages via `vi.mock('@soulerou/oa-adapter-<id>', () => ({ adapter: { ... } }))`. This registers factory mocks in vitest's module resolver, so the dynamic `import()` in `registry.ts` returns the stub regardless of whether the adapter package is installed.

Drop the three adapter entries from `oa-core/package.json > devDependencies`. `oa-core` now has no dependency arrow into any adapter package, and the graph is a clean DAG: `oa-cli → oa-core`, `oa-adapter-* → oa-core`.

Trade-off: the test no longer exercises real package resolution. That layer is indirectly covered by the adapter smoke tests (each adapter's own test suite imports and invokes its own `adapter` export) and by the CLI's e2e test, so we're not giving up meaningful coverage.

### 3. Bundle shims inside `@soulerou/oa-cli`

A build-time script (`packages/oa-cli/scripts/bundle-shims.mjs`) copies `packages/oa-shims/<host>/{commands,skills}/` into `packages/oa-cli/dist/shims/<host>/` before the package is packed. The `files` allowlist (`dist`) sweeps this into the tarball.

At runtime, a new `oa shims install [--host …] [--scope …] [--dry-run] [--force]` command reads from `dist/shims/` (resolved via `new URL('./shims', import.meta.url)`) and copies markdown into host-specific target directories:

| host     | default scope | target path                                    |
|----------|---------------|-------------------------------------------------|
| claude   | project       | `<cwd>/.claude/commands/` + `.claude/skills/`   |
| codex    | user          | `~/.codex/prompts/`                             |
| opencode | user          | `~/.config/opencode/commands/`                  |

`--host all` installs every host with its default scope. `--scope project` is refused for codex and opencode (neither reads project-local paths in v0). Re-runs skip existing files unless `--force` is given. `--dry-run` reports the plan without writing.

Alternative considered: ship shims as three separate packages (`@soulerou/oa-shims-claude`, etc.) that depend on `@soulerou/oa-cli` only optionally. Rejected: shim content is a handful of markdown files totaling < 10 KB, three extra registry entries for ~10 KB is registry pollution, and the separate-package version would still require `oa shims install` to find them — shipping them in-tree is strictly simpler.

## Release mechanics

Root `package.json` now carries:

- `"release:verify"` — runs `typecheck && lint && build && test` across all workspaces (the four-gate verification).
- `"release:publish"` — runs `pnpm -r publish --access public`. pnpm's default `--git-checks` blocks publishing from a dirty working tree; we rely on that as a guardrail rather than passing `--no-git-checks`.
- `"release"` — chains the two.

Version bumps are manual per-package in v0. `pnpm -r exec npm version <patch|minor|major> --no-git-tag-version` bumps all packages together without creating 5 separate tags; the maintainer creates a single root tag after the bump.

## Consequences

**Positive.**

- Users install with a one-liner: `pnpm add -g @soulerou/oa-cli && oa shims install --host all`.
- Publish is no longer blocked on the cycle carry-forward from v0.
- Scope ownership is explicit; `@soulerou` is the namespace.
- The shim install flow is idempotent, dry-runnable, and scoped — no footguns for users who symlinked manually before.
- Adapter packages are importable by embedders (`import { adapter } from '@soulerou/oa-adapter-claude'`) who want to run OvernightAgent-compatible agents outside the CLI.

**Negative.**

- Registry test is no longer a real-loading integration test. Mitigated by adapter smoke tests and CLI e2e.
- Shim updates require a CLI version bump to reach users; there's no "update shims independently" path in v0. Acceptable given shims are tightly versioned against the CLI's expected intake schema.
- The per-host `skills/` target dir convention is hardcoded. When codex or opencode grow a skills equivalent, the `HOSTS` table in `shims.ts` needs an edit.

**Follow-ups.**

- `oa shims uninstall` and `oa shims update` (opt-in overwrite) — not in v0.
- Honor host config overrides (e.g. `~/.config/opencode/config.json > commandsDir`) instead of hardcoding paths.
- Publish a `@soulerou/create-oa` bootstrapper so `pnpm create @soulerou/oa <project>` sets up a project `.claude/commands/` + a starter `intake.json` template.
