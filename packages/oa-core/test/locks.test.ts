import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { spawnSync, fork, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { withInboxLock } from '../src/locks.js';

let TMP: string;
let ORIG: string | undefined;

beforeAll(() => {
  // The cross-process test forks the WORKER_PATH .mjs file, which imports
  // from `../../dist/index.js`. child_process.fork runs under plain node and
  // does NOT use vitest's TS transformer, so we must produce a fresh dist
  // before any forks. Mirrors oa-cli/test/cli.test.ts.
  const tsconfigDir = fileURLToPath(new URL('..', import.meta.url));
  const require = createRequire(import.meta.url);
  const tscBin = require.resolve('typescript/bin/tsc');
  const result = spawnSync(process.execPath, [tscBin, '--build', tsconfigDir, '--force'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`tsc build failed (exit ${result.status}): ${result.stderr || result.stdout}`);
  }
  const builtIndex = fileURLToPath(new URL('../dist/index.js', import.meta.url));
  if (!existsSync(builtIndex)) {
    throw new Error(`tsc reported success but did not emit ${builtIndex}`);
  }
});

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

  it('serializes withInboxLock across processes (not just intra-process)', async () => {
    // The intra-process test above can pass even if the FS lock is broken
    // (Promise scheduling alone serializes within a process). This forks
    // multiple node children sharing the same OA_HOME and asserts their
    // critical sections do not overlap — which can ONLY hold if the
    // mkdir-based file lock is genuinely serializing across processes.
    const workerPath = fileURLToPath(new URL('./fixtures/lock-worker.mjs', import.meta.url));
    type Event = { ts: number; kind: 'start' | 'end'; pid: number };
    const events: Event[] = [];

    const spawnWorker = () =>
      new Promise<void>((resolve, reject) => {
        const child: ChildProcess = fork(workerPath, [TMP], { silent: true });
        child.on('message', (msg) => events.push(msg as Event));
        child.on('exit', (code) =>
          code === 0 ? resolve() : reject(new Error(`worker exit ${code}`)),
        );
        child.on('error', reject);
      });

    await Promise.all([spawnWorker(), spawnWorker(), spawnWorker()]);

    // 3 workers x (start + end) = 6 events.
    expect(events).toHaveLength(6);

    // Sort by timestamp; adjacent pairs must belong to the same pid (no
    // interleaving means each critical section ran to completion before the
    // next one started).
    events.sort((a, b) => a.ts - b.ts);
    for (let i = 0; i < events.length; i += 2) {
      expect(events[i]!.kind).toBe('start');
      expect(events[i + 1]!.kind).toBe('end');
      expect(events[i]!.pid).toBe(events[i + 1]!.pid);
      if (i + 2 < events.length) {
        expect(events[i + 1]!.ts).toBeLessThanOrEqual(events[i + 2]!.ts);
      }
    }
  }, 15_000);

  it('recovers from a stale lock left by a dead process', async () => {
    // Simulate: a previous process acquired the lock, crashed without
    // releasing, and the lock dir's mtime has aged past the stale threshold
    // (10s default). withInboxLock should reclaim it within the retry budget.
    const lockTarget = path.resolve(TMP, 'tasks.json.lock');
    const lockDir = lockTarget + '.lock';
    await fs.mkdir(lockDir, { recursive: true });
    // Backdate to 30s ago — well beyond the 10s stale threshold.
    const oldDate = new Date(Date.now() - 30_000);
    await fs.utimes(lockDir, oldDate, oldDate);

    const t0 = Date.now();
    const result = await withInboxLock(async () => 'recovered');
    const elapsed = Date.now() - t0;
    expect(result).toBe('recovered');
    // Should be quick: proper-lockfile detects staleness on the first
    // EEXIST and removes+retries. 2s is generous slack.
    expect(elapsed).toBeLessThan(2000);
  }, 10_000);

  it('rejects with ELOCKED after the retry budget is exhausted', async () => {
    // Hold the lock from a child process so the second call can't acquire
    // and exhausts its retry budget. Using a child process — not in-process
    // — sidesteps proper-lockfile's per-file in-memory `locks` map and
    // exercises the genuine cross-process retry path.
    const holderPath = fileURLToPath(new URL('./fixtures/lock-holder.mjs', import.meta.url));
    const holder = fork(holderPath, [TMP], { silent: true });
    // Wait until the holder has actually acquired (it sends 'acquired').
    await new Promise<void>((resolve, reject) => {
      const onMsg = (msg: unknown) => {
        if ((msg as { kind?: string }).kind === 'acquired') {
          holder.off('message', onMsg);
          resolve();
        }
      };
      holder.on('message', onMsg);
      holder.on('error', reject);
      holder.on('exit', (code) => reject(new Error(`holder exited prematurely (code ${code})`)));
    });

    try {
      const t0 = Date.now();
      const err = await withInboxLock(async () => 'never reached').then(
        () => null,
        (e: unknown) => e,
      );
      const elapsed = Date.now() - t0;
      expect(err).not.toBeNull();
      expect((err as { code?: string }).code).toBe('ELOCKED');
      // ~5s budget (49 retries x 100ms). Floor at 4s, ceiling at 8s.
      expect(elapsed).toBeGreaterThan(4000);
      expect(elapsed).toBeLessThan(8000);
    } finally {
      // Tell holder to release and exit.
      holder.send({ kind: 'release' });
      await new Promise<void>((resolve) => holder.on('exit', () => resolve()));
    }
  }, 15_000);
});
