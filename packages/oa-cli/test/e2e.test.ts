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

/**
 * CLI-level e2e: exercise the read-only + derived-state paths against a
 * hand-seeded OA_HOME. The full supervisor/worktree/adapter flow is
 * exercised by `oa-core/test/supervisor/runPlan.integration.test.ts`;
 * here we verify the CLI glue (subcommands find the state, compose the
 * right shell exit codes, and render the summary).
 */
describe('oa e2e (CLI → on-disk state)', () => {
  let TMP: string;
  let OA_HOME: string;
  const planId = 'p_2026-04-20_e2e1';

  beforeEach(async () => {
    TMP = await fs.mkdtemp(path.resolve(os.tmpdir(), 'oa-e2e-'));
    OA_HOME = path.resolve(TMP, 'home');
    await fs.mkdir(OA_HOME, { recursive: true });
    await fs.mkdir(path.resolve(OA_HOME, 'plans'), { recursive: true });
    await fs.mkdir(path.resolve(OA_HOME, 'runs', planId), { recursive: true });

    await fs.writeFile(
      path.resolve(OA_HOME, 'plans', `${planId}.json`),
      JSON.stringify({
        schemaVersion: 1,
        id: planId,
        createdAt: new Date().toISOString(),
        status: 'done',
        taskListIds: ['t_2026-04-20_0001'],
        overrides: {},
      }),
    );

    const events = [
      { ts: '2026-04-20T00:00:00Z', kind: 'run.start', planId },
      { ts: '2026-04-20T00:00:05Z', kind: 'task.start', taskId: 't_2026-04-20_0001' },
      { ts: '2026-04-20T00:00:10Z', kind: 'step.start', taskId: 't_2026-04-20_0001', stepN: 1 },
      { ts: '2026-04-20T00:00:11Z', kind: 'step.attempt.start', taskId: 't_2026-04-20_0001', stepN: 1, attempt: 1 },
      { ts: '2026-04-20T00:01:00Z', kind: 'step.end', taskId: 't_2026-04-20_0001', stepN: 1, status: 'done' },
      { ts: '2026-04-20T00:02:00Z', kind: 'task.end', taskId: 't_2026-04-20_0001', status: 'done' },
      { ts: '2026-04-20T00:02:05Z', kind: 'run.stop', reason: 'completed' },
    ];
    await fs.writeFile(
      path.resolve(OA_HOME, 'runs', planId, 'events.jsonl'),
      events.map((e) => JSON.stringify(e)).join('\n') + '\n',
    );
  });

  afterEach(async () => {
    await fs.rm(TMP, { recursive: true, force: true });
  });

  it('plan ls shows the seeded plan', () => {
    const r = run(['plan', 'ls'], { OA_HOME });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(planId);
    expect(r.stdout).toContain('done');
  });

  it('plan show returns the plan JSON', () => {
    const r = run(['plan', 'show', planId], { OA_HOME });
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as { id: string; status: string };
    expect(parsed.id).toBe(planId);
    expect(parsed.status).toBe('done');
  });

  it('status derives from events.jsonl when no daemon is running', () => {
    const r = run(['status', '--json', planId], { OA_HOME });
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as { source: string; planId: string };
    expect(parsed.source).toBe('events');
    expect(parsed.planId).toBe(planId);
  });

  it('summary --stdout renders markdown with the run meta and task outcome', () => {
    const r = run(['summary', planId, '--stdout'], { OA_HOME });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`# SUMMARY — ${planId}`);
    expect(r.stdout).toContain('reason=completed');
    expect(r.stdout).toContain('t_2026-04-20_0001');
  });

  it('summary (default) writes to runs/<planId>/SUMMARY.md', () => {
    const r = run(['summary', planId], { OA_HOME });
    expect(r.status).toBe(0);
    const summaryPath = path.resolve(OA_HOME, 'runs', planId, 'SUMMARY.md');
    expect(fsSync.existsSync(summaryPath)).toBe(true);
    const md = fsSync.readFileSync(summaryPath, 'utf8');
    expect(md).toContain(`# SUMMARY — ${planId}`);
  });

  it('tail --once prints the whole events log', () => {
    const r = run(['tail', '--once', '--raw', planId], { OA_HOME });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('"kind":"run.start"');
    expect(r.stdout).toContain('"kind":"run.stop"');
  });
});
