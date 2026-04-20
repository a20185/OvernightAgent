import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { assertAbs, pidfile, runDir, taskDir, worktreeDir } from '../paths.js';
import { assertId } from '../ids.js';
import * as inbox from '../stores/inbox.js';
import * as plan from '../stores/plan.js';
import * as progress from '../state/progress.js';
import * as worktree from '../worktree.js';
import { openEventWriter } from '../events/writer.js';
import { runPlan, type RunPlanOpts, type RunPlanResult } from './runPlan.js';
import { isStale } from './pidfile.js';

/**
 * Task 7.8 — Resume protocol (ADR-0003).
 *
 * `resumePlan(planId)` is the foreground entrypoint for recovering a plan
 * whose prior supervisor run was interrupted (laptop sleep, ctrl+c, crash,
 * `oa stop --now`). It is *not* a daemon entry — unlike `runSupervisorEntry`,
 * resumePlan does NOT acquire the pidfile; it's a thin prelude that cleans
 * state then delegates to `runPlan`. The caller (entry, daemon, or a test)
 * owns pidfile ownership for the fresh attempt.
 *
 * Behavior:
 *
 *   1. Liveness refuse: if `pidfile(planId)` points to a LIVE pid, we refuse
 *      and throw a clear error naming both the live pid and the planId. If
 *      the pidfile is stale (or absent), we unlink it so the next acquirer
 *      sees a clean slate.
 *   2. Orphan temp-file sweep: best-effort removal of `.tmp.<oldpid>.*`
 *      files left under `<runDir>/` by a crashed `writeJsonAtomic` in a
 *      prior supervisor process. Filters out files whose name contains THIS
 *      process's pid (defensive; no concurrent writer exists at this
 *      point). Tolerates ENOENT on `<runDir>` (never created yet).
 *   3. Scan per-task state: for each `taskListIds` entry, inspect
 *      `<taskFolder>/_progress.json` and the inbox row. "In-flight" means
 *      any `_progress.json` step is at `status === 'running'` OR the inbox
 *      status is `'running'`.
 *   4. For each in-flight task:
 *        - If the worktree dir exists, call `worktree.rewindToHead(absRoot)`
 *          (`git reset --hard HEAD && git clean -fdx`). Missing worktree
 *          dir is skipped silently (pre-bootstrap interruption).
 *        - Rewrite every `_progress.json` step currently at `'running'`
 *          back to `'pending'` via `progress.mark(...)`. `'done'` /
 *          `'failed'` / `'blocked'` steps are left alone.
 *        - Flip the inbox status back to `'pending'` UNLESS it's already at
 *          a terminal status (`'done'` / `'failed'` / `'blocked-needs-human'`
 *          / `'stopped'` / `'bootstrap-failed'`) — those tasks have already
 *          contributed their outcome and must NOT re-run. 'stopped' IS an
 *          in-flight marker for tasks that a user aborted mid-step; those
 *          must re-run on resume, so we rewind them like any other
 *          in-flight. ('stopped' means resumable; 'done' means settled.)
 *   5. Open the events writer (same O_APPEND file as prior runs) and emit
 *      `run.resume {planId, rewoundSteps}`. `rewoundSteps` is
 *      `Array<{taskId, stepN}>`. Close the writer (runPlan will re-open it).
 *   6. Flip the plan status back to `'running'` — runPlan's guard rejects
 *      anything other than `'sealed' | 'running'`, and we may be resuming
 *      from `'partial'` / `'stopped'`.
 *   7. Delegate to `runPlan`, forwarding the adapter factories. runPlan's
 *      outer loop skips tasks already at terminal inbox status (see
 *      runPlan.ts line ~737 for the matching guard), so previously-`'done'`
 *      tasks are NOT re-executed.
 *
 * **Preconditions / invariants (ADR-0003 carry-forwards):**
 *
 *   - `worktree.rewindToHead` requires NO live process from a prior attempt
 *     retains open file handles under `absRoot`. Resume satisfies this via
 *     step (1): if the pidfile had pointed at a live pid we would have
 *     thrown before reaching rewind. The stale/absent pidfile path is the
 *     guarantee here.
 *   - Atomic writes only. `progress.mark` composes `writeJsonAtomic` +
 *     `writeFileAtomic` — we just call it.
 *   - All paths are absolute (via the paths.ts helpers), asserted at the
 *     boundary.
 *   - We do NOT call `pidfile.release()` here. resumePlan does not own the
 *     pidfile; its job is to DETECT a dead one and clear it so the next
 *     proper acquirer succeeds.
 */

