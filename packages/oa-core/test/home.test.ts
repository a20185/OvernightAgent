import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ensureHomeLayout } from '../src/home.js';
import { readJson } from '../src/atomicJson.js';

const DEFAULT_CONFIG = {
  schemaVersion: 1,
  defaultAgent: 'claude',
  defaultModel: { claude: 'opus', codex: 'gpt-5', opencode: 'sonnet' },
  defaultReviewer: {
    agent: 'claude',
    model: { claude: 'opus', codex: 'gpt-5', opencode: 'sonnet' },
  },
  defaults: {
    stepTimeoutSec: 1800,
    planBudgetSec: 28800,
    stepStdoutCapBytes: 52428800,
    reviewFixLoop: { enabled: true, maxLoops: 5, blockOn: ['P0', 'P1'] },
    commitMode: 'per-step',
    onFailure: 'markBlocked',
    parallel: { enabled: false, max: 1 },
    references: { strict: false },
  },
};

let TMP: string;
let ORIG: string | undefined;

beforeEach(() => {
  ORIG = process.env.OA_HOME;
  TMP = path.resolve(os.tmpdir(), 'oa-test-home-' + Math.random().toString(36).slice(2));
  process.env.OA_HOME = TMP;
});

afterEach(async () => {
  if (ORIG === undefined) delete process.env.OA_HOME;
  else process.env.OA_HOME = ORIG;
  await fs.rm(TMP, { recursive: true, force: true });
});

async function isDir(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

describe('ensureHomeLayout', () => {
  it('creates oaHome and all subdirs (tasks, plans, runs, worktrees) when starting empty', async () => {
    // Sanity: tmp dir does not exist yet.
    expect(await isDir(TMP)).toBe(false);

    await ensureHomeLayout();

    expect(await isDir(TMP)).toBe(true);
    expect(await isDir(path.resolve(TMP, 'tasks'))).toBe(true);
    expect(await isDir(path.resolve(TMP, 'plans'))).toBe(true);
    expect(await isDir(path.resolve(TMP, 'runs'))).toBe(true);
    expect(await isDir(path.resolve(TMP, 'worktrees'))).toBe(true);
  });

  it('writes config.json matching the documented default schema when none exists', async () => {
    await ensureHomeLayout();
    const cfgPath = path.resolve(TMP, 'config.json');
    const stat = await fs.stat(cfgPath);
    expect(stat.isFile()).toBe(true);

    const parsed = await readJson<typeof DEFAULT_CONFIG>(cfgPath);
    expect(parsed).not.toBeNull();
    expect(parsed!.schemaVersion).toBe(1);
    expect(parsed).toEqual(DEFAULT_CONFIG);
  });

  it('is idempotent: a second call does not throw and leaves dirs/config unchanged', async () => {
    await ensureHomeLayout();
    const cfgPath = path.resolve(TMP, 'config.json');
    const first = await fs.readFile(cfgPath, 'utf8');
    const firstMtime = (await fs.stat(cfgPath)).mtimeMs;

    // Second call must be a no-op.
    await expect(ensureHomeLayout()).resolves.toBeUndefined();

    // Subdirs still present.
    expect(await isDir(path.resolve(TMP, 'tasks'))).toBe(true);
    expect(await isDir(path.resolve(TMP, 'plans'))).toBe(true);
    expect(await isDir(path.resolve(TMP, 'runs'))).toBe(true);
    expect(await isDir(path.resolve(TMP, 'worktrees'))).toBe(true);

    // Config content unchanged.
    const second = await fs.readFile(cfgPath, 'utf8');
    expect(second).toBe(first);

    // Mtime not bumped (no rewrite happened).
    const secondMtime = (await fs.stat(cfgPath)).mtimeMs;
    expect(secondMtime).toBe(firstMtime);
  });

  it('preserves a user-customized config.json on subsequent calls', async () => {
    // Pre-create the home dir + a customized config.
    await fs.mkdir(TMP, { recursive: true });
    const cfgPath = path.resolve(TMP, 'config.json');
    const customized = {
      schemaVersion: 1,
      defaultAgent: 'codex',
      defaultModel: { claude: 'opus', codex: 'gpt-5', opencode: 'sonnet' },
      defaultReviewer: {
        agent: 'claude',
        model: { claude: 'opus', codex: 'gpt-5', opencode: 'sonnet' },
      },
      defaults: {
        stepTimeoutSec: 1800,
        planBudgetSec: 28800,
        stepStdoutCapBytes: 52428800,
        reviewFixLoop: { enabled: true, maxLoops: 5, blockOn: ['P0', 'P1'] },
        commitMode: 'per-step',
        onFailure: 'markBlocked',
        parallel: { enabled: false, max: 1 },
        references: { strict: false },
      },
      __userMarker: 'do-not-overwrite',
    };
    const customizedRaw = JSON.stringify(customized, null, 2);
    await fs.writeFile(cfgPath, customizedRaw, 'utf8');

    await ensureHomeLayout();

    const onDisk = await fs.readFile(cfgPath, 'utf8');
    expect(onDisk).toBe(customizedRaw);
    const parsed = await readJson<typeof customized>(cfgPath);
    expect(parsed).toEqual(customized);
    expect(parsed!.defaultAgent).toBe('codex');
  });
});
