#!/usr/bin/env node
import { Command } from 'commander';
import pkg from '../package.json' with { type: 'json' };
import { registerIntakeCommands } from './commands/intake.js';
import { registerQueueCommands } from './commands/queue.js';
import { registerPlanCommands } from './commands/plan.js';
import { registerRunCommand } from './commands/run.js';
import { registerStopCommand } from './commands/stop.js';
import { registerStatusCommand } from './commands/status.js';
import { registerTailCommand } from './commands/tail.js';
import { registerRerunCommand } from './commands/rerun.js';
import { registerArchiveCommand } from './commands/archive.js';
import { registerSummaryCommand } from './commands/summary.js';
import { registerShimsCommands } from './commands/shims.js';

const program = new Command();

program.name('oa').version(pkg.version).description('OvernightAgent CLI');

registerIntakeCommands(program);
registerQueueCommands(program);
registerPlanCommands(program);
registerRunCommand(program);
registerStopCommand(program);
registerStatusCommand(program);
registerTailCommand(program);
registerRerunCommand(program);
registerArchiveCommand(program);
registerSummaryCommand(program);
registerShimsCommands(program);

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
});
