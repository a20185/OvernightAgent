import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { once } from 'node:events';
import type { Server } from 'node:net';
import { simpleGit } from 'simple-git';
import { writeFileAtomic } from '../atomicJson.js';
import { runDir, socketPath, taskDir, worktreeDir } from '../paths.js';
import { readJson } from '../atomicJson.js';
import {
  IntakeSchema,
  StepsSchema,
  type Intake,
  type Steps,
  type Step,
  type OaReviewIssue,
  type StepStatusT,
  type TaskStatusT,
} from '../schemas.js';
import * as inbox from '../stores/inbox.js';
import * as plan from '../stores/plan.js';
import * as worktree from '../worktree.js';
import * as progress from '../state/progress.js';
import * as findings from '../state/findings.js';
import * as context from '../verify/context.js';
import * as verifyGates from '../verify/gates.js';
import * as review from '../verify/review.js';
import { synthesizeFixContext } from '../verify/fixLoop.js';
import { parseTail } from '../verify/tail.js';
import { runBootstrap } from './bootstrap.js';
import { openEventWriter, type EventWriter } from '../events/writer.js';
import { readAll } from '../events/reader.js';
import { getAdapter } from '../adapter/registry.js';
import { serve } from './controlSocket.js';
import type { AgentAdapter, AgentRunControl } from '../adapter/types.js';
import { renderSandboxProfile } from '../sandbox/render.js';

/**
 * Task 7.3 — Supervisor outer loop (sequential v0).
 *
 * `runPlan` is the production glue between every Phase 1–7 piece. Given a sealed
 * planId it:
 *
 *   1. loads the plan + every per-task intake/steps,
 *   2. opens `<runDir>/events.jsonl` (Task 7.1),
 *   3. for each task, in order: creates a worktree (Task 2.2), runs bootstrap
 *      (Task 7.2), then for each step iterates the inner-loop (the Phase 6
 *      reference shape: assemblePrompt → adapter.run → verifyTail → verifyCommit
 *      → verifyCmd → reviewer → maybe-fix-loop) until the step lands or the
 *      attempt budget runs out,
 *   4. mutates PROGRESS / FINDINGS via the Task 6.5 helpers,
 *   5. emits the design §3.6 event taxonomy at every transition,
 *   6. propagates outcomes upward: per-attempt → per-step → per-task → per-plan.
 *
 * Carry-forwards from prior reviews + the plan brief:
 *
 *   - **Per-attempt rewindToHead** (ADR-0003). Attempts > 1 wipe the worktree
 *     to `stepStartSha` BEFORE the next assemblePrompt → run, so the agent
 *     starts from a clean slate. We pre-stamp the prompt's "this is a retry"
 *     status note via the `isRetry` flag in `assemblePrompt`.
 *   - **Tail-fail short-circuits before reviewer**. The reviewer is the
 *     single most expensive call in the loop — if the worker didn't even emit
 *     a tail block, we don't pay for review feedback that won't help.
 *   - **stepStartSha captured ONCE per step**. The fix-loop's "what changed
 *     this step" diff is anchored at the step's first attempt, not each
 *     attempt's HEAD — otherwise rewind would reset the diff base and the
 *     reviewer would always see an empty diff after rewind.
 *   - **One AbortSignal per step**. Each adapter.run gets a fresh AbortController
 *     wired to the supervisor's signal so the supervisor's abort cleanly tears
 *     down whatever's currently spawning, and a step-local timeout (future
 *     work) won't kill the next step's spawn.
 *   - **Per-attempt issue history** is captured implicitly via per-attempt
 *     `step.attempt.start` / `step.verify.review.fail` events; the events.jsonl
 *     is the source of truth for the post-mortem renderer.
 *   - **Bootstrap distinguishes 3 outcomes** via `runBootstrap`'s typed result
 *     (success / timeout / non-zero exit). On any non-success the task is
 *     marked `bootstrap-failed` and per-task onFailure decides whether to halt
 *     the plan or continue.
 *   - **Adapter resolution defaults to the registry, with test injection
 *     preserved.** Production falls back to `getAdapter(...)`; tests can still
 *     inject `workerAdapterFactory(agentId)` / `reviewerAdapterFactory(agentId)`
 *     to stay hermetic.
 *
 * No background processes, no parallelism — sequential v0. Parallel mode lands
 * in Phase 8+ once the sequential outer loop has shipped and the per-task
 * isolation invariants are pinned by tests.
 */

export interface RunPlanOpts {
  planId: string;
  signal: AbortSignal;
  /** Tests can override adapter resolution; production falls back to getAdapter(agentId). */
  workerAdapterFactory?: (agentId: string) => AgentAdapter | Promise<AgentAdapter>;
  reviewerAdapterFactory?: (agentId: string) => AgentAdapter | Promise<AgentAdapter>;
  /** Override of `<runDir(planId)>/events.jsonl`. Tests use this rarely; prod never. */
  eventsPath?: string;
  /** CLI `--sandbox` override: when true, force `intake.sandbox.enabled = true` for every task (in-memory only). */
  sandboxOverride?: boolean;
}

export type PlanOutcome = 'done' | 'partial' | 'stopped' | 'budget-exhausted';
export type TaskOutcome =
  | 'done'
  | 'failed'
  | 'blocked-needs-human'
  | 'stopped'
  | 'bootstrap-failed'
  | 'budget-exhausted';

export interface RunPlanResult {
  planId: string;
  outcome: PlanOutcome;
  taskOutcomes: Array<{ taskId: string; outcome: TaskOutcome; stepsRun: number }>;
  durationMs: number;
}

// `step.end` carries the step's final status. We map per-attempt outcomes onto
// the StepStatusT enum so callers (PROGRESS.md, events.jsonl, the per-task
// aggregator below) all read the same vocabulary.
type StepOutcome = 'done' | 'failed' | 'blocked' | 'pending';

type StopMode = 'none' | 'graceful' | 'force-now';

interface SupervisorLiveState {
  planId: string;
  currentTaskId: string | null;
  currentStepN: number | null;
  currentAttempt: number | null;
  elapsedRunMs: number;
  elapsedTaskMs: number | null;
  elapsedStepMs: number | null;
  budgetRemainingMs: number | null;
}

