import { Command } from 'commander';
import { queue } from 'oa-core';

export function registerQueueCommands(program: Command): void {
  const q = program
    .command('queue')
    .description('queue: add, list, remove, or clear queued task ids');

  q.command('add <ids...>')
    .description('append one or more task ids to the queue')
    .action(async (ids: string[]) => {
      await queue.add(ids);
      process.stdout.write(`queued ${String(ids.length)} task(s)\n`);
    });

  q.command('ls')
    .description('print the current queue, one id per line')
    .action(async () => {
      const ids = await queue.list();
      if (ids.length === 0) {
        process.stdout.write('(empty)\n');
        return;
      }
      for (const id of ids) process.stdout.write(`${id}\n`);
    });

  q.command('rm <id>')
    .description('remove a single id from the queue')
    .action(async (id: string) => {
      await queue.remove(id);
      process.stdout.write(`removed: ${id}\n`);
    });

  q.command('clear')
    .description('empty the queue')
    .action(async () => {
      await queue.clear();
      process.stdout.write('cleared\n');
    });
}
