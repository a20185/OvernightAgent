import * as path from 'node:path';
import { Command } from 'commander';
import { eventsReader, summary, runDir, writeFileAtomic, inbox } from '@soulerou/oa-core';

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
      // ADR-0015 — collect skipped task IDs from the inbox so the renderer
      // can annotate them (they have no events in the stream). Best-effort:
      // if the inbox is empty or missing, skippedTaskIds stays [].
      let skippedTaskIds: string[] = [];
      try {
        const allTasks = await inbox.list();
        skippedTaskIds = allTasks
          .filter((t) => t.status === 'skipped')
          .map((t) => t.id);
      } catch {
        /* inbox may not exist in minimal/test setups */
      }
      const md = summary.renderSummary({ planId, events, skippedTaskIds });
      if (opts.stdout === true) {
        process.stdout.write(md);
        return;
      }
      await writeFileAtomic(path.resolve(runDirAbs, 'SUMMARY.md'), md);
      process.stdout.write(`wrote ${path.resolve(runDirAbs, 'SUMMARY.md')}\n`);
    });
}
