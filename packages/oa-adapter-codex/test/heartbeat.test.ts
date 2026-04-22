import { describe, it, expect } from 'vitest';
import type { AgentHeartbeat } from '@soulerou/oa-core';
import { createCodexHeartbeatParser } from '../src/heartbeat.js';

// Unit tests for the codex live classifier. Codex emits plain text, so the
// interesting behavior is byte accumulation + debounce and the one-shot
// rate-limit detection on stderr.

function collect(): { emits: AgentHeartbeat[]; emit: (h: AgentHeartbeat) => void } {
  const emits: AgentHeartbeat[] = [];
  return { emits, emit: (h) => emits.push(h) };
}

describe('createCodexHeartbeatParser', () => {
  it('accumulates stdout bytes and debounces assistant.delta', () => {
    const { emits, emit } = collect();
    let t = 0;
    const p = createCodexHeartbeatParser({ emit, debounceMs: 1000, now: () => t });
    // t=0: first line — delta fires (cumulative = 5 bytes 'hello' + 1 implied \n = 6).
    t = 0;
    p.onStdoutLine('hello');
    // t=500: inside debounce — pending only.
    t = 500;
    p.onStdoutLine('world'); // +6 bytes -> pending 6, cumulative 12
    // t=1500: past debounce — emits cumulative 12.
    t = 1500;
    p.onStdoutLine('!!'); // +3 bytes -> cumulative 15, pending 3 before flush check

    const deltas = emits.filter((e) => e.kind === 'assistant.delta');
    // At t=0: emits cumulative=6. At t=1500: emits cumulative=15 (all lines so far).
    expect(deltas).toEqual([
      { kind: 'assistant.delta', cumulativeBytes: 6 },
      { kind: 'assistant.delta', cumulativeBytes: 15 },
    ]);
  });

  it('emits ratelimited at most once — subsequent stderr rate-limit lines are ignored', () => {
    const { emits, emit } = collect();
    const p = createCodexHeartbeatParser({ emit });
    p.onStderrLine('Error: 429 Too Many Requests');
    p.onStderrLine('Error: rate limit exceeded again');
    p.onStderrLine('overloaded once more');
    const rl = emits.filter((e) => e.kind === 'ratelimited');
    expect(rl).toHaveLength(1);
  });

  it('extracts retry-after hint when present in stderr', () => {
    const { emits, emit } = collect();
    const p = createCodexHeartbeatParser({ emit });
    p.onStderrLine('rate-limit: retry after 30s');
    const rl = emits.filter((e) => e.kind === 'ratelimited');
    expect(rl).toEqual([{ kind: 'ratelimited', retryAfterMs: 30_000 }]);
  });

  it('stderr without rate-limit signals is silent', () => {
    const { emits, emit } = collect();
    const p = createCodexHeartbeatParser({ emit });
    p.onStderrLine('Loaded config from /etc/codex.toml');
    p.onStderrLine('Starting exec run');
    expect(emits.filter((e) => e.kind === 'ratelimited')).toHaveLength(0);
  });

  it('flush() emits pending debounced delta on spawn exit', () => {
    const { emits, emit } = collect();
    let t = 0;
    const p = createCodexHeartbeatParser({ emit, debounceMs: 10_000, now: () => t });
    // First line fires immediately (t=0 vs lastEmit=0).
    t = 0;
    p.onStdoutLine('first');
    // Second line is inside the debounce window — pending only.
    t = 100;
    p.onStdoutLine('second');
    p.flush();
    const deltas = emits.filter((e) => e.kind === 'assistant.delta');
    expect(deltas).toHaveLength(2);
    const last = deltas[deltas.length - 1];
    expect(last).toMatchObject({ kind: 'assistant.delta' });
    // Cumulative covers both lines: 'first' + \n + 'second' + \n = 13 bytes.
    expect((last as { cumulativeBytes: number }).cumulativeBytes).toBe(13);
  });
});
