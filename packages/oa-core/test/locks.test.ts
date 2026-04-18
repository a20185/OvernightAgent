import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { withInboxLock } from '../src/locks.js';

let TMP: string;
let ORIG: string | undefined;

beforeEach(async () => {
  ORIG = process.env.OA_HOME;
  TMP = path.resolve(os.tmpdir(), 'oa-test-locks-' + Math.random().toString(36).slice(2));
  process.env.OA_HOME = TMP;
  // The lock helper assumes oaHome() exists (callers run ensureHomeLayout
  // once at startup per Task 1.3 carry-forward). Pre-create the dir here.
  await fs.mkdir(TMP, { recursive: true });
});

afterEach(async () => {
  if (ORIG === undefined) delete process.env.OA_HOME;
  else process.env.OA_HOME = ORIG;
  await fs.rm(TMP, { recursive: true, force: true });
});

describe('withInboxLock', () => {
  it('serializes concurrent withInboxLock calls', async () => {
    const events: Array<{ kind: 'start' | 'end'; ts: number; id: number }> = [];
    const work = (id: number, durationMs: number) =>
      withInboxLock(async () => {
        events.push({ kind: 'start', ts: Date.now(), id });
        await new Promise((r) => setTimeout(r, durationMs));
        events.push({ kind: 'end', ts: Date.now(), id });
      });
    await Promise.all([work(1, 100), work(2, 100), work(3, 100)]);

    // Each (start, end) pair must belong to the same id, in adjacent slots,
    // proving no other critical section ran between them.
    expect(events).toHaveLength(6);
    for (let i = 0; i < events.length; i += 2) {
      expect(events[i]!.kind).toBe('start');
      expect(events[i + 1]!.kind).toBe('end');
      expect(events[i]!.id).toBe(events[i + 1]!.id);
      if (i + 2 < events.length) {
        // Next critical section starts no earlier than this one ended.
        expect(events[i + 1]!.ts).toBeLessThanOrEqual(events[i + 2]!.ts);
      }
    }
  });

  it('propagates the wrapped function return value', async () => {
    const result = await withInboxLock(async () => 42);
    expect(result).toBe(42);

    const obj = await withInboxLock(async () => ({ ok: true, n: 7 }));
    expect(obj).toEqual({ ok: true, n: 7 });
  });

  it('releases the lock when the wrapped function throws', async () => {
    await expect(
      withInboxLock(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow(/boom/);

    // If the previous call had failed to release, this one would either
    // hang past the retry budget (~5s) or eventually reject. It should
    // succeed promptly because the lock was released in finally.
    const t0 = Date.now();
    const value = await withInboxLock(async () => 'after-throw');
    const elapsed = Date.now() - t0;
    expect(value).toBe('after-throw');
    // Comfortably under the ~5s retry budget. 1s is plenty of slack.
    expect(elapsed).toBeLessThan(1000);
  });

  it('propagates the wrapped function thrown error to the caller', async () => {
    const err = new Error('propagate-me');
    await expect(
      withInboxLock(async () => {
        throw err;
      }),
    ).rejects.toBe(err);
  });
});
