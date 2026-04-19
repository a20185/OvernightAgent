import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomBytes } from 'node:crypto';
import type { AgentAdapter, AgentRunResult } from '../adapter/types.js';
import type { OaReviewIssue } from '../schemas.js';
import { assertAbs } from '../paths.js';
import { parseTail } from './tail.js';

/**
 * Task 6.3 — reviewer invocation + AI-judge review gate.
 *
 * The supervisor (Phase 7) consults this gate after the executor's pre-merge
 * gates (tail/commit/cmd) all pass. It runs the configured reviewer adapter
 * (typically `claude` with `opus`) against the diff that landed during the
 * step, parses the reviewer's `oa-review` tail block (ADR-0008), and decides
 * `ok` iff:
 *
 *   1. the reviewer process actually ran (no kill, exitCode 0),
 *   2. it emitted a parseable `oa-review` block (last-fence-wins per parseTail),
 *   3. and none of the parsed issues' priorities are in the supervisor's
 *      `blockOn` list.
 *
 * Distinct fail reasons across (1)/(2)/(3) are load-bearing — the fix-loop
 * synthesizer (Task 6.6) keys off them when composing corrective prompts:
 *   - `reviewer killed: <killedBy>`  → bump timeout / mark blocked
 *   - `reviewer exited <code>`       → adapter-side problem; mark blocked
 *   - `no parseable oa-review: …`    → re-prompt the reviewer with stricter
 *                                       protocol reminder
 *   - `<N> blocking issue(s) found`  → re-prompt the EXECUTOR with the
 *                                       blocking issues as feedback
 *
 * The gate composes a fresh "full prompt" (template + diff + protocol block)
 * in a temp file under `os.tmpdir()` and hands THAT path to the adapter — the
 * caller-supplied `promptPath` is read but never modified, so a user-supplied
 * reviewer template can be reused across many step invocations without
 * accumulating injected context. The temp file is unlinked best-effort in a
 * `finally` so a process crash mid-spawn doesn't leave detritus behind (and
 * the supervisor's `os.tmpdir()` housekeeping eventually mops anything that
 * does survive).
 */

export interface RunReviewerOpts {
  /** The reviewer adapter (typically claude with opus). */
  adapter: AgentAdapter;
  /** Override of `adapter.defaultModel`. */
  model: string;
  /** Extra CLI args forwarded to the adapter. */
  extraArgs: string[];
  /** Absolute path to the reviewer's prompt template (user-supplied or default). */
  promptPath: string;
  /** The git diff `<stepStartSha>..HEAD` output (computed by caller). */
  stepDiff: string;
  /** Priorities that count as "blocking" (typically `['P0','P1']`). */
  blockOn: ReadonlyArray<'P0' | 'P1' | 'P2'>;
  /** Absolute worktree path passed through to the adapter. */
  cwd: string;
  env?: Record<string, string>;
  timeoutSec: number;
  stdoutCapBytes: number;
  /** Absolute capture path for reviewer stdout. */
  stdoutPath: string;
  /** Absolute capture path for reviewer stderr. */
  stderrPath: string;
  signal: AbortSignal;
}

export interface RunReviewerResult {
  /**
   * `true` iff the reviewer ran AND emitted a parseable `oa-review` block AND
   * `blocking.length === 0`. Any other outcome is `false` with a distinct
   * `reason` substring (see top-of-file taxonomy).
   */
  ok: boolean;
  eventKind: 'step.verify.review.ok' | 'step.verify.review.fail';
  reason?: string;
  /** All issues from the reviewer (empty if reviewer didn't run / failed parse). */
  issues: OaReviewIssue[];
  /** Subset of `issues` whose priority ∈ `blockOn`. */
  blocking: OaReviewIssue[];
  /** Adapter run result for events.jsonl. */
  detail?: unknown;
}

// The protocol block we append to every reviewer prompt. Mirrors the executor
// `oa-status` block (Task 6.1) — it tells the reviewer EXACTLY what fenced
// shape the supervisor will parse with `parseTail(_, 'oa-review')`. Keeping
// the contract literal (rather than free-form) is what lets the parser stay
// tiny and the fix-loop synthesizer (Task 6.6) point at a stable spec when
// the reviewer drifts.
const PROTOCOL_BLOCK = [
  '',
  'Please end your response with a fenced code block exactly like this:',
  '',
  '```oa-review',
  '{"issues":[{"priority":"P0|P1|P2","file":"path/to/file","line":123,"finding":"...","suggestion":"..."}]}',
  '```',
  '',
  'If there are no issues, emit `{"issues":[]}`. Use `P0` for must-fix,',
  '`P1` for should-fix, `P2` for advisory. `line` and `suggestion` are optional.',
  '',
].join('\n');

