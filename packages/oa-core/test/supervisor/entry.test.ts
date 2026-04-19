import { describe, it, expect, afterEach, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('runSupervisorEntry', () => {
  it('does not release the pidfile before acquire has succeeded when signalled during startup', async () => {
    let resolveAcquire: (() => void) | undefined;
    const acquire = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveAcquire = resolve;
        }),
    );
    const release = vi.fn(async () => {});
    const handlers = new Map<string, () => void>();

    vi.doMock('../../src/supervisor/pidfile.js', () => ({
      acquire,
      release,
    }));
    vi.spyOn(process, 'once').mockImplementation(((event: string, handler: () => void) => {
      handlers.set(event, handler);
      return process;
    }) as typeof process.once);

    const { runSupervisorEntry } = await import('../../src/supervisor/entry.js');

    const run = runSupervisorEntry('p_2026-04-18_abcd');
    handlers.get('SIGTERM')?.();
    await Promise.resolve();

    expect(release).not.toHaveBeenCalled();

    resolveAcquire?.();
    await run;

    expect(release).toHaveBeenCalledTimes(1);
    expect(acquire).toHaveBeenCalledTimes(1);
  });
});
