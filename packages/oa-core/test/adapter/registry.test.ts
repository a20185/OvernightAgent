import { describe, it, expect, beforeEach } from 'vitest';
import type { AgentAdapter, AgentId } from '../../src/adapter/types.js';
import { getAdapter, __resetAdapterCacheForTest } from '../../src/adapter/registry.js';

// -----------------------------------------------------------------------------
// Adapter registry — Task 5.4. The registry lazy-loads `oa-adapter-<id>`
// packages via dynamic import and caches the resolved AgentAdapter instance in
// a module-level Map so each id is loaded at most once per process.
//
// These tests cover the v0 wiring: only `oa-adapter-claude` is implemented;
// `oa-adapter-codex` / `oa-adapter-opencode` are still empty stubs (`export {}`)
// from Task 0.3 and the Phase 10 backlog will fill them in. Until then, the
// registry must fail loudly rather than silently load a half-built adapter.
//
// `__resetAdapterCacheForTest()` is the one test seam exposed from the module
// so we can run the singleton-cache test (#2) deterministically without test
// order coupling. It is exported but clearly marked test-only.
// -----------------------------------------------------------------------------

beforeEach(() => {
  // Each test gets a clean cache so #2's singleton check measures *only*
  // the within-call caching, not leakage from a prior test.
  __resetAdapterCacheForTest();
});

describe('getAdapter', () => {
  it('returns the claude adapter for id="claude"', async () => {
    const adapter = await getAdapter('claude');
    expect(adapter.id).toBe('claude');
    // Sanity: the claude adapter advertises its real default model so we don't
    // accidentally accept some other module that happens to satisfy the shape
    // check but pretend to be claude.
    expect(adapter.defaultModel).toBe('opus');
  });

  it('returns the SAME instance on subsequent calls (singleton cache)', async () => {
    const a = await getAdapter('claude');
    const b = await getAdapter('claude');
    // Reference equality, not deep equality — proves the module-level Map is
    // serving the second call without re-importing or re-constructing.
    expect(a).toBe(b);
  });

  it('returns an object satisfying the AgentAdapter interface', async () => {
    const adapter: AgentAdapter = await getAdapter('claude');
    expect(typeof adapter.id).toBe('string');
    expect(typeof adapter.defaultModel).toBe('string');
    expect(typeof adapter.capabilities).toBe('function');
    expect(typeof adapter.run).toBe('function');
    const caps = adapter.capabilities();
    expect(caps).toMatchObject({
      supportsSessionId: expect.any(Boolean),
      supportsStructuredOutput: expect.any(Boolean),
    });
  });

  it('throws clearly for codex (stub package with no adapter export)', async () => {
    // `oa-adapter-codex/src/index.ts` is `export {};` from Task 0.3. Phase 10
    // will replace it with a real adapter; until then, the registry must
    // refuse to hand back an undefined and instead surface a clear message
    // pointing at the package name.
    await expect(getAdapter('codex')).rejects.toThrow(
      /no valid AgentAdapter export found in oa-adapter-codex/,
    );
  });

  it('throws clearly for a cast-coerced unknown id ("gemini" as AgentId)', async () => {
    // TS rules out this call at compile time; the runtime guard exists for
    // callers that come in through `JSON.parse` / IPC / shim bridges where
    // the type system can't see the value's provenance.
    await expect(getAdapter('gemini' as unknown as AgentId)).rejects.toThrow(/unknown adapter id/);
  });
});
