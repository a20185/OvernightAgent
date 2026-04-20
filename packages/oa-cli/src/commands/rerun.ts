import { Command } from 'commander';
import { resumePlan, detachAndRun } from '@soulerou/oa-core';

export function registerRerunCommand(program: Command): void {
  program
    .command('rerun <planId>')
    .description('resume an interrupted plan (rewind in-flight worktrees, re-enter)')
    .option('--detach', 'spawn the supervisor daemon with OA_RESUME=1 and return')
    .action(async (planId: string, opts: { detach?: boolean }) => {
      if (opts.detach === true) {
        // The daemon entry (supervisor/entry.ts) reads OA_RESUME=1 and
        // delegates to resumePlan instead of runPlan. Launcher process
        // forwards the env via detachAndRun's `env` option.
        detachAndRun(planId, { env: { OA_RESUME: '1' } });
        process.stdout.write(`detached (resume): ${planId}\n`);
        return;
      }

      const ac = new AbortController();
      const onSig = (): void => ac.abort();
      process.once('SIGINT', onSig);
      process.once('SIGTERM', onSig);
      try {
        const res = await resumePlan({ planId, signal: ac.signal });
        process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
      } finally {
        process.removeListener('SIGINT', onSig);
        process.removeListener('SIGTERM', onSig);
      }
    });
}
