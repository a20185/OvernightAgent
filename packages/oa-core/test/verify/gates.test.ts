import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { simpleGit } from 'simple-git';
import { verifyTail, verifyCommit, verifyCmd } from '../../src/verify/gates.js';

// -----------------------------------------------------------------------------
// Task 6.2 — three pre-merge verify gates the supervisor (Phase 7) consults
// after every step run before deciding to advance / fix-loop / mark blocked.
//
// Contract is uniform across all three gates: each returns a tagged GateResult
//   { ok: true,  eventKind: 'step.verify.<gate>.ok',   detail?: ... }
//   { ok: false, eventKind: 'step.verify.<gate>.fail', reason: string, detail?: ... }
// so the supervisor's event emitter can shovel `eventKind` straight into the
// run log without a per-gate switch.
//
// The gates DO NOT themselves apply policy (e.g. "blocked status means human
// needed") — they just verify the protocol contract. Policy lives in Phase 7.
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// verifyTail
// -----------------------------------------------------------------------------

const bt = (n: number): string => '`'.repeat(n);
const fence = (kind: string, body: string): string => `${bt(3)}${kind}\n${body}\n${bt(3)}`;

describe('verifyTail', () => {
  // (1) Happy path: a valid oa-status block at the tail of stdout. detail
  // carries the parsed payload through verbatim so the supervisor doesn't
  // re-parse to read the summary/notes when emitting the event.
  it('returns ok with parsed status as detail when an oa-status block parses cleanly', () => {
    const stdout = `did the work\n${fence('oa-status', '{"status":"done","summary":"shipped"}')}\n`;
    const r = verifyTail(stdout);
    expect(r.ok).toBe(true);
    expect(r.eventKind).toBe('step.verify.tail.ok');
    if (r.ok) expect(r.detail).toEqual({ status: 'done', summary: 'shipped' });
  });

  // (2) Crucial semantic: status='blocked' is a tail-PASS. The tail gate
  // verifies the protocol contract (a parseable oa-status block exists); the
  // supervisor (Phase 7) decides what to do with `blocked`. If this gate
  // failed on `blocked`, the supervisor couldn't distinguish "agent didn't
  // emit a tail" from "agent reported needs-human" — both would surface as
  // tail.fail, conflating two very different failure modes.
  it('treats status="blocked" as a tail-PASS (gate verifies protocol, not status semantics)', () => {
    const stdout = fence('oa-status', '{"status":"blocked","summary":"need API key"}');
    const r = verifyTail(stdout);
    expect(r.ok).toBe(true);
    expect(r.eventKind).toBe('step.verify.tail.ok');
    if (r.ok) expect(r.detail).toEqual({ status: 'blocked', summary: 'need API key' });
  });

  // (3) Fail path: no oa-status block. We don't pin the exact reason wording
  // (parseTail owns that), only that the gate translates ok=false into a
  // tail.fail event with a non-empty reason for the supervisor to log.
  it('returns fail with eventKind step.verify.tail.fail when no oa-status block is present', () => {
    const r = verifyTail('agent did some work but never emitted a status block\n');
    expect(r.ok).toBe(false);
    expect(r.eventKind).toBe('step.verify.tail.fail');
    if (!r.ok) {
      expect(typeof r.reason).toBe('string');
      expect(r.reason.length).toBeGreaterThan(0);
    }
  });
});

// -----------------------------------------------------------------------------
// verifyCommit — temp-repo fixture mirrors worktree.test.ts's makeTempRepo so
// we exercise the real `commitsSince` against real git rev-list output rather
// than mocking it. Per-test repos keep state isolated.
// -----------------------------------------------------------------------------

async function makeTempRepo(): Promise<string> {
  const dir = path.resolve(os.tmpdir(), 'oa-gates-repo-' + Math.random().toString(36).slice(2));
  await fs.mkdir(dir, { recursive: true });
  const git = simpleGit(dir);
  await git.init({ '--initial-branch': 'main' });
  await git.addConfig('user.email', 'test@example.com');
  await git.addConfig('user.name', 'Test');
  await fs.writeFile(path.resolve(dir, 'README.md'), '# test\n');
  await git.add('README.md');
  await git.commit('initial');
  return dir;
}

