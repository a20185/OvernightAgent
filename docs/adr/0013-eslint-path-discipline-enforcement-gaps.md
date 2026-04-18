# ADR-0013 — ESLint path-discipline enforcement gaps

**Status:** Accepted
**Date:** 2026-04-18
**Deciders:** OvernightAgent maintainers
**Related:** ADR-0002 (worktree-per-tasklist and absolute paths), Task 0.2, Task 1.1 (runtime `assertAbs`)

## Context

ADR-0002 mandates absolute paths in all worktree-touching code. To make that
discipline visible at lint time, Task 0.2 added two scoped rules to
`.eslintrc.cjs`, applied only to files matching `**/worktree*.ts` and
`**/paths*.ts`:

1. `no-restricted-syntax` — flags `CallExpression[callee.object.name='path'][callee.property.name='join']`
   that is not the immediate child of a `path.resolve(...)` call.
2. `no-restricted-imports` — flags `import { join } from 'path'` and
   `import { join } from 'node:path'`.

The Task 0.2 review confirmed empirically that the AST selector has documented
escape hatches:

- **Destructured import:** `import { join } from 'path'; join(a, b)` — bypasses
  the `no-restricted-syntax` selector because the call site has no `path.`
  prefix. (Now caught by the added `no-restricted-imports`.)
- **Namespace rename:** `import * as nodePath from 'node:path'; nodePath.join(...)`
  — bypasses both rules. The `no-restricted-syntax` selector hard-codes
  `callee.object.name='path'`; matching every possible alias would require a
  custom rule that tracks bindings.
- **Computed property access:** `(path as any)['join'](a, b)` — different AST
  shape (`MemberExpression` with computed `Literal`/`Identifier` rather than
  the dotted form). Reaches a different selector entirely.

Reverse-parent-aware AST matching beyond simple `:not(parent > child)`
relations is also limited in `no-restricted-syntax`; broader patterns would
require a real custom ESLint rule shipped as a plugin package.

## Decision

Lint enforcement of the absolute-path rule is **best-effort**, intentionally
covering only the obvious accidental mistakes:

- bare `path.join(...)` in the `path.<method>` namespace style, and
- destructured `join` import from `path` / `node:path`.

The **authoritative contract** is the runtime `assertAbs()` helper (planned in
Task 1.1) that guards every path-receiving public API at the boundary of the
worktree, paths, and supervisor layers. Anything reaching those APIs that is
not already absolute throws immediately, regardless of how it was constructed.

Pathological bypasses (namespace rename, computed access, dynamic
construction, third-party libraries) are accepted as out of scope for lint and
are caught by the runtime guard.

## Consequences

- **Positive:** The two most common accidental mistakes —
  `path.join('/a', 'b')` used directly, and `import { join } from 'path'` —
  fail at lint time with a message pointing to ADR-0002. Contributors learn
  the rule on the first attempt rather than via a runtime crash in a
  half-finished worktree operation.
- **Negative:** Pathological code that renames the namespace import or uses
  computed property access bypasses the lint rule and only fails when it hits
  `assertAbs()`. In CI this still surfaces — but in a unit test failure
  rather than a lint error, which is a slightly worse UX.
- **Neutral / observable:** When adding files matching `worktree*.ts` or
  `paths*.ts`, contributors must use `import * as path from 'node:path'` (or
  similar non-aliased form) and wrap `path.join(...)` in `path.resolve(...)`
  — or call `path.resolve(...)` directly. The lint rule will block any other
  shape of `path.join` use in those files.

## Alternatives Considered

- **Custom ESLint plugin with binding-aware rule.** Would catch namespace
  rename and destructured-then-aliased forms by tracking the import binding
  through scope. Rejected for v0: requires a published plugin package or a
  workspace-local plugin with its own `package.json`, both of which add
  configuration weight disproportionate to the value over the simple rules
  plus runtime guard.
- **Runtime `assertAbs()` only, no lint rules.** Rejected: loses the
  obvious-mistake tripwire that catches the typical `path.join` slip during
  initial development, before tests even run. The lint rule has near-zero
  cost; removing it would trade a real (small) ergonomic win for nothing.
- **`eslint-plugin-no-relative-paths` or similar third-party plugin.**
  Rejected: those plugins target relative-vs-absolute *import specifiers*
  (`import x from './foo'`), not the `path.join` runtime construction
  pattern that ADR-0002 is concerned with. Wrong tool.
- **Convert to a flat-config-based custom rule when ESLint v9+ is adopted.**
  Deferred: the project is on ESLint 8.57 for `.eslintrc.cjs` first-class
  support; revisit if/when we migrate to flat config.

## Notes

- This ADR is the formal record of the deferral noted in the Task 0.2
  code-quality review. Task 0.2's commit `0422187` shipped the initial
  `no-restricted-syntax` rule; the follow-up commit hardens it with
  `no-restricted-imports` and lands this ADR.
- The runtime `assertAbs()` helper specified in Task 1.1 is the actual
  contract and must be called at every public path-accepting boundary in
  the worktree/paths/supervisor layers.
