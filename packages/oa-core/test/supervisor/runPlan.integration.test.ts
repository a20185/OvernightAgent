import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { simpleGit } from 'simple-git';
import { runPlan } from '../../src/supervisor/runPlan.js';
import { ensureHomeLayout } from '../../src/home.js';
import { writeFileAtomic, writeJsonAtomic } from '../../src/atomicJson.js';
import { taskDir, runDir, socketPath, worktreeDir } from '../../src/paths.js';
import * as inbox from '../../src/stores/inbox.js';
import * as plan from '../../src/stores/plan.js';
import { request as controlRequest } from '../../src/supervisor/controlSocket.js';
import type {
  AgentAdapter,
  AgentRunOpts,
  AgentRunResult,
  Intake,
  Steps,
} from '../../src/index.js';

// -----------------------------------------------------------------------------
// Task 7.3 — runPlan (supervisor outer loop) integration tests.
//
// These exercise the supervisor's full per-plan flow against mock adapters in a
// throwaway git repo: load plan → bootstrap each task → run each step (with the
// inner loop from Task 6.7) → verify gates → fix-loop on review issues → write
// progress + findings → emit events → mark inbox + plan terminal statuses.
//
// Each test pins:
//   - the plan-level outcome (`done` / `partial` / `stopped` / `budget-exhausted`)
//   - per-task outcomes
//   - the relevant emitted event kinds (start/end pairing, key transitions)
//
// The mock adapters follow the same `makeStubAdapter` shape used by Task 6.7's
// inner-loop test — keeps both call sites aligned and makes it easy to copy a
// scenario between the two.
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

/**
 * Build a stub AgentAdapter driven by a per-call script. Mirrors the helper in
 * `innerLoop.integration.test.ts` so a scenario can move between the two
 * without re-shaping its inputs.
 */
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

