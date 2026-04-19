import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { AgentAdapter, AgentRunOpts, AgentRunResult } from '../../src/adapter/types.js';
import { runReviewer } from '../../src/verify/review.js';

// -----------------------------------------------------------------------------
// Task 6.3 — Reviewer invocation + review gate.
//
// The supervisor (Phase 7) consults this gate after the executor's pre-merge
// gates (tail/commit/cmd) pass. It runs the configured reviewer adapter
// (typically claude with opus) against the step diff, parses the reviewer's
// `oa-review` tail block (ADR-0008), and decides ok iff:
//   - the reviewer ran (no kill, exitCode 0), AND
//   - it emitted a parseable oa-review block, AND
//   - none of the parsed issues' priorities are in the supervisor's blockOn list.
//
// Tests here exercise every distinct outcome with a MOCK adapter — no real
// claude spawn — so the suite stays fast and deterministic. The mock satisfies
// AgentAdapter, lets each test declare what stdoutPath body to write and what
// AgentRunResult to return, and (where useful) captures the prompt-file path
// the reviewer was actually invoked with so the prompt-assembly contract can
// be asserted directly.
// -----------------------------------------------------------------------------

const bt = (n: number): string => '`'.repeat(n);
const fence = (kind: string, body: string): string => `${bt(3)}${kind}\n${body}\n${bt(3)}`;

interface MockAdapterOpts {
  exitCode?: number | null;
  killedBy?: 'timeout' | 'stdoutCap' | 'signal' | null;
  stdoutBody?: string;
  sessionId?: string;
  // Out-param: the run() call records the AgentRunOpts it was given here so
  // tests can inspect the assembled prompt file (and any other passthroughs).
  capturedRunOpts?: { value?: AgentRunOpts };
  // Out-param: when set, run() reads the prompt file before adapter return so
  // the prompt-assembly test can assert template + diff + protocol all landed.
  capturedPromptText?: { value?: string };
}

function makeMockAdapter(opts: MockAdapterOpts): AgentAdapter {
  return {
    id: 'claude',
    defaultModel: 'opus',
    capabilities: () => ({ supportsSessionId: true, supportsStructuredOutput: true }),
    run: async (runOpts: AgentRunOpts): Promise<AgentRunResult> => {
      if (opts.capturedRunOpts) opts.capturedRunOpts.value = runOpts;
      if (opts.capturedPromptText) {
        opts.capturedPromptText.value = await fs.readFile(runOpts.promptPath, 'utf8');
      }
      if (opts.stdoutBody !== undefined) {
        await fs.writeFile(runOpts.stdoutPath, opts.stdoutBody, 'utf8');
      }
      return {
        exitCode: opts.exitCode ?? 0,
        durationMs: 1,
        timedOut: opts.killedBy === 'timeout',
        stdoutCapHit: opts.killedBy === 'stdoutCap',
        killedBy: opts.killedBy ?? null,
        sessionId: opts.sessionId,
      };
    },
  };
}

