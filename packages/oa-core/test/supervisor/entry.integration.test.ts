import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { simpleGit } from 'simple-git';
import { ensureHomeLayout } from '../../src/home.js';
import { writeFileAtomic, writeJsonAtomic } from '../../src/atomicJson.js';
import { pidfile, socketPath, taskDir } from '../../src/paths.js';
import * as inbox from '../../src/stores/inbox.js';
import * as plan from '../../src/stores/plan.js';
import { request as controlRequest } from '../../src/supervisor/controlSocket.js';
import { runSupervisorEntry } from '../../src/supervisor/entry.js';
import type { AgentAdapter, AgentRunOpts, AgentRunResult, Intake, Steps } from '../../src/index.js';

const bt = (n: number): string => '`'.repeat(n);
const fence = (kind: string, body: string): string => `${bt(3)}${kind}\n${body}\n${bt(3)}`;
const EMPTY_REVIEW_BLOCK = fence('oa-review', '{"issues":[]}');

let TMP: string;
let REPO: string;
let REVIEWER_PROMPT: string;
let fixtureCounter = 0;

interface Fixture {
  taskId: string;
}

beforeEach(async () => {
  TMP = path.resolve(os.tmpdir(), 'oa-test-entry-' + Math.random().toString(36).slice(2));
  await fs.mkdir(TMP, { recursive: true });
  process.env.OA_HOME = path.resolve(TMP, 'home');
  await ensureHomeLayout();

  REPO = path.resolve(TMP, 'repo');
  await fs.mkdir(REPO);
  const git = simpleGit(REPO);
  await git.init({ '--initial-branch': 'main' });
  await git.addConfig('user.email', 'test@example.com');
  await git.addConfig('user.name', 'Test');
  await fs.writeFile(path.resolve(REPO, 'README.md'), '# init\n');
  await git.add('.');
  await git.commit('init');

  REVIEWER_PROMPT = path.resolve(TMP, 'reviewer-prompt.md');
  await fs.writeFile(REVIEWER_PROMPT, 'Review the diff. Be terse.\n', 'utf8');
});

afterEach(async () => {
  delete process.env.OA_HOME;
  await fs.rm(TMP, { recursive: true, force: true });
});

async function makeTaskFixture(): Promise<Fixture> {
  fixtureCounter += 1;
  const taskId = `t_2026-04-19_${String(fixtureCounter).padStart(4, '0')}`;
  const folder = taskDir(taskId);
  await fs.mkdir(folder, { recursive: true });

  const steps: Steps = {
    schemaVersion: 1,
    steps: [
      {
        n: 1,
        title: 'Step 1',
        spec: 'Wait for supervisor stop.',
        verify: null,
        expectedOutputs: [],
      },
    ],
  };

  const intake: Intake = {
    schemaVersion: 1,
    id: taskId,
    title: 'entry fixture task',
    createdAt: new Date().toISOString(),
    source: { agent: 'claude', sessionId: 'sess', cwd: REPO },
    project: { dir: REPO, baseBranch: 'main', worktreeMode: 'perTaskList' },
    executor: { agent: 'claude', model: 'opus', extraArgs: [] },
    reviewer: {
      agent: 'claude',
      model: 'opus',
      extraArgs: [],
      promptPath: REVIEWER_PROMPT,
    },
    bootstrap: { script: '', timeoutSec: 30 },
    verify: {
      command: 'true',
      requireCommit: true,
      requireTailMessage: true,
    },
    strategy: {
      commitMode: 'per-step',
      onFailure: 'markBlocked',
      reviewFixLoop: { enabled: true, maxLoops: 3, blockOn: ['P0', 'P1'] },
      parallel: { enabled: false, max: 1 },
      stepTimeoutSec: 60,
      stepStdoutCapBytes: 1_000_000,
    },
    references: [],
  };

  await writeJsonAtomic(path.resolve(folder, 'intake.json'), intake);
  await writeJsonAtomic(path.resolve(folder, 'steps.json'), steps);
  await writeFileAtomic(path.resolve(folder, 'HANDOFF.md'), '# HANDOFF\n');
  await writeFileAtomic(path.resolve(folder, 'PROGRESS.md'), '');
  await writeFileAtomic(path.resolve(folder, 'FINDINGS.md'), '');

  await inbox.add({
    id: taskId,
    title: 'entry fixture task',
    status: 'pending',
    createdAt: intake.createdAt,
    sourceAgent: 'claude',
    projectDir: REPO,
    folder: `tasks/${taskId}`,
  });

  return { taskId };
}

