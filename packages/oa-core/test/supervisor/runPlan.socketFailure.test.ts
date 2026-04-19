import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  delete process.env.OA_HOME;
});

describe('runPlan socket-open failure cleanup', () => {
  it('closes the events writer and marks the plan partial when control socket bind fails', async () => {
    const tmp = await fs.mkdtemp(path.resolve(os.tmpdir(), 'oarf-'));
    process.env.OA_HOME = tmp;
    const setStatus = vi.fn(async () => {});
    const emit = vi.fn(async () => {});
    const close = vi.fn(async () => {});

    vi.doMock('../../src/stores/plan.js', () => ({
      get: vi.fn(async () => ({
        schemaVersion: 1,
        id: 'p_2026-04-19_abcd',
        createdAt: new Date().toISOString(),
        status: 'sealed',
        taskListIds: [],
        overrides: {},
      })),
      setStatus,
    }));
    vi.doMock('../../src/events/writer.js', () => ({
      openEventWriter: vi.fn(async () => ({
        emit,
        close,
      })),
    }));
    vi.doMock('../../src/supervisor/controlSocket.js', () => ({
      serve: vi.fn(() => {
        throw new Error('bind failed');
      }),
    }));

    const { runPlan } = await import('../../src/supervisor/runPlan.js');

    await expect(
      runPlan({
        planId: 'p_2026-04-19_abcd',
        signal: new AbortController().signal,
        workerAdapterFactory: vi.fn(),
        reviewerAdapterFactory: vi.fn(),
      }),
    ).rejects.toThrow('bind failed');

    expect(setStatus).toHaveBeenNthCalledWith(1, 'p_2026-04-19_abcd', 'running');
    expect(setStatus).toHaveBeenLastCalledWith('p_2026-04-19_abcd', 'partial');
    expect(close).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({ kind: 'run.error', message: 'bind failed' });
    await fs.rm(tmp, { recursive: true, force: true });
  });
});
