import { describe, it, expect } from 'vitest';
import type { AgentHeartbeat } from '@soulerou/oa-core';
import { createStreamJsonHeartbeatParser } from '../src/heartbeat.js';

// -----------------------------------------------------------------------------
// Unit tests for the claude stream-json live classifier. Each test drives the
// parser with a canned sequence of JSONL lines and asserts the emitted
// heartbeat sequence. A fake clock is injected so the debounce window is
// testable without setTimeout gymnastics.
// -----------------------------------------------------------------------------

function collect(): { emits: AgentHeartbeat[]; emit: (h: AgentHeartbeat) => void } {
  const emits: AgentHeartbeat[] = [];
  return { emits, emit: (h) => emits.push(h) };
}

describe('createStreamJsonHeartbeatParser', () => {
  it('emits session.init once on the first type=system subtype=init line', () => {
    const { emits, emit } = collect();
    const p = createStreamJsonHeartbeatParser({ emit });
    p.onLine(
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-1', model: 'opus' }),
    );
    p.onLine(
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-2', model: 'opus' }),
    );
    expect(emits).toEqual([{ kind: 'session.init', sessionId: 'sid-1', model: 'opus' }]);
  });

  it('emits api.retry for every api_retry line — never debounced', () => {
    const { emits, emit } = collect();
    const p = createStreamJsonHeartbeatParser({ emit });
    for (let i = 1; i <= 3; i += 1) {
      p.onLine(
        JSON.stringify({
          type: 'system',
          subtype: 'api_retry',
          attempt: i,
          max_retries: 10,
          error_status: 429,
          retry_delay_ms: 1000 * i,
        }),
      );
    }
    expect(emits).toEqual([
      { kind: 'api.retry', attempt: 1, maxRetries: 10, errorStatus: 429, retryDelayMs: 1000 },
      { kind: 'api.retry', attempt: 2, maxRetries: 10, errorStatus: 429, retryDelayMs: 2000 },
      { kind: 'api.retry', attempt: 3, maxRetries: 10, errorStatus: 429, retryDelayMs: 3000 },
    ]);
  });

  it('emits tool.use for each assistant tool_use content block', () => {
    const { emits, emit } = collect();
    const p = createStreamJsonHeartbeatParser({ emit });
    p.onLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'thinking...' },
            { type: 'tool_use', id: 'x', name: 'Bash' },
            { type: 'tool_use', id: 'y', name: 'Read' },
          ],
        },
      }),
    );
    const toolUses = emits.filter((e) => e.kind === 'tool.use');
    expect(toolUses).toEqual([
      { kind: 'tool.use', name: 'Bash' },
      { kind: 'tool.use', name: 'Read' },
    ]);
  });

  it('debounces assistant.delta to at most one emission per window', () => {
    const { emits, emit } = collect();
    let t = 0;
    const p = createStreamJsonHeartbeatParser({
      emit,
      debounceMs: 1000,
      now: () => t,
    });
    // First line at t=0 — first delta fires immediately (t - lastEmit=0 >= 0).
    t = 0;
    p.onLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'aaa' }] } }));
    // Second line at t=500 — inside debounce window, no emit.
    t = 500;
    p.onLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'bbb' }] } }));
    // Third line at t=1500 — past the window, emits cumulative total.
    t = 1500;
    p.onLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ccc' }] } }));

    const deltas = emits.filter((e) => e.kind === 'assistant.delta');
    expect(deltas).toEqual([
      { kind: 'assistant.delta', cumulativeBytes: 3 },
      { kind: 'assistant.delta', cumulativeBytes: 9 },
    ]);
  });

  it('flush() force-emits a pending debounced delta', () => {
    const { emits, emit } = collect();
    let t = 0;
    const p = createStreamJsonHeartbeatParser({ emit, debounceMs: 10_000, now: () => t });
    // t=0: first delta fires (cumulative=3).
    t = 0;
    p.onLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'aaa' }] } }));
    // t=100: inside debounce window — pending but not emitted.
    t = 100;
    p.onLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'bbb' }] } }));
    p.flush();
    const deltas = emits.filter((e) => e.kind === 'assistant.delta');
    expect(deltas).toEqual([
      { kind: 'assistant.delta', cumulativeBytes: 3 },
      { kind: 'assistant.delta', cumulativeBytes: 6 },
    ]);
  });

  it('emits ratelimited on type=result with is_error and api_error_status=429', () => {
    const { emits, emit } = collect();
    const p = createStreamJsonHeartbeatParser({ emit });
    p.onLine(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: true,
        api_error_status: 429,
        retry_after_seconds: 45,
      }),
    );
    expect(emits).toEqual([{ kind: 'ratelimited', retryAfterMs: 45_000 }]);
  });

  it('silently skips non-JSON lines and malformed objects', () => {
    const { emits, emit } = collect();
    const p = createStreamJsonHeartbeatParser({ emit });
    p.onLine('not json at all');
    p.onLine('');
    p.onLine('   ');
    p.onLine('null');
    p.onLine('"just a string"');
    p.onLine('[1,2,3]');
    p.onLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid' }));
    expect(emits).toEqual([{ kind: 'session.init', sessionId: 'sid' }]);
  });

  it('counts thinking-block bytes toward assistant.delta', () => {
    const { emits, emit } = collect();
    let t = 0;
    const p = createStreamJsonHeartbeatParser({ emit, debounceMs: 1000, now: () => t });
    t = 0;
    p.onLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'abcd' },
            { type: 'text', text: 'ef' },
          ],
        },
      }),
    );
    const deltas = emits.filter((e) => e.kind === 'assistant.delta');
    expect(deltas).toEqual([{ kind: 'assistant.delta', cumulativeBytes: 6 }]);
  });
});
