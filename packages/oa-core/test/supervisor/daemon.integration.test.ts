import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { detachAndRun } from '../../src/supervisor/daemon.js';
import { pidfile } from '../../src/paths.js';

let TMP: string;
let oldOaHome: string | undefined;
let launchedPlanIds: string[] = [];
let stubSupervisorEntry: string;

beforeEach(async () => {
  TMP = path.resolve(os.tmpdir(), 'oa-test-daemon-' + Math.random().toString(36).slice(2));
  await fs.mkdir(TMP, { recursive: true });
  oldOaHome = process.env.OA_HOME;
  process.env.OA_HOME = path.resolve(TMP, 'home');
  launchedPlanIds = [];
  stubSupervisorEntry = path.resolve(TMP, 'stub-supervisor-entry.mjs');
  await fs.writeFile(
    stubSupervisorEntry,
    [
      "import * as fs from 'node:fs/promises';",
      "import * as path from 'node:path';",
      'const planId = process.argv[2];',
      "const pidPath = path.resolve(process.env.OA_HOME ?? '', 'runs', planId, 'oa.pid');",
      'await fs.mkdir(path.dirname(pidPath), { recursive: true });',
      "await fs.writeFile(pidPath, `${process.pid}\\n`, 'utf8');",
      'const stop = async (signal) => {',
      "  process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), kind: 'daemon.signal', signal }) + '\\n');",
      "  await fs.unlink(pidPath).catch(() => undefined);",
      '  process.exit(0);',
      '};',
      "process.once('SIGTERM', () => { void stop('SIGTERM'); });",
      "process.once('SIGINT', () => { void stop('SIGINT'); });",
      'setInterval(() => {}, 60_000);',
      '',
    ].join('\n'),
    'utf8',
  );
});

afterEach(async () => {
  for (const planId of launchedPlanIds) {
    await cleanupDetachedChild(planId);
  }

  if (oldOaHome === undefined) {
    delete process.env.OA_HOME;
  } else {
    process.env.OA_HOME = oldOaHome;
  }

  await fs.rm(TMP, { recursive: true, force: true });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(p: string, timeoutMs = 5_000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      return await fs.readFile(p, 'utf8');
    } catch {
      await delay(25);
    }
  }
  throw new Error(`timed out waiting for file: ${p}`);
}

async function waitForMissingFile(p: string, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fs.access(p);
      await delay(25);
    } catch {
      return;
    }
  }
  throw new Error(`timed out waiting for file to disappear: ${p}`);
}

async function waitForDeadProcess(pid: number, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isAlive(pid)) return;
    await delay(25);
  }
  throw new Error(`timed out waiting for process to exit: ${pid}`);
}

async function waitForJsonEvent(
  p: string,
  predicate: (event: Record<string, unknown>) => boolean,
  timeoutMs = 5_000,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const raw = await fs.readFile(p, 'utf8');
      for (const line of raw.split('\n').filter((l) => l.length > 0)) {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (predicate(event)) return event;
      }
    } catch {
      /* keep polling */
    }
    await delay(25);
  }
  throw new Error(`timed out waiting for matching JSON event in: ${p}`);
}

async function cleanupDetachedChild(planId: string): Promise<void> {
  const pidPath = pidfile(planId);
  try {
    const pidText = await waitForFile(pidPath, 1_500);
    const pid = Number(pidText.trim());
    if (!Number.isInteger(pid)) return;

    if (isAlive(pid)) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* ignore */
      }
      try {
        await waitForDeadProcess(pid, 1_500);
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* ignore */
        }
        await waitForDeadProcess(pid, 1_500).catch(() => undefined);
      }
    }
  } catch {
    /* best effort */
  }
}

async function exerciseSignal(signal: 'SIGTERM' | 'SIGINT'): Promise<void> {
  const planId = `p_2026-04-18_${signal === 'SIGTERM' ? 'a1' : 'b2'}`;
  launchedPlanIds.push(planId);

  const eventsPath = path.resolve(process.env.OA_HOME ?? '', 'runs', planId, 'events.jsonl');
  const pidPath = pidfile(planId);
  const exitCodes: number[] = [];

  const launcher = detachAndRun(planId, {
    supervisorEntry: stubSupervisorEntry,
    exit: (code) => {
      exitCodes.push(code);
    },
  });
  expect(launcher).toBeUndefined();
  expect(exitCodes).toEqual([0]);

  const pidText = await waitForFile(pidPath);
  const pid = Number(pidText.trim());
  expect(Number.isInteger(pid)).toBe(true);
  expect(isAlive(pid)).toBe(true);

  process.kill(pid, signal);

  const signalEvent = await waitForJsonEvent(eventsPath, (event) => {
    return event.kind === 'daemon.signal' && event.signal === signal;
  });
  expect(signalEvent).toMatchObject({ kind: 'daemon.signal', signal });
  await waitForMissingFile(pidPath);
  await waitForDeadProcess(pid);
}

describe('detachAndRun', () => {
  it('fails fast when the supervisor entry is missing and does not exit the launcher', async () => {
    const planId = 'p_2026-04-18_miss';
    const eventsPath = path.resolve(process.env.OA_HOME ?? '', 'runs', planId, 'events.jsonl');
    const exitCodes: number[] = [];

    expect(() =>
      detachAndRun(planId, {
        supervisorEntry: path.resolve(TMP, 'missing-entry.js'),
        eventsLogPath: eventsPath,
        exit: (code) => {
          exitCodes.push(code);
        },
      }),
    ).toThrow(/supervisor entry missing or unreadable/);
    expect(exitCodes).toEqual([]);
    await expect(fs.access(eventsPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('writes the pidfile on startup, keeps the daemon alive, and handles SIGTERM', async () => {
    await exerciseSignal('SIGTERM');
  });

  it('writes the pidfile on startup, keeps the daemon alive, and handles SIGINT', async () => {
    await exerciseSignal('SIGINT');
  });
});