interface RunPlanRuntime {
  stopMode: StopMode;
  activeSpawn: AgentRunControl | null;
  currentTaskId: string | null;
  currentTaskStartedAt: number | null;
  currentStepN: number | null;
  currentStepStartedAt: number | null;
  currentAttempt: number | null;
  budgetDeadlineMs: number | null;
}

interface StepRunResult {
  outcome: StepOutcome;
  attemptsRun: number;
  /** Issues from the LAST reviewer pass, surfaced into events for post-mortem. */
  finalReviewIssues: OaReviewIssue[];
}

function snapshotLiveState(
  planId: string,
  startedAt: number,
  runtime: RunPlanRuntime,
): SupervisorLiveState {
  const now = Date.now();
  return {
    planId,
    currentTaskId: runtime.currentTaskId,
    currentStepN: runtime.currentStepN,
    currentAttempt: runtime.currentAttempt,
    elapsedRunMs: now - startedAt,
    elapsedTaskMs: runtime.currentTaskStartedAt === null ? null : now - runtime.currentTaskStartedAt,
    elapsedStepMs: runtime.currentStepStartedAt === null ? null : now - runtime.currentStepStartedAt,
    budgetRemainingMs:
      runtime.budgetDeadlineMs === null ? null : Math.max(0, runtime.budgetDeadlineMs - now),
  };
}

async function openControlSocket(
  planId: string,
  startedAt: number,
  runtime: RunPlanRuntime,
  gracefulStop: () => void,
  forceStopNow: () => void,
): Promise<Server> {
  const server = serve(socketPath(planId), {
    stop: async (message) => {
      if (message.now) forceStopNow();
      else gracefulStop();
      return {
        schemaVersion: 1,
        type: 'stop.reply',
        acknowledged: true,
        mode: message.now ? 'force-now' : 'graceful',
      };
    },
    status: async () => ({
      schemaVersion: 1,
      type: 'status.reply',
      state: snapshotLiveState(planId, startedAt, runtime),
    }),
  });

  if (!server.listening) {
    await Promise.race([
      once(server, 'listening'),
      once(server, 'error').then(([err]) => {
        throw err;
      }),
    ]);
  }

  return server;
}

/** Read + Zod-validate a per-task intake.json. Throws on missing/corrupt. */
async function loadIntake(taskFolder: string): Promise<Intake> {
  const p = path.resolve(taskFolder, 'intake.json');
  const raw = await readJson<unknown>(p);
  if (raw === null) throw new Error(`intake.json not found: ${p}`);
  try {
    return IntakeSchema.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`intake.json at ${p} is corrupted: ${msg}`, { cause: err });
  }
}

/** Read + Zod-validate a per-task steps.json. */
async function loadSteps(taskFolder: string): Promise<Steps> {
  const p = path.resolve(taskFolder, 'steps.json');
  const raw = await readJson<unknown>(p);
  if (raw === null) throw new Error(`steps.json not found: ${p}`);
  try {
    return StepsSchema.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`steps.json at ${p} is corrupted: ${msg}`, { cause: err });
  }
}

/** Per-attempt log/prompt directory: `<runDir>/steps/<taskId>/<n>/<attempt>`. */
function attemptDir(runDirAbs: string, taskId: string, n: number, attempt: number): string {
  return path.resolve(runDirAbs, 'steps', taskId, String(n), String(attempt));
}

/** Read HEAD sha of a worktree. */
async function headSha(absRoot: string): Promise<string> {
  const g = simpleGit(absRoot);
  return (await g.revparse(['HEAD'])).trim();
}

/**
 * Run a single step's inner loop. Mirrors the shape of Task 6.7's reference
 * helper, but emits Phase 7 events at every transition and uses the production
 * I/O surfaces (per-attempt prompt files on disk under `<runDir>/steps/...`,
 * one AbortController per adapter.run, per-attempt rewindToHead).
 */
