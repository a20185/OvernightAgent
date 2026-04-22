import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command } from 'commander';
import { runDir, plan } from '@soulerou/oa-core';

async function latestPlanId(): Promise<string | null> {
  const plans = await plan.list();
  if (plans.length === 0) return null;
  const running = plans.find((p) => p.status === 'running');
  const chosen = running ?? plans[plans.length - 1];
  return chosen?.id ?? null;
}

// Event kinds that are noisy in interactive `oa tail` but valuable in
// `events.jsonl` for post-mortem analysis. Pretty output filters them; `--raw`
// passes everything through verbatim so operators can still inspect with jq.
const QUIET_KINDS = new Set(['step.heartbeat']);

function formatPretty(line: string): string | null {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    const kind = String(obj.kind ?? '?');
    if (QUIET_KINDS.has(kind)) return null;
    const ts = String(obj.ts ?? '');
    return `${ts} ${kind} ${JSON.stringify(obj)}`;
  } catch {
    return line;
  }
}

export function registerTailCommand(program: Command): void {
  program
    .command('tail [planId]')
    .description('follow events.jsonl like tail -f')
    .option('--raw', 'print raw lines without pretty formatting')
    .option('--once', 'print current content and exit (no follow)')
    .action(async (planIdArg: string | undefined, opts: { raw?: boolean; once?: boolean }) => {
      const planId = planIdArg ?? (await latestPlanId());
      if (planId === null) {
        process.stderr.write('no plan in store and no planId given\n');
        process.exit(2);
        return;
      }
      const logPath = path.resolve(runDir(planId), 'events.jsonl');
      const emit = (line: string): void => {
        if (opts.raw === true) {
          process.stdout.write(`${line}\n`);
          return;
        }
        const pretty = formatPretty(line);
        if (pretty === null) return;
        process.stdout.write(`${pretty}\n`);
      };

      let buffer = '';
      const drain = (chunk: Buffer | string): void => {
        buffer += chunk.toString();
        for (;;) {
          const nl = buffer.indexOf('\n');
          if (nl < 0) break;
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line.length > 0) emit(line);
        }
      };

      let existing = '';
      try {
        existing = await fs.promises.readFile(logPath, 'utf8');
      } catch {
        /* file may not exist yet */
      }
      drain(existing);

      if (opts.once === true) return;

      // Re-open read stream and follow via fs.watchFile polling — simple &
      // portable, avoids the fs.watch/inotify cross-platform mess.
      let position = existing.length;
      const pollMs = 250;
      const abort = new AbortController();
      const onSig = (): void => abort.abort();
      process.once('SIGINT', onSig);
      process.once('SIGTERM', onSig);

      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          fs.stat(logPath, (err, st) => {
            if (err) return;
            if (st.size <= position) return;
            const fd = fs.openSync(logPath, 'r');
            const toRead = st.size - position;
            const buf = Buffer.alloc(toRead);
            fs.readSync(fd, buf, 0, toRead, position);
            fs.closeSync(fd);
            position = st.size;
            drain(buf);
          });
        }, pollMs);
        abort.signal.addEventListener(
          'abort',
          () => {
            clearInterval(timer);
            resolve();
          },
          { once: true },
        );
      });
      process.removeListener('SIGINT', onSig);
      process.removeListener('SIGTERM', onSig);
    });
}
