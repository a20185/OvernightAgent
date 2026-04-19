import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { acquire, release, isStale } from '../../src/supervisor/pidfile.js';
import { pidfile } from '../../src/paths.js';

const VALID_PLAN_ID = 'p_2026-04-18_abcd';
const DIST_PIDFILE_URL = new URL('../../dist/supervisor/pidfile.js', import.meta.url).href;

let oldOaHome: string | undefined;
let tmpHome: string;
let children: ChildProcess[] = [];

beforeEach(async () => {
  oldOaHome = process.env.OA_HOME;
  tmpHome = await fs.mkdtemp(path.resolve(os.tmpdir(), 'oa-pidfile-'));
  process.env.OA_HOME = tmpHome;
  children = [];
});

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.pid) {
      try {
        process.kill(child.pid, 'SIGKILL');
      } catch {
        /* ignore */
      }
    }
  }
  if (oldOaHome === undefined) {
    delete process.env.OA_HOME;
  } else {
    process.env.OA_HOME = oldOaHome;
  }
  await fs.rm(tmpHome, { recursive: true, force: true });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnAcquireChild(planId: string): ChildProcess {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      [
        `import { acquire } from ${JSON.stringify(DIST_PIDFILE_URL)};`,
        'try {',
        '  await acquire(process.env.TEST_PLAN_ID);',
        '  process.stdout.write(String(process.pid));',
        '  setInterval(() => {}, 1_000);',
        '} catch (err) {',
        '  process.stderr.write(err instanceof Error ? err.message : String(err));',
        '  process.exit(10);',
        '}',
      ].join('\n'),
    ],
    {
      env: {
        ...process.env,
        OA_HOME: tmpHome,
        TEST_PLAN_ID: planId,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  children.push(child);
  return child;
}

async function waitForLivePidfile(planId: string, timeoutMs = 5_000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      return await fs.readFile(pidfile(planId), 'utf8');
    } catch {
      await delay(25);
    }
  }
  throw new Error(`timed out waiting for pidfile: ${planId}`);
}

async function waitForSingleWinner(
  childrenToCheck: ChildProcess[],
  timeoutMs = 5_000,
): Promise<{ winner: ChildProcess; loser: ChildProcess }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const exited = childrenToCheck.filter((child) => child.exitCode !== null);
    const running = childrenToCheck.filter((child) => child.exitCode === null);
    if (exited.length === 1 && running.length === 1) {
      return { winner: running[0], loser: exited[0] };
    }
    await delay(25);
  }
  throw new Error('timed out waiting for one child to win and one to lose');
}

describe('pidfile lifecycle', () => {
  it('acquire writes the current pid atomically when no live pidfile exists', async () => {
    await acquire(VALID_PLAN_ID);

    const raw = await fs.readFile(pidfile(VALID_PLAN_ID), 'utf8');
    expect(raw.trim()).toBe(String(process.pid));
  });

  it('acquire refuses when the pidfile already contains a live pid', async () => {
    await fs.mkdir(path.dirname(pidfile(VALID_PLAN_ID)), { recursive: true });
    await fs.writeFile(pidfile(VALID_PLAN_ID), `${process.pid}\n`, 'utf8');

    await expect(acquire(VALID_PLAN_ID)).rejects.toThrow(/live pid|already running/i);

    const raw = await fs.readFile(pidfile(VALID_PLAN_ID), 'utf8');
    expect(raw.trim()).toBe(String(process.pid));
  });

  it('acquire replaces a stale pidfile with the current pid', async () => {
    await fs.mkdir(path.dirname(pidfile(VALID_PLAN_ID)), { recursive: true });
    await fs.writeFile(pidfile(VALID_PLAN_ID), '999999\n', 'utf8');

    await acquire(VALID_PLAN_ID);

    const raw = await fs.readFile(pidfile(VALID_PLAN_ID), 'utf8');
    expect(raw.trim()).toBe(String(process.pid));
  });

  it('acquire is single-winner across competing processes', async () => {
    const childA = spawnAcquireChild(VALID_PLAN_ID);
    const childB = spawnAcquireChild(VALID_PLAN_ID);

    const raw = await waitForLivePidfile(VALID_PLAN_ID);
    const { winner, loser } = await waitForSingleWinner([childA, childB]);
    expect(loser.exitCode).not.toBe(0);
    const winnerPid = Number(raw.trim());
    expect(Number.isInteger(winnerPid)).toBe(true);
    expect(winnerPid).toBe(winner.pid);
    expect(winnerPid).not.toBe(loser.pid);
  });

  it('release removes the pidfile and does not throw when it is absent', async () => {
    await acquire(VALID_PLAN_ID);
    await release(VALID_PLAN_ID);
    await expect(fs.access(pidfile(VALID_PLAN_ID))).rejects.toMatchObject({ code: 'ENOENT' });

    await expect(release(VALID_PLAN_ID)).resolves.toBeUndefined();
  });

  it('isStale returns false for a live pid and true for a dead pid', async () => {
    await fs.mkdir(path.dirname(pidfile(VALID_PLAN_ID)), { recursive: true });
    await fs.writeFile(pidfile(VALID_PLAN_ID), `${process.pid}\n`, 'utf8');
    expect(isStale(VALID_PLAN_ID)).toBe(false);

    await fs.writeFile(pidfile(VALID_PLAN_ID), '999999\n', 'utf8');
    expect(isStale(VALID_PLAN_ID)).toBe(true);
  });

  it('rejects malformed plan ids at the public boundary', async () => {
    await expect(acquire('bad id')).rejects.toThrow(/invalid id/);
  });
});