async function runStep(
  taskId: string,
  step: Step,
  intake: Intake,
  workerAdapter: AgentAdapter,
  reviewerAdapter: AgentAdapter,
  worktreeInfo: { absRoot: string; branch: string },
  reviewerPromptPath: string,
  runDirAbs: string,
  taskFolder: string,
  events: EventWriter,
  parentSignal: AbortSignal,
  runtime: RunPlanRuntime,
  stallEmitted: Set<string>,
): Promise<StepRunResult> {
  // stepStartSha is captured ONCE at step start. Per-attempt rewind restores
  // the worktree TO this sha; the reviewer's diff is `stepStartSha..HEAD`,
  // which after a successful attempt N is the N-th attempt's commit set.
  const stepStartSha = await headSha(worktreeInfo.absRoot);

  await events.emit({ kind: 'step.start', taskId, stepN: step.n });
  runtime.currentStepN = step.n;
  runtime.currentStepStartedAt = Date.now();
  runtime.currentAttempt = null;

  const maxLoops = intake.strategy.reviewFixLoop.maxLoops > 0 ? intake.strategy.reviewFixLoop.maxLoops : 1;
  const blockOn = intake.strategy.reviewFixLoop.blockOn;

  // ADR-0015: resolved soft/hard stall thresholds, derived from maxLoops
  // (mirrors the 0.6× heuristic from synthesizeFixContext).
  const soft = Math.max(1, Math.ceil(maxLoops * 0.6));
  const hard = maxLoops;

  let prevIssues: OaReviewIssue[] | undefined;
  let lastReviewIssues: OaReviewIssue[] = [];
  let attempt = 0;
  let stepOutcome: StepOutcome = 'failed';

  while (attempt < maxLoops) {
    attempt += 1;

    // Fail-fast on parent abort (e.g. daemon `oa stop`). Without this check we
    // would otherwise pay for a fresh prompt-write + progress.mark + adapter
    // spawn for an attempt that's about to be torn down anyway. The outer-loop
    // already emits run.stop with reason='user' downstream.
    if (parentSignal.aborted) {
      break;
    }

    // ADR-0003: rewind worktree to HEAD (== stepStartSha after a previous
    // attempt's commits got rewound) BEFORE attempts > 1. The first attempt
    // has nothing to rewind. We rewind to `stepStartSha` explicitly via
    // `git reset --hard <sha>` rather than `HEAD` because a prior attempt
    // already moved HEAD forward; rewindToHead resets to current HEAD which
    // is the WRONG sha for a fix-loop iteration. Use git directly here.
    if (attempt > 1) {
      const g = simpleGit(worktreeInfo.absRoot);
      try {
        await g.raw(['reset', '--hard', stepStartSha]);
        await g.raw(['clean', '-fdx']);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`rewind failed at ${worktreeInfo.absRoot}: ${msg}`, { cause: err });
      }
    }

    await progress.mark(taskFolder, step.n, 'running', `attempt ${String(attempt)}`);

    // ADR-0015 (Task 3.4): emit step.stall at most once per step when the
    // attempt count crosses the soft threshold. The key is `taskId:stepN`
    // so the guard persists across the per-step attempt loop and — because
    // stallEmitted lives per-plan-run — across multiple steps of the same
    // task as well.
    const stallKey = `${taskId}:${String(step.n)}`;
    if (attempt >= soft && !stallEmitted.has(stallKey)) {
      await events.emit({ kind: 'step.stall', taskId, stepN: step.n, attempt, soft, hard });
      stallEmitted.add(stallKey);
    }

    const dir = attemptDir(runDirAbs, taskId, step.n, attempt);
    await fs.mkdir(dir, { recursive: true });
    const promptPath = path.resolve(dir, 'prompt.md');
    const stdoutPath = path.resolve(dir, 'stdout.log');
    const stderrPath = path.resolve(dir, 'stderr.log');
    const reviewerStdoutPath = path.resolve(dir, 'reviewer.stdout.log');
    const reviewerStderrPath = path.resolve(dir, 'reviewer.stderr.log');

    // Read the latest progress + findings so the prompt is current. Both
    // helpers tolerate missing files (return ''/empty doc) so a brand-new
    // task folder doesn't need to seed them.
    const handoffText = await fs
      .readFile(path.resolve(taskFolder, 'HANDOFF.md'), 'utf8')
      .catch(() => '');
    const progressMd = await fs
      .readFile(path.resolve(taskFolder, 'PROGRESS.md'), 'utf8')
      .catch(() => '');
    const findingsMd = await findings.read(taskFolder);

    const promptText = context.assemblePrompt({
      handoff: handoffText,
      progress: progressMd,
      findings: findingsMd,
      stepSpec: step,
      gitContext: {
        branch: worktreeInfo.branch,
        headSha: await headSha(worktreeInfo.absRoot),
        isClean: true,
      },
      references: intake.references,
      openReviewIssues: prevIssues,
      isRetry: attempt > 1,
    });
    await writeFileAtomic(promptPath, promptText);

    // Task 2.5 (ADR-0015): maintain .oa-current-prompt.md symlink in the
    // worktree root. The compact-recovery hook reads this to recover context
    // after Claude Code auto-compaction. Absolute paths throughout.
    const symlinkPath = path.resolve(worktreeInfo.absRoot, '.oa-current-prompt.md');
    await fs.rm(symlinkPath, { force: true });
    await fs.symlink(promptPath, symlinkPath);

    await events.emit({
      kind: 'step.prompt.written',
      taskId,
      stepN: step.n,
      attempt,
      promptPath,
    });

    await events.emit({ kind: 'step.attempt.start', taskId, stepN: step.n, attempt });
    runtime.currentAttempt = attempt;

    // Per-step abort controller chained off the parent signal. This lets a
    // future per-step timeout fire its own abort without nuking later steps,
    // and keeps the parent's user-driven abort propagating cleanly.
    const stepAc = new AbortController();
    const onParentAbort = (): void => stepAc.abort();
    const clearParentAbort = (): void => {
      parentSignal.removeEventListener('abort', onParentAbort);
    };
    parentSignal.addEventListener('abort', onParentAbort, { once: true });
    if (parentSignal.aborted) stepAc.abort();

    // Abort check before worker spawn: a control-socket stop can land after
    // prompt/materialization but before the adapter gets called. Do not invoke
    // a fresh adapter run with an already-aborted signal.
    if (parentSignal.aborted) {
      await events.emit({ kind: 'step.attempt.end', taskId, stepN: step.n, attempt, status: 'pending' });
      stepOutcome = 'pending';
      clearParentAbort();
      break;
    }

    // ADR-0016: materialize per-attempt sandbox profile on macOS when
    // intake.sandbox.enabled is true. The profile is written atomically to
    // <attemptDir>/sandbox.sb and its absolute path is passed through to
    // the adapter via opts.sandboxProfile.
    let sandboxProfilePath: string | undefined;
    if (intake.sandbox?.enabled && process.platform === 'darwin') {
      const sbPath = path.resolve(dir, 'sandbox.sb');
      const profile = renderSandboxProfile({
        worktreeAbs: worktreeInfo.absRoot,
        homeAbs: await fs.realpath(path.resolve(os.homedir())),
        extraAllowPaths: intake.sandbox.extraAllowPaths ?? [],
      });
      await writeFileAtomic(sbPath, profile);
      sandboxProfilePath = sbPath;
    }

    let workerResult;
    const workerStart = Date.now();
    try {
      workerResult = await workerAdapter.run({
        cwd: worktreeInfo.absRoot,
        promptPath,
        model: intake.executor.model,
        extraArgs: intake.executor.extraArgs,
        env: {
          ...process.env as Record<string, string>,
          OA_TASK_DIR: taskFolder,
          OA_CURRENT_PROMPT: promptPath,
        },
        timeoutSec: intake.strategy.stepTimeoutSec,
        stdoutCapBytes: intake.strategy.stepStdoutCapBytes,
        stdoutPath,
        stderrPath,
        signal: stepAc.signal,
        onSpawned: (control) => {
          runtime.activeSpawn = control;
        },
        ...(sandboxProfilePath !== undefined ? { sandboxProfile: sandboxProfilePath } : {}),
      });
    } finally {
      runtime.activeSpawn = null;
    }
    await events.emit({
      kind: 'step.agent.exit',
      taskId,
      stepN: step.n,
      attempt,
      exitCode: workerResult.exitCode,
      durationMs: workerResult.durationMs > 0 ? workerResult.durationMs : Date.now() - workerStart,
      ...(workerResult.sessionId !== undefined ? { sessionId: workerResult.sessionId } : {}),
      ...(workerResult.killedBy !== null ? { killedBy: workerResult.killedBy } : {}),
    });

    // If the adapter was killed (timeout / cap / parent signal), treat as a
    // tail failure for v0 — the agent didn't get to emit a tail block. The
    // supervisor's reaction is the same: short-circuit, mark step failed,
    // exit attempt loop. Distinct events surface the killer for post-mortem.
    if (workerResult.killedBy) {
      if (workerResult.killedBy === 'signal' && parentSignal.aborted) {
        await events.emit({ kind: 'step.attempt.end', taskId, stepN: step.n, attempt, status: 'pending' });
        stepOutcome = 'pending';
        clearParentAbort();
        break;
      }
      // Emit the dedicated kill-cause event AS WELL as the unified tail-fail
      // below. Reviewers/post-mortems that care about *why* the worker was
      // killed (timeout vs stdout-cap) read these; verify-pipeline-aware
      // consumers still get the gate result via the tail-fail emission.
      if (workerResult.killedBy === 'timeout') {
        await events.emit({
          kind: 'step.timeout',
          taskId,
          stepN: step.n,
          attempt,
          durationMs:
            workerResult.durationMs > 0 ? workerResult.durationMs : Date.now() - workerStart,
        });
      } else if (workerResult.killedBy === 'stdoutCap') {
        await events.emit({
          kind: 'step.stdoutCapHit',
          taskId,
          stepN: step.n,
          attempt,
          bytes: intake.strategy.stepStdoutCapBytes,
        });
      }
      await events.emit({
        kind: 'step.verify.tail.fail',
        taskId,
        stepN: step.n,
        attempt,
        reason: `worker killed: ${workerResult.killedBy}`,
      });
      await events.emit({ kind: 'step.attempt.end', taskId, stepN: step.n, attempt, status: 'failed' });
      // markBlocked / skip onFailure → step ends 'blocked' so the task is
      // marked needs-human downstream; halt → 'failed' so the plan halts.
      stepOutcome =
        intake.strategy.onFailure === 'halt' ? 'failed' : 'blocked';
      clearParentAbort();
      break;
    }

    // ---- Pre-merge gate 1: tail-message ------------------------------------
    // Tail-fail short-circuits BEFORE reviewer: if the worker didn't honor
    // the protocol there's no point paying for an expensive reviewer call.
    // Per design + Task 6.7 carry-forward, this is intentional.
    const stdoutContent = await fs.readFile(stdoutPath, 'utf8');
    const tailGate = verifyGates.verifyTail(stdoutContent);
    if (!tailGate.ok) {
      await events.emit({
        kind: 'step.verify.tail.fail',
        taskId,
        stepN: step.n,
        attempt,
        reason: tailGate.reason,
      });
      await events.emit({ kind: 'step.attempt.end', taskId, stepN: step.n, attempt, status: 'failed' });
      stepOutcome = intake.strategy.onFailure === 'halt' ? 'failed' : 'blocked';
      clearParentAbort();
      break;
    }
    await events.emit({ kind: 'step.verify.tail.ok', taskId, stepN: step.n, attempt });

    // ---- Pre-merge gate 2: commit-since-step-start -------------------------
    const commitGate = await verifyGates.verifyCommit(worktreeInfo.absRoot, stepStartSha);
    if (!commitGate.ok) {
      await events.emit({
        kind: 'step.verify.commit.fail',
        taskId,
        stepN: step.n,
        attempt,
        reason: commitGate.reason,
      });
      await events.emit({ kind: 'step.attempt.end', taskId, stepN: step.n, attempt, status: 'failed' });
      stepOutcome = intake.strategy.onFailure === 'halt' ? 'failed' : 'blocked';
      clearParentAbort();
      break;
    }
    await events.emit({ kind: 'step.verify.commit.ok', taskId, stepN: step.n, attempt });

    // ---- Pre-merge gate 3: user verify command -----------------------------
    // Abort check before verifyCmd: this gate spawns the user's verify script
    // which can run for minutes (e.g. `pnpm test`). A pending parent abort
    // would otherwise be observed only after the script finishes. Emit the
    // attempt's terminal events so the events.jsonl stream stays consistent.
    if (parentSignal.aborted) {
      await events.emit({ kind: 'step.attempt.end', taskId, stepN: step.n, attempt, status: 'pending' });
      stepOutcome = 'pending';
      clearParentAbort();
      break;
    }
    const verifyCmdString = step.verify ?? intake.verify.command;
    const cmdGate = await verifyGates.verifyCmd(worktreeInfo.absRoot, verifyCmdString);
    if (!cmdGate.ok) {
      const detail = cmdGate.detail as { exitCode?: number | null } | undefined;
      await events.emit({
        kind: 'step.verify.cmd.fail',
        taskId,
        stepN: step.n,
        attempt,
        exitCode: typeof detail?.exitCode === 'number' ? detail.exitCode : -1,
      });
      await events.emit({ kind: 'step.attempt.end', taskId, stepN: step.n, attempt, status: 'failed' });
      stepOutcome = intake.strategy.onFailure === 'halt' ? 'failed' : 'blocked';
      clearParentAbort();
      break;
    }
    await events.emit({ kind: 'step.verify.cmd.ok', taskId, stepN: step.n, attempt });

    // ---- Pre-merge gate 4: reviewer ----------------------------------------
    // Abort check before reviewer: the reviewer is the single most expensive
    // call in the inner loop (LLM round-trip, often 30s+). Skip it if the
    // parent already aborted. The stepAc.signal would tear down a spawned
    // adapter mid-flight, but we'd still pay for the prompt assembly and any
    // initial setup here — fail fast instead.
    if (parentSignal.aborted) {
      await events.emit({ kind: 'step.attempt.end', taskId, stepN: step.n, attempt, status: 'pending' });
      stepOutcome = 'pending';
      clearParentAbort();
      break;
    }
    const g = simpleGit(worktreeInfo.absRoot);
    const stepDiff = await g.raw(['diff', `${stepStartSha}..HEAD`]);

    let reviewResult: Awaited<ReturnType<typeof review.runReviewer>>;
    try {
      reviewResult = await review.runReviewer({
        adapter: reviewerAdapter,
        model: intake.reviewer.model,
        extraArgs: intake.reviewer.extraArgs,
        promptPath: reviewerPromptPath,
        stepDiff,
        blockOn,
        cwd: worktreeInfo.absRoot,
        timeoutSec: intake.strategy.stepTimeoutSec,
        stdoutCapBytes: intake.strategy.stepStdoutCapBytes,
        stdoutPath: reviewerStdoutPath,
        stderrPath: reviewerStderrPath,
        signal: stepAc.signal,
        onSpawned: (control) => {
          runtime.activeSpawn = control;
        },
      });
    } finally {
      runtime.activeSpawn = null;
    }
    if (
      typeof reviewResult.detail === 'object' &&
      reviewResult.detail !== null &&
      'killedBy' in reviewResult.detail &&
      (reviewResult.detail as { killedBy?: unknown }).killedBy === 'signal'
    ) {
      await events.emit({ kind: 'step.attempt.end', taskId, stepN: step.n, attempt, status: 'pending' });
      stepOutcome = 'pending';
      clearParentAbort();
      break;
    }
    lastReviewIssues = reviewResult.issues;

    if (reviewResult.ok) {
      await events.emit({ kind: 'step.verify.review.ok', taskId, stepN: step.n, attempt });
      await events.emit({ kind: 'step.attempt.end', taskId, stepN: step.n, attempt, status: 'done' });
      // Append a finding from the parsed oa-status block (summary). The tail
      // gate already validated structurally; reparse to extract `summary`.
      const status = parseTail(stdoutContent, 'oa-status');
      if (status.ok) await findings.append(taskFolder, status.value.summary);
      stepOutcome = 'done';
      clearParentAbort();
      break;
    }

    // Reviewer flagged something. Two sub-cases:
    //   (a) blocking issues + attempts remaining → synthesize fix context,
    //       loop back for another attempt.
    //   (b) blocking issues + last attempt exhausted → block the step.
    // Reviewer non-blocking issues never appear here (review.runReviewer
    // returns ok:true in that case).
    await events.emit({
      kind: 'step.verify.review.fail',
      taskId,
      stepN: step.n,
      attempt,
      blocking: reviewResult.blocking as unknown[],
    });

    if (attempt < maxLoops) {
      const fixCtx = synthesizeFixContext({
        attempt,
        thresholds: { soft: Math.max(1, Math.ceil(maxLoops * 0.6)), hard: maxLoops },
        issues: reviewResult.blocking,
      });
      prevIssues = fixCtx.openReviewIssues;
      // Only emit step.fix.synthesized on the path that actually USES the
      // synthesized fix context — i.e. there's at least one more attempt.
      // Emitting it on the exhausted-final-attempt branch below would imply a
      // fix is queued for the next attempt that will never happen.
      await events.emit({ kind: 'step.fix.synthesized', taskId, stepN: step.n, attempt });
      await events.emit({ kind: 'step.attempt.end', taskId, stepN: step.n, attempt, status: 'failed' });
      clearParentAbort();
      // Loop continues.
    } else {
      // Final attempt exhausted with blocking issues remaining. No fix is
      // synthesized: the loop ends here.
      await events.emit({ kind: 'step.attempt.end', taskId, stepN: step.n, attempt, status: 'blocked' });
      stepOutcome = 'blocked';
      clearParentAbort();
      break;
    }
  }

  // Mark the step's terminal status in PROGRESS.
  const stepStatusForProgress: StepStatusT =
    stepOutcome === 'done'
      ? 'done'
      : stepOutcome === 'failed'
        ? 'failed'
        : stepOutcome === 'pending'
          ? 'pending'
          : 'blocked';
  await progress.mark(taskFolder, step.n, stepStatusForProgress);
  await events.emit({ kind: 'step.end', taskId, stepN: step.n, status: stepStatusForProgress });
  runtime.currentStepN = null;
  runtime.currentStepStartedAt = null;
  runtime.currentAttempt = null;

  return {
    outcome: stepOutcome,
    attemptsRun: attempt,
    finalReviewIssues: lastReviewIssues,
  };
}

