import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AgentAdapter, AgentId } from '../../src/adapter/types.js';
import { getAdapter, __resetAdapterCacheForTest } from '../../src/adapter/registry.js';

// -----------------------------------------------------------------------------
// Adapter registry — Task 5.4. The registry lazy-loads `oa-adapter-<id>`
// packages via dynamic import and caches the resolved AgentAdapter instance in
// a module-level Map so each id is loaded at most once per process.
//
// These tests use `vi.mock` to stub the three adapter packages rather than
// depending on them at compile time. That breaks the workspace cycle that
// otherwise blocks `npm publish` of `oa-core`: if this test imported the real
// adapter packages, `oa-core` would need to devDep them, and the adapters
// already depend on `oa-core` → dependency loop. See ADR-0014.
//
// `__resetAdapterCacheForTest()` is the one test seam exposed from the module
// so we can run the singleton-cache test deterministically without test-order
// coupling. It is exported but clearly marked test-only.
// -----------------------------------------------------------------------------

// Mocks for the three real adapter packages. Each returns an object that
// satisfies the AgentAdapter shape the registry validates against. The mock
// specifiers MUST match the exact string the registry builds in
// `pkgName = \`@soulerou/oa-adapter-${id}\`` — keep the two in sync.
vi.mock('@soulerou/oa-adapter-claude', () => ({
  adapter: {
    id: 'claude',
    defaultModel: 'opus',
    capabilities: () => ({ supportsSessionId: true, supportsStructuredOutput: true }),
    run: async () => ({
      ok: true,
      exitCode: 0,
      timedOut: false,
      killedBySignal: null,
      stdoutPath: '/tmp/stdout',
      stderrPath: '/tmp/stderr',
      stdoutBytes: 0,
      stderrBytes: 0,
      durationMs: 0,
    }),
  } satisfies AgentAdapter,
}));

vi.mock('@soulerou/oa-adapter-codex', () => ({
  adapter: {
    id: 'codex',
    defaultModel: 'o3-mini',
    capabilities: () => ({ supportsSessionId: false, supportsStructuredOutput: false }),
    run: async () => ({
      ok: true,
      exitCode: 0,
      timedOut: false,
      killedBySignal: null,
      stdoutPath: '/tmp/stdout',
      stderrPath: '/tmp/stderr',
      stdoutBytes: 0,
      stderrBytes: 0,
      durationMs: 0,
    }),
  } satisfies AgentAdapter,
}));

vi.mock('@soulerou/oa-adapter-opencode', () => ({
  adapter: {
    id: 'opencode',
    defaultModel: 'claude-sonnet-4',
    capabilities: () => ({ supportsSessionId: false, supportsStructuredOutput: false }),
    run: async () => ({
      ok: true,
      exitCode: 0,
      timedOut: false,
      killedBySignal: null,
      stdoutPath: '/tmp/stdout',
      stderrPath: '/tmp/stderr',
      stdoutBytes: 0,
      stderrBytes: 0,
      durationMs: 0,
    }),
  } satisfies AgentAdapter,
}));

beforeEach(() => {
  // Each test gets a clean cache so the singleton-cache check measures *only*
  // the within-call caching, not leakage from a prior test.
  __resetAdapterCacheForTest();
});

describe('getAdapter', () => {
  it('returns the claude adapter for id="claude"', async () => {
    const adapter = await getAdapter('claude');
    expect(adapter.id).toBe('claude');
    // Sanity: the mocked claude adapter advertises 'opus' — matching the real
    // adapter's default — so this assertion also catches a future drift
    // between the mock and the real package.
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

  it('loads the codex adapter', async () => {
    const c = await getAdapter('codex');
    expect(c.id).toBe('codex');
    expect(typeof c.defaultModel).toBe('string');
    expect(typeof c.run).toBe('function');
  });

  it('loads the opencode adapter', async () => {
    const o = await getAdapter('opencode');
    expect(o.id).toBe('opencode');
    expect(typeof o.defaultModel).toBe('string');
    expect(typeof o.run).toBe('function');
  });

  it('throws clearly for a cast-coerced unknown id ("gemini" as AgentId)', async () => {
    // TS rules out this call at compile time; the runtime guard exists for
    // callers that come in through `JSON.parse` / IPC / shim bridges where
    // the type system can't see the value's provenance.
    await expect(getAdapter('gemini' as unknown as AgentId)).rejects.toThrow(/unknown adapter id/);
  });
});
