import { Command } from 'commander';
import { runPlan, detachAndRun, plan } from '@soulerou/oa-core';

export function registerRunCommand(program: Command): void {
  program
    .command('run [planId]')
    .description('run a sealed plan (foreground) or detach it (--detach)')
    .option('--detach', 'spawn the supervisor daemon and return')
    .option('--dry-run', 'print taskList ordering without executing')
    .action(
      async (
        planIdArg: string | undefined,
        opts: { detach?: boolean; dryRun?: boolean },
      ) => {
        let planId = planIdArg;
        if (planId === undefined) {
          // Fall back to the latest sealed/running plan.
          const plans = await plan.list();
          const candidate = plans.find((p) => p.status === 'sealed' || p.status === 'running');
          if (candidate === undefined) {
            process.stderr.write('no planId given and no sealed/running plan in store\n');
            process.exit(2);
            return;
          }
          planId = candidate.id;
        }

        if (opts.dryRun === true) {
          const p = await plan.get(planId);
          if (p === null) {
            process.stderr.write(`no such plan: ${planId}\n`);
            process.exit(1);
            return;
          }
          process.stdout.write(`plan: ${planId}\n`);
          for (const tid of p.taskListIds) process.stdout.write(`  ${tid}\n`);
          return;
        }

        if (opts.detach === true) {
          detachAndRun(planId);
          process.stdout.write(`detached: ${planId}\n`);
          return;
        }

        const ac = new AbortController();
        const onSig = (): void => ac.abort();
        process.once('SIGINT', onSig);
        process.once('SIGTERM', onSig);
        try {
          const res = await runPlan({ planId, signal: ac.signal });
          process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
        } finally {
          process.removeListener('SIGINT', onSig);
          process.removeListener('SIGTERM', onSig);
        }
      },
    );
}
