import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { simpleGit } from 'simple-git';
import { resumePlan } from '../../src/supervisor/resume.js';
import { runPlan } from '../../src/supervisor/runPlan.js';
import { ensureHomeLayout } from '../../src/home.js';
import { writeFileAtomic, writeJsonAtomic } from '../../src/atomicJson.js';
import { taskDir, runDir, pidfile, worktreeDir } from '../../src/paths.js';
import * as inbox from '../../src/stores/inbox.js';
import * as plan from '../../src/stores/plan.js';
import * as progress from '../../src/state/progress.js';
import type {
  AgentAdapter,
  AgentRunOpts,
  AgentRunResult,
  Intake,
  Steps,
} from '../../src/index.js';

// -----------------------------------------------------------------------------
// Task 7.8 — resumePlan integration tests.
//
// Mirrors the runPlan.integration.test.ts fixture pattern:
//  - tmpdir OA_HOME per test
//  - tmp git repo seeded with an initial commit
//  - per-test cleanup of worktrees + sockets via OA_HOME rm -rf
//
// Each scenario pins the post-resume invariants:
//  - events.jsonl contains a run.resume event with the expected rewound steps
//  - in-flight step progress is rewound from 'running' back to 'pending'
//  - inbox status for in-flight tasks is flipped back to pending before re-entry
//  - worktree is clean (rewindToHead) before the interrupted step re-runs
//  - previously-'done' tasks are NOT re-executed
// -----------------------------------------------------------------------------

const bt = (n: number): string => '`'.repeat(n);
const fence = (kind: string, body: string): string => `${bt(3)}${kind}\n${body}\n${bt(3)}`;
const OK_STATUS_BLOCK = fence('oa-status', '{"status":"done","summary":"shipped"}');
const EMPTY_REVIEW_BLOCK = fence('oa-review', '{"issues":[]}');

interface MockScript {
  stdoutBody?: string;
  exitCode?: number | null;
  killedBy?: 'timeout' | 'stdoutCap' | 'signal' | null;
  sideEffect?: (cwd: string) => Promise<void>;
  waitForSignal?: boolean;
}

interface MockAdapter extends AgentAdapter {
  callCount: () => number;
}

function makeStubAdapter(scripts: MockScript[]): MockAdapter {
  const state = { calls: 0 };
  return {
    id: 'claude',
    defaultModel: 'opus',
    capabilities: () => ({ supportsSessionId: false, supportsStructuredOutput: false }),
    async run(opts: AgentRunOpts): Promise<AgentRunResult> {
      const i = state.calls;
      state.calls += 1;
      const s = scripts[i] ?? scripts[scripts.length - 1] ?? {};
      if (s.waitForSignal) {
        await new Promise<void>((resolve) => {
          const onAbort = (): void => resolve();
          opts.signal.addEventListener('abort', onAbort, { once: true });
          if (opts.signal.aborted) {
            opts.signal.removeEventListener('abort', onAbort);
            resolve();
          }
        });
      }
      await fs.writeFile(opts.stdoutPath, s.stdoutBody ?? '', 'utf8');
      await fs.writeFile(opts.stderrPath, '');
      if (s.sideEffect) await s.sideEffect(opts.cwd);
      return {
        exitCode: s.exitCode ?? 0,
        durationMs: 1,
        timedOut: s.killedBy === 'timeout',
        stdoutCapHit: s.killedBy === 'stdoutCap',
        killedBy: s.killedBy ?? null,
      };
    },
    callCount: () => state.calls,
  };
}