export interface ResumePlanOpts {
  planId: string;
  signal: AbortSignal;
  /** Tests can override adapter resolution; production falls back to getAdapter(agentId). */
  workerAdapterFactory?: RunPlanOpts['workerAdapterFactory'];
  reviewerAdapterFactory?: RunPlanOpts['reviewerAdapterFactory'];
  /** Override of `<runDir(planId)>/events.jsonl`. Tests use this rarely; prod never. */
  eventsPath?: string;
}

export type { RunPlanResult as ResumePlanResult } from './runPlan.js';

/**
 * Clean up the pidfile if stale/absent, refuse if live.
 *
 * `isStale` from pidfile.ts treats a missing pidfile as stale so this path
 * doubles as "no pidfile → nothing to do". The unlink is ENOENT-tolerant
 * because the pidfile may be absent OR another cleanup path may have
 * already claimed it (idempotent by design).
 */
async function refuseIfLiveElseCleanPidfile(planId: string): Promise<void> {
  const pidPath = pidfile(planId);
  if (!isStale(planId)) {
    // Live pid. Re-read the file so the thrown message names it.
    let livePid: string = '?';
    try {
      const raw = await fs.readFile(pidPath, 'utf8');
      livePid = raw.trim();
    } catch {
      /* swallow — we still refuse */
    }
    throw new Error(
      `resumePlan refusing: pidfile at ${pidPath} points to live pid ${livePid} ` +
        `(planId=${planId}). Stop the running supervisor first.`,
    );
  }
  // Stale or absent. Unlink (ENOENT-tolerant) so the foreground caller's
  // own pidfile.acquire (if any) sees a clean slate. Do NOT go through
  // pidfile.release — that's owned by the pidfile module lifecycle; resume
  // is a foreground recovery path that explicitly does not hold the lock.
  await fs.unlink(pidPath).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err;
  });
}

/**
 * Best-effort sweep of orphan temp files under `<runDir>`. Matches the
 * `.tmp.` substring produced by `writeFileAtomic` in atomicJson.ts
 * (`<basename>.tmp.<pid>.<rand>`). Files whose name contains the current
 * pid are skipped defensively (there's no concurrent writer at this
 * point, but the filter costs nothing and guards against future callers
 * who resume mid-run).
 */
async function sweepOrphanTempFiles(planId: string): Promise<void> {
  const dir = runDir(planId);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  const myPidMarker = `.tmp.${String(process.pid)}.`;
  for (const entry of entries) {
    if (!entry.includes('.tmp.')) continue;
    if (entry.includes(myPidMarker)) continue;
    await fs.unlink(path.resolve(dir, entry)).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
    });
  }
}

/**
 * Does `absRoot` exist as a directory we can enter? We don't verify `.git`
 * is inside — simple-git will surface that via its own error path when the
 * rewind happens. The presence check is only to skip rewind for tasks that
 * crashed before worktree bootstrap ever ran.
 */
