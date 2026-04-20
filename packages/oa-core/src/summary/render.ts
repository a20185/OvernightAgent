/**
 * Task 9.2 — SUMMARY.md renderer.
 *
 * Builds the morning report from a plan's events.jsonl. The rendered document
 * is the operator's primary post-run artifact: per-task outcome table (status
 * / duration / commits / blocked reason), per-step status with fix-loop
 * counts, open P0/P1 issues, and relative links to per-step prompt.md /
 * stdout.log.
 *
 * Contract:
 *  - Pure function: takes parsed events + planId, returns markdown string.
 *  - Tolerates forward-compat unknown event kinds (ignored).
 *  - Tolerates partial logs (crashed mid-run): outcome columns show whatever
 *    latest state was captured.
 */

type EventObj = Record<string, unknown>;

interface PerTaskAccum {
  taskId: string;
  startedAtMs: number | null;
  endedAtMs: number | null;
  status: string | null;
  stepsStarted: Map<number, number>; // stepN -> startedAtMs
  stepsFinal: Map<number, string>; // stepN -> final status
  stepsAttempts: Map<number, number>; // stepN -> attempt count
  stepsStalled: Map<number, boolean>; // stepN -> saw step.stall
  bootstrapStartedAtMs: number | null;
  bootstrapEndedAtMs: number | null;
  bootstrapOk: boolean | null;
  openIssues: Array<{ stepN: number; priority: string; summary: string }>;
}

function tsToMs(ts: unknown): number | null {
  if (typeof ts !== 'string') return null;
  const d = new Date(ts).getTime();
  return Number.isFinite(d) ? d : null;
}

function fmtDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${String(ms)}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${String(s)}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${String(m)}m${String(rs)}s`;
}

export interface RenderSummaryOpts {
  planId: string;
  events: EventObj[];
  /**
   * Optional: relative path base for per-step links (prompt.md, stdout.log).
   * Defaults to `runs/<planId>` so links render from the repo root.
   */
  linkBase?: string;
  /**
   * Optional: task IDs that were skipped due to budget exhaustion.
   * These tasks have no events in the stream; the renderer adds them
   * to the task table with a "skipped (budget exhausted)" annotation.
   */
  skippedTaskIds?: string[];
}

export function renderSummary(opts: RenderSummaryOpts): string {
  const { planId, events } = opts;
  const linkBase = opts.linkBase ?? `runs/${planId}`;
  const skippedTaskIds = opts.skippedTaskIds ?? [];

  let runStartMs: number | null = null;
  let runStopMs: number | null = null;
  let runStopReason: string | null = null;
  let budgetExhaustedBlocked: number | null = null;
  let budgetExhaustedThreshold: number | null = null;
  const tasks = new Map<string, PerTaskAccum>();
  const taskOrder: string[] = [];

  const tk = (taskId: string): PerTaskAccum => {
    let cur = tasks.get(taskId);
    if (cur === undefined) {
      cur = {
        taskId,
        startedAtMs: null,
        endedAtMs: null,
        status: null,
        stepsStarted: new Map(),
        stepsFinal: new Map(),
        stepsAttempts: new Map(),
        stepsStalled: new Map(),
        bootstrapStartedAtMs: null,
        bootstrapEndedAtMs: null,
        bootstrapOk: null,
        openIssues: [],
      };
      tasks.set(taskId, cur);
      taskOrder.push(taskId);
    }
    return cur;
  };

  for (const e of events) {
    const kind = typeof e.kind === 'string' ? e.kind : '';
    const ts = tsToMs(e.ts);
    switch (kind) {
      case 'run.start':
        runStartMs = ts;
        break;
      case 'run.stop':
        runStopMs = ts;
        runStopReason = typeof e.reason === 'string' ? e.reason : null;
        break;
      case 'task.start': {
        const taskId = typeof e.taskId === 'string' ? e.taskId : null;
        if (taskId === null) break;
        const t = tk(taskId);
        t.startedAtMs = ts;
        break;
      }
      case 'task.end': {
        const taskId = typeof e.taskId === 'string' ? e.taskId : null;
        if (taskId === null) break;
        const t = tk(taskId);
        t.endedAtMs = ts;
        t.status = typeof e.status === 'string' ? e.status : null;
        break;
      }
      case 'task.bootstrap.start': {
        const taskId = typeof e.taskId === 'string' ? e.taskId : null;
        if (taskId === null) break;
        tk(taskId).bootstrapStartedAtMs = ts;
        break;
      }
      case 'task.bootstrap.end': {
        const taskId = typeof e.taskId === 'string' ? e.taskId : null;
        if (taskId === null) break;
        const t = tk(taskId);
        t.bootstrapEndedAtMs = ts;
        if (typeof e.ok === 'boolean') t.bootstrapOk = e.ok;
        break;
      }
      case 'step.start': {
        const taskId = typeof e.taskId === 'string' ? e.taskId : null;
        const stepN = typeof e.stepN === 'number' ? e.stepN : null;
        if (taskId === null || stepN === null) break;
        const t = tk(taskId);
        if (ts !== null) t.stepsStarted.set(stepN, ts);
        break;
      }
      case 'step.end': {
        const taskId = typeof e.taskId === 'string' ? e.taskId : null;
        const stepN = typeof e.stepN === 'number' ? e.stepN : null;
        if (taskId === null || stepN === null) break;
        const t = tk(taskId);
        t.stepsFinal.set(stepN, typeof e.status === 'string' ? e.status : 'unknown');
        break;
      }
      case 'step.attempt.start': {
        const taskId = typeof e.taskId === 'string' ? e.taskId : null;
        const stepN = typeof e.stepN === 'number' ? e.stepN : null;
        const attempt = typeof e.attempt === 'number' ? e.attempt : null;
        if (taskId === null || stepN === null || attempt === null) break;
        const t = tk(taskId);
        const prev = t.stepsAttempts.get(stepN) ?? 0;
        if (attempt > prev) t.stepsAttempts.set(stepN, attempt);
        break;
      }
      case 'step.stall': {
        const taskId = typeof e.taskId === 'string' ? e.taskId : null;
        const stepN = typeof e.stepN === 'number' ? e.stepN : null;
        if (taskId === null || stepN === null) break;
        tk(taskId).stepsStalled.set(stepN, true);
        break;
      }
      case 'step.verify.review.fail': {
        const taskId = typeof e.taskId === 'string' ? e.taskId : null;
        const stepN = typeof e.stepN === 'number' ? e.stepN : null;
        if (taskId === null || stepN === null) break;
        const t = tk(taskId);
        const issues = Array.isArray(e.issues) ? e.issues : [];
        for (const raw of issues) {
          if (raw !== null && typeof raw === 'object') {
            const rec = raw as Record<string, unknown>;
            const priority = typeof rec.priority === 'string' ? rec.priority : '';
            const summary = typeof rec.summary === 'string' ? rec.summary : '';
            if (priority === 'P0' || priority === 'P1') {
              t.openIssues.push({ stepN, priority, summary });
            }
          }
        }
        break;
      }
      case 'plan.budget.exhausted': {
        const bc = typeof e.blockedCount === 'number' ? e.blockedCount : null;
        const th = typeof e.threshold === 'number' ? e.threshold : null;
        if (bc !== null) budgetExhaustedBlocked = bc;
        if (th !== null) budgetExhaustedThreshold = th;
        break;
      }
      default:
        break;
    }
  }

  const lines: string[] = [];
  lines.push(`# SUMMARY — ${planId}`);
  lines.push('');
  const runDur = runStartMs !== null && runStopMs !== null ? runStopMs - runStartMs : null;
  lines.push(
    `Run: started=${runStartMs !== null ? new Date(runStartMs).toISOString() : '—'}` +
      ` stopped=${runStopMs !== null ? new Date(runStopMs).toISOString() : '—'}` +
      ` duration=${fmtDuration(runDur)}` +
      ` reason=${runStopReason ?? '—'}`,
  );
  lines.push('');

  // ADR-0015 — Budget-exhausted abort banner
  if (budgetExhaustedBlocked !== null) {
    const bc = String(budgetExhaustedBlocked);
    const th = budgetExhaustedThreshold !== null ? String(budgetExhaustedThreshold) : '?';
    lines.push(`> **PLAN ABORTED** — error budget exhausted (${bc}/${th} blocked)`);
    lines.push('');
  }

  lines.push('## Tasks');
  lines.push('');
  lines.push('| Task | Status | Duration | Steps (done/total) | Open issues |');
  lines.push('|---|---|---|---|---|');
  for (const taskId of taskOrder) {
    const t = tasks.get(taskId);
    if (t === undefined) continue;
    const dur =
      t.startedAtMs !== null && t.endedAtMs !== null ? t.endedAtMs - t.startedAtMs : null;
    const totalSteps = Math.max(t.stepsStarted.size, t.stepsFinal.size);
    let done = 0;
    for (const s of t.stepsFinal.values()) if (s === 'done') done += 1;
    lines.push(
      `| ${taskId} | ${t.status ?? '(in-flight)'} | ${fmtDuration(dur)} | ${String(done)}/${String(totalSteps)} | ${String(t.openIssues.length)} |`,
    );
  }
  // ADR-0015 — Skipped tasks (no events in stream, status from inbox)
  for (const taskId of skippedTaskIds) {
    lines.push(
      `| ${taskId} | skipped (budget exhausted) | — | 0/0 | 0 |`,
    );
  }
  lines.push('');

  lines.push('## Steps');
  lines.push('');
  for (const taskId of taskOrder) {
    const t = tasks.get(taskId);
    if (t === undefined) continue;
    lines.push(`### ${taskId}`);
    lines.push('');
    if (t.stepsStarted.size === 0 && t.stepsFinal.size === 0) {
      lines.push('(no steps)');
      lines.push('');
      continue;
    }
    lines.push('| # | Status | Attempts | Prompt | Stdout |');
    lines.push('|---|---|---|---|---|');
    const allSteps = Array.from(
      new Set([...t.stepsStarted.keys(), ...t.stepsFinal.keys()]),
    ).sort((a, b) => a - b);
    for (const n of allSteps) {
      const status = t.stepsFinal.get(n) ?? '(in-flight)';
      const attempts = t.stepsAttempts.get(n) ?? 0;
      const stalled = t.stepsStalled.get(n) === true;
      let statusCol = status;
      if (stalled) {
        if (status === 'done') {
          statusCol = 'done ⚠ stalled';
        } else if (status === 'blocked') {
          statusCol = 'blocked ⚠ stalled→blocked';
        }
      }
      const stepDirRel = `${linkBase}/${taskId}/step-${String(n).padStart(2, '0')}`;
      const promptRel = `${stepDirRel}/attempt-01/prompt.md`;
      const stdoutRel = `${stepDirRel}/attempt-01/stdout.log`;
      lines.push(
        `| ${String(n)} | ${statusCol} | ${String(attempts)} | [prompt](${promptRel}) | [stdout](${stdoutRel}) |`,
      );
    }
    lines.push('');
  }

  lines.push('## Open P0/P1 issues');
  lines.push('');
  let hasIssues = false;
  for (const taskId of taskOrder) {
    const t = tasks.get(taskId);
    if (t === undefined) continue;
    for (const iss of t.openIssues) {
      hasIssues = true;
      lines.push(`- \`${taskId}\` step ${String(iss.stepN)} [${iss.priority}] ${iss.summary}`);
    }
  }
  if (!hasIssues) lines.push('(none)');
  lines.push('');

  return lines.join('\n');
}