export async function runPlan(opts: RunPlanOpts): Promise<RunPlanResult> {
  const startedAt = Date.now();
  const supervisorAc = new AbortController();
  const onExternalAbort = (): void => {
    supervisorAc.abort();
  };
  if (opts.signal.aborted) supervisorAc.abort();
  else opts.signal.addEventListener('abort', onExternalAbort, { once: true });
  const runtime: RunPlanRuntime = {
    stopMode: 'none',
    activeSpawn: null,
    currentTaskId: null,
    currentTaskStartedAt: null,
    currentStepN: null,
    currentStepStartedAt: null,
    currentAttempt: null,
    budgetDeadlineMs: null,
  };
  const gracefulStop = (): void => {
    if (runtime.stopMode === 'force-now') return;
    runtime.stopMode = 'graceful';
    supervisorAc.abort();
  };
  const forceStopNow = (): void => {
    runtime.stopMode = 'force-now';
    runtime.activeSpawn?.killNow();
    supervisorAc.abort();
  };

  // (1) Load + validate the plan. Reject if absent or in a status that means
  //     it shouldn't be re-run via this path. 'sealed' is the canonical
  //     "ready to run" state; 'running' is permitted so a future resume can
  //     re-enter without forcing a status flip.
  const sealed = await plan.get(opts.planId);
  if (sealed === null) throw new Error(`plan not found: ${opts.planId}`);
  if (sealed.status !== 'sealed' && sealed.status !== 'running') {
    throw new Error(`plan ${opts.planId} is not runnable (status=${sealed.status})`);
  }

  // (1b) Fail-fast: if any task requests sandbox and we're not on macOS, throw
  //      before any events are written, any worktrees are created, or the plan
  //      status is flipped to 'running'. This keeps the run fully pristine so
  //      the operator can fix the config and re-run without cleanup.
  if (process.platform !== 'darwin') {
    // When sandboxOverride is set, every task will be sandboxed regardless of
    // per-task config, so fail-fast immediately.
    if (opts.sandboxOverride === true) {
      throw new Error(`sandbox requested but unsupported on ${process.platform}`);
    }
    for (const tid of sealed.taskListIds) {
      const intake = await loadIntake(taskDir(tid));
      if (intake.sandbox?.enabled) {
        throw new Error(`sandbox requested but unsupported on ${process.platform}`);
      }
    }
  }

  // (2) Flip plan to 'running'.
  await plan.setStatus(opts.planId, 'running');

  // (3) Ensure runDir exists.
  const runDirAbs = runDir(opts.planId);
  await fs.mkdir(runDirAbs, { recursive: true });

  // From here on, ANY throw must (a) emit run.error so events.jsonl is the
  // authoritative crash record, (b) flip the plan to a terminal status so it
  // doesn't get stuck at 'running', and (c) close the events writer so its
  // fd doesn't leak (events.close() is idempotent, see writer.ts). The
  // try/catch/finally below is the single chokepoint for those three.
  let planTerminalSet = false;
  let planOutcome: PlanOutcome = 'partial';
  const taskOutcomes: RunPlanResult['taskOutcomes'] = [];
  let events: EventWriter | null = null;
  let controlServer: Server | null = null;
  const skippedTaskIds: string[] = [];
  try {
    // (4) Open the events writer. validate:false keeps the hot path lean; the
    //     EventSchema test suite covers shape drift in CI.
    const eventsPath = opts.eventsPath ?? path.resolve(runDirAbs, 'events.jsonl');
    events = await openEventWriter({ absPath: eventsPath, validate: false });
    controlServer = await openControlSocket(
      opts.planId,
      startedAt,
      runtime,
      gracefulStop,
      forceStopNow,
    );

    // (5) Emit run.start.
    await events.emit({
      kind: 'run.start',
      planId: opts.planId,
      hostInfo: {
        pid: process.pid,
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
      },
    });

    // (6) Wall-clock budget. v0 reads `overrides.planBudgetSec` (set by the
    //     plan author at seal time) or falls back to 8h (the DEFAULT_CONFIG
    //     value). The supervisor still consumes the sealed plan's overrides
    //     directly here; that keeps tests simple and matches the current
    //     runtime contract.
    const planBudgetSec =
      typeof sealed.overrides.planBudgetSec === 'number' ? sealed.overrides.planBudgetSec : 28800;
    const budgetDeadline = startedAt + planBudgetSec * 1000;
    runtime.budgetDeadlineMs = budgetDeadline;
    const isBudgetExhausted = (): boolean => Date.now() >= budgetDeadline;

    // (6b) ADR-0015 — Error budget (graduated blocked-task counter). Scan the
    //      existing events.jsonl for pre-existing `step.end(status: 'blocked')`
    //      events so the count is durable across `oa rerun` / resume. The budget
    //      is read from `sealed.errorBudget`; if absent, no enforcement.
    const errorBudget = sealed.errorBudget;
    let blockedCount = 0;
    {
      const existing = await readAll({ absPath: eventsPath, onInvalid: () => undefined });
      blockedCount = existing.filter(
        (e) => e.kind === 'step.end' && (e as { status?: string }).status === 'blocked',
      ).length;
    }

    // (7) Per-task outer loop.
    let halted = false;
    let budgetExhausted = false;
    let abortedReason: 'user' | 'budget' | 'completed' = 'completed';

    for (const taskId of sealed.taskListIds) {
      // Budget check first: if exhausted, mark THIS and remaining tasks as
      // budget-exhausted (no events emitted for them — the plan-level run.stop
      // 'budget' reason carries the signal).
      if (isBudgetExhausted()) {
        taskOutcomes.push({ taskId, outcome: 'budget-exhausted', stepsRun: 0 });
        // No `.catch(() => undefined)` here: a real disk failure during the
        // budget-exhausted marking is a genuine problem the operator should
        // see — let it propagate up to the run.error path.
        await inbox.setStatus(taskId, 'budget-exhausted');
        abortedReason = 'budget';
        halted = true;
        continue;
      }

      // Signal-abort check: stop cleanly. Tasks not yet started leave their
      // inbox status untouched (still 'queued') — the operator can resume.
      if (supervisorAc.signal.aborted) {
        abortedReason = 'user';
        halted = true;
        break;
      }

      // Resume-safety: if the inbox already shows this task at a terminal
      // status, skip it entirely. Without this guard, a resumePlan() against a
      // plan whose earlier tasks already landed 'done' (or 'failed' / other
      // terminal statuses) would unconditionally flip the inbox row back to
      // 'running' and re-invoke `worktree.create(...)`, which would throw on
      // the existing worktree dir. Terminal-status tasks do not appear in the
      // returned per-task outcome list on this run — they contributed their
      // outcome on the prior run — which also preserves the identity of
      // `taskOutcomes` as "what happened THIS run".
      const existingInbox = await inbox.get(taskId);
      if (
        existingInbox !== null &&
        (existingInbox.status === 'done' ||
          existingInbox.status === 'failed' ||
          existingInbox.status === 'blocked-needs-human' ||
          existingInbox.status === 'bootstrap-failed' ||
          existingInbox.status === 'budget-exhausted')
      ) {
        continue;
      }

      const taskFolder = taskDir(taskId);
      const intake = await loadIntake(taskFolder);
      // CLI `--sandbox` override: force sandbox.enabled without mutating the
      // sealed intake on disk. Runtime-only, per ADR-0016.
      if (opts.sandboxOverride === true) {
        intake.sandbox = { enabled: true, extraAllowPaths: intake.sandbox?.extraAllowPaths ?? [] };
      }
      const stepsDoc = await loadSteps(taskFolder);

      await inbox.setStatus(taskId, 'running');
      await events.emit({ kind: 'task.start', taskId });
      runtime.currentTaskId = taskId;
      runtime.currentTaskStartedAt = Date.now();
      runtime.currentStepN = null;
      runtime.currentStepStartedAt = null;
      runtime.currentAttempt = null;

      // Worktree. Adopt-or-create: if the worktree dir already exists on
      // disk, we're on the resume path (Task 7.8) — the prior supervisor run
      // had already bootstrapped this task before being interrupted.
      // `worktree.adopt` reconstructs the info without calling `git worktree
      // add` (which would throw on the EEXIST pre-check). resumePlan has
      // already rewound the tree to HEAD before delegating back here.
      const wtAbsRoot = worktreeDir(taskId);
      let wtExists = false;
      try {
        await fs.access(wtAbsRoot);
        wtExists = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      const wt = wtExists
        ? await worktree.adopt({
            taskId,
            repoDir: intake.project.dir,
            baseBranch: intake.project.baseBranch,
            taskTitle: intake.title,
          })
        : await worktree.create({
            taskId,
            repoDir: intake.project.dir,
            baseBranch: intake.project.baseBranch,
            taskTitle: intake.title,
          });

      // Bootstrap. v0 onFailure semantics: bootstrap-failed = task fails. If
      // intake.strategy.onFailure === 'halt', the plan halts after this task;
      // any other policy continues to the next task.
      if (intake.bootstrap.script.trim() !== '') {
        const bs = await runBootstrap({
          absWorktree: wt.absRoot,
          script: intake.bootstrap.script,
          timeoutSec: intake.bootstrap.timeoutSec,
          eventWriter: events,
          taskId,
        });
        if (!bs.ok) {
          await inbox.setStatus(taskId, 'bootstrap-failed');
          await events.emit({ kind: 'task.end', taskId, status: 'bootstrap-failed' });
          taskOutcomes.push({ taskId, outcome: 'bootstrap-failed', stepsRun: 0 });
          runtime.currentTaskId = null;
          runtime.currentTaskStartedAt = null;
          runtime.currentStepN = null;
          runtime.currentStepStartedAt = null;
          runtime.currentAttempt = null;
          if (intake.strategy.onFailure === 'halt') {
            halted = true;
            break;
          }
          continue;
        }
      }

      // Resolve adapters via the injected factories. Production wiring (Task
      // 7.7) will route through `getAdapter(intake.executor.agent)`; the
      // factory-injection seam keeps tests free of registry plumbing.
      const workerAdapter =
        opts.workerAdapterFactory !== undefined
          ? await opts.workerAdapterFactory(intake.executor.agent)
          : await getAdapter(intake.executor.agent);
      const reviewerAdapter =
        opts.reviewerAdapterFactory !== undefined
          ? await opts.reviewerAdapterFactory(intake.reviewer.agent)
          : await getAdapter(intake.reviewer.agent);

      // Reviewer prompt path: intake.reviewer.promptPath or a default. The
      // default is materialized as a tmp file so review.runReviewer can read
      // it via fs.readFile (the contract requires an absolute path).
      let reviewerPromptPath = intake.reviewer.promptPath;
      let cleanupReviewerPrompt: (() => Promise<void>) | null = null;
      if (reviewerPromptPath === null) {
        const tmp = path.resolve(runDirAbs, 'reviewer-default-prompt.md');
        await writeFileAtomic(
          tmp,
          'You are the reviewer. Examine the diff and emit findings as P0/P1/P2.\n',
        );
        reviewerPromptPath = tmp;
        cleanupReviewerPrompt = async (): Promise<void> => {
          await fs.unlink(tmp).catch(() => undefined);
        };
      }

      // Resume-safety: load prior `_progress.json` and compute the set of
      // step numbers already marked 'done'. Those steps were completed during
      // a previous supervisor run (the one whose checkpoint this call is
      // resuming from), and re-executing them would duplicate their committed
      // work and burn extra worker invocations. resumePlan flips in-flight
      // steps back to 'pending' before delegating here, so the only 'done'
      // entries we'll see are the genuinely-finished ones. A fresh run simply
      // sees an empty doc and the set stays empty.
      const priorProgress = await progress.read(taskFolder);
      const alreadyDoneStepNs = new Set(
        priorProgress.steps.filter((s) => s.status === 'done').map((s) => s.n),
      );

      // Per-step inner loop.
      let stepsRun = 0;
      const stepResults: StepRunResult[] = [];
      const stallEmitted = new Set<string>();
      let taskHaltedByStep = false;
      // When a non-review gate fails under markBlocked policy, the worktree
      // may carry uncommitted side-effects from the failed worker. Continuing
      // to step N+1 against that dirty tree poisons the next step's verify
      // diff and any rewindToHead it does on retry. Per the code-review
      // remediation (option b), break out of the per-step loop on the first
      // 'blocked' outcome and surface the task as blocked-needs-human — the
      // remaining steps can't make progress without manual intervention.
      let taskBlockedByStep = false;
      for (const step of stepsDoc.steps) {
        if (alreadyDoneStepNs.has(step.n)) {
          // Already finished on a prior run — record a synthetic 'done'
          // result so the aggregate reasoning below ('all done' vs 'any
          // blocked') stays correct, but do NOT bump `stepsRun` (which is
          // "work performed THIS run") and do NOT emit step.start/step.end
          // events (they already landed in events.jsonl on the prior run).
          stepResults.push({ outcome: 'done', attemptsRun: 0, finalReviewIssues: [] });
          continue;
        }
        if (supervisorAc.signal.aborted) {
          abortedReason = 'user';
          halted = true;
          break;
        }
        if (isBudgetExhausted()) {
          abortedReason = 'budget';
          halted = true;
          break;
        }
        const stepResult = await runStep(
          taskId,
          step,
          intake,
          workerAdapter,
          reviewerAdapter,
          wt,
          reviewerPromptPath,
          runDirAbs,
          taskFolder,
          events,
          supervisorAc.signal,
          runtime,
          stallEmitted,
        );
        stepsRun += 1;
        stepResults.push(stepResult);
        if (supervisorAc.signal.aborted) {
          abortedReason = 'user';
          halted = true;
        }
        if (stepResult.outcome === 'pending') {
          abortedReason = 'user';
          halted = true;
          break;
        }
        if (halted) break;
        if (stepResult.outcome === 'failed' && intake.strategy.onFailure === 'halt') {
          taskHaltedByStep = true;
          halted = true;
          break;
        }
        if (stepResult.outcome === 'blocked') {
          taskBlockedByStep = true;
          break;
        }
      }

      if (cleanupReviewerPrompt !== null) await cleanupReviewerPrompt();

      // Aggregate task outcome from step outcomes:
      //   any step 'failed' (with halt policy) → task 'failed', plan halts
      //   any step 'blocked'                   → task 'blocked-needs-human'
      //   any step 'failed' (non-halt policy)  → task 'blocked-needs-human'
      //   all 'done'                           → task 'done'
      let taskOutcome: TaskOutcome;
      if (stepResults.length === 0 && halted && abortedReason === 'user') {
        taskOutcome = 'stopped';
      } else if (stepResults.length === 0 && halted && abortedReason === 'budget') {
        taskOutcome = 'budget-exhausted';
      } else if (stepResults.some((r) => r.outcome === 'pending')) {
        taskOutcome = 'stopped';
      } else if (
        stepResults.some((r) => r.outcome === 'failed') &&
        intake.strategy.onFailure === 'halt'
      ) {
        taskOutcome = 'failed';
      } else if (
        stepResults.some((r) => r.outcome === 'blocked' || r.outcome === 'failed')
      ) {
        taskOutcome = 'blocked-needs-human';
      } else {
        taskOutcome = 'done';
      }
      const taskStatus: TaskStatusT =
        taskOutcome === 'done'
          ? 'done'
          : taskOutcome === 'failed'
            ? 'failed'
            : taskOutcome === 'stopped'
              ? 'stopped'
              : taskOutcome === 'budget-exhausted'
                ? 'budget-exhausted'
            : 'blocked-needs-human';

      await events.emit({ kind: 'task.end', taskId, status: taskStatus });
      await inbox.setStatus(taskId, taskStatus);
      taskOutcomes.push({ taskId, outcome: taskOutcome, stepsRun });
      runtime.currentTaskId = null;
      runtime.currentTaskStartedAt = null;
      runtime.currentStepN = null;
      runtime.currentStepStartedAt = null;
      runtime.currentAttempt = null;

      // ADR-0015 — Error budget accounting. After each task, if the task
      // ended as blocked-needs-human, increment blockedCount and check the
      // graduated thresholds. warnAfter emits a one-time warning; stopAfter
      // breaks the loop and marks remaining tasks as 'skipped'.
      if (taskOutcome === 'blocked-needs-human') {
        blockedCount += 1;
        if (
          errorBudget !== undefined &&
          errorBudget.warnAfter !== undefined &&
          blockedCount === errorBudget.warnAfter
        ) {
          await events.emit({
            kind: 'plan.budget.warn',
            blockedCount,
            threshold: errorBudget.warnAfter,
          });
        }
        if (
          errorBudget !== undefined &&
          errorBudget.stopAfter !== undefined &&
          blockedCount >= errorBudget.stopAfter
        ) {
          await events.emit({
            kind: 'plan.budget.exhausted',
            blockedCount,
            threshold: errorBudget.stopAfter,
          });
          budgetExhausted = true;
          abortedReason = 'budget';
          halted = true;
          break;
        }
      }

      if (taskHaltedByStep) break;
      // taskBlockedByStep does NOT halt the plan as a whole — onFailure
      // policy at the *plan* level decides cross-task continuation. We only
      // stop running THIS task's remaining steps. Continue to the next task.
      void taskBlockedByStep;
      if (halted) break;
    }

    // (7b) ADR-0015 — After error-budget exhaustion, mark remaining pending tasks
    //      as 'skipped'. Do NOT emit synthetic task.start/task.end events — the
    //      plan.budget.exhausted event already carries the signal. Only tasks that
    //      were never started (i.e. don't appear in taskOutcomes) get skipped.
    if (budgetExhausted) {
      const completedTaskIds = new Set(taskOutcomes.map((t) => t.taskId));
      for (const tid of sealed.taskListIds) {
        if (!completedTaskIds.has(tid)) {
          await inbox.setStatus(tid, 'skipped');
          skippedTaskIds.push(tid);
        }
      }
    }

    // (8) run.stop. Reason precedence: budget > user > completed.
    await events.emit({ kind: 'run.stop', reason: abortedReason });

    // (9) Plan terminal status. Error-budget exhaustion maps to 'partial'
    //     (distinguished from wall-clock budget-exhausted by the
    //     plan.budget.exhausted event in events.jsonl).
    if (abortedReason === 'budget' && !budgetExhausted) planOutcome = 'budget-exhausted';
    else if (abortedReason === 'user') planOutcome = 'stopped';
    else if (taskOutcomes.every((t) => t.outcome === 'done')) planOutcome = 'done';
    else planOutcome = 'partial';

    const planStatusForStore =
      planOutcome === 'done'
        ? 'done'
        : planOutcome === 'stopped'
          ? 'stopped'
          : 'partial'; // 'partial' covers both partial AND budget-exhausted in the store
    await plan.setStatus(opts.planId, planStatusForStore);
    planTerminalSet = true;
  } catch (err) {
    // Surface the crash through events.jsonl BEFORE re-throwing so the
    // post-mortem renderer can attribute the failure. Use a best-effort
    // emit: if the writer is in a bad state itself, swallow that secondary
    // error so the original throw isn't shadowed.
    const message = err instanceof Error ? err.message : String(err);
    await events?.emit({ kind: 'run.error', message }).catch(() => undefined);
    throw err;
  } finally {
    opts.signal.removeEventListener('abort', onExternalAbort);
    // Always flip the plan to a terminal status, even on throw, so it isn't
    // left at 'running' indefinitely. 'partial' is the right default for
    // unexpected crashes — it tells the operator "I started, I didn't finish,
    // you need to look".
    if (!planTerminalSet) {
      await plan.setStatus(opts.planId, 'partial').catch(() => undefined);
    }
    // events.close() is idempotent and swallows write-after-close errors that
    // its own emit() would surface — see writer.ts. Always call it last so
    // the fd is released regardless of which path we exit through.
    if (controlServer !== null) {
      await new Promise<void>((resolve) => controlServer?.close(() => resolve())).catch(() => undefined);
    }
    await events?.close();

    // Auto-render SUMMARY.md from events.jsonl. Best-effort: a render failure
    // should never shadow the caller's outcome (and likewise must not mask the
    // original throw in the outer catch). Writes to <runDir>/SUMMARY.md; CLI
    // users can regenerate via `oa summary <planId>`.
    try {
      const { readAll } = await import('../events/reader.js');
      const { renderSummary } = await import('../summary/render.js');
      const eventsPath = opts.eventsPath ?? path.resolve(runDirAbs, 'events.jsonl');
      const readEvents = await readAll({ absPath: eventsPath, onInvalid: () => undefined });
      const md = renderSummary({ planId: opts.planId, events: readEvents, skippedTaskIds });
      await writeFileAtomic(path.resolve(runDirAbs, 'SUMMARY.md'), md);
    } catch {
      /* best-effort render; never hide the real outcome */
    }
  }

  // Return.
  return {
    planId: opts.planId,
    outcome: planOutcome,
    taskOutcomes,
    durationMs: Date.now() - startedAt,
  };
}
