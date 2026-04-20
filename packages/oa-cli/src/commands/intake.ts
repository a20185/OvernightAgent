import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Command } from 'commander';
import { submit, inbox, IntakeSchema, taskDir } from 'oa-core';
import type { IntakeSubmitInput, Intake } from 'oa-core';

/**
 * `oa intake submit` reads a submission payload (JSON) and dispatches
 * `intakeSubmit`. The payload shape is `IntakeSubmitInput` from oa-core:
 * title/source/project/executor/reviewer/bootstrap/verify/strategy plus
 * `references` and `sourcePlanMd`. Input is either `--payload <inline>` or
 * `--payload-file <absolutePath>`.
 */
async function readPayload(opts: { payload?: string; payloadFile?: string }): Promise<string> {
  if (opts.payload !== undefined && opts.payloadFile !== undefined) {
    throw new Error('--payload and --payload-file are mutually exclusive');
  }
  if (opts.payload !== undefined) return opts.payload;
  if (opts.payloadFile !== undefined) {
    if (!path.isAbsolute(opts.payloadFile)) {
      throw new Error('--payload-file must be an absolute path');
    }
    return await fs.readFile(opts.payloadFile, 'utf8');
  }
  throw new Error('one of --payload or --payload-file is required');
}

export function registerIntakeCommands(program: Command): void {
  const intake = program
    .command('intake')
    .description('intake: submit, list, show, or remove task submissions');

  intake
    .command('submit')
    .description('submit a task via JSON payload; prints the new taskId')
    .option('--payload <json>', 'inline JSON submission')
    .option('--payload-file <abs>', 'absolute path to a JSON file with the submission')
    .action(async (opts: { payload?: string; payloadFile?: string }) => {
      const raw = await readPayload(opts);
      let parsed: IntakeSubmitInput;
      try {
        parsed = JSON.parse(raw) as IntakeSubmitInput;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`payload is not valid JSON: ${msg}`);
      }
      const result = await submit.intakeSubmit(parsed);
      process.stdout.write(`${result.taskId}\n`);
    });

  intake
    .command('list')
    .description('list the inbox as a table (optionally filter by status)')
    .option('--status <status>', 'filter by task status')
    .action(async (opts: { status?: string }) => {
      const all = await inbox.list();
      const filtered =
        opts.status !== undefined ? all.filter((t) => t.status === opts.status) : all;
      if (filtered.length === 0) {
        process.stdout.write('(empty)\n');
        return;
      }
      for (const t of filtered) {
        process.stdout.write(`${t.id}\t${t.status}\t${t.title}\n`);
      }
    });

  intake
    .command('show <id>')
    .description('pretty-print intake.json and steps.json for the given task')
    .action(async (id: string) => {
      const row = await inbox.get(id);
      if (row === null) {
        process.stderr.write(`no such task: ${id}\n`);
        process.exit(1);
        return;
      }
      const folder = taskDir(id);
      const intakeRaw = await fs.readFile(path.resolve(folder, 'intake.json'), 'utf8');
      const intakeJson = IntakeSchema.parse(JSON.parse(intakeRaw)) as Intake;
      const stepsPath = path.resolve(folder, 'steps.json');
      let stepsJson: unknown;
      try {
        stepsJson = JSON.parse(await fs.readFile(stepsPath, 'utf8'));
      } catch {
        stepsJson = null;
      }
      process.stdout.write(`# ${intakeJson.title} (${id})\n`);
      process.stdout.write(`status: ${row.status}\n`);
      process.stdout.write(`folder: ${folder}\n`);
      process.stdout.write('\n-- intake.json --\n');
      process.stdout.write(`${JSON.stringify(intakeJson, null, 2)}\n`);
      process.stdout.write('\n-- steps.json --\n');
      process.stdout.write(`${JSON.stringify(stepsJson, null, 2)}\n`);
    });

  intake
    .command('rm <id>')
    .description('remove a task from the inbox')
    .option('-y, --yes', 'skip confirmation prompt')
    .action(async (id: string, opts: { yes?: boolean }) => {
      if (opts.yes !== true) {
        process.stderr.write(
          `intake rm without -y is non-interactive; pass -y to confirm\n`,
        );
        process.exit(2);
        return;
      }
      await inbox.remove(id);
      process.stdout.write(`removed: ${id}\n`);
    });
}
