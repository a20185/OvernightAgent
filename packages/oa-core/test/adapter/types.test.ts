import { describe, it, expect } from 'vitest';
import type { z } from 'zod';
import type { AgentAdapter, AgentId, AgentRunOpts, AgentRunResult } from '../../src/adapter/types.js';
import { AgentId as AgentIdSchema } from '../../src/schemas.js';

// -----------------------------------------------------------------------------
// Compile-time conformance witness. If anyone removes a member from
// `AgentAdapter` (or changes a signature in a non-assignable way), this mock
// stops compiling — which fails `pnpm --filter oa-core test` at typecheck
// before any test even runs. That's the point: the runtime assertions below
// are almost incidental; the real check is that the file compiles.
// -----------------------------------------------------------------------------

const mockAdapter: AgentAdapter = {
  id: 'claude',
  defaultModel: 'opus',
  capabilities: () => ({ supportsSessionId: false, supportsStructuredOutput: false }),
  // Param intentionally omitted: the contextual type from `AgentAdapter.run`
  // gives the parameter its `AgentRunOpts` type without a binding the linter
  // would flag as unused. The conformance check is the assignment to
  // `mockAdapter: AgentAdapter`.
  run: async (): Promise<AgentRunResult> => ({
    exitCode: 0,
    durationMs: 0,
    timedOut: false,
    stdoutCapHit: false,
    killedBy: null,
  }),
};

describe('AgentAdapter type', () => {
  it('a minimal mock conforms to the interface', () => {
    expect(mockAdapter.id).toBe('claude');
    expect(mockAdapter.defaultModel).toBe('opus');
    expect(mockAdapter.capabilities()).toMatchObject({
      supportsSessionId: false,
      supportsStructuredOutput: false,
    });
  });

  it('mock run() returns a well-formed AgentRunResult', async () => {
    // Build a no-op AgentRunOpts purely for the type-conformance assertion;
    // the mock ignores it. AbortController gives us a real `AbortSignal`
    // without any test-only shim.
    const ac = new AbortController();
    const opts: AgentRunOpts = {
      cwd: '/tmp/x',
      promptPath: '/tmp/x/prompt.md',
      model: 'opus',
      extraArgs: [],
      timeoutSec: 1,
      stdoutCapBytes: 1,
      stdoutPath: '/tmp/x/stdout.log',
      stderrPath: '/tmp/x/stderr.log',
      signal: ac.signal,
    };
    const result = await mockAdapter.run(opts);
    expect(result).toMatchObject({
      exitCode: 0,
      durationMs: 0,
      timedOut: false,
      stdoutCapHit: false,
      killedBy: null,
    });
  });
});

// -----------------------------------------------------------------------------
// Cross-validation: the `AgentId` literal union in `adapter/types.ts` must
// agree with the `AgentId` zod enum in `schemas.ts`. Per ADR-0009 the duplica-
// tion is deliberate (adapter/types.ts has no `oa-core` imports), but the two
// sources of truth must stay aligned. These bidirectional assignments compile
// iff the literal sets are mutually assignable — drift in either direction
// will fail typecheck before this test even runs.
// -----------------------------------------------------------------------------

type AgentIdFromSchema = z.infer<typeof AgentIdSchema>;

// Bidirectional assignability — both lines must compile.
const _checkAdapterToSchema: AgentIdFromSchema = 'claude' as AgentId;
const _checkSchemaToAdapter: AgentId = 'claude' as AgentIdFromSchema;
void _checkAdapterToSchema;
void _checkSchemaToAdapter;

describe('AgentId cross-validation', () => {
  it('every adapter AgentId literal is accepted by the zod schema', () => {
    // Runtime witness in case the compile-time assignment ever gets weakened
    // (e.g. someone widens AgentId to `string`). Cheap belt-and-braces check.
    for (const id of ['claude', 'codex', 'opencode'] satisfies AgentId[]) {
      expect(AgentIdSchema.safeParse(id).success).toBe(true);
    }
  });
});