async function commitWork(cwd: string, label: string): Promise<void> {
  const g = simpleGit(cwd);
  const fname = `step-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
  await fs.writeFile(path.resolve(cwd, fname), 'work\n', 'utf8');
  await g.add('.');
  await g.commit(`worker step ${label}`);
}

interface FixtureOpts {
  stepCount?: number;
  onFailure?: 'halt' | 'skip' | 'markBlocked';
  maxLoops?: number;
}

interface Fixture {
  taskId: string;
  taskFolder: string;
}

let fixtureCounter = 0;

async function makeTaskFixture(
  repoDir: string,
  reviewerPromptPath: string,
  o: FixtureOpts = {},
): Promise<Fixture> {
  fixtureCounter += 1;
  const taskId = `t_2026-04-19_${String(fixtureCounter).padStart(4, '0')}`;
  const folder = taskDir(taskId);
  await fs.mkdir(folder, { recursive: true });

  const stepCount = o.stepCount ?? 1;
  const steps: Steps = {
    schemaVersion: 1,
    steps: Array.from({ length: stepCount }, (_, i) => ({
      n: i + 1,
      title: `Step ${String(i + 1)}`,
      spec: `Do step ${String(i + 1)} and commit.`,
      verify: null,
      expectedOutputs: [],
    })),
  };

  const intake: Intake = {
    schemaVersion: 1,
    id: taskId,
    title: 'fixture task',
    createdAt: new Date().toISOString(),
    source: { agent: 'claude', sessionId: 'sess', cwd: repoDir },
    project: { dir: repoDir, baseBranch: 'main', worktreeMode: 'perTaskList' },
    executor: { agent: 'claude', model: 'opus', extraArgs: [] },
    reviewer: {
      agent: 'claude',
      model: 'opus',
      extraArgs: [],
      promptPath: reviewerPromptPath,
    },
    bootstrap: { script: '', timeoutSec: 30 },
    verify: {
      command: 'true',
      requireCommit: true,
      requireTailMessage: true,
    },
    strategy: {
      commitMode: 'per-step',
      onFailure: o.onFailure ?? 'markBlocked',
      reviewFixLoop: { enabled: true, maxLoops: o.maxLoops ?? 3, blockOn: ['P0', 'P1'] },
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
    title: 'fixture task',
    status: 'pending',
    createdAt: intake.createdAt,
    sourceAgent: 'claude',
    projectDir: repoDir,
    folder: `tasks/${taskId}`,
  });

  return { taskId, taskFolder: folder };
}

async function readEvents(planId: string): Promise<Array<Record<string, unknown>>> {
  const p = path.resolve(runDir(planId), 'events.jsonl');
  const raw = await fs.readFile(p, 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Pick a pid that is reliably dead on this host. */
function pickDeadPid(): number {
  let p = 999_999;
  for (let i = 0; i < 100; i += 1) {
    try {
      process.kill(p, 0);
      p += 1;
    } catch {
      return p;
    }
  }
  throw new Error('could not find a dead pid');
}

describe('resumePlan integration (Task 7.8)', () => {
  let TMP: string;
  let REPO: string;
  let REVIEWER_PROMPT: string;

  beforeEach(async () => {
    TMP = path.resolve(os.tmpdir(), 'oa-resume-' + Math.random().toString(36).slice(2, 8));
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

  // (1) Happy path — no prior interruption. resumePlan should behave like a
  //     fresh run, emitting run.resume {rewoundSteps: []} before the usual
  //     run.start / … / run.stop sequence.
  it('happy path — no prior interruption: plan runs fresh to done', async () => {
    const f1 = await makeTaskFixture(REPO, REVIEWER_PROMPT, { stepCount: 1 });
    const f2 = await makeTaskFixture(REPO, REVIEWER_PROMPT, { stepCount: 1 });
    const sealed = await plan.create({ taskListIds: [f1.taskId, f2.taskId] });

    const worker = makeStubAdapter([
      {
        stdoutBody: `ok\n${OK_STATUS_BLOCK}\n`,
        sideEffect: (cwd) => commitWork(cwd, 't1'),
      },
      {
        stdoutBody: `ok\n${OK_STATUS_BLOCK}\n`,
        sideEffect: (cwd) => commitWork(cwd, 't2'),
      },
    ]);
    const reviewer = makeStubAdapter([{ stdoutBody: EMPTY_REVIEW_BLOCK }]);

    const r = await resumePlan({
      planId: sealed.id,
      signal: new AbortController().signal,
      workerAdapterFactory: () => worker,
      reviewerAdapterFactory: () => reviewer,
    });

    expect(r.outcome).toBe('done');
    expect(r.taskOutcomes).toHaveLength(2);
    expect(r.taskOutcomes.every((t) => t.outcome === 'done')).toBe(true);

    const events = await readEvents(sealed.id);
    const kinds = events.map((e) => e.kind);
    // run.resume is the FIRST event, before run.start.
    expect(kinds[0]).toBe('run.resume');
    const resumeEvt = events[0] as {
      kind: string;
      planId: string;
      rewoundSteps: Array<{ taskId: string; stepN: number }>;
    };
    expect(resumeEvt.planId).toBe(sealed.id);
    expect(resumeEvt.rewoundSteps).toEqual([]);
    // Then a normal runPlan sequence.
    expect(kinds).toContain('run.start');
    expect(kinds[kinds.length - 1]).toBe('run.stop');
  });

  // (2) Mid-step interrupt recovery. Simulate a prior crashed supervisor by
  //     running step 1 cleanly, then manually rigging state to look like a
  //     crash-interrupted step 2: progress._json says step 2 is 'running',
  //     inbox status is 'running', the worktree has dirty uncommitted work,
  //     and no pidfile is present. Then call resumePlan and assert it
  //     rewinds the worktree, re-runs step 2 to completion, emits
  //     run.resume with {taskId, stepN: 2}, and lands the task at 'done'.
  it('mid-step interrupt recovery: rewinds worktree, re-runs interrupted step', async () => {
    const f = await makeTaskFixture(REPO, REVIEWER_PROMPT, { stepCount: 2 });
    const sealed = await plan.create({ taskListIds: [f.taskId] });

    // Prime via a controlled first runPlan that completes ONLY step 1. We
    // do this by feeding a strategy with a single step to the supervisor —
    // but the fixture is already 2-step. Simplest: run a short first pass
    // using a worker that completes step 1 then blocks step 2 via a
    // deliberately-failing tail (empty stdout → tail-fail → step 'blocked'
    // under markBlocked policy → task 'blocked-needs-human'). This gives us
    // a real worktree (created by runPlan), step 1 committed, and no
    // residual 'running' progress entries. We'll THEN rig the state
    // manually to look like a crash mid-step-2.
    const reviewerFirst = makeStubAdapter([{ stdoutBody: EMPTY_REVIEW_BLOCK }]);
    const workerFirst = makeStubAdapter([
      {
        stdoutBody: `ok\n${OK_STATUS_BLOCK}\n`,
        sideEffect: (cwd) => commitWork(cwd, 'first-s1'),
      },
      // Step 2 aborts quickly; stdout empty → tail fail → blocked under
      // markBlocked. Avoids needing a live abort signal.
      { stdoutBody: '', exitCode: 0 },
    ]);
    const first = await runPlan({
      planId: sealed.id,
      signal: new AbortController().signal,
      workerAdapterFactory: () => workerFirst,
      reviewerAdapterFactory: () => reviewerFirst,
    });
    expect(first.outcome).toBe('partial');

    // Simulate a crash mid-step-2: manually rig the on-disk state.
    //   - Rewrite _progress.json so step 2 status is 'running'.
    //   - Flip inbox from 'blocked-needs-human' to 'running'.
    //   - Dirty the worktree (uncommitted change to a tracked file).
    //   - Ensure no pidfile exists.
    await progress.mark(f.taskFolder, 2, 'running', 'mid-crash simulation');
    await inbox.setStatus(f.taskId, 'running');

    const absRoot = worktreeDir(f.taskId);
    const readmePath = path.resolve(absRoot, 'README.md');
    await fs.writeFile(readmePath, '# CORRUPTED BY CRASHED SUPERVISOR\n', 'utf8');
    const gitBefore = simpleGit(absRoot);
    const statusBefore = await gitBefore.status();
    expect(statusBefore.files.length).toBeGreaterThan(0);

    // No pidfile should be present (fresh crash: supervisor never wrote one
    // in this test harness).
    await fs.unlink(pidfile(sealed.id)).catch(() => undefined);

    // Resume. Second worker: step 2 completes cleanly.
    const worker2 = makeStubAdapter([
      {
        stdoutBody: `second step 2\n${OK_STATUS_BLOCK}\n`,
        sideEffect: (cwd) => commitWork(cwd, 'second-s2'),
      },
    ]);
    const reviewer2 = makeStubAdapter([{ stdoutBody: EMPTY_REVIEW_BLOCK }]);

    const r = await resumePlan({
      planId: sealed.id,
      signal: new AbortController().signal,
      workerAdapterFactory: () => worker2,
      reviewerAdapterFactory: () => reviewer2,
    });

    expect(r.outcome).toBe('done');

    // Worktree must have been rewound BEFORE the resumed step ran. Since
    // step 2 committed its own fresh content, the tree has a new commit
    // on top; the rewind happened before that, so the CORRUPTED content
    // must not be present in README.
    const readmeNow = await fs.readFile(readmePath, 'utf8');
    expect(readmeNow).not.toContain('CORRUPTED');
    const gitAfter = simpleGit(absRoot);
    const statusAfter = await gitAfter.status();
    expect(statusAfter.isClean()).toBe(true);

    const events = await readEvents(sealed.id);
    const resumeEvt = events.find((e) => e.kind === 'run.resume') as
      | { rewoundSteps: Array<{ taskId: string; stepN: number }> }
      | undefined;
    expect(resumeEvt).toBeDefined();
    expect(resumeEvt?.rewoundSteps).toContainEqual({ taskId: f.taskId, stepN: 2 });

    // Step 2 was re-executed.
    expect(worker2.callCount()).toBe(1);

    // Inbox terminal.
    const tAfter = await inbox.get(f.taskId);
    expect(tAfter?.status).toBe('done');

    // Progress shows step 2 done, not stuck at running.
    const progressMd = await fs.readFile(path.resolve(f.taskFolder, 'PROGRESS.md'), 'utf8');
    expect(progressMd).toMatch(/\| 2 \| done \|/);
  });

  // (3) Stale pidfile with dead pid is cleaned up silently.
  it('stale pidfile (dead pid) is cleaned up; resume proceeds', async () => {
    const f = await makeTaskFixture(REPO, REVIEWER_PROMPT, { stepCount: 1 });
    const sealed = await plan.create({ taskListIds: [f.taskId] });

    // Plant a stale pidfile with a dead pid BEFORE resumePlan runs.
    const deadPid = pickDeadPid();
    const pidPath = pidfile(sealed.id);
    await fs.mkdir(path.dirname(pidPath), { recursive: true });
    await fs.writeFile(pidPath, `${String(deadPid)}\n`, 'utf8');

    const worker = makeStubAdapter([
      {
        stdoutBody: `ok\n${OK_STATUS_BLOCK}\n`,
        sideEffect: (cwd) => commitWork(cwd, 'stale-pidfile'),
      },
    ]);
    const reviewer = makeStubAdapter([{ stdoutBody: EMPTY_REVIEW_BLOCK }]);

    const r = await resumePlan({
      planId: sealed.id,
      signal: new AbortController().signal,
      workerAdapterFactory: () => worker,
      reviewerAdapterFactory: () => reviewer,
    });
    expect(r.outcome).toBe('done');

    // The stale pidfile must have been removed (resume does not own the
    // pidfile; it just cleans the stale one so the real foreground caller
    // can proceed).
    await expect(fs.access(pidPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // (4) Live pidfile refused.
  it('live pidfile refused: resume throws with pid + planId in message', async () => {
    const f = await makeTaskFixture(REPO, REVIEWER_PROMPT, { stepCount: 1 });
    const sealed = await plan.create({ taskListIds: [f.taskId] });

    const pidPath = pidfile(sealed.id);
    await fs.mkdir(path.dirname(pidPath), { recursive: true });
    await fs.writeFile(pidPath, `${String(process.pid)}\n`, 'utf8');

    try {
      await expect(
        resumePlan({
          planId: sealed.id,
          signal: new AbortController().signal,
          workerAdapterFactory: () => makeStubAdapter([{}]),
          reviewerAdapterFactory: () => makeStubAdapter([{}]),
        }),
      ).rejects.toThrow(new RegExp(`${String(process.pid)}.*${sealed.id}|${sealed.id}.*${String(process.pid)}`));
    } finally {
      // afterEach rm -rf TMP will clean up but pidfile sits under
      // <oaHome>/runs/<planId>/oa.pid which is under TMP — safe.
      await fs.unlink(pidPath).catch(() => undefined);
    }
  });

  // (5) Already-done tasks are NOT re-executed on resume.
  it('already-done tasks are skipped: adapter not called for them', async () => {
    const f1 = await makeTaskFixture(REPO, REVIEWER_PROMPT, { stepCount: 1 });
    const f2 = await makeTaskFixture(REPO, REVIEWER_PROMPT, { stepCount: 1 });
    const sealed = await plan.create({ taskListIds: [f1.taskId, f2.taskId] });

    // Manually mark f1 as 'done' — simulates a prior partial run where task 1
    // completed and the crash occurred later. Task 2 stays 'queued'.
    await inbox.setStatus(f1.taskId, 'done');

    const worker = makeStubAdapter([
      {
        stdoutBody: `ok\n${OK_STATUS_BLOCK}\n`,
        sideEffect: (cwd) => commitWork(cwd, 'only-t2'),
      },
    ]);
    const reviewer = makeStubAdapter([{ stdoutBody: EMPTY_REVIEW_BLOCK }]);

    const r = await resumePlan({
      planId: sealed.id,
      signal: new AbortController().signal,
      workerAdapterFactory: () => worker,
      reviewerAdapterFactory: () => reviewer,
    });

    // Plan ends done (task 1 already done, task 2 just ran done).
    expect(r.outcome).toBe('done');
    // Worker should have been called exactly once (task 2 only).
    expect(worker.callCount()).toBe(1);
    // taskOutcomes should describe only the executed task (terminal-status
    // tasks are skipped before emitting any events — they don't appear in
    // the returned per-task outcome list).
    const executedIds = r.taskOutcomes.map((t) => t.taskId);
    expect(executedIds).not.toContain(f1.taskId);
    expect(executedIds).toContain(f2.taskId);

    // Events: no task.start for task 1.
    const events = await readEvents(sealed.id);
    const taskStarts = events.filter((e) => e.kind === 'task.start');
    expect(taskStarts.some((e) => (e as { taskId?: string }).taskId === f1.taskId)).toBe(false);
    expect(taskStarts.some((e) => (e as { taskId?: string }).taskId === f2.taskId)).toBe(true);

    // Inbox: task 1 still done; task 2 now done.
    const t1 = await inbox.get(f1.taskId);
    const t2 = await inbox.get(f2.taskId);
    expect(t1?.status).toBe('done');
    expect(t2?.status).toBe('done');
  });

  // (6) Orphan temp file sweep. Leave a stale `.tmp.<oldpid>.<rand>` file in
  //     the runDir from a prior writeJsonAtomic. resumePlan must sweep it
  //     before the fresh run begins.
  it('orphan temp-file sweep: deletes stale .tmp.<oldpid>.* under runDir', async () => {
    const f = await makeTaskFixture(REPO, REVIEWER_PROMPT, { stepCount: 1 });
    const sealed = await plan.create({ taskListIds: [f.taskId] });

    const runDirAbs = runDir(sealed.id);
    await fs.mkdir(runDirAbs, { recursive: true });
    // A plausible orphan from a crashed writeJsonAtomic in a previous
    // supervisor process. Pid 12345 is not our current pid.
    const orphan = path.resolve(runDirAbs, 'reviewer-default-prompt.md.tmp.12345.abcd');
    await fs.writeFile(orphan, 'orphan\n', 'utf8');

    const worker = makeStubAdapter([
      {
        stdoutBody: `ok\n${OK_STATUS_BLOCK}\n`,
        sideEffect: (cwd) => commitWork(cwd, 'sweep'),
      },
    ]);
    const reviewer = makeStubAdapter([{ stdoutBody: EMPTY_REVIEW_BLOCK }]);

    const r = await resumePlan({
      planId: sealed.id,
      signal: new AbortController().signal,
      workerAdapterFactory: () => worker,
      reviewerAdapterFactory: () => reviewer,
    });
    expect(r.outcome).toBe('done');

    await expect(fs.access(orphan)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