describe('verifyCommit', () => {
  let TMP_REPO: string;

  beforeEach(async () => {
    TMP_REPO = await makeTempRepo();
  });

  afterEach(async () => {
    await fs.rm(TMP_REPO, { recursive: true, force: true });
  });

  // (4) Happy path: capture HEAD before the step "runs", make one commit, then
  // verify. The detail carries `count` so the supervisor can log how much
  // progress landed without re-shelling git.
  it('returns ok with count >= 1 when new commits exist since stepStartSha', async () => {
    const git = simpleGit(TMP_REPO);
    const stepStartSha = (await git.revparse(['HEAD'])).trim();
    await fs.writeFile(path.resolve(TMP_REPO, 'next.txt'), 'next', 'utf8');
    await git.add('next.txt');
    await git.commit('next commit');

    const r = await verifyCommit(TMP_REPO, stepStartSha);
    expect(r.ok).toBe(true);
    expect(r.eventKind).toBe('step.verify.commit.ok');
    if (r.ok) expect(r.detail).toEqual({ count: 1 });
  });

  // (5) Zero-commits case is the canonical failure mode: agent ran but
  // forgot/refused to commit. `no new commits` substring is part of the
  // contract — Phase 7's fix-loop synthesizer (Task 6.6) keys off it when
  // composing the corrective prompt ("you must commit before declaring done").
  it('returns fail with "no new commits" reason when no commits landed since stepStartSha', async () => {
    const git = simpleGit(TMP_REPO);
    const stepStartSha = (await git.revparse(['HEAD'])).trim();

    const r = await verifyCommit(TMP_REPO, stepStartSha);
    expect(r.ok).toBe(false);
    expect(r.eventKind).toBe('step.verify.commit.fail');
    if (!r.ok) expect(r.reason).toMatch(/no new commits/);
  });

  // (6) Boundary contract: absWorktree must be absolute. Mirrors the worktree
  // primitives' assertAbs guards so callers can't smuggle a CWD-relative path
  // past the gate.
  it('rejects relative absWorktree via assertAbs', async () => {
    await expect(verifyCommit('relative/repo', 'abc')).rejects.toThrow(/non-absolute path/);
  });
});

// -----------------------------------------------------------------------------
// verifyCmd — run user-provided shell strings (e.g. "pnpm test && pnpm lint")
// in the worktree. Per-test tmp dirs (no git needed) keep cwd assertions
// independent of repo state.
// -----------------------------------------------------------------------------

describe('verifyCmd', () => {
  let TMP_DIR: string;

  beforeEach(async () => {
    TMP_DIR = path.resolve(os.tmpdir(), 'oa-gates-cmd-' + Math.random().toString(36).slice(2));
    await fs.mkdir(TMP_DIR, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(TMP_DIR, { recursive: true, force: true });
  });

  // (7) Happy path: `true` exits 0 across every POSIX shell. detail.exitCode
  // is asserted so the supervisor's success log surfaces the same number an
  // operator would see running the command by hand.
  it('returns ok with exitCode 0 when the command exits cleanly', async () => {
    const r = await verifyCmd(TMP_DIR, 'true');
    expect(r.ok).toBe(true);
    expect(r.eventKind).toBe('step.verify.cmd.ok');
    if (r.ok) {
      expect((r.detail as { exitCode: number }).exitCode).toBe(0);
    }
  });

  // (8) Fail path: `false` exits 1. detail.exitCode is asserted to ensure the
  // supervisor's fail log includes the actual exit code (not just `non-zero`).
  it('returns fail with non-zero exitCode when the command exits non-zero', async () => {
    const r = await verifyCmd(TMP_DIR, 'false');
    expect(r.ok).toBe(false);
    expect(r.eventKind).toBe('step.verify.cmd.fail');
    if (!r.ok) {
      expect((r.detail as { exitCode: number }).exitCode).toBe(1);
      expect(r.reason).toMatch(/exit/);
    }
  });

  // (9) Stdout AND stderr must be captured separately so the fix-loop
  // synthesizer (Task 6.6) can compose a corrective prompt that includes the
  // failing-test stack trace (typically stderr) without dragging the entire
  // success log along. `shell: true` is also load-bearing here: the `&&`
  // would otherwise be passed as a literal arg.
  it('captures stdout and stderr separately for shell-form commands', async () => {
    const r = await verifyCmd(TMP_DIR, 'echo hello && echo bad >&2');
    expect(r.ok).toBe(true);
    if (r.ok) {
      const detail = r.detail as { stdout: string; stderr: string };
      expect(detail.stdout).toContain('hello');
      expect(detail.stderr).toContain('bad');
    }
  });

  // (10) Boundary contract symmetry with verifyCommit (test 6).
  it('rejects relative absWorktree via assertAbs', async () => {
    await expect(verifyCmd('relative/dir', 'true')).rejects.toThrow(/non-absolute path/);
  });

  // (11) cwd contract: the command must execute IN the given worktree, not in
  // the supervisor's cwd. `pwd` is the canonical witness. macOS's /tmp is a
  // symlink to /private/tmp, so the resolved tmpdir may have a /private prefix
  // — accept either the exact path or its /private-prefixed form.
  it('runs the command in the given absWorktree (cwd contract)', async () => {
    const r = await verifyCmd(TMP_DIR, 'pwd');
    expect(r.ok).toBe(true);
    if (r.ok) {
      const out = (r.detail as { stdout: string }).stdout.trim();
      // macOS: /tmp -> /private/tmp; either form is correct.
      const ok = out === TMP_DIR || out === path.resolve('/private', TMP_DIR.replace(/^\/+/, ''));
      expect(ok).toBe(true);
    }
  });
});
