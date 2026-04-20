import { Command } from 'commander';
import { plan, queue } from 'oa-core';

function parseOptionalInt(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${flag} must be a non-negative integer`);
  return n;
}

export function registerPlanCommands(program: Command): void {
  const p = program
    .command('plan')
    .description('plan: create, show, or list sealed execution plans');

  p.command('create')
    .description('seal a new plan from the queue or an explicit task id list')
    .option('--from-queue', 'take ids from the queue snapshot (default)')
    .option('--tasks <ids...>', 'explicit task ids (space separated)')
    .option('--budget <sec>', 'planBudgetSec override')
    .option('--parallel <n>', 'parallel max')
    .action(
      async (opts: {
        fromQueue?: boolean;
        tasks?: string[];
        budget?: string;
        parallel?: string;
      }) => {
        let taskIds: string[];
        if (opts.tasks !== undefined && opts.tasks.length > 0) {
          taskIds = opts.tasks;
        } else {
          taskIds = await queue.snapshot();
        }
        if (taskIds.length === 0) {
          process.stderr.write('plan create: no task ids supplied (queue is empty)\n');
          process.exit(2);
          return;
        }
        const overrides: NonNullable<Parameters<typeof plan.create>[0]['overrides']> = {};
        const budget = parseOptionalInt(opts.budget, '--budget');
        if (budget !== undefined) overrides.planBudgetSec = budget;
        const parallel = parseOptionalInt(opts.parallel, '--parallel');
        if (parallel !== undefined) overrides.parallel = { enabled: parallel > 1, max: parallel };
        const sealed = await plan.create({ taskListIds: taskIds, overrides });
        process.stdout.write(`${sealed.id}\n`);
        process.stdout.write(`status: ${sealed.status}\n`);
        process.stdout.write(`tasks: ${String(sealed.taskListIds.length)}\n`);
      },
    );

  p.command('show <planId>')
    .description('print a plan by id')
    .action(async (planId: string) => {
      const row = await plan.get(planId);
      if (row === null) {
        process.stderr.write(`no such plan: ${planId}\n`);
        process.exit(1);
        return;
      }
      process.stdout.write(`${JSON.stringify(row, null, 2)}\n`);
    });

  p.command('ls')
    .description('list all plans, newest first (by id order)')
    .action(async () => {
      const plans = await plan.list();
      if (plans.length === 0) {
        process.stdout.write('(no plans)\n');
        return;
      }
      for (const pl of plans) {
        process.stdout.write(`${pl.id}\t${pl.status}\t${String(pl.taskListIds.length)} tasks\n`);
      }
    });
}
