import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Command } from 'commander';
import { controlSocket, socketPath, runDir, plan } from '@soulerou/oa-core';

async function latestPlanId(): Promise<string | null> {
  const plans = await plan.list();
  if (plans.length === 0) return null;
  const running = plans.find((p) => p.status === 'running');
  const chosen = running ?? plans[plans.length - 1];
  return chosen?.id ?? null;
}

/**
 * Live status from control socket if the daemon is running; otherwise derive
 * from events.jsonl (last known state).
 */
async function deriveFromEvents(planId: string): Promise<Record<string, unknown>> {
  const logPath = path.resolve(runDir(planId), 'events.jsonl');
  let raw: string;
  try {
    raw = await fs.readFile(logPath, 'utf8');
  } catch {
    return { planId, source: 'events', state: 'unknown', reason: 'no events.jsonl' };
  }
  const lines = raw.split('\n').filter((l) => l.length > 0);
  const last = lines[lines.length - 1] ?? '';
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(last) as Record<string, unknown>;
  } catch {
    /* ignore */
  }
  return { planId, source: 'events', lastEvent: parsed, lines: lines.length };
}

export function registerStatusCommand(program: Command): void {
  program
    .command('status [planId]')
    .description('show live supervisor status from the control socket or events.jsonl')
    .option('--json', 'print raw JSON')
    .action(async (planIdArg: string | undefined, opts: { json?: boolean }) => {
      const planId = planIdArg ?? (await latestPlanId());
      if (planId === null) {
        process.stderr.write('no plan in store and no planId given\n');
        process.exit(2);
        return;
      }
      let report: Record<string, unknown>;
      try {
        const reply = await controlSocket.request(socketPath(planId), {
          schemaVersion: 1,
          type: 'status',
        });
        report = { planId, source: 'socket', ...reply };
      } catch {
        report = await deriveFromEvents(planId);
      }
      if (opts.json === true) {
        process.stdout.write(`${JSON.stringify(report)}\n`);
      } else {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      }
    });
}
