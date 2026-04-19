import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { openEventWriter } from '../../src/events/writer.js';

/**
 * Task 7.1 — events.jsonl writer tests.
 *
 * The writer is the spine of the Phase 7 supervisor: every state transition
 * (run.start, task.start, step.attempt.start, verify gates, fix-loop synth,
 * task.end, run.stop, …) flows through `emit()`. The contract these tests
 * lock in is small but load-bearing:
 *
 *   - one JSON object per line, in caller order, append-only;
 *   - the writer auto-stamps `ts` so call sites stay terse;
 *   - validation is opt-in (dev/test pay zod cost; prod skips for hot path);
 *   - close() is idempotent and emit-after-close throws (catches programmer
 *     errors in the supervisor's shutdown sequence);
 *   - parent dir is auto-created on first open (so the supervisor can blindly
 *     point at `<runDir>/events.jsonl` without bootstrapping that subtree).
 *
 * The concurrency test (Promise.all of 50 emits) verifies the in-process
 * ordering guarantee: the writer awaits each `appendFile` so consecutive
 * calls observe the in-flight write as already-resolved before issuing their
 * own. The result is FIFO append order at the line level.
 */

let TMP: string;

beforeEach(async () => {
  TMP = path.resolve(os.tmpdir(), 'oa-test-events-' + Math.random().toString(36).slice(2));
  await fs.mkdir(TMP, { recursive: true });
});

afterEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

function readLines(p: string): Promise<string[]> {
  return fs.readFile(p, 'utf8').then((body) => body.split('\n').filter((l) => l.length > 0));
}

describe('openEventWriter', () => {
  it('rejects relative absPath', async () => {
    await expect(openEventWriter({ absPath: 'relative/events.jsonl' })).rejects.toThrow(
      /non-absolute path/,
    );
  });

  it('creates the parent dir when missing', async () => {
    const target = path.resolve(TMP, 'a/b/c/events.jsonl');
    const w = await openEventWriter({ absPath: target });
    await w.emit({ kind: 'run.resume' });
    await w.close();

    const stat = await fs.stat(target);
    expect(stat.isFile()).toBe(true);
  });
});

describe('EventWriter.emit', () => {
  it('appends one JSON line per emit, in order', async () => {
    const target = path.resolve(TMP, 'events.jsonl');
    const w = await openEventWriter({ absPath: target });

    await w.emit({ kind: 'run.resume' });
    await w.emit({ kind: 'run.error', message: 'boom' });
    await w.emit({ kind: 'run.stop', reason: 'completed' });
    await w.close();

    const lines = await readLines(target);
    expect(lines).toHaveLength(3);

    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0].kind).toBe('run.resume');
    expect(parsed[1].kind).toBe('run.error');
    expect(parsed[1].message).toBe('boom');
    expect(parsed[2].kind).toBe('run.stop');
    expect(parsed[2].reason).toBe('completed');
  });

  it('auto-stamps a valid ISO 8601 ts on every emit', async () => {
    const target = path.resolve(TMP, 'events.jsonl');
    const w = await openEventWriter({ absPath: target });

    const before = Date.now();
    await w.emit({ kind: 'run.resume' });
    const after = Date.now();
    await w.close();

    const [line] = await readLines(target);
    const parsed = JSON.parse(line);
    expect(typeof parsed.ts).toBe('string');
    // Strict ISO 8601 with millisecond precision and Z suffix (Date#toISOString).
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const t = Date.parse(parsed.ts);
    expect(Number.isNaN(t)).toBe(false);
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(after);
  });

  it('validates with EventSchema when validate: true', async () => {
    const target = path.resolve(TMP, 'events.jsonl');
    const w = await openEventWriter({ absPath: target, validate: true });

    // `kind: 'not.a.real.kind'` is not in the discriminated union → zod throws.
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      w.emit({ kind: 'not.a.real.kind' as any }),
    ).rejects.toThrow();

    await w.close();
    // Nothing should have been written for the rejected event.
    const body = await fs.readFile(target, 'utf8').catch(() => '');
    expect(body).toBe('');
  });

  it('skips validation when validate is omitted (writes malformed lines)', async () => {
    const target = path.resolve(TMP, 'events.jsonl');
    const w = await openEventWriter({ absPath: target });

    // Bogus kind — no schema check, line is written as-is.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await w.emit({ kind: 'totally.bogus.kind' as any, weird: 1 } as any);
    await w.close();

    const lines = await readLines(target);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.kind).toBe('totally.bogus.kind');
    expect(parsed.weird).toBe(1);
    // Auto-stamping still happens regardless of validation.
    expect(typeof parsed.ts).toBe('string');
  });

  it('preserves ordering under parallel emits', async () => {
    const target = path.resolve(TMP, 'events.jsonl');
    const w = await openEventWriter({ absPath: target });

    const N = 50;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        w.emit({
          kind: 'step.start',
          taskId: 'T-2026-04-18-stress',
          stepN: i + 1,
        }),
      ),
    );
    await w.close();

    const lines = await readLines(target);
    expect(lines).toHaveLength(N);

    const parsed = lines.map((l) => JSON.parse(l));
    // Each emitted event survived intact.
    for (const e of parsed) {
      expect(e.kind).toBe('step.start');
      expect(e.taskId).toBe('T-2026-04-18-stress');
      expect(typeof e.ts).toBe('string');
    }
    // Order is the order of issuance: stepN 1..N appears in file order. The
    // writer awaits each appendFile, so callers that issue in i-order observe
    // a queue that drains in i-order.
    const stepNs = parsed.map((e) => e.stepN);
    expect(stepNs).toEqual(Array.from({ length: N }, (_, i) => i + 1));
  });
});

describe('EventWriter.close', () => {
  it('is idempotent — multiple close() calls are safe', async () => {
    const target = path.resolve(TMP, 'events.jsonl');
    const w = await openEventWriter({ absPath: target });
    await w.emit({ kind: 'run.resume' });
    await w.close();
    await expect(w.close()).resolves.toBeUndefined();
    await expect(w.close()).resolves.toBeUndefined();
  });

  it('emit() after close() throws', async () => {
    const target = path.resolve(TMP, 'events.jsonl');
    const w = await openEventWriter({ absPath: target });
    await w.close();

    await expect(w.emit({ kind: 'run.resume' })).rejects.toThrow(/closed/);
  });
});
