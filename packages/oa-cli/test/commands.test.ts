import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

function run(args: string[], env: NodeJS.ProcessEnv = {}): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

describe('oa CLI subcommands', () => {
  let TMP: string;
  let OA_HOME: string;
  let REPO: string;

  beforeEach(async () => {
    TMP = await fs.mkdtemp(path.resolve(os.tmpdir(), 'oa-cli-'));
    OA_HOME = path.resolve(TMP, 'home');
    await fs.mkdir(OA_HOME, { recursive: true });
    REPO = path.resolve(TMP, 'repo');
    await fs.mkdir(REPO);
  });

  afterEach(async () => {
    await fs.rm(TMP, { recursive: true, force: true });
  });

  it('--version prints package.version', () => {
    const r = run(['--version']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim().length).toBeGreaterThan(0);
  });

  it('queue add / ls / rm / clear round-trip', () => {
    const env = { OA_HOME };
    // Seed inbox directly.
    fsSync.mkdirSync(OA_HOME, { recursive: true });
    fsSync.writeFileSync(
      path.resolve(OA_HOME, 'tasks.json'),
      JSON.stringify({
        schemaVersion: 1,
        tasks: [
          {
            id: 't_2026-04-20_0001',
            title: 'x',
            status: 'pending',
            createdAt: new Date().toISOString(),
            sourceAgent: 'claude',
            projectDir: REPO,
            folder: 'tasks/t_2026-04-20_0001',
          },
        ],
      }),
    );
    fsSync.mkdirSync(path.resolve(OA_HOME, 'queue'), { recursive: true });
    fsSync.writeFileSync(
      path.resolve(OA_HOME, 'queue', 'queue.json'),
      JSON.stringify({ schemaVersion: 1, ids: [] }),
    );

    const add = run(['queue', 'add', 't_2026-04-20_0001'], env);
    expect(add.status).toBe(0);
    const ls = run(['queue', 'ls'], env);
    expect(ls.status).toBe(0);
    expect(ls.stdout).toContain('t_2026-04-20_0001');
    const rm = run(['queue', 'rm', 't_2026-04-20_0001'], env);
    expect(rm.status).toBe(0);
    const lsAfter = run(['queue', 'ls'], env);
    expect(lsAfter.stdout.trim()).toBe('(empty)');
    const clear = run(['queue', 'clear'], env);
    expect(clear.status).toBe(0);
  });

  it('intake list (empty inbox) prints (empty)', () => {
    fsSync.mkdirSync(OA_HOME, { recursive: true });
    fsSync.writeFileSync(
      path.resolve(OA_HOME, 'tasks.json'),
      JSON.stringify({ schemaVersion: 1, tasks: [] }),
    );
    const r = run(['intake', 'list'], { OA_HOME });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('(empty)');
  });

  it('plan ls when no plans exist prints (no plans)', () => {
    fsSync.mkdirSync(path.resolve(OA_HOME, 'plans'), { recursive: true });
    const r = run(['plan', 'ls'], { OA_HOME });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('(no plans)');
  });

  it('status with no plan exits 2', () => {
    fsSync.mkdirSync(OA_HOME, { recursive: true });
    const r = run(['status'], { OA_HOME });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('no plan');
  });

  it('stop with no plan exits 2', () => {
    fsSync.mkdirSync(OA_HOME, { recursive: true });
    const r = run(['stop'], { OA_HOME });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('no running plan');
  });

  it('tail --once on nonexistent events log prints nothing and exits 0', () => {
    fsSync.mkdirSync(path.resolve(OA_HOME, 'plans'), { recursive: true });
    // Seed a plan file so tail has a planId fallback.
    const planId = 'p_2026-04-20_0001';
    fsSync.writeFileSync(
      path.resolve(OA_HOME, 'plans', `${planId}.json`),
      JSON.stringify({
        schemaVersion: 1,
        id: planId,
        createdAt: new Date().toISOString(),
        status: 'sealed',
        taskListIds: ['t_2026-04-20_0001'],
        overrides: {},
      }),
    );
    const r = run(['tail', '--once', planId], { OA_HOME });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });
});