describe('runReviewer', () => {
  let TMP_DIR: string;
  let TMP_CWD: string;
  let promptPath: string;
  let stdoutPath: string;
  let stderrPath: string;
  let signal: AbortSignal;

  beforeEach(async () => {
    TMP_DIR = path.resolve(os.tmpdir(), 'oa-review-' + Math.random().toString(36).slice(2));
    await fs.mkdir(TMP_DIR, { recursive: true });
    TMP_CWD = path.resolve(TMP_DIR, 'cwd');
    await fs.mkdir(TMP_CWD, { recursive: true });
    promptPath = path.resolve(TMP_DIR, 'reviewer-prompt.md');
    stdoutPath = path.resolve(TMP_DIR, 'reviewer.stdout');
    stderrPath = path.resolve(TMP_DIR, 'reviewer.stderr');
    await fs.writeFile(
      promptPath,
      'You are a reviewer. Look at the diff and report issues.\n',
      'utf8',
    );
    signal = new AbortController().signal;
  });

  afterEach(async () => {
    await fs.rm(TMP_DIR, { recursive: true, force: true });
  });

  // (1) Happy path — reviewer ran and emitted an empty issues list. The most
  // common outcome on a clean step. We pin `ok: true`, the ok eventKind, and
  // both `issues`/`blocking` empty so the supervisor's logger doesn't render
  // a phantom "0 blocking" line.
  it('returns ok with empty issues when reviewer emits {"issues":[]}', async () => {
    const adapter = makeMockAdapter({
      stdoutBody: 'looked at the diff\n' + fence('oa-review', '{"issues":[]}') + '\n',
    });
    const r = await runReviewer({
      adapter,
      model: 'opus',
      extraArgs: [],
      promptPath,
      stepDiff: 'diff --git a/x b/x\n+hello\n',
      blockOn: ['P0', 'P1'],
      cwd: TMP_CWD,
      timeoutSec: 60,
      stdoutCapBytes: 1024,
      stdoutPath,
      stderrPath,
      signal,
    });
    expect(r.ok).toBe(true);
    expect(r.eventKind).toBe('step.verify.review.ok');
    expect(r.issues).toEqual([]);
    expect(r.blocking).toEqual([]);
  });

  // (2) Non-blocking issues only: the reviewer found things worth noting but
  // none are in the supervisor's blockOn set. Result is still ok=true and the
  // full issue list is preserved in `issues` (so the run log can surface the
  // advisory findings even though they don't block merge).
  it('returns ok when only non-blocking-priority issues are emitted', async () => {
    const issues = [
      { priority: 'P2', file: 'a.ts', finding: 'consider extracting helper' },
      { priority: 'P2', file: 'b.ts', finding: 'docstring could be clearer' },
    ];
    const adapter = makeMockAdapter({
      stdoutBody: fence('oa-review', JSON.stringify({ issues })),
    });
    const r = await runReviewer({
      adapter,
      model: 'opus',
      extraArgs: [],
      promptPath,
      stepDiff: '',
      blockOn: ['P0', 'P1'],
      cwd: TMP_CWD,
      timeoutSec: 60,
      stdoutCapBytes: 1024,
      stdoutPath,
      stderrPath,
      signal,
    });
    expect(r.ok).toBe(true);
    expect(r.eventKind).toBe('step.verify.review.ok');
    expect(r.issues).toHaveLength(2);
    expect(r.blocking).toEqual([]);
  });

  // (3) The canonical fail mode. A P0 issue is blocking under the default
  // policy; a P2 alongside it must NOT count as blocking. We pin both the
  // issue partition (issues=2, blocking=[the P0]) and the reason substring
  // ("1 blocking") since Phase 7's run-log renderer keys off it.
  it('returns fail with blocking subset when blockOn priority is present', async () => {
    const issues = [
      { priority: 'P0', file: 'a.ts', line: 10, finding: 'null deref', suggestion: 'add guard' },
      { priority: 'P2', file: 'b.ts', finding: 'nit' },
    ];
    const adapter = makeMockAdapter({
      stdoutBody: fence('oa-review', JSON.stringify({ issues })),
    });
    const r = await runReviewer({
      adapter,
      model: 'opus',
      extraArgs: [],
      promptPath,
      stepDiff: '',
      blockOn: ['P0', 'P1'],
      cwd: TMP_CWD,
      timeoutSec: 60,
      stdoutCapBytes: 1024,
      stdoutPath,
      stderrPath,
      signal,
    });
    expect(r.ok).toBe(false);
    expect(r.eventKind).toBe('step.verify.review.fail');
    expect(r.issues).toHaveLength(2);
    expect(r.blocking).toHaveLength(1);
    expect(r.blocking[0].priority).toBe('P0');
    if (!r.ok) expect(r.reason).toMatch(/1 blocking/);
  });

  // (4) Reviewer emitted unrelated text but no oa-review fenced block. The
  // gate must fail with a "no parseable oa-review" reason (substring stable
  // for the fix-loop synthesizer in 6.6) and EMPTY issue lists — we never
  // invent issues from a malformed reviewer.
  it('returns fail with "no parseable oa-review" reason when no block is present', async () => {
    const adapter = makeMockAdapter({
      stdoutBody: 'I read the diff but I am declining to emit a review block today.\n',
    });
    const r = await runReviewer({
      adapter,
      model: 'opus',
      extraArgs: [],
      promptPath,
      stepDiff: '',
      blockOn: ['P0', 'P1'],
      cwd: TMP_CWD,
      timeoutSec: 60,
      stdoutCapBytes: 1024,
      stdoutPath,
      stderrPath,
      signal,
    });
    expect(r.ok).toBe(false);
    expect(r.eventKind).toBe('step.verify.review.fail');
    expect(r.issues).toEqual([]);
    expect(r.blocking).toEqual([]);
    if (!r.ok) expect(r.reason).toMatch(/no parseable oa-review/);
  });

  // (5) Reviewer process itself failed (exitCode != 0, not killed). Distinct
  // event reason from the parse-fail and the killed-by paths so the run log
  // tells a human exactly which step in the chain went wrong.
  it('returns fail with "reviewer exited" reason when adapter exits non-zero', async () => {
    const adapter = makeMockAdapter({ exitCode: 1, stdoutBody: '' });
    const r = await runReviewer({
      adapter,
      model: 'opus',
      extraArgs: [],
      promptPath,
      stepDiff: '',
      blockOn: ['P0', 'P1'],
      cwd: TMP_CWD,
      timeoutSec: 60,
      stdoutCapBytes: 1024,
      stdoutPath,
      stderrPath,
      signal,
    });
    expect(r.ok).toBe(false);
    expect(r.eventKind).toBe('step.verify.review.fail');
    expect(r.issues).toEqual([]);
    expect(r.blocking).toEqual([]);
    if (!r.ok) expect(r.reason).toMatch(/reviewer exited 1/);
  });

  // (6) Reviewer was killed by the timeout backstop. Distinct from exit-nonzero:
  // exitCode is null, killedBy is 'timeout'. The reason carries the killer
  // tag verbatim so the supervisor can decide whether to retry with a longer
  // budget vs mark blocked.
  it('returns fail with "killed: timeout" reason when adapter hits timeout', async () => {
    const adapter = makeMockAdapter({
      exitCode: null,
      killedBy: 'timeout',
      stdoutBody: '',
    });
    const r = await runReviewer({
      adapter,
      model: 'opus',
      extraArgs: [],
      promptPath,
      stepDiff: '',
      blockOn: ['P0', 'P1'],
      cwd: TMP_CWD,
      timeoutSec: 60,
      stdoutCapBytes: 1024,
      stdoutPath,
      stderrPath,
      signal,
    });
    expect(r.ok).toBe(false);
    expect(r.eventKind).toBe('step.verify.review.fail');
    if (!r.ok) expect(r.reason).toMatch(/killed: timeout/);
  });

  // (7) Boundary contract: every path input must be absolute. The supervisor
  // assembles them from the worktree root, but defence-in-depth (mirroring
  // the spawn / verify-gate guards) stops a misuse from spawning the reviewer
  // under process.cwd().
  it('rejects relative cwd / promptPath / stdoutPath / stderrPath via assertAbs', async () => {
    const adapter = makeMockAdapter({ stdoutBody: '' });
    const baseOpts = {
      adapter,
      model: 'opus',
      extraArgs: [],
      stepDiff: '',
      blockOn: ['P0', 'P1'] as const,
      timeoutSec: 60,
      stdoutCapBytes: 1024,
      signal,
    };
    await expect(
      runReviewer({ ...baseOpts, promptPath: 'rel.md', cwd: TMP_CWD, stdoutPath, stderrPath }),
    ).rejects.toThrow(/non-absolute path/);
    await expect(
      runReviewer({ ...baseOpts, promptPath, cwd: 'rel/cwd', stdoutPath, stderrPath }),
    ).rejects.toThrow(/non-absolute path/);
    await expect(
      runReviewer({ ...baseOpts, promptPath, cwd: TMP_CWD, stdoutPath: 'rel.out', stderrPath }),
    ).rejects.toThrow(/non-absolute path/);
    await expect(
      runReviewer({ ...baseOpts, promptPath, cwd: TMP_CWD, stdoutPath, stderrPath: 'rel.err' }),
    ).rejects.toThrow(/non-absolute path/);
  });

  // (8) Prompt assembly contract: the file the adapter reads must include the
  // user-supplied template, the step diff, AND the oa-review protocol block
  // describing the expected fenced output format. We capture both the run
  // opts (to confirm the adapter was invoked with a TMP path under os.tmpdir,
  // not the original promptPath) and the file's text content (read inside the
  // mock before the gate's finally-cleanup unlinks it).
  it('assembles the reviewer prompt as template + diff + protocol block in a tmp file', async () => {
    const captured: { value?: AgentRunOpts } = {};
    const capturedText: { value?: string } = {};
    const templateText = 'TEMPLATE_MARKER_xyz: please review the following diff.';
    await fs.writeFile(promptPath, templateText, 'utf8');
    const diffText = 'DIFF_MARKER_abc\n--- a/foo\n+++ b/foo\n@@\n+hello\n';
    const adapter = makeMockAdapter({
      capturedRunOpts: captured,
      capturedPromptText: capturedText,
      stdoutBody: fence('oa-review', '{"issues":[]}'),
    });
    await runReviewer({
      adapter,
      model: 'opus',
      extraArgs: [],
      promptPath,
      stepDiff: diffText,
      blockOn: ['P0', 'P1'],
      cwd: TMP_CWD,
      timeoutSec: 60,
      stdoutCapBytes: 1024,
      stdoutPath,
      stderrPath,
      signal,
    });
    // Adapter was invoked with a TMP prompt path (under os.tmpdir), NOT the
    // original promptPath — the gate composes a fresh assembled prompt and
    // hands the temp file path to the adapter.
    expect(captured.value).toBeDefined();
    const usedPromptPath = captured.value!.promptPath;
    expect(path.isAbsolute(usedPromptPath)).toBe(true);
    expect(usedPromptPath.startsWith(os.tmpdir())).toBe(true);
    expect(usedPromptPath).not.toBe(promptPath);

    // Assembled text contains all three sections.
    const text = capturedText.value!;
    expect(text).toContain('TEMPLATE_MARKER_xyz');
    expect(text).toContain('DIFF_MARKER_abc');
    expect(text).toContain('oa-review');

    // Best-effort cleanup happened — the temp prompt file is unlinked after
    // the adapter returns.
    await expect(fs.access(usedPromptPath)).rejects.toThrow();
  });
});