// Markdown horizontal-rule separator. Two newlines on each side keep the
// rendered prompt readable in agent UIs that pretty-print markdown.
const PROMPT_SEPARATOR = '\n\n---\n\n';

export async function runReviewer(opts: RunReviewerOpts): Promise<RunReviewerResult> {
  // Defence-in-depth: every path the supervisor hands us must already be
  // absolute (it's assembled from the worktree root). Mirrors the worktree /
  // verify-gate / spawn guards so a misuse can't silently spawn the reviewer
  // under process.cwd().
  assertAbs(opts.promptPath);
  assertAbs(opts.cwd);
  assertAbs(opts.stdoutPath);
  assertAbs(opts.stderrPath);

  const template = await fs.readFile(opts.promptPath, 'utf8');
  const fullPrompt = [template, opts.stepDiff, PROTOCOL_BLOCK].join(PROMPT_SEPARATOR);

  // Per-call random suffix avoids tmp-file collisions when the supervisor
  // runs multiple tasks concurrently (Phase 7 parallel mode). pid is included
  // for human-debuggability when staring at /tmp during a hung run.
  const tmpPromptPath = path.resolve(
    os.tmpdir(),
    `oa-reviewer-${process.pid}-${randomBytes(4).toString('hex')}.md`,
  );
  await fs.writeFile(tmpPromptPath, fullPrompt, 'utf8');

  let result: AgentRunResult;
  try {
    result = await opts.adapter.run({
      cwd: opts.cwd,
      promptPath: tmpPromptPath,
      model: opts.model,
      extraArgs: opts.extraArgs,
      env: opts.env,
      timeoutSec: opts.timeoutSec,
      stdoutCapBytes: opts.stdoutCapBytes,
      stdoutPath: opts.stdoutPath,
      stderrPath: opts.stderrPath,
      signal: opts.signal,
    });
  } finally {
    // Best-effort cleanup. A failure here (already unlinked, fs full, etc.)
    // is never load-bearing — the supervisor / OS tmpdir-reaper will catch
    // any straggler — and we'd rather lose the cleanup than mask the real
    // adapter result by throwing from finally.
    try {
      await fs.unlink(tmpPromptPath);
    } catch {
      /* ignore */
    }
  }

  // Killed paths come BEFORE the exit-code check: a killed process has
  // exitCode === null, so the order doesn't matter for correctness, but
  // pinning the killer name in the reason is more actionable than a bare
  // "exited null" would be.
  if (result.killedBy) {
    return {
      ok: false,
      eventKind: 'step.verify.review.fail',
      reason: `reviewer killed: ${result.killedBy}`,
      issues: [],
      blocking: [],
      detail: result,
    };
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      eventKind: 'step.verify.review.fail',
      reason: `reviewer exited ${String(result.exitCode)}`,
      issues: [],
      blocking: [],
      detail: result,
    };
  }

  // Re-read the captured stdout (the adapter wrote it during run()). We DO
  // NOT trust an in-memory copy because the adapter contract is "writes to
  // stdoutPath" — sniffing the file mirrors what the supervisor's other
  // gates (verifyTail) do, so a single capture file is the canonical source
  // of truth.
  const stdoutContent = await fs.readFile(opts.stdoutPath, 'utf8');
  const parsed = parseTail(stdoutContent, 'oa-review');
  if (!parsed.ok) {
    return {
      ok: false,
      eventKind: 'step.verify.review.fail',
      reason: `no parseable oa-review block: ${parsed.reason}`,
      issues: [],
      blocking: [],
      detail: result,
    };
  }

  const issues = parsed.value.issues;
  // `Array.includes` on a `ReadonlyArray<T>` accepts any T at the type level;
  // here `i.priority` is exactly the union we filter on, so this is direct.
  const blocking = issues.filter((i) => opts.blockOn.includes(i.priority));
  if (blocking.length === 0) {
    return {
      ok: true,
      eventKind: 'step.verify.review.ok',
      issues,
      blocking: [],
      detail: result,
    };
  }
  return {
    ok: false,
    eventKind: 'step.verify.review.fail',
    reason: `${blocking.length} blocking issue(s) found`,
    issues,
    blocking,
    detail: result,
  };
}
