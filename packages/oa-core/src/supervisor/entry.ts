import * as fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { assertId } from '../ids.js';
import { acquire, release } from './pidfile.js';

/**
 * Minimal supervisor daemon entry scaffold for Task 7.4.
 *
 * The real outer loop lands later; for now the entry only establishes the
 * daemon's runtime shape:
 *   - write `<runDir>/oa.pid` as soon as startup begins,
 *   - stay alive until SIGTERM/SIGINT,
 *   - exit cleanly when signalled.
 */
export async function runSupervisorEntry(planId: string): Promise<void> {
  assertId(planId);

  const keepAlive = setInterval(() => {}, 60_000);
  let resolveStop: () => void = () => {};
  let stopped = false;
  let ownsPidfile = false;
  const stopPromise = new Promise<void>((resolve) => {
    resolveStop = resolve;
  });
  const stop = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopped) return;
    stopped = true;
    fs.writeSync(
      2,
      JSON.stringify({
        ts: new Date().toISOString(),
        kind: 'daemon.signal',
        signal,
      }) + '\n',
    );
    if (ownsPidfile) {
      try {
        await release(planId);
      } catch {
        /* ignore */
      }
    }
    clearInterval(keepAlive);
    resolveStop();
  };
  process.once('SIGTERM', () => {
    void stop('SIGTERM');
  });
  process.once('SIGINT', () => {
    void stop('SIGINT');
  });

  await acquire(planId);
  ownsPidfile = true;

  if (stopped) {
    await release(planId);
    return;
  }

  await stopPromise;
}

const mainArg = process.argv[1];

if (mainArg && import.meta.url === pathToFileURL(mainArg).href) {
  const planId = process.argv[2];
  if (!planId) {
    fs.writeSync(
      2,
      JSON.stringify({
        ts: new Date().toISOString(),
        kind: 'run.error',
        message: 'supervisor entry: missing planId argv[2]',
      }) + '\n',
    );
    process.exit(2);
  }

  void runSupervisorEntry(planId).catch((err) => {
    fs.writeSync(
      2,
      JSON.stringify({
        ts: new Date().toISOString(),
        kind: 'run.error',
        message: err instanceof Error ? err.message : String(err),
      }) + '\n',
    );
    process.exit(1);
  });
}
