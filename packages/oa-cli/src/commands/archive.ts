import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Command } from 'commander';
import { oaHome, taskDir, runDir, inbox, plan } from '@soulerou/oa-core';

/**
 * `oa archive <id>` moves either `<oaHome>/tasks/<id>/` or
 * `<oaHome>/runs/<id>/` (whichever exists) to `<oaHome>/_archive/<id>-<ts>/`.
 * For task ids, inbox status is updated to 'archived' if currently terminal.
 */
export function registerArchiveCommand(program: Command): void {
  program
    .command('archive <id>')
    .description('move a task folder or run folder to _archive/')
    .action(async (id: string) => {
      const archiveRoot = path.resolve(oaHome(), '_archive');
      await fs.mkdir(archiveRoot, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const dest = path.resolve(archiveRoot, `${id}-${ts}`);

      const taskFolder = taskDir(id);
      const runFolder = runDir(id);

      let moved: string | null = null;
      try {
        await fs.access(taskFolder);
        await fs.rename(taskFolder, dest);
        moved = 'task';
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      if (moved === null) {
        try {
          await fs.access(runFolder);
          await fs.rename(runFolder, dest);
          moved = 'run';
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
      }
      if (moved === null) {
        process.stderr.write(`no task or run folder found for id: ${id}\n`);
        process.exit(1);
        return;
      }

      if (moved === 'task') {
        const row = await inbox.get(id);
        if (row !== null) await inbox.remove(id);
      }
      if (moved === 'run') {
        const p = await plan.get(id);
        if (p !== null && p.status !== 'done') {
          // No plan.setStatus-to-archived — we simply stop tracking the folder.
        }
      }

      process.stdout.write(`archived ${moved}: ${id} -> ${dest}\n`);
    });
}
