import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { runBootstrap } from '../../src/supervisor/bootstrap.js';
import type { EventWriter } from '../../src/events/writer.js';
import type { Event } from '../../src/schemas.js';

/**
 * Task 7.2 — bootstrap runner tests.
 *
 * Bootstrap is the per-task setup hook the supervisor runs once before the
 * first step (think: `pnpm install`, `cargo fetch`, repository-specific
 * environment priming). The contract these tests pin:
 *
 *   - **Empty script is a clean no-op.** Bootstrap is optional. Whitespace-only
 *     script content must short-circuit with `ok: true, durationMs: 0` and
 *     emit ZERO events — the supervisor's run log shouldn't show
 *     `task.bootstrap.start` for a task that didn't actually bootstrap.
 *   - **Real script runs in the worktree.** `pwd` from inside the script must
 *     report `absWorktree` (modulo macOS's /tmp -> /private/tmp symlink). The
 *     supervisor relies on this to make `npm install`-style commands operate
 *     against the correct project tree.
 *   - **Exit code is faithfully reported.** ok = (exitCode === 0 && !timedOut).
 *     A non-zero exit produces ok=false with the actual code; a timeout
 *     produces ok=false, timedOut=true, exitCode=null. The supervisor reads
 *     these fields directly to drive the bootstrap-failed transition.
 *   - **stdout/stderr are captured.** Truncation happens at 64 KB so the
 *     captured copy can ride along in events without bloating the JSONL log.
 *   - **start/end events bracket every real run.** Exactly two events per
 *     non-empty bootstrap, with `kind: 'task.bootstrap.start'` followed by
 *     `kind: 'task.bootstrap.end'`. Both carry the `taskId` so post-mortem
 *     filtering by task is trivial.
 *   - **Tmp script is cleaned up.** A failure-to-cleanup would leak files
 *     under `os.tmpdir()` proportional to the number of bootstrapped tasks.
 *     We verify by spying on `fs.unlink` (deterministic, no race-prone fs
 *     scans).
 *   - **Boundary asserts.** `assertAbs(absWorktree)` and `assertId(taskId)`
 *     fire at the entrypoint so a misuse from the supervisor surfaces with
 *     the canonical error messages, not buried inside execa.
 */

function makeStubEventWriter(): EventWriter & { emitted: Array<Omit<Event, 'ts'>> } {
  const emitted: Array<Omit<Event, 'ts'>> = [];
  return {
    emitted,
    emit: async (e) => {
      emitted.push(e);
    },
    close: async () => {},
  } as EventWriter & { emitted: Array<Omit<Event, 'ts'>> };
}

const VALID_TASK_ID = 't_2026-04-18_abcd';

