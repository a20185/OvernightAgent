import type { AgentAdapter, AgentId } from './types.js';

/**
 * Adapter registry — Task 5.4. Lazy-loads `oa-adapter-<id>` packages via
 * dynamic `import()` and caches each resolved AgentAdapter so subsequent
 * lookups are free.
 *
 * Per ADR-0009 the supervisor stays agent-agnostic: it depends only on the
 * `AgentAdapter` interface and asks the registry for a concrete one. The
 * registry is the single integration point — every other layer treats adapters
 * as opaque interface-typed values.
 *
 * Failure modes (all surface as thrown `Error`s, never silent fallbacks):
 *   1. Unknown id (caller bypassed TS via `as`) — refused by the literal-set
 *      guard before any import is attempted. Cheap and unambiguous.
 *   2. Package can't be resolved (missing dep, broken install) — the dynamic
 *      `import()` rejection is wrapped with a message naming the package and
 *      the original error attached as `cause` so callers can drill in.
 *   3. Package exists but has no `adapter` export, or that export doesn't
 *      satisfy the AgentAdapter shape (e.g. the codex/opencode stubs from
 *      Task 0.3, which are still `export {};`) — refused with a message
 *      naming the package, *before* anything is cached.
 *   4. The exported adapter's `id` field doesn't match the lookup id — refused
 *      to catch a copy-paste mistake in a future adapter package early.
 */

const cache = new Map<AgentId, AgentAdapter>();

// Mirror of the `AgentId` literal union as a runtime value. The two are kept
// in sync by the compile-time witnesses in `test/adapter/types.test.ts`
// (which assert assignability against the zod `AgentId` enum). Adding a new
// adapter id is a three-place edit (types.ts, schemas.ts, here) so the
// drift check fails loudly rather than at runtime.
const VALID_IDS: ReadonlySet<AgentId> = new Set<AgentId>(['claude', 'codex', 'opencode']);

function isAgentAdapter(x: unknown): x is AgentAdapter {
  if (x === null || typeof x !== 'object') return false;
  const a = x as Partial<AgentAdapter>;
  return (
    typeof a.id === 'string' &&
    typeof a.defaultModel === 'string' &&
    typeof a.capabilities === 'function' &&
    typeof a.run === 'function'
  );
}

export async function getAdapter(id: AgentId): Promise<AgentAdapter> {
  // Step 1: literal-set guard. TS already rules this out at compile time, but
  // values arriving via JSON.parse / IPC / shim bridges have no static
  // provenance — without this guard a typo in a queue.json file would attempt
  // a dynamic import of `@soulerou/oa-adapter-<typo>` and fail with whatever obscure
  // resolver error the runtime emits.
  if (!VALID_IDS.has(id)) {
    throw new Error(`unknown adapter id: ${JSON.stringify(id)}`);
  }

  const cached = cache.get(id);
  if (cached !== undefined) return cached;

  const pkgName = `@soulerou/oa-adapter-${id}`;

  // Step 2: dynamic import. Wrapped so the error message names the package
  // (Node's default `Cannot find package '@soulerou/oa-adapter-foo'` is fine but easy
  // to miss in a stack trace). Original error attached as `cause` per ES2022
  // Error options for callers that want to inspect it.
  let mod: { adapter?: unknown };
  try {
    // The `as` is unavoidable here: dynamic `import()` returns `any`, and the
    // shape check below validates the actual structure.
    mod = (await import(pkgName)) as { adapter?: unknown };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to load adapter package ${pkgName}: ${msg}`, { cause: err });
  }

  // Step 3: shape validation. Catches the empty-stub case (codex/opencode
  // before Phase 10) and any future package that forgets to export `adapter`
  // or exports it under the wrong name. We intentionally don't try to be
  // helpful about *which* field is missing — the contract is small and the
  // package author is the right person to look at the AgentAdapter interface.
  if (!isAgentAdapter(mod.adapter)) {
    throw new Error(`no valid AgentAdapter export found in ${pkgName}`);
  }

  // Step 4: id-match check. Caught a real bug in earlier prototypes where a
  // copy-pasted adapter advertised someone else's id; the supervisor would
  // then route work to the wrong implementation. Cheap and explicit.
  if (mod.adapter.id !== id) {
    throw new Error(
      `adapter id mismatch in ${pkgName}: expected ${id}, got ${String(mod.adapter.id)}`,
    );
  }

  cache.set(id, mod.adapter);
  return mod.adapter;
}

/**
 * Test-only seam: clear the module-level cache so tests can verify the
 * singleton behavior of `getAdapter` without test-order coupling. Production
 * code MUST NOT call this — there is no scenario in which the supervisor
 * benefits from re-importing an adapter package mid-run.
 *
 * Exported (rather than hidden behind a conditional) because vitest's ESM
 * loader doesn't expose any test-only hatch and we don't want to fork the
 * registry into "real" and "test" variants for the sake of one Map.clear().
 */
export function __resetAdapterCacheForTest(): void {
  cache.clear();
}
