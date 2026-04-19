import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { simpleGit } from 'simple-git';
import {
  context,
  verifyGates,
  review,
  synthesizeFixContext,
} from '../src/index.js';
import type {
  AgentAdapter,
  AgentRunOpts,
  AgentRunResult,
  OaReviewIssue,
  Step,
} from '../src/index.js';

// -----------------------------------------------------------------------------
// Task 6.7 — Inner-loop integration test.
//
// Phase 6 shipped five separable pieces (parseTail, verifyGates,
// runReviewer, assemblePrompt, synthesizeFixContext). Phase 7 will glue them
// together inside the supervisor's per-step inner loop. This test stands up an
// inline `runInnerLoop` helper that wires the same pieces in the same order
// the supervisor will, then exercises the five canonical scenarios end-to-end
// against mock adapters in a temp git repo.
//
// The helper is INLINE on purpose: production wiring lands in Phase 7. By
// proving the seams compose cleanly here — same module surface, same path
// shapes, same return values — we catch shape mismatches NOW rather than
// surfacing them when the supervisor lands.
// -----------------------------------------------------------------------------

const bt = (n: number): string => '`'.repeat(n);
const fence = (kind: string, body: string): string => `${bt(3)}${kind}\n${body}\n${bt(3)}`;

const OK_STATUS_BLOCK = fence('oa-status', '{"status":"done","summary":"shipped"}');
const EMPTY_REVIEW_BLOCK = fence('oa-review', '{"issues":[]}');

interface MockScript {
  /** Body to write to stdoutPath. Defaults to empty string. */
  stdoutBody?: string;
  /** Adapter exit code; defaults to 0. */
  exitCode?: number | null;
  /** Adapter killer; defaults to null. */
  killedBy?: 'timeout' | 'stdoutCap' | 'signal' | null;
  /** Optional side effect run after writing stdout (e.g. make a commit). */
  sideEffect?: (cwd: string) => Promise<void>;
}

interface MockAdapter extends AgentAdapter {
  callCount: () => number;
}

/**
 * Build a stub AgentAdapter that drives the per-call behaviour off a script.
 * The Nth call consumes scripts[N]; if the array is shorter than the call
 * count, the LAST entry is reused (so a single-entry script means "always do
 * X"). Each call writes the script's stdoutBody to stdoutPath, runs the
 * optional sideEffect against the worktree, and returns an AgentRunResult
 * shaped from the script's exitCode / killedBy.
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

/** Convenience side-effect: synthesize a worker commit in the worktree. */
async function commitWork(cwd: string, label: string): Promise<void> {
  const g = simpleGit(cwd);
  const fname = `step-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`;
  await fs.writeFile(path.resolve(cwd, fname), 'work\n', 'utf8');
  await g.add('.');
  await g.commit(`worker step ${label}`);
}

interface InnerLoopResult {
  outcome: 'done' | 'tail-fail' | 'commit-fail' | 'cmd-fail' | 'blocked-needs-human';
  attemptsRun: number;
  finalReviewIssues: OaReviewIssue[];
}

interface InnerLoopOpts {
  workerAdapter: AgentAdapter;
  reviewerAdapter: AgentAdapter;
  worktree: string;
  stepStartSha: string;
  stepSpec: Step;
  verifyCommand: string;
  reviewerPromptPath: string;
  maxLoops: number;
  blockOn: ReadonlyArray<'P0' | 'P1' | 'P2'>;
  /** Directory under which per-attempt prompt + adapter logs are written. */
  stdoutBase: string;
}

/**
 * The Phase 6 inner loop, inlined for the integration test. Mirrors the order
 * the Phase 7 supervisor will use:
 *   1. assemblePrompt -> write to disk -> hand path to worker adapter
 *   2. verifyTail (parses captured stdout)
 *   3. verifyCommit (commits since stepStartSha)
 *   4. verifyCmd (the user-supplied shell string)
 *   5. runReviewer -> if blocking issues remain, synthesizeFixContext and loop
 *
 * Returns one of five outcomes. attemptsRun is the number of (worker)
 * iterations consumed; finalReviewIssues is the issue list from the LAST
 * reviewer invocation that completed (empty when we never reached the
 * reviewer or when the reviewer cleared the gate).
 */
