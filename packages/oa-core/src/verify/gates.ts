import { execa } from 'execa';
import { assertAbs } from '../paths.js';
import { commitsSince } from '../worktree.js';
import { parseTail } from './tail.js';

/**
 * Three pre-merge verify gates the Phase 7 supervisor consults after every
 * step run. Each returns the same tagged shape so the supervisor's event
 * emitter can shovel `eventKind` straight into the run log without a per-gate
 * switch. Per-gate `detail` carries structured payloads useful to both the
 * fix-loop synthesizer (Task 6.6) and the human-readable run log.
 *
 * IMPORTANT: gates verify the protocol contract; they do NOT apply policy.
 *   - `verifyTail` ok==true on `status:'blocked'` — the supervisor decides
 *     blocked-needs-human is a different transition from "agent never
 *     emitted a tail".
 *   - `verifyCommit` returns `count:0` as a fail, NOT throws — only genuine
 *     git/IO errors propagate, so the supervisor can distinguish "agent
 *     forgot to commit" (recoverable; trigger fix-loop) from "git itself
 *     broke" (unrecoverable; mark blocked).
 *   - `verifyCmd` similarly returns fail on non-zero exit / timeout rather
 *     than throwing; only adapter-level failures (e.g. command-not-found
 *     bubbled by execa as a thrown error) escape.
 *
 * The Phase 7 step-level timeout is separate from `CMD_TIMEOUT_MS` here —
 * this 5-min cap is a backstop that prevents a runaway verify command from
 * eating the supervisor's per-step budget; the supervisor's own timeout will
 * usually fire first.
 */

export interface GateOk {
  ok: true;
  eventKind: string;
  detail?: unknown;
}

export interface GateFail {
  ok: false;
  eventKind: string;
  reason: string;
  detail?: unknown;
}

export type GateResult = GateOk | GateFail;

// 5-minute backstop for verify commands (`pnpm test`, etc). Sized for typical
// JS/TS test suites; the supervisor's per-step timeout (Phase 7) takes
// precedence in practice and is shorter for most tasks.
const CMD_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Verifies the agent emitted a parseable `oa-status` block at the tail of its
 * stdout (ADR-0008). Delegates to `parseTail` for the actual extraction +
 * schema check; this gate just translates the result into the supervisor's
 * GateResult shape.
 *
 * Note: a parsed status of `'blocked'` is a tail-PASS. The supervisor (Phase
 * 7) handles the blocked-needs-human transition as a separate concern; this
 * gate's job is purely "did the agent honor the tail-message protocol".
 */
export function verifyTail(stdoutText: string): GateResult {
  const r = parseTail(stdoutText, 'oa-status');
  if (r.ok) {
    return { ok: true, eventKind: 'step.verify.tail.ok', detail: r.value };
  }
  return { ok: false, eventKind: 'step.verify.tail.fail', reason: r.reason };
}

/**
 * Verifies at least one commit landed in `absWorktree` since `stepStartSha`
 * (the HEAD captured by the supervisor before invoking the agent). A step
 * that produces no commits is — per ADR-0003 / commit-mode contract — a
 * non-progressing step, regardless of what the agent claimed in its tail.
 *
 * Errors from `commitsSince` (bad sha, git not installed, repo broken)
 * propagate untouched. The supervisor distinguishes those from a clean
 * `count: 0` fail and routes them differently (mark blocked vs fix-loop).
 */
export async function verifyCommit(
  absWorktree: string,
  stepStartSha: string,
): Promise<GateResult> {
  assertAbs(absWorktree);
  const count = await commitsSince(absWorktree, stepStartSha);
  if (count >= 1) {
    return { ok: true, eventKind: 'step.verify.commit.ok', detail: { count } };
  }
  return {
    ok: false,
    eventKind: 'step.verify.commit.fail',
    reason: 'no new commits since step start',
    detail: { count },
  };
}

/**
 * Runs the user-supplied verify command (e.g. `pnpm test && pnpm lint`) in
 * `absWorktree` via a real shell, captures stdout/stderr separately, and
 * returns ok iff the command exited 0 and didn't time out.
 *
 * `shell: true` is load-bearing: the command may be a multi-word string with
 * `&&`, redirections, or pipes. Without it, execa would treat the entire
 * string as argv[0] and fail with ENOENT.
 *
 * `reject: false` keeps execa from throwing on non-zero exit so we can shape
 * the result as a GateFail rather than wrap an exception. Only truly
 * exceptional execa errors (e.g. spawn-failure on a non-existent shell)
 * escape — the supervisor handles those upstream.
 *
 * `timedOut` from execa is checked explicitly: a timeout produces an
 * undefined exitCode alongside `timedOut: true`, and the gate's `reason`
 * needs to surface that distinction to the fix-loop synthesizer ("verify
 * timed out" prompts a different corrective hint than "verify exited N").
 */
export async function verifyCmd(absWorktree: string, command: string): Promise<GateResult> {
  assertAbs(absWorktree);
  const result = await execa(command, [], {
    cwd: absWorktree,
    shell: true,
    reject: false,
    timeout: CMD_TIMEOUT_MS,
  });
  const detail = {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
  };
  if (result.exitCode === 0 && !result.timedOut) {
    return { ok: true, eventKind: 'step.verify.cmd.ok', detail };
  }
  const reason = result.timedOut
    ? `verify command timed out after ${CMD_TIMEOUT_MS}ms`
    : `verify command exited ${String(result.exitCode)}`;
  return { ok: false, eventKind: 'step.verify.cmd.fail', reason, detail };
}