async function waitForSocket(planId: string, timeoutMs = 5_000): Promise<string> {
  const p = socketPath(planId);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await controlRequest(p, { schemaVersion: 1, type: 'status' });
      return p;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`timed out waiting for control socket: ${p}`);
}

async function waitForStatus(
  sock: string,
  predicate: (state: Record<string, unknown>) => boolean,
  timeoutMs = 5_000,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const reply = await controlRequest(sock, { schemaVersion: 1, type: 'status' });
    const state = (reply as { state?: Record<string, unknown> }).state;
    if (state && predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for matching status from control socket: ${sock}`);
}

const worker: AgentAdapter = {
  id: 'claude',
  defaultModel: 'opus',
  capabilities: () => ({ supportsSessionId: false, supportsStructuredOutput: false }),
  async run(opts: AgentRunOpts): Promise<AgentRunResult> {
    await new Promise<void>((resolve) => {
      const onAbort = (): void => resolve();
      opts.signal.addEventListener('abort', onAbort, { once: true });
      if (opts.signal.aborted) {
        opts.signal.removeEventListener('abort', onAbort);
        resolve();
      }
    });
    await fs.writeFile(opts.stdoutPath, '', 'utf8');
    await fs.writeFile(opts.stderrPath, '', 'utf8');
    return {
      exitCode: null,
      durationMs: 1,
      timedOut: false,
      stdoutCapHit: false,
      killedBy: 'signal',
    };
  },
};

const reviewer: AgentAdapter = {
  id: 'claude',
  defaultModel: 'opus',
  capabilities: () => ({ supportsSessionId: false, supportsStructuredOutput: false }),
  async run(opts: AgentRunOpts): Promise<AgentRunResult> {
    await fs.writeFile(opts.stdoutPath, EMPTY_REVIEW_BLOCK, 'utf8');
    await fs.writeFile(opts.stderrPath, '', 'utf8');
    return {
      exitCode: 0,
      durationMs: 1,
      timedOut: false,
      stdoutCapHit: false,
      killedBy: null,
    };
  },
};

describe('runSupervisorEntry integration', () => {
  it('starts the real supervisor entry, serves stop over the control socket, and exits', async () => {
    const f = await makeTaskFixture();
    const sealed = await plan.create({ taskListIds: [f.taskId] });
    const sigtermCountBefore = process.listenerCount('SIGTERM');
    const sigintCountBefore = process.listenerCount('SIGINT');

    const runPromise = runSupervisorEntry(sealed.id, {
      workerAdapterFactory: () => worker,
      reviewerAdapterFactory: () => reviewer,
    });

    const sock = await waitForSocket(sealed.id);
    await waitForStatus(sock, (state) => {
      return state.planId === sealed.id;
    });
    const stopReply = await controlRequest(sock, { schemaVersion: 1, type: 'stop', now: false });
    expect(stopReply).toMatchObject({
      schemaVersion: 1,
      type: 'stop.reply',
      acknowledged: true,
      mode: 'graceful',
    });

    await runPromise;

    const reread = await plan.get(sealed.id);
    expect(reread?.status).toBe('stopped');
    await expect(fs.access(pidfile(sealed.id))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(socketPath(sealed.id))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(process.listenerCount('SIGTERM')).toBe(sigtermCountBefore);
    expect(process.listenerCount('SIGINT')).toBe(sigintCountBefore);
  });
});