async function runInnerLoop(opts: InnerLoopOpts): Promise<InnerLoopResult> {
  let prevIssues: OaReviewIssue[] | undefined;
  let attempt = 0;
  let lastReviewIssues: OaReviewIssue[] = [];
  while (attempt < opts.maxLoops) {
    attempt += 1;
    const promptPath = path.resolve(opts.stdoutBase, `prompt-${String(attempt)}.md`);
    const workerStdout = path.resolve(opts.stdoutBase, `worker-${String(attempt)}.log`);
    const workerStderr = path.resolve(opts.stdoutBase, `worker-${String(attempt)}.err`);
    const reviewerStdout = path.resolve(opts.stdoutBase, `reviewer-${String(attempt)}.log`);
    const reviewerStderr = path.resolve(opts.stdoutBase, `reviewer-${String(attempt)}.err`);

    const promptText = context.assemblePrompt({
      handoff: '# HANDOFF\n',
      progress: '',
      findings: '',
      stepSpec: opts.stepSpec,
      gitContext: { branch: 'main', headSha: opts.stepStartSha, isClean: true },
      references: [],
      openReviewIssues: prevIssues,
      isRetry: attempt > 1,
    });
    await fs.writeFile(promptPath, promptText, 'utf8');

    const workerResult = await opts.workerAdapter.run({
      cwd: opts.worktree,
      promptPath,
      model: 'opus',
      extraArgs: [],
      timeoutSec: 60,
      stdoutCapBytes: 1_000_000,
      stdoutPath: workerStdout,
      stderrPath: workerStderr,
      signal: new AbortController().signal,
    });
    if (workerResult.killedBy) {
      return { outcome: 'tail-fail', attemptsRun: attempt, finalReviewIssues: [] };
    }

    const stdoutContent = await fs.readFile(workerStdout, 'utf8');
    const tailGate = verifyGates.verifyTail(stdoutContent);
    if (!tailGate.ok) {
      return { outcome: 'tail-fail', attemptsRun: attempt, finalReviewIssues: [] };
    }

    const commitGate = await verifyGates.verifyCommit(opts.worktree, opts.stepStartSha);
    if (!commitGate.ok) {
      return { outcome: 'commit-fail', attemptsRun: attempt, finalReviewIssues: [] };
    }

    const cmdGate = await verifyGates.verifyCmd(opts.worktree, opts.verifyCommand);
    if (!cmdGate.ok) {
      return { outcome: 'cmd-fail', attemptsRun: attempt, finalReviewIssues: [] };
    }

    const git = simpleGit(opts.worktree);
    const stepDiff = await git.raw(['diff', `${opts.stepStartSha}..HEAD`]);

    const reviewResult = await review.runReviewer({
      adapter: opts.reviewerAdapter,
      model: 'opus',
      extraArgs: [],
      promptPath: opts.reviewerPromptPath,
      stepDiff,
      blockOn: opts.blockOn,
      cwd: opts.worktree,
      timeoutSec: 60,
      stdoutCapBytes: 1_000_000,
      stdoutPath: reviewerStdout,
      stderrPath: reviewerStderr,
      signal: new AbortController().signal,
    });
    lastReviewIssues = reviewResult.issues;
    if (reviewResult.blocking.length === 0) {
      return { outcome: 'done', attemptsRun: attempt, finalReviewIssues: reviewResult.issues };
    }
    // Hand the blocking issues to the synthesizer; the returned context flows
    // into the next iteration's assemblePrompt as openReviewIssues.
    prevIssues = synthesizeFixContext(reviewResult.blocking).openReviewIssues;
  }
  return { outcome: 'blocked-needs-human', attemptsRun: attempt, finalReviewIssues: lastReviewIssues };
}

