import * as fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { assertId } from '../ids.js';
import { acquire, release } from './pidfile.js';
import { runPlan } from './runPlan.js';
import type { RunPlanOpts } from './runPlan.js';

export interface RunSupervisorEntryOpts {
  workerAdapterFactory?: RunPlanOpts['workerAdapterFactory'];
  reviewerAdapterFactory?: RunPlanOpts['reviewerAdapterFactory'];
}

/**
 * Supervisor daemon entrypoint.
 *
 * Startup order is intentionally strict:
 *   1. install SIGTERM/SIGINT handlers,
 *   2. acquire/publish the pidfile,
 *   3. hand off to `runPlan(...)`, which now owns the control socket and live
 *      supervisor loop,
 *   4. always release the pidfile on the way out.
 *
 * Tests can inject adapter factories so the real entry path (pidfile +
 * runPlan + control socket) can be exercised without depending on the dynamic
 * adapter registry.
 */
export async function runSupervisorEntry(
  planId: string,
  opts: RunSupervisorEntryOpts = {},
): Promise<void> {
  assertId(planId);

  const ac = new AbortController();
  let stopSignal: NodeJS.Signals | null = null;
  let stopped = false;
  let ownsPidfile = false;
  const stop = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopped) return;
    stopped = true;
    stopSignal = signal;
    ac.abort();
    fs.writeSync(
      2,
      JSON.stringify({
        ts: new Date().toISOString(),
        kind: 'daemon.signal',
        signal,
      }) + '\n',
    );
  };
  const onSigterm = (): void => {
    void stop('SIGTERM');
  };
  const onSigint = (): void => {
    void stop('SIGINT');
  };
  process.once('SIGTERM', onSigterm);
  process.once('SIGINT', onSigint);

  try {
    await acquire(planId);
    ownsPidfile = true;

    if (stopped) {
      await release(planId);
      return;
    }

    try {
      await runPlan({
        planId,
        signal: ac.signal,
        ...(opts.workerAdapterFactory !== undefined
          ? { workerAdapterFactory: opts.workerAdapterFactory }
          : {}),
        ...(opts.reviewerAdapterFactory !== undefined
          ? { reviewerAdapterFactory: opts.reviewerAdapterFactory }
          : {}),
      });
    } finally {
      if (ownsPidfile) {
        try {
          await release(planId);
        } catch {
          /* ignore */
        }
      }
      void stopSignal;
    }
  } finally {
    process.removeListener('SIGTERM', onSigterm);
    process.removeListener('SIGINT', onSigint);
  }
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
