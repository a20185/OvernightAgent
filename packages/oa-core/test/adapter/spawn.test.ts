import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnHeadless } from '../../src/adapter/spawn.js';

// -----------------------------------------------------------------------------
// Integration tests for the low-level spawn primitive. We use `process.execPath`
// (the running Node binary) as the spawn target so the suite is portable across
// hosts: no PATH lookups, no global node, no shell. Each test gets its own
// tmpdir for stdout/stderr capture files so concurrent runs don't collide and
// teardown is a single rm -rf.
//
// Timing assertions are kept loose (`> 0`, ranges with generous slack) because
// CI machines have unpredictable scheduling jitter; the only thing we strictly
// assert about durations is "the process actually ran" and "it stopped near the
// deadline" — never "took exactly N ms".
// -----------------------------------------------------------------------------

let TMP: string;

beforeEach(async () => {
  TMP = path.resolve(os.tmpdir(), 'oa-test-spawn-' + Math.random().toString(36).slice(2));
  await fs.mkdir(TMP, { recursive: true });
});

afterEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

function paths(): { stdoutPath: string; stderrPath: string } {
  return {
    stdoutPath: path.resolve(TMP, 'stdout.log'),
    stderrPath: path.resolve(TMP, 'stderr.log'),
  };
}

describe('spawnHeadless', () => {
  it('captures stdout, returns exitCode 0 on a normal exit', async () => {
    const { stdoutPath, stderrPath } = paths();
    const ac = new AbortController();
    const result = await spawnHeadless({
      command: process.execPath,
      args: ['-e', "console.log('hi'); process.exit(0)"],
      cwd: TMP,
      timeoutSec: 10,
      stdoutCapBytes: 1_000_000,
      stdoutPath,
      stderrPath,
      signal: ac.signal,
    });
    expect(result.exitCode).toBe(0);
    expect(result.killedBy).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.stdoutCapHit).toBe(false);
    expect(result.durationMs).toBeGreaterThan(0);
    expect(result.sessionId).toBeUndefined();
    const captured = await fs.readFile(stdoutPath, 'utf8');
    expect(captured).toBe('hi\n');
  });

  it('returns the actual non-zero exit code on natural exit', async () => {
    const { stdoutPath, stderrPath } = paths();
    const ac = new AbortController();
    const result = await spawnHeadless({
      command: process.execPath,
      args: ['-e', 'process.exit(7)'],
      cwd: TMP,
      timeoutSec: 10,
      stdoutCapBytes: 1_000_000,
      stdoutPath,
      stderrPath,
      signal: ac.signal,
    });
    expect(result.exitCode).toBe(7);
    expect(result.killedBy).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.stdoutCapHit).toBe(false);
  });

  it('kills with SIGTERM/SIGKILL and reports timeout when timeoutSec elapses', async () => {
    const { stdoutPath, stderrPath } = paths();
    const ac = new AbortController();
    const start = Date.now();
    const result = await spawnHeadless({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: TMP,
      timeoutSec: 1,
      stdoutCapBytes: 1_000_000,
      stdoutPath,
      stderrPath,
      signal: ac.signal,
    });
    const elapsed = Date.now() - start;
    expect(result.timedOut).toBe(true);
    expect(result.killedBy).toBe('timeout');
    expect(result.exitCode).toBeNull();
    expect(result.stdoutCapHit).toBe(false);
    // Should be ~1000ms; allow generous slack for CI scheduling + SIGKILL grace.
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(5000);
    expect(result.durationMs).toBeGreaterThanOrEqual(900);
  });

  it('kills the process and reports stdoutCap when the byte cap is reached', async () => {
    const { stdoutPath, stderrPath } = paths();
    const ac = new AbortController();
    // Tight cap (5000 bytes) + heavy writer (1000 bytes every 10ms) → cap hits
    // within ~50ms. Some overshoot expected because we kill mid-chunk and the
    // child may flush a few more buffers before SIGKILL lands.
    const result = await spawnHeadless({
      command: process.execPath,
      args: [
        '-e',
        "setInterval(() => process.stdout.write('x'.repeat(1000)), 10)",
      ],
      cwd: TMP,
      timeoutSec: 30,
      stdoutCapBytes: 5_000,
      stdoutPath,
      stderrPath,
      signal: ac.signal,
    });
    expect(result.stdoutCapHit).toBe(true);
    expect(result.killedBy).toBe('stdoutCap');
    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(false);
    const stat = await fs.stat(stdoutPath);
    // Some overshoot is acceptable due to stream chunking. We assert it's at
    // least the cap (proves the writer ran past the threshold) and not wildly
    // larger (proves we killed before it ran for a full 30s).
    expect(stat.size).toBeGreaterThanOrEqual(5_000);
    expect(stat.size).toBeLessThan(500_000);
  });

  it('kills the process and reports signal when AbortSignal fires', async () => {
    const { stdoutPath, stderrPath } = paths();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const result = await spawnHeadless({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: TMP,
      timeoutSec: 30,
      stdoutCapBytes: 1_000_000,
      stdoutPath,
      stderrPath,
      signal: ac.signal,
    });
    expect(result.killedBy).toBe('signal');
    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.stdoutCapHit).toBe(false);
  });

  it('rejects relative cwd / stdoutPath / stderrPath via assertAbs', async () => {
    const { stdoutPath, stderrPath } = paths();
    const ac = new AbortController();
    const base = {
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      timeoutSec: 5,
      stdoutCapBytes: 1_000,
      signal: ac.signal,
    } as const;
    await expect(
      spawnHeadless({ ...base, cwd: 'rel/cwd', stdoutPath, stderrPath }),
    ).rejects.toThrow(/non-absolute/);
    await expect(
      spawnHeadless({ ...base, cwd: TMP, stdoutPath: 'rel/stdout.log', stderrPath }),
    ).rejects.toThrow(/non-absolute/);
    await expect(
      spawnHeadless({ ...base, cwd: TMP, stdoutPath, stderrPath: 'rel/stderr.log' }),
    ).rejects.toThrow(/non-absolute/);
  });
});