describe('inner-loop integration (Task 6.7)', () => {
  let TMP: string;
  let REPO: string;
  let STDOUT_BASE: string;
  let REVIEWER_PROMPT: string;
  let STEP_START_SHA: string;

  const STEP_SPEC: Step = {
    n: 1,
    title: 'demo step',
    spec: 'do the work and commit',
    verify: null,
    expectedOutputs: [],
  };

  beforeEach(async () => {
    TMP = path.resolve(os.tmpdir(), 'oa-test-innerloop-' + Math.random().toString(36).slice(2));
    await fs.mkdir(TMP, { recursive: true });
    REPO = path.resolve(TMP, 'repo');
    await fs.mkdir(REPO);
    STDOUT_BASE = path.resolve(TMP, 'logs');
    await fs.mkdir(STDOUT_BASE);
    const git = simpleGit(REPO);
    await git.init({ '--initial-branch': 'main' });
    await git.addConfig('user.email', 'test@example.com');
    await git.addConfig('user.name', 'Test');
    await fs.writeFile(path.resolve(REPO, 'README.md'), '# init\n');
    await git.add('.');
    await git.commit('init');
    STEP_START_SHA = (await git.revparse(['HEAD'])).trim();
    REVIEWER_PROMPT = path.resolve(TMP, 'reviewer-prompt.md');
    await fs.writeFile(REVIEWER_PROMPT, 'Review the diff. Be terse.\n', 'utf8');
  });

  afterEach(async () => {
    await fs.rm(TMP, { recursive: true, force: true });
  });

  // (1) Happy path: one worker attempt, all gates green, reviewer clean.
  // The supervisor's most common control-flow path — a step that lands first
  // try with no fix-loop iteration. We pin attempts=1 + outcome=done so a
  // future change that accidentally re-enters the loop gets caught here.
  it('happy path: single worker attempt + clean reviewer => done in 1 attempt', async () => {
    const workerAdapter = makeStubAdapter([
      {
        stdoutBody: `did the work\n${OK_STATUS_BLOCK}\n`,
        sideEffect: (cwd) => commitWork(cwd, 'happy'),
      },
    ]);
    const reviewerAdapter = makeStubAdapter([{ stdoutBody: EMPTY_REVIEW_BLOCK }]);

    const r = await runInnerLoop({
      workerAdapter,
      reviewerAdapter,
      worktree: REPO,
      stepStartSha: STEP_START_SHA,
      stepSpec: STEP_SPEC,
      verifyCommand: 'true',
      reviewerPromptPath: REVIEWER_PROMPT,
      maxLoops: 3,
      blockOn: ['P0', 'P1'],
      stdoutBase: STDOUT_BASE,
    });

    expect(r.outcome).toBe('done');
    expect(r.attemptsRun).toBe(1);
    expect(r.finalReviewIssues).toEqual([]);
    // Worker was called once; reviewer was called once.
    expect((workerAdapter as MockAdapter).callCount()).toBe(1);
    expect((reviewerAdapter as MockAdapter).callCount()).toBe(1);
  });

  // (2) Tail-fail short-circuit. v0's inner loop does NOT auto-retry on a
  // tail gate failure (per gate-contract docs: tail.fail surfaces as a
  // distinct outcome). We assert that a worker emitting no oa-status block
  // produces outcome='tail-fail' on attempt 1, and that the reviewer was
  // NEVER consulted (the per-step pipeline must short-circuit before the
  // expensive reviewer invocation).
  it('tail-fail: worker omits oa-status => tail-fail outcome, reviewer not invoked', async () => {
    const workerAdapter = makeStubAdapter([
      {
        stdoutBody: 'did some work but never emitted a status block\n',
        sideEffect: (cwd) => commitWork(cwd, 'tailfail'),
      },
    ]);
    const reviewerAdapter = makeStubAdapter([{ stdoutBody: EMPTY_REVIEW_BLOCK }]);

    const r = await runInnerLoop({
      workerAdapter,
      reviewerAdapter,
      worktree: REPO,
      stepStartSha: STEP_START_SHA,
      stepSpec: STEP_SPEC,
      verifyCommand: 'true',
      reviewerPromptPath: REVIEWER_PROMPT,
      maxLoops: 3,
      blockOn: ['P0', 'P1'],
      stdoutBase: STDOUT_BASE,
    });

    expect(r.outcome).toBe('tail-fail');
    expect(r.attemptsRun).toBe(1);
    expect(r.finalReviewIssues).toEqual([]);
    expect((reviewerAdapter as MockAdapter).callCount()).toBe(0);
  });

  // (3) Fix-loop on P0. Attempt 1: all pre-merge gates pass, reviewer flags a
  // P0. Synthesizer hands the blocking list to attempt 2; the next prompt
  // surfaces it under "Open review issues" (we don't assert that here — the
  // assemblePrompt unit tests own that — we DO assert the loop iterated and
  // resolved). Attempt 2: gates pass, reviewer is clean. Outcome=done in 2.
  it('fix-loop: P0 in attempt 1 then clean in attempt 2 => done in 2 attempts', async () => {
    const workerAdapter = makeStubAdapter([
      {
        stdoutBody: `attempt 1 work\n${OK_STATUS_BLOCK}\n`,
        sideEffect: (cwd) => commitWork(cwd, 'fix-1'),
      },
      {
        stdoutBody: `attempt 2 work, fixed\n${OK_STATUS_BLOCK}\n`,
        sideEffect: (cwd) => commitWork(cwd, 'fix-2'),
      },
    ]);
    const reviewerAdapter = makeStubAdapter([
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

    const r = await runInnerLoop({
      workerAdapter,
      reviewerAdapter,
      worktree: REPO,
      stepStartSha: STEP_START_SHA,
      stepSpec: STEP_SPEC,
      verifyCommand: 'true',
      reviewerPromptPath: REVIEWER_PROMPT,
      maxLoops: 3,
      blockOn: ['P0', 'P1'],
      stdoutBase: STDOUT_BASE,
    });

    expect(r.outcome).toBe('done');
    expect(r.attemptsRun).toBe(2);
    expect(r.finalReviewIssues).toEqual([]);
    expect((workerAdapter as MockAdapter).callCount()).toBe(2);
    expect((reviewerAdapter as MockAdapter).callCount()).toBe(2);
    // The attempt-2 prompt on disk must carry the open review issues section
    // produced by the synthesizer — this is the integration seam the helper
    // exists to verify.
    const prompt2 = await fs.readFile(path.resolve(STDOUT_BASE, 'prompt-2.md'), 'utf8');
    expect(prompt2).toContain('Open review issues');
    expect(prompt2).toContain('[P0]');
    expect(prompt2).toContain('x.ts');
  });

  // (4) Max-loops exhaustion. Reviewer flags 1 P0 every iteration; with
  // maxLoops=3 the loop runs 3 worker attempts then surrenders. Outcome is
  // blocked-needs-human and the LAST reviewer's issue list is preserved on
  // the result so the supervisor can render it into the human-needed event.
  it('max-loops exhaustion: P0 every iteration with maxLoops=3 => blocked-needs-human', async () => {
    const workerAdapter = makeStubAdapter([
      {
        stdoutBody: `work\n${OK_STATUS_BLOCK}\n`,
        sideEffect: (cwd) => commitWork(cwd, 'exhaust'),
      },
    ]);
    const reviewerAdapter = makeStubAdapter([
      {
        stdoutBody: fence(
          'oa-review',
          JSON.stringify({
            issues: [{ priority: 'P0', file: 'y.ts', finding: 'still bad' }],
          }),
        ),
      },
    ]);

    const r = await runInnerLoop({
      workerAdapter,
      reviewerAdapter,
      worktree: REPO,
      stepStartSha: STEP_START_SHA,
      stepSpec: STEP_SPEC,
      verifyCommand: 'true',
      reviewerPromptPath: REVIEWER_PROMPT,
      maxLoops: 3,
      blockOn: ['P0', 'P1'],
      stdoutBase: STDOUT_BASE,
    });

    expect(r.outcome).toBe('blocked-needs-human');
    expect(r.attemptsRun).toBe(3);
    expect(r.finalReviewIssues).toHaveLength(1);
    expect(r.finalReviewIssues[0].priority).toBe('P0');
    expect((workerAdapter as MockAdapter).callCount()).toBe(3);
    expect((reviewerAdapter as MockAdapter).callCount()).toBe(3);
  });

  // (5) Non-blocking issues only: reviewer surfaces P2 advice but blockOn is
  // ['P0','P1']. Outcome=done in 1 attempt; the full issue list is preserved
  // on the result so the supervisor's run-log renderer can surface them as
  // advisories without forcing a fix-loop iteration.
  it('non-blocking only: P2 issues with blockOn=[P0,P1] => done in 1 attempt with issues preserved', async () => {
    const workerAdapter = makeStubAdapter([
      {
        stdoutBody: `work\n${OK_STATUS_BLOCK}\n`,
        sideEffect: (cwd) => commitWork(cwd, 'nonblocking'),
      },
    ]);
    const reviewerAdapter = makeStubAdapter([
      {
        stdoutBody: fence(
          'oa-review',
          JSON.stringify({
            issues: [
              { priority: 'P2', file: 'a.ts', finding: 'nit one' },
              { priority: 'P2', file: 'b.ts', finding: 'nit two' },
            ],
          }),
        ),
      },
    ]);

    const r = await runInnerLoop({
      workerAdapter,
      reviewerAdapter,
      worktree: REPO,
      stepStartSha: STEP_START_SHA,
      stepSpec: STEP_SPEC,
      verifyCommand: 'true',
      reviewerPromptPath: REVIEWER_PROMPT,
      maxLoops: 3,
      blockOn: ['P0', 'P1'],
      stdoutBase: STDOUT_BASE,
    });

    expect(r.outcome).toBe('done');
    expect(r.attemptsRun).toBe(1);
    expect(r.finalReviewIssues).toHaveLength(2);
    expect(r.finalReviewIssues.every((i) => i.priority === 'P2')).toBe(true);
  });
});
