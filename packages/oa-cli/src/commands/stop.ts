import * as fs from 'node:fs/promises';
import { Command } from 'commander';
import { controlSocket, socketPath, pidfile, plan } from 'oa-core';

async function latestRunningPlanId(): Promise<string | null> {
  const plans = await plan.list();
  const candidate = plans.find((p) => p.status === 'running');
  return candidate?.id ?? null;
}

export function registerStopCommand(program: Command): void {
  program
    .command('stop [planId]')
    .description('ask the running supervisor to stop (SIGTERM via socket)')
    .option('--now', 'force-stop (kill the adapter spawn immediately)')
    .action(async (planIdArg: string | undefined, opts: { now?: boolean }) => {
      const planId = planIdArg ?? (await latestRunningPlanId());
      if (planId === null) {
        process.stderr.write('no running plan in store and no planId given\n');
        process.exit(2);
        return;
      }
      const abs = socketPath(planId);
      try {
        const reply = await controlSocket.request(abs, {
          schemaVersion: 1,
          type: 'stop',
          now: opts.now === true,
        });
        process.stdout.write(`${JSON.stringify(reply, null, 2)}\n`);
      } catch (err) {
        // Fallback: SIGTERM via pidfile.
        let pidStr: string;
        try {
          pidStr = (await fs.readFile(pidfile(planId), 'utf8')).trim();
        } catch {
          process.stderr.write(
            `socket unreachable and no pidfile present: ${
              err instanceof Error ? err.message : String(err)
            }\n`,
          );
          process.exit(1);
          return;
        }
        const pid = Number.parseInt(pidStr, 10);
        if (!Number.isFinite(pid) || pid <= 0) {
          process.stderr.write(`invalid pid in pidfile: ${pidStr}\n`);
          process.exit(1);
          return;
        }
        try {
          process.kill(pid, opts.now === true ? 'SIGKILL' : 'SIGTERM');
          process.stdout.write(`signalled pid ${String(pid)}\n`);
        } catch (sigErr) {
          process.stderr.write(
            `kill failed: ${sigErr instanceof Error ? sigErr.message : String(sigErr)}\n`,
          );
          process.exit(1);
        }
      }
    });
}