async function worktreeExists(absRoot: string): Promise<boolean> {
  assertAbs(absRoot);
  try {
    const st = await fs.stat(absRoot);
    return st.isDirectory();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Walk every task in the plan's `taskListIds` and return the set of
 * in-flight tasks (inbox 'running' or 'stopped', OR progress-doc has any
 * 'running' step) paired with the stepNs that need rewinding. 'stopped'
 * tasks are included because the supervisor's graceful-abort path sets
 * inbox to 'stopped' — resume must re-run those. Terminal statuses
 * ('done', 'failed', 'blocked-needs-human', 'bootstrap-failed',
 * 'budget-exhausted') are skipped; the downstream runPlan also guards
 * against re-running them.
 */
interface InFlight {
  taskId: string;
  runningStepNs: number[];
  inboxStatusBeforeResume: string | null;
}

async function scanInFlight(taskListIds: readonly string[]): Promise<InFlight[]> {
  const out: InFlight[] = [];
  for (const taskId of taskListIds) {
    const row = await inbox.get(taskId);
    const inboxStatus = row?.status ?? null;

    // Read progress — tolerate missing folder / missing _progress.json.
    // progress.read throws only on corrupt JSON; a missing _progress.json
    // returns an empty doc, so any throw here is genuine and surfaces up.
    const doc = await progress.read(taskDir(taskId));
    const runningStepNs = doc.steps
      .filter((s) => s.status === 'running')
      .map((s) => s.n);

    const inboxInFlight = inboxStatus === 'running' || inboxStatus === 'stopped';
    if (inboxInFlight || runningStepNs.length > 0) {
      out.push({ taskId, runningStepNs, inboxStatusBeforeResume: inboxStatus });
    }
  }
  return out;
}

export async function resumePlan(opts: ResumePlanOpts): Promise<RunPlanResult> {
  assertId(opts.planId);

  // (1) Pidfile liveness + cleanup.
  await refuseIfLiveElseCleanPidfile(opts.planId);

  // (2) Load plan to enumerate tasks.
  const sealed = await plan.get(opts.planId);
  if (sealed === null) throw new Error(`plan not found: ${opts.planId}`);

  // (3) Orphan temp-file sweep under runDir.
  await sweepOrphanTempFiles(opts.planId);

  // (4) Scan per-task state.
  const inFlight = await scanInFlight(sealed.taskListIds);

  // (5) For each in-flight task: rewind worktree (if exists), mark running
  //     steps back to pending, flip inbox to pending.
  const rewoundSteps: Array<{ taskId: string; stepN: number }> = [];
  for (const t of inFlight) {
    const absRoot = worktreeDir(t.taskId);
    if (await worktreeExists(absRoot)) {
      await worktree.rewindToHead(absRoot);
      // Task 2.5 (ADR-0015): remove stale .oa-current-prompt.md symlink so
      // the post-compact hook doesn't read a prompt from the prior attempt.
      await fs.rm(path.resolve(absRoot, '.oa-current-prompt.md'), { force: true });
    }
    for (const stepN of t.runningStepNs) {
      // progress.mark preserves `attempt` across calls; we're writing
      // 'pending' so the prior 'running' doesn't leak into the next
      // attempt's PROGRESS.md and the supervisor's re-entry writes a
      // fresh 'running' when it picks the step back up.
      await progress.mark(taskDir(t.taskId), stepN, 'pending');
      rewoundSteps.push({ taskId: t.taskId, stepN });
    }
    // Inbox flip: send resumable tasks back to 'pending' so the downstream
    // runPlan path is identical to a fresh run. runPlan re-flips to
    // 'running' on task entry.
    await inbox.setStatus(t.taskId, 'pending');
  }

  // (6) Emit run.resume. Open the writer in the same O_APPEND mode runPlan
  //     uses so the resume event appends to prior events.jsonl content.
  const eventsPathAbs = opts.eventsPath ?? path.resolve(runDir(opts.planId), 'events.jsonl');
  const writer = await openEventWriter({ absPath: eventsPathAbs, validate: false });
  try {
    await writer.emit({
      kind: 'run.resume',
      planId: opts.planId,
      rewoundSteps,
    } as unknown as Parameters<typeof writer.emit>[0]);
  } finally {
    await writer.close();
  }

  // (7) Flip plan status to 'running' so runPlan's guard accepts it. runPlan
  //     also re-flips this at its own entry, but we need to clear any
  //     'partial' / 'stopped' terminal state from the prior run.
  if (sealed.status !== 'sealed' && sealed.status !== 'running') {
    await plan.setStatus(opts.planId, 'running');
  }

  // (8) Delegate to runPlan. It will re-open the events writer, emit
  //     run.start, and walk taskListIds — skipping terminal-status inbox
  //     rows via its built-in guard.
  return runPlan({
    planId: opts.planId,
    signal: opts.signal,
    ...(opts.workerAdapterFactory !== undefined
      ? { workerAdapterFactory: opts.workerAdapterFactory }
      : {}),
    ...(opts.reviewerAdapterFactory !== undefined
      ? { reviewerAdapterFactory: opts.reviewerAdapterFactory }
      : {}),
    ...(opts.eventsPath !== undefined ? { eventsPath: opts.eventsPath } : {}),
  });
}
