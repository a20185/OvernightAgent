import * as path from 'node:path';
import { Command } from 'commander';
import { eventsReader, summary, runDir, writeFileAtomic } from 'oa-core';

export function registerSummaryCommand(program: Command): void {
  program
    .command('summary <planId>')
    .description('(re)render SUMMARY.md from events.jsonl')
    .option('--stdout', 'print to stdout instead of writing SUMMARY.md')
    .action(async (planId: string, opts: { stdout?: boolean }) => {
      const runDirAbs = runDir(planId);
      const events = await eventsReader.readAll({
        absPath: path.resolve(runDirAbs, 'events.jsonl'),
        onInvalid: () => undefined,
      });
      const md = summary.renderSummary({ planId, events });
      if (opts.stdout === true) {
        process.stdout.write(md);
        return;
      }
      await writeFileAtomic(path.resolve(runDirAbs, 'SUMMARY.md'), md);
      process.stdout.write(`wrote ${path.resolve(runDirAbs, 'SUMMARY.md')}\n`);
    });
}
