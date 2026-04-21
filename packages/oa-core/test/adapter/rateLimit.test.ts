import { describe, it, expect, vi } from 'vitest';
import {
  detectRateLimitInStderr,
  runAdapterWithRateLimitBackoff,
} from '../../src/adapter/rateLimit.js';
import type {
  AgentAdapter,
  AgentRunOpts,
  AgentRunResult,
} from '../../src/adapter/types.js';
import type { RateLimitBackoff } from '../../src/schemas.js';

// -----------------------------------------------------------------------------
// ADR-0017 — rate-limit detection + supervisor retry wrapper.
//
// Two layers of tests:
//
//   1. `detectRateLimitInStderr` — regex-based shared detector used by codex
//      and opencode adapters. Pure string-in / struct-out; pinned here so a
//      regex edit can't silently broaden or narrow which phrases count.
//
//   2. `runAdapterWithRateLimitBackoff` — supervisor wrapper. Uses a mock
//      adapter (scripted sequence of AgentRunResult values) and a mock event
//      emitter so the event shape is asserted in every path. Sleep is
//      injected as a no-op so the suite stays in-memory and fast.
// -----------------------------------------------------------------------------

describe('detectRateLimitInStderr', () => {
  it('returns rateLimited=false on empty input', () => {
    expect(detectRateLimitInStderr('')).toEqual({ rateLimited: false });
  });

  it('returns rateLimited=false when no known phrase is present', () => {
    expect(
      detectRateLimitInStderr('Error: permission denied reading /etc/passwd\n'),
    ).toEqual({ rateLimited: false });
  });

  it.each([
    ['Rate limit exceeded for requests', true],
    ['rate-limit reached', true],
    ['HTTP 429 Too Many Requests', true],
    ['Service is overloaded, try again later', true],
    ['quota exceeded', true],
    ['please try again in 30 seconds', true],
    ['503 service unavailable', true],
  ])('detects common phrase: %j → rateLimited=%s', (input, expected) => {
    expect(detectRateLimitInStderr(input).rateLimited).toBe(expected);
  });

  it('parses "retry-after: 45" as 45 seconds (45000ms)', () => {
    const d = detectRateLimitInStderr('429 Too Many Requests. retry-after: 45');
    expect(d.rateLimited).toBe(true);
    expect(d.retryAfterMs).toBe(45_000);
  });

  it('parses "retry_after: 30s" as 30 seconds', () => {
    const d = detectRateLimitInStderr('rate limit; retry_after: 30s');
    expect(d.rateLimited).toBe(true);
    expect(d.retryAfterMs).toBe(30_000);
  });

  it('parses "try again in 2 minutes" as 120 seconds', () => {
    const d = detectRateLimitInStderr('overloaded. Please try again in 2 minutes.');
    expect(d.rateLimited).toBe(true);
    expect(d.retryAfterMs).toBe(120_000);
  });

  it('parses "retry-after: 500ms" preserving ms unit', () => {
    const d = detectRateLimitInStderr('429; retry-after: 500ms');
    expect(d.rateLimited).toBe(true);
    expect(d.retryAfterMs).toBe(500);
  });

  it('returns rateLimited=true but retryAfterMs undefined when no hint is present', () => {
    const d = detectRateLimitInStderr('HTTP 429');
    expect(d.rateLimited).toBe(true);
    expect(d.retryAfterMs).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// Supervisor wrapper tests.
// -----------------------------------------------------------------------------

interface EmittedEvent {
  kind: string;
  taskId: string;
  stepN: number;
  attempt: number;
  waitMs?: number;
  source?: string;
  retryAfterMs?: number;
  reason?: string;
}

function collectingEmitter(): {
  emit: (e: EmittedEvent) => Promise<void>;
  events: EmittedEvent[];
} {
  const events: EmittedEvent[] = [];
  return {
    async emit(e) {
      events.push(e);
    },
    events,
  };
}

function scriptedAdapter(results: AgentRunResult[]): AgentAdapter & { calls: number } {
  let i = 0;
  const adapter = {
    id: 'claude' as const,
    defaultModel: 'opus',
    capabilities: () => ({ supportsSessionId: true, supportsStructuredOutput: true }),
    async run(opts: AgentRunOpts): Promise<AgentRunResult> {
      void opts;
      const r = results[i];
      if (r === undefined) {
        throw new Error(`scripted adapter exhausted (call #${String(i + 1)})`);
      }
      i += 1;
      adapter.calls = i;
      return r;
    },
    calls: 0,
  };
  return adapter;
}

const fakeOpts: AgentRunOpts = {
  cwd: '/tmp/fake',
  promptPath: '/tmp/fake/prompt.md',
  model: 'opus',
  extraArgs: [],
  timeoutSec: 10,
  stdoutCapBytes: 1_000_000,
  stdoutPath: '/tmp/fake/stdout.log',
  stderrPath: '/tmp/fake/stderr.log',
  signal: new AbortController().signal,
};

const okResult: AgentRunResult = {
  exitCode: 0,
  durationMs: 100,
  timedOut: false,
  stdoutCapHit: false,
  killedBy: null,
};

const rlResult = (retryAfterMs?: number): AgentRunResult => ({
  ...okResult,
  rateLimited: true,
  ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
});

const defaultConfig: RateLimitBackoff = { defaultWaitMs: 60_000, maxRetries: 3 };

const ctx = { taskId: 't_1', stepN: 1, verifyAttempt: 1 };

describe('runAdapterWithRateLimitBackoff', () => {
  it('returns the first result unchanged when not rate-limited (zero events emitted)', async () => {
    const adapter = scriptedAdapter([okResult]);
    const em = collectingEmitter();
    const sleep = vi.fn(async () => {});
    const result = await runAdapterWithRateLimitBackoff({
      adapter,
      opts: fakeOpts,
      config: defaultConfig,
      context: ctx,
      events: em,
      abortSignal: new AbortController().signal,
      sleep,
    });
    expect(result).toBe(okResult);
    expect(adapter.calls).toBe(1);
    expect(em.events).toEqual([]);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries once with adapter-supplied retryAfterMs, then returns the clean result', async () => {
    const adapter = scriptedAdapter([rlResult(15_000), okResult]);
    const em = collectingEmitter();
    const sleep = vi.fn(async () => {});
    const result = await runAdapterWithRateLimitBackoff({
      adapter,
      opts: fakeOpts,
      config: defaultConfig,
      context: ctx,
      events: em,
      abortSignal: new AbortController().signal,
      sleep,
    });
    expect(result).toBe(okResult);
    expect(adapter.calls).toBe(2);
    expect(sleep).toHaveBeenCalledWith(15_000, expect.any(Object));
    expect(em.events.map((e) => e.kind)).toEqual([
      'step.ratelimit.wait',
      'step.ratelimit.retry',
    ]);
    expect(em.events[0]).toMatchObject({
      kind: 'step.ratelimit.wait',
      taskId: 't_1',
      stepN: 1,
      attempt: 1,
      waitMs: 15_000,
      source: 'adapter-hint',
      retryAfterMs: 15_000,
    });
    expect(em.events[1]).toMatchObject({
      kind: 'step.ratelimit.retry',
      attempt: 1,
    });
  });

  it('falls back to defaultWaitMs when the adapter does not supply retryAfterMs', async () => {
    const adapter = scriptedAdapter([rlResult(undefined), okResult]);
    const em = collectingEmitter();
    const sleep = vi.fn(async () => {});
    await runAdapterWithRateLimitBackoff({
      adapter,
      opts: fakeOpts,
      config: { defaultWaitMs: 60_000, maxRetries: 3 },
      context: ctx,
      events: em,
      abortSignal: new AbortController().signal,
      sleep,
    });
    expect(sleep).toHaveBeenCalledWith(60_000, expect.any(Object));
    expect(em.events[0]).toMatchObject({ waitMs: 60_000, source: 'default' });
    expect(em.events[0].retryAfterMs).toBeUndefined();
  });

  it('caps the wait at maxWaitMs when the adapter-supplied hint exceeds it', async () => {
    const adapter = scriptedAdapter([rlResult(600_000), okResult]);
    const em = collectingEmitter();
    const sleep = vi.fn(async () => {});
    await runAdapterWithRateLimitBackoff({
      adapter,
      opts: fakeOpts,
      config: { defaultWaitMs: 60_000, maxRetries: 3, maxWaitMs: 120_000 },
      context: ctx,
      events: em,
      abortSignal: new AbortController().signal,
      sleep,
    });
    expect(sleep).toHaveBeenCalledWith(120_000, expect.any(Object));
    expect(em.events[0].waitMs).toBe(120_000);
    // The hint was still 600_000 — we surface it so post-mortems can see the
    // cap kicked in, but we honored the cap for the actual wait.
    expect(em.events[0].retryAfterMs).toBe(600_000);
  });

  it('emits step.ratelimit.give_up when maxRetries is exhausted and returns the final rate-limited result', async () => {
    const final = rlResult(10);
    const adapter = scriptedAdapter([rlResult(10), rlResult(10), final]);
    const em = collectingEmitter();
    const sleep = vi.fn(async () => {});
    const result = await runAdapterWithRateLimitBackoff({
      adapter,
      opts: fakeOpts,
      config: { defaultWaitMs: 60_000, maxRetries: 2 },
      context: ctx,
      events: em,
      abortSignal: new AbortController().signal,
      sleep,
    });
    expect(result).toBe(final);
    expect(adapter.calls).toBe(3);
    const kinds = em.events.map((e) => e.kind);
    expect(kinds).toEqual([
      'step.ratelimit.wait',
      'step.ratelimit.retry',
      'step.ratelimit.wait',
      'step.ratelimit.retry',
      'step.ratelimit.give_up',
    ]);
    expect(em.events.at(-1)).toMatchObject({
      kind: 'step.ratelimit.give_up',
      attempt: 3,
      reason: expect.stringContaining('maxRetries'),
    });
  });

  it('emits give_up without a wait/retry pair when maxRetries=0 (detection-only mode)', async () => {
    const r = rlResult();
    const adapter = scriptedAdapter([r]);
    const em = collectingEmitter();
    const sleep = vi.fn(async () => {});
    const result = await runAdapterWithRateLimitBackoff({
      adapter,
      opts: fakeOpts,
      config: { defaultWaitMs: 60_000, maxRetries: 0 },
      context: ctx,
      events: em,
      abortSignal: new AbortController().signal,
      sleep,
    });
    expect(result).toBe(r);
    expect(adapter.calls).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(em.events).toEqual([
      expect.objectContaining({
        kind: 'step.ratelimit.give_up',
        attempt: 1,
      }),
    ]);
  });

  it('short-circuits with give_up(reason="aborted during wait") when the abort signal fires mid-sleep', async () => {
    const ac = new AbortController();
    const adapter = scriptedAdapter([rlResult(60_000)]);
    const em = collectingEmitter();
    // Sleep simulates abort-mid-wait by throwing an AbortError.
    const sleep = vi.fn(async (_ms: number, signal: AbortSignal) => {
      ac.abort(); // flip the signal
      void signal; // quiet unused — we're simulating a sleep that noticed
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });
    const result = await runAdapterWithRateLimitBackoff({
      adapter,
      opts: fakeOpts,
      config: defaultConfig,
      context: ctx,
      events: em,
      abortSignal: ac.signal,
      sleep,
    });
    expect(result.rateLimited).toBe(true);
    const kinds = em.events.map((e) => e.kind);
    expect(kinds).toEqual(['step.ratelimit.wait', 'step.ratelimit.give_up']);
    expect(em.events.at(-1)).toMatchObject({ reason: 'aborted during wait' });
  });
});