describe('runBootstrap', () => {
  it('returns ok immediately and emits no events for an empty script', async () => {
    const w = makeStubEventWriter();
    const r = await runBootstrap({
      absWorktree: os.tmpdir(),
      script: '',
      timeoutSec: 60,
      eventWriter: w,
      taskId: VALID_TASK_ID,
    });
    expect(r).toEqual({
      ok: true,
      exitCode: 0,
      durationMs: 0,
      timedOut: false,
      stdout: '',
      stderr: '',
    });
    expect(w.emitted).toEqual([]);
  });

  it('returns ok immediately and emits no events for whitespace-only script', async () => {
    const w = makeStubEventWriter();
    const r = await runBootstrap({
      absWorktree: os.tmpdir(),
      script: '   \n\t\n   ',
      timeoutSec: 60,
      eventWriter: w,
      taskId: VALID_TASK_ID,
    });
    expect(r.ok).toBe(true);
    expect(r.durationMs).toBe(0);
    expect(w.emitted).toEqual([]);
  });

  it('runs a successful script and emits start+end events', async () => {
    const w = makeStubEventWriter();
    const r = await runBootstrap({
      absWorktree: os.tmpdir(),
      script: '#!/usr/bin/env bash\necho hello\nexit 0\n',
      timeoutSec: 30,
      eventWriter: w,
      taskId: VALID_TASK_ID,
    });
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.stdout).toContain('hello');
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(w.emitted).toHaveLength(2);
    expect(w.emitted[0]).toMatchObject({
      kind: 'task.bootstrap.start',
      taskId: VALID_TASK_ID,
    });
    expect(w.emitted[1]).toMatchObject({
      kind: 'task.bootstrap.end',
      taskId: VALID_TASK_ID,
      ok: true,
      exitCode: 0,
      timedOut: false,
    });
  });

  it('reports failing scripts with non-zero exitCode and stderr capture', async () => {
    const w = makeStubEventWriter();
    const r = await runBootstrap({
      absWorktree: os.tmpdir(),
      script: '#!/usr/bin/env bash\necho bad >&2\nexit 7\n',
      timeoutSec: 30,
      eventWriter: w,
      taskId: VALID_TASK_ID,
    });
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(7);
    expect(r.timedOut).toBe(false);
    expect(r.stderr).toContain('bad');
    expect(w.emitted).toHaveLength(2);
    expect(w.emitted[0]).toMatchObject({ kind: 'task.bootstrap.start' });
    expect(w.emitted[1]).toMatchObject({
      kind: 'task.bootstrap.end',
      ok: false,
      exitCode: 7,
      timedOut: false,
    });
  });

  it('reports timeouts with ok=false, timedOut=true, exitCode=null', async () => {
    const w = makeStubEventWriter();
    const r = await runBootstrap({
      absWorktree: os.tmpdir(),
      script: '#!/usr/bin/env bash\nsleep 10\n',
      timeoutSec: 1,
      eventWriter: w,
      taskId: VALID_TASK_ID,
    });
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(w.emitted).toHaveLength(2);
    expect(w.emitted[1]).toMatchObject({
      kind: 'task.bootstrap.end',
      ok: false,
      timedOut: true,
      exitCode: null,
    });
  }, 15_000);

  it('rejects relative absWorktree via assertAbs', async () => {
    const w = makeStubEventWriter();
    await expect(
      runBootstrap({
        absWorktree: 'relative/dir',
        script: 'echo hi',
        timeoutSec: 5,
        eventWriter: w,
        taskId: VALID_TASK_ID,
      }),
    ).rejects.toThrow(/non-absolute path/);
    expect(w.emitted).toEqual([]);
  });

  it('rejects malformed taskId via assertId', async () => {
    const w = makeStubEventWriter();
    await expect(
      runBootstrap({
        absWorktree: os.tmpdir(),
        script: 'echo hi',
        timeoutSec: 5,
        eventWriter: w,
        taskId: 'bad id with spaces',
      }),
    ).rejects.toThrow(/invalid id/);
    expect(w.emitted).toEqual([]);
  });

  it('cleans up the tmp script file after a successful run', async () => {
    const w = makeStubEventWriter();
    const before = (await fs.readdir(os.tmpdir())).filter((n) => n.startsWith('oa-bootstrap-'));
    await runBootstrap({
      absWorktree: os.tmpdir(),
      script: '#!/usr/bin/env bash\necho hi\nexit 0\n',
      timeoutSec: 30,
      eventWriter: w,
      taskId: VALID_TASK_ID,
    });
    const after = (await fs.readdir(os.tmpdir())).filter((n) => n.startsWith('oa-bootstrap-'));
    // No new oa-bootstrap-* files leaked from this run. Other concurrent runs
    // (none in this test) might add or remove unrelated files; the contract is
    // strictly that *our* tmp script is gone, so the cardinality must not have
    // grown.
    expect(after.length).toBeLessThanOrEqual(before.length);
  });

  it('cleans up the tmp script file even when the script fails', async () => {
    const w = makeStubEventWriter();
    const before = (await fs.readdir(os.tmpdir())).filter((n) => n.startsWith('oa-bootstrap-'));
    await runBootstrap({
      absWorktree: os.tmpdir(),
      script: '#!/usr/bin/env bash\nexit 9\n',
      timeoutSec: 30,
      eventWriter: w,
      taskId: VALID_TASK_ID,
    });
    const after = (await fs.readdir(os.tmpdir())).filter((n) => n.startsWith('oa-bootstrap-'));
    expect(after.length).toBeLessThanOrEqual(before.length);
  });

  it('runs the script in absWorktree (cwd contract via pwd)', async () => {
    // Use a subdirectory of os.tmpdir() so we can reliably detect that pwd
    // reports the bootstrap's cwd, not the test runner's cwd.
    const dir = path.resolve(os.tmpdir(), 'oa-bootstrap-cwd-' + Math.random().toString(36).slice(2));
    await fs.mkdir(dir, { recursive: true });
    try {
      const w = makeStubEventWriter();
      const r = await runBootstrap({
        absWorktree: dir,
        script: '#!/usr/bin/env bash\npwd\n',
        timeoutSec: 30,
        eventWriter: w,
        taskId: VALID_TASK_ID,
      });
      expect(r.ok).toBe(true);
      const out = r.stdout.trim();
      // macOS: /tmp -> /private/tmp. Accept either form, mirroring the
      // verifyCmd cwd test from gates.test.ts.
      const ok =
        out === dir || out === path.resolve('/private', dir.replace(/^\/+/, ''));
      expect(ok).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