/** Stage + commit a per-step file in the worktree. Used as a mock side-effect. */
async function commitWork(cwd: string, label: string): Promise<void> {
  const g = simpleGit(cwd);
  const fname = `step-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
  await fs.writeFile(path.resolve(cwd, fname), 'work\n', 'utf8');
  await g.add('.');
  await g.commit(`worker step ${label}`);
}

interface FixtureOpts {
  bootstrapScript?: string;
  stepCount?: number;
  verifyCommand?: string;
  reviewerPromptPath?: string;
  onFailure?: 'halt' | 'skip' | 'markBlocked';
  maxLoops?: number;
}

interface Fixture {
  taskId: string;
  taskFolder: string;
}

let fixtureCounter = 0;

/** Lay down an inbox + per-task folder (intake.json + steps.json + HANDOFF/PROGRESS/FINDINGS). */
async function makeTaskFixture(
  repoDir: string,
  reviewerPromptPath: string,
  o: FixtureOpts = {},
): Promise<Fixture> {
  // Use an id that's both a legal task id (matches ID_REGEX) and unique across
  // tests. The taskId.slice(-6) -> branch fragment isn't load-bearing here.
  fixtureCounter += 1;
  const taskId = `t_2026-04-18_${String(fixtureCounter).padStart(4, '0')}`;
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
    bootstrap: { script: o.bootstrapScript ?? '', timeoutSec: 30 },
    verify: {
      command: o.verifyCommand ?? 'true',
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

/** Read the events.jsonl file produced by a run and return the parsed lines. */
async function readEvents(planId: string): Promise<Array<Record<string, unknown>>> {
  const p = path.resolve(runDir(planId), 'events.jsonl');
  const raw = await fs.readFile(p, 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
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

describe('runPlan integration (Task 7.3)', () => {
  let TMP: string;
  let REPO: string;
  let REVIEWER_PROMPT: string;

  beforeEach(async () => {
    TMP = path.resolve(os.tmpdir(), 'oarp-' + Math.random().toString(36).slice(2, 8));
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

  // (1) Single-task happy plan: 2 steps, both green; plan ends 'done'.
  it('happy: 1 task with 2 clean steps -> plan done, both steps committed', async () => {
    const f = await makeTaskFixture(REPO, REVIEWER_PROMPT, { stepCount: 2 });
    const sealed = await plan.create({ taskListIds: [f.taskId] });

    const worker = makeStubAdapter([
      {
        stdoutBody: `step 1 work\n${OK_STATUS_BLOCK}\n`,
        sideEffect: (cwd) => commitWork(cwd, 's1'),
      },
      {
        stdoutBody: `step 2 work\n${OK_STATUS_BLOCK}\n`,
        sideEffect: (cwd) => commitWork(cwd, 's2'),
      },
    ]);
    const reviewer = makeStubAdapter([{ stdoutBody: EMPTY_REVIEW_BLOCK }]);

    const r = await runPlan({
      planId: sealed.id,
      signal: new AbortController().signal,
      workerAdapterFactory: () => worker,
      reviewerAdapterFactory: () => reviewer,
    });

    expect(r.outcome).toBe('done');
    expect(r.taskOutcomes).toHaveLength(1);
    expect(r.taskOutcomes[0]).toEqual({ taskId: f.taskId, outcome: 'done', stepsRun: 2 });

    const events = await readEvents(sealed.id);
    const kinds = events.map((e) => e.kind);
    expect(kinds[0]).toBe('run.start');
    expect(kinds[kinds.length - 1]).toBe('run.stop');
    expect(kinds).toContain('task.start');
    expect(kinds).toContain('task.end');
    expect(kinds.filter((k) => k === 'step.start')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'step.end')).toHaveLength(2);
    expect(kinds).toContain('step.verify.review.ok');
    expect((events[events.length - 1] as { reason?: string }).reason).toBe('completed');

    // PROGRESS.md shows both steps as 'done'.
    const progressMd = await fs.readFile(path.resolve(f.taskFolder, 'PROGRESS.md'), 'utf8');
    expect(progressMd).toMatch(/\| 1 \| done \|/);
    expect(progressMd).toMatch(/\| 2 \| done \|/);

    // Inbox + plan terminal states.
    const t = await inbox.get(f.taskId);
    expect(t?.status).toBe('done');
    const reread = await plan.get(sealed.id);
    expect(reread?.status).toBe('done');

    // Worker adapter was called once per step; reviewer once per step.
    expect(worker.callCount()).toBe(2);
    expect(reviewer.callCount()).toBe(2);
  });

  // (2) Bootstrap fails: task is marked 'bootstrap-failed', plan is 'partial'.
  it('bootstrap fails: task is marked bootstrap-failed, plan ends partial', async () => {
    const f = await makeTaskFixture(REPO, REVIEWER_PROMPT, {
      stepCount: 1,
      bootstrapScript: '#!/usr/bin/env bash\nexit 9\n',
    });
    const sealed = await plan.create({ taskListIds: [f.taskId] });

    const worker = makeStubAdapter([{ stdoutBody: `nope\n${OK_STATUS_BLOCK}\n` }]);
    const reviewer = makeStubAdapter([{ stdoutBody: EMPTY_REVIEW_BLOCK }]);

    const r = await runPlan({
      planId: sealed.id,
      signal: new AbortController().signal,
      workerAdapterFactory: () => worker,
      reviewerAdapterFactory: () => reviewer,
    });

    expect(r.outcome).toBe('partial');
    expect(r.taskOutcomes).toHaveLength(1);
    expect(r.taskOutcomes[0]).toEqual({
      taskId: f.taskId,
      outcome: 'bootstrap-failed',
      stepsRun: 0,
    });

    // Worker should NOT have been called — bootstrap failure short-circuits steps.
    expect(worker.callCount()).toBe(0);

    const events = await readEvents(sealed.id);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('task.bootstrap.start');
    expect(kinds).toContain('task.bootstrap.end');
    // The task.end event reports the bootstrap-failed status.
    const taskEnd = events.find(
      (e) => e.kind === 'task.end' && e.taskId === f.taskId,
    ) as { status?: string } | undefined;
    expect(taskEnd?.status).toBe('bootstrap-failed');

    const t = await inbox.get(f.taskId);
    expect(t?.status).toBe('bootstrap-failed');
    const reread = await plan.get(sealed.id);
    expect(reread?.status).toBe('partial');
  });

  // (3) Step fails verify: worker emits a clean tail but never commits.
  // Commit gate fails => task marked 'failed' (markBlocked policy => task ends
  // 'blocked-needs-human' downstream wouldn't apply here because the failing
  // gate is commit, not review). Plan ends 'partial'.
  it('verify fails (no commit): task marked blocked-needs-human, plan ends partial', async () => {
    const f = await makeTaskFixture(REPO, REVIEWER_PROMPT, { stepCount: 1 });
    const sealed = await plan.create({ taskListIds: [f.taskId] });

    // Worker emits a 'done' status block but never makes a commit.
    const worker = makeStubAdapter([{ stdoutBody: `claimed done\n${OK_STATUS_BLOCK}\n` }]);
    const reviewer = makeStubAdapter([{ stdoutBody: EMPTY_REVIEW_BLOCK }]);

    const r = await runPlan({
      planId: sealed.id,
      signal: new AbortController().signal,
      workerAdapterFactory: () => worker,
      reviewerAdapterFactory: () => reviewer,
    });

    expect(r.outcome).toBe('partial');
    expect(r.taskOutcomes).toHaveLength(1);
    // markBlocked policy + verify-gate failure => task is 'blocked-needs-human'.
    expect(r.taskOutcomes[0]?.outcome).toBe('blocked-needs-human');

    // Reviewer must NOT have been called — commit-gate fails before we
    // reach the (expensive) reviewer invocation.
    expect(reviewer.callCount()).toBe(0);

    const events = await readEvents(sealed.id);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('step.verify.commit.fail');
    expect(kinds).not.toContain('step.verify.review.ok');
    expect(kinds).not.toContain('step.verify.review.fail');

    const t = await inbox.get(f.taskId);
    expect(t?.status).toBe('blocked-needs-human');
    const reread = await plan.get(sealed.id);
    expect(reread?.status).toBe('partial');
  });

  // (4) Fix loop: P0 first attempt, clean second attempt. Step ends 'done',
  // task ends 'done', plan ends 'done'.
  it('fix loop: P0 then clean -> step done in 2 attempts, plan done', async () => {
    const f = await makeTaskFixture(REPO, REVIEWER_PROMPT, { stepCount: 1, maxLoops: 3 });
    const sealed = await plan.create({ taskListIds: [f.taskId] });

    const worker = makeStubAdapter([
      {
        stdoutBody: `attempt 1\n${OK_STATUS_BLOCK}\n`,
        sideEffect: (cwd) => commitWork(cwd, 'a1'),
      },
      {
        stdoutBody: `attempt 2 fixed\n${OK_STATUS_BLOCK}\n`,
        sideEffect: (cwd) => commitWork(cwd, 'a2'),
      },
    ]);
    const reviewer = makeStubAdapter([
      {
        stdoutBody: fence(
          'oa-review',
          JSON.stringify({
            issues: [{ priority: 'P0', file: 'x.ts', finding: 'bad', suggestion: 'fix it' }],
          }),
        ),
      },
      { stdoutBody: EMPTY_REVIEW_BLOCK },
    ]);

    const r = await runPlan({
      planId: sealed.id,
      signal: new AbortController().signal,
      workerAdapterFactory: () => worker,
      reviewerAdapterFactory: () => reviewer,
    });

    expect(r.outcome).toBe('done');
    expect(r.taskOutcomes[0]).toEqual({
      taskId: f.taskId,
      outcome: 'done',
      stepsRun: 1,
    });

    expect(worker.callCount()).toBe(2);
    expect(reviewer.callCount()).toBe(2);

    const events = await readEvents(sealed.id);
    const attemptStarts = events.filter((e) => e.kind === 'step.attempt.start');
    expect(attemptStarts).toHaveLength(2);
    expect(attemptStarts[0]).toMatchObject({ attempt: 1 });
    expect(attemptStarts[1]).toMatchObject({ attempt: 2 });
    // The fix-synthesized event marks the boundary between attempts 1 and 2.
    expect(events.some((e) => e.kind === 'step.fix.synthesized')).toBe(true);

    // The attempt-2 prompt on disk must surface the open review issue —
    // proves the fix-loop wiring threads issues through to the next prompt.
    const prompt2 = await fs.readFile(
      path.resolve(runDir(sealed.id), 'steps', f.taskId, '1', '2', 'prompt.md'),
      'utf8',
    );
    expect(prompt2).toContain('Open review issues');
    expect(prompt2).toContain('[P0]');
    expect(prompt2).toContain('x.ts');

    const t = await inbox.get(f.taskId);
    expect(t?.status).toBe('done');
    const reread = await plan.get(sealed.id);
    expect(reread?.status).toBe('done');
  });

  // (5) Signal abort mid-plan: 2 tasks, abort while task 1 is mid-step.
  // Plan ends 'stopped', task 2 never started. With the post-Task-7.3
  // hardening (mid-attempt abort checks before verifyCmd / runReviewer), an
  // abort that fires inside the worker's sideEffect is observed at the next
  // gate boundary — task 1's step lands as 'blocked' under the markBlocked
  // policy, the task aggregates to 'blocked-needs-human', and task 2 is
  // skipped entirely at the next per-task abort check.
  it('signal abort mid-plan: task 2 never starts, plan ends stopped', async () => {
    const f1 = await makeTaskFixture(REPO, REVIEWER_PROMPT, { stepCount: 1 });
    const f2 = await makeTaskFixture(REPO, REVIEWER_PROMPT, { stepCount: 1 });
    const sealed = await plan.create({ taskListIds: [f1.taskId, f2.taskId] });

    const ac = new AbortController();
    const worker = makeStubAdapter([
      {
        stdoutBody: `task 1 step 1\n${OK_STATUS_BLOCK}\n`,
        sideEffect: async (cwd) => {
          await commitWork(cwd, 't1');
          // Abort AFTER the first task's commit lands but BEFORE verifyCmd /
          // reviewer get to run. The supervisor's mid-attempt abort guards
          // short-circuit those gates.
          ac.abort();
        },
      },
      // Will never be called.
      {
        stdoutBody: `task 2 unused\n${OK_STATUS_BLOCK}\n`,
        sideEffect: (cwd) => commitWork(cwd, 't2'),
      },
    ]);
    const reviewer = makeStubAdapter([{ stdoutBody: EMPTY_REVIEW_BLOCK }]);

    const r = await runPlan({
      planId: sealed.id,
      signal: ac.signal,
      workerAdapterFactory: () => worker,
      reviewerAdapterFactory: () => reviewer,
    });

    expect(r.outcome).toBe('stopped');
    expect(r.taskOutcomes).toHaveLength(1);
    // User aborts keep the in-flight step resumable, so the current task is
    // surfaced as stopped rather than as a verify/reviewer failure.
    expect(r.taskOutcomes[0]).toEqual({
      taskId: f1.taskId,
      outcome: 'stopped',
      stepsRun: 1,
    });

    // Worker called exactly once — only task 1's step. Task 2 never started.
    expect(worker.callCount()).toBe(1);
    // Reviewer never called: the abort check before runReviewer (and before
    // verifyCmd) short-circuits before we reach the reviewer.
    expect(reviewer.callCount()).toBe(0);

    const events = await readEvents(sealed.id);
    const kinds = events.map((e) => e.kind);
    // task.start fires once (task 1) — task 2 skipped before any task.start.
    expect(kinds.filter((k) => k === 'task.start')).toHaveLength(1);
    // run.stop reports 'stopped'.
    const last = events[events.length - 1] as { kind?: string; reason?: string };
    expect(last.kind).toBe('run.stop');
    expect(last.reason).toBe('user');

    // Inbox: task 1 is stopped/resumable, task 2 untouched (still 'queued'
    // from seal — operator can resume).
    const t1 = await inbox.get(f1.taskId);
    expect(t1?.status).toBe('stopped');
    const t2 = await inbox.get(f2.taskId);
    expect(t2?.status).toBe('queued');

    const reread = await plan.get(sealed.id);
    expect(reread?.status).toBe('stopped');
  });

  // Bonus coverage for the rewindToHead-between-attempts contract (ADR-0003).
  // Drop a junk file in the worktree between attempt 1 and attempt 2; after
  // rewind it must be gone before attempt 2 runs.
  it('per-attempt rewind: junk dropped after attempt 1 is wiped before attempt 2', async () => {
    const f = await makeTaskFixture(REPO, REVIEWER_PROMPT, { stepCount: 1, maxLoops: 3 });
    const sealed = await plan.create({ taskListIds: [f.taskId] });
    let junkExistedAtAttempt2: boolean | null = null;

    const worker = makeStubAdapter([
      {
        stdoutBody: `attempt 1\n${OK_STATUS_BLOCK}\n`,
        sideEffect: async (cwd) => {
          await commitWork(cwd, 'a1');
          // Drop an UNTRACKED junk file. The next attempt's rewindToHead must
          // wipe it (per ADR-0003, `git clean -fdx`).
          await fs.writeFile(path.resolve(cwd, 'JUNK.tmp'), 'should be wiped\n', 'utf8');
        },
      },
      {
        stdoutBody: `attempt 2\n${OK_STATUS_BLOCK}\n`,
        sideEffect: async (cwd) => {
          // Probe BEFORE committing — the rewind already ran by the time the
          // second adapter call happens.
          junkExistedAtAttempt2 = await fs
            .access(path.resolve(cwd, 'JUNK.tmp'))
            .then(() => true)
            .catch(() => false);
          await commitWork(cwd, 'a2');
        },
      },
    ]);
    const reviewer = makeStubAdapter([
      {
        stdoutBody: fence(
          'oa-review',
          JSON.stringify({
            issues: [{ priority: 'P0', file: 'y.ts', finding: 'bad' }],
          }),
        ),
      },
      { stdoutBody: EMPTY_REVIEW_BLOCK },
    ]);

    const r = await runPlan({
      planId: sealed.id,
      signal: new AbortController().signal,
      workerAdapterFactory: () => worker,
      reviewerAdapterFactory: () => reviewer,
    });
    expect(r.outcome).toBe('done');
    expect(junkExistedAtAttempt2).toBe(false);
  });

  it('status over control socket reports the live task, step, attempt, elapsed, and budget fields', async () => {
    const f = await makeTaskFixture(REPO, REVIEWER_PROMPT, { stepCount: 1 });
    const sealed = await plan.create({
      taskListIds: [f.taskId],
      overrides: { planBudgetSec: 123 },
    });

    const worker = makeStubAdapter([
      {
        waitForSignal: true,
        stdoutBody: `waiting\n${OK_STATUS_BLOCK}\n`,
        sideEffect: (cwd) => commitWork(cwd, 'socket-status'),
      },
    ]);
    const reviewer = makeStubAdapter([{ stdoutBody: EMPTY_REVIEW_BLOCK }]);
    const ac = new AbortController();

    const runPromise = runPlan({
      planId: sealed.id,
      signal: ac.signal,
      workerAdapterFactory: () => worker,
      reviewerAdapterFactory: () => reviewer,
    });

    const sock = await waitForSocket(sealed.id);
    const liveState = await waitForStatus(sock, (state) => {
      return state.currentTaskId === f.taskId && state.currentStepN === 1 && state.currentAttempt === 1;
    });
    const statusReply = await controlRequest(sock, { schemaVersion: 1, type: 'status' });
    expect(statusReply).toMatchObject({
      schemaVersion: 1,
      type: 'status.reply',
      state: {
        planId: sealed.id,
        currentTaskId: f.taskId,
        currentStepN: 1,
        currentAttempt: 1,
        elapsedRunMs: expect.any(Number),
        elapsedTaskMs: expect.any(Number),
        elapsedStepMs: expect.any(Number),
        budgetRemainingMs: expect.any(Number),
      },
    });
    expect(liveState.currentStepN).toBe(1);

    ac.abort();
    const result = await runPromise;
    expect(result.outcome).toBe('stopped');
  });

  it('graceful stop over control socket aborts the run and exits stopped', async () => {
    const f = await makeTaskFixture(REPO, REVIEWER_PROMPT, { stepCount: 1 });
    const sealed = await plan.create({ taskListIds: [f.taskId] });

    const worker = makeStubAdapter([
      {
        waitForSignal: true,
        stdoutBody: `waiting\n${OK_STATUS_BLOCK}\n`,
        sideEffect: (cwd) => commitWork(cwd, 'socket-stop'),
      },
    ]);
    const reviewer = makeStubAdapter([{ stdoutBody: EMPTY_REVIEW_BLOCK }]);

    const runPromise = runPlan({
      planId: sealed.id,
      signal: new AbortController().signal,
      workerAdapterFactory: () => worker,
      reviewerAdapterFactory: () => reviewer,
    });

    const sock = await waitForSocket(sealed.id);
    await waitForStatus(sock, (state) => {
      return state.currentTaskId === f.taskId && state.currentStepN === 1 && state.currentAttempt === 1;
    });
    const stopReply = await controlRequest(sock, { schemaVersion: 1, type: 'stop', now: false });
    expect(stopReply).toMatchObject({
      schemaVersion: 1,
      type: 'stop.reply',
      acknowledged: true,
      mode: 'graceful',
    });

    const result = await runPromise;
    expect(result.outcome).toBe('stopped');

    const reread = await plan.get(sealed.id);
    expect(reread?.status).toBe('stopped');
    const progressMd = await fs.readFile(path.resolve(f.taskFolder, 'PROGRESS.md'), 'utf8');
    expect(progressMd).toMatch(/\| 1 \| pending \|/);
  });

  it('graceful stop during reviewer aborts the reviewer run and exits stopped', async () => {
    const f = await makeTaskFixture(REPO, REVIEWER_PROMPT, { stepCount: 1 });
    const sealed = await plan.create({ taskListIds: [f.taskId] });
    let reviewerReleased: (() => void) | undefined;

    const worker = makeStubAdapter([
      {
        stdoutBody: `done\n${OK_STATUS_BLOCK}\n`,
        sideEffect: (cwd) => commitWork(cwd, 'reviewer-graceful-stop'),
      },
    ]);
    const reviewer: MockAdapter = {
      id: 'claude',
      defaultModel: 'opus',
      capabilities: () => ({ supportsSessionId: false, supportsStructuredOutput: false }),
      async run(opts: AgentRunOpts): Promise<AgentRunResult> {
        await new Promise<void>((resolve) => {
          reviewerReleased = resolve;
          opts.signal.addEventListener('abort', () => resolve(), { once: true });
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
      callCount: () => 1,
    };

    const runPromise = runPlan({
      planId: sealed.id,
      signal: new AbortController().signal,
      workerAdapterFactory: () => worker,
      reviewerAdapterFactory: () => reviewer,
    });

    const sock = await waitForSocket(sealed.id);
    const start = Date.now();
    while (reviewerReleased === undefined && Date.now() - start < 5_000) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(reviewerReleased).toBeTypeOf('function');

    const stopReply = await controlRequest(sock, { schemaVersion: 1, type: 'stop', now: false });
    expect(stopReply).toMatchObject({
      schemaVersion: 1,
      type: 'stop.reply',
      acknowledged: true,
      mode: 'graceful',
    });

    const result = await runPromise;
    expect(result.outcome).toBe('stopped');

    const reread = await plan.get(sealed.id);
    expect(reread?.status).toBe('stopped');
    const progressMd = await fs.readFile(path.resolve(f.taskFolder, 'PROGRESS.md'), 'utf8');
    expect(progressMd).toMatch(/\| 1 \| pending \|/);
  });

  it('force stop now kills the in-flight worker, marks the step pending, and exits', async () => {
    const f = await makeTaskFixture(REPO, REVIEWER_PROMPT, { stepCount: 1 });
    const sealed = await plan.create({ taskListIds: [f.taskId] });
    let killNow: (() => void) | undefined;

    const worker: MockAdapter = {
      id: 'claude',
      defaultModel: 'opus',
      capabilities: () => ({ supportsSessionId: false, supportsStructuredOutput: false }),
      async run(opts: AgentRunOpts): Promise<AgentRunResult> {
        opts.onSpawned?.({
          killNow: () => {
            killNow?.();
          },
        });
        await new Promise<AgentRunResult>((resolve) => {
          killNow = () =>
            resolve({
              exitCode: null,
              durationMs: 1,
              timedOut: false,
              stdoutCapHit: false,
              killedBy: 'signal',
            });
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
      callCount: () => 1,
    };
    const reviewer = makeStubAdapter([{ stdoutBody: EMPTY_REVIEW_BLOCK }]);

    const runPromise = runPlan({
      planId: sealed.id,
      signal: new AbortController().signal,
      workerAdapterFactory: () => worker,
      reviewerAdapterFactory: () => reviewer,
    });

    const sock = await waitForSocket(sealed.id);
    const start = Date.now();
    while (killNow === undefined && Date.now() - start < 5_000) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(killNow).toBeTypeOf('function');
    const stopReply = await controlRequest(sock, { schemaVersion: 1, type: 'stop', now: true });
    expect(stopReply).toMatchObject({
      schemaVersion: 1,
      type: 'stop.reply',
      acknowledged: true,
      mode: 'force-now',
    });

    const result = await runPromise;
    expect(result.outcome).toBe('stopped');

    const progressMd = await fs.readFile(path.resolve(f.taskFolder, 'PROGRESS.md'), 'utf8');
    expect(progressMd).toMatch(/\| 1 \| pending \|/);

    const events = await readEvents(sealed.id);
    const last = events[events.length - 1] as { kind?: string; reason?: string };
    expect(last.kind).toBe('run.stop');
    expect(last.reason).toBe('user');
  });

  // Task 2.4 — OA_TASK_DIR + OA_CURRENT_PROMPT env vars are passed to the
  // worker adapter via opts.env. This test captures the env from the mock
  // adapter and asserts both vars are present with correct absolute values.
  it('passes OA_TASK_DIR and OA_CURRENT_PROMPT env vars to worker adapter', async () => {
    const f = await makeTaskFixture(REPO, REVIEWER_PROMPT, { stepCount: 1 });
    const sealed = await plan.create({ taskListIds: [f.taskId] });

    let capturedEnv: Record<string, string> | undefined;
    let capturedPromptPath: string | undefined;

    const worker: MockAdapter = {
      id: 'claude',
      defaultModel: 'opus',
      capabilities: () => ({ supportsSessionId: false, supportsStructuredOutput: false }),
      async run(opts: AgentRunOpts): Promise<AgentRunResult> {
        capturedEnv = opts.env;
        capturedPromptPath = opts.promptPath;
        await fs.writeFile(opts.stdoutPath, `done\n${OK_STATUS_BLOCK}\n`, 'utf8');
        await fs.writeFile(opts.stderrPath, '');
        await commitWork(opts.cwd, 'env-test');
        return { exitCode: 0, durationMs: 1, timedOut: false, stdoutCapHit: false, killedBy: null };
      },
      callCount: () => 1,
    };
    const reviewer = makeStubAdapter([{ stdoutBody: EMPTY_REVIEW_BLOCK }]);

    const r = await runPlan({
      planId: sealed.id,
      signal: new AbortController().signal,
      workerAdapterFactory: () => worker,
      reviewerAdapterFactory: () => reviewer,
    });

    expect(r.outcome).toBe('done');

    // The env field must be present and contain both OA_ vars.
    expect(capturedEnv).toBeDefined();
    expect(capturedEnv!.OA_TASK_DIR).toBe(f.taskFolder);
    expect(capturedEnv!.OA_CURRENT_PROMPT).toBe(capturedPromptPath);
    expect(path.isAbsolute(capturedEnv!.OA_TASK_DIR!)).toBe(true);
    expect(path.isAbsolute(capturedEnv!.OA_CURRENT_PROMPT!)).toBe(true);
  });

  it('force stop now during reviewer kill marks the step pending and exits', async () => {
    const f = await makeTaskFixture(REPO, REVIEWER_PROMPT, { stepCount: 1 });
    const sealed = await plan.create({ taskListIds: [f.taskId] });
    let reviewerKillNow: (() => void) | undefined;

    const worker = makeStubAdapter([
      {
        stdoutBody: `done\n${OK_STATUS_BLOCK}\n`,
        sideEffect: (cwd) => commitWork(cwd, 'reviewer-force-stop'),
      },
    ]);
    const reviewer: MockAdapter = {
      id: 'claude',
      defaultModel: 'opus',
      capabilities: () => ({ supportsSessionId: false, supportsStructuredOutput: false }),
      async run(opts: AgentRunOpts): Promise<AgentRunResult> {
        opts.onSpawned?.({
          killNow: () => {
            reviewerKillNow?.();
          },
        });
        await new Promise<void>((resolve) => {
          reviewerKillNow = () => resolve();
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
      callCount: () => 1,
    };

    const runPromise = runPlan({
      planId: sealed.id,
      signal: new AbortController().signal,
      workerAdapterFactory: () => worker,
      reviewerAdapterFactory: () => reviewer,
    });

    const sock = await waitForSocket(sealed.id);
    const start = Date.now();
    while (reviewerKillNow === undefined && Date.now() - start < 5_000) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(reviewerKillNow).toBeTypeOf('function');
    const stopReply = await controlRequest(sock, { schemaVersion: 1, type: 'stop', now: true });
    expect(stopReply).toMatchObject({
      schemaVersion: 1,
      type: 'stop.reply',
      acknowledged: true,
      mode: 'force-now',
    });

    const result = await runPromise;
    expect(result.outcome).toBe('stopped');

    const progressMd = await fs.readFile(path.resolve(f.taskFolder, 'PROGRESS.md'), 'utf8');
    expect(progressMd).toMatch(/\| 1 \| pending \|/);
  });

  // Task 2.5 — .oa-current-prompt.md symlink is created in the worktree root
  // after assemblePrompt writes the attempt prompt, and points to the correct
  // attempt-NN/prompt.md path.
  it('creates .oa-current-prompt.md symlink in worktree pointing to attempt prompt', async () => {
    const f = await makeTaskFixture(REPO, REVIEWER_PROMPT, { stepCount: 1 });
    const sealed = await plan.create({ taskListIds: [f.taskId] });

    const worker = makeStubAdapter([
      {
        stdoutBody: `done\n${OK_STATUS_BLOCK}\n`,
        sideEffect: (cwd) => commitWork(cwd, 'symlink-test'),
      },
    ]);
    const reviewer = makeStubAdapter([{ stdoutBody: EMPTY_REVIEW_BLOCK }]);

    const r = await runPlan({
      planId: sealed.id,
      signal: new AbortController().signal,
      workerAdapterFactory: () => worker,
      reviewerAdapterFactory: () => reviewer,
    });

    expect(r.outcome).toBe('done');

    // The symlink must exist in the worktree root.
    const wtRoot = worktreeDir(f.taskId);
    const symlinkPath = path.resolve(wtRoot, '.oa-current-prompt.md');
    const stat = await fs.lstat(symlinkPath);
    expect(stat.isSymbolicLink()).toBe(true);

    // readlink must return an absolute path ending with the expected attempt dir.
    const linkTarget = await fs.readlink(symlinkPath);
    expect(path.isAbsolute(linkTarget)).toBe(true);
    expect(linkTarget).toMatch(/[/\\]1[/\\]prompt\.md$/);
  });

  // Task 2.5 — Symlink is updated across fix-loop attempts (attempt 1 → attempt 2).
  it('updates .oa-current-prompt.md symlink across fix-loop attempts', async () => {
    const f = await makeTaskFixture(REPO, REVIEWER_PROMPT, { stepCount: 1, maxLoops: 3 });
    const sealed = await plan.create({ taskListIds: [f.taskId] });

    const worker = makeStubAdapter([
      {
        stdoutBody: `attempt 1\n${OK_STATUS_BLOCK}\n`,
        sideEffect: (cwd) => commitWork(cwd, 'a1'),
      },
      {
        stdoutBody: `attempt 2 fixed\n${OK_STATUS_BLOCK}\n`,
        sideEffect: (cwd) => commitWork(cwd, 'a2'),
      },
    ]);
    const reviewer = makeStubAdapter([
      {
        stdoutBody: fence(
          'oa-review',
          JSON.stringify({
            issues: [{ priority: 'P0', file: 'x.ts', finding: 'bad', suggestion: 'fix it' }],
          }),
        ),
      },
      { stdoutBody: EMPTY_REVIEW_BLOCK },
    ]);

    const r = await runPlan({
      planId: sealed.id,
      signal: new AbortController().signal,
      workerAdapterFactory: () => worker,
      reviewerAdapterFactory: () => reviewer,
    });

    expect(r.outcome).toBe('done');

    // After a 2-attempt fix loop, the symlink must point at attempt-2.
    const wtRoot = worktreeDir(f.taskId);
    const symlinkPath = path.resolve(wtRoot, '.oa-current-prompt.md');
    const linkTarget = await fs.readlink(symlinkPath);
    expect(path.isAbsolute(linkTarget)).toBe(true);
    expect(linkTarget).toMatch(/[/\\]2[/\\]prompt\.md$/);
  });
});
