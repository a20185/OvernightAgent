import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  assertAbs,
  oaHome,
  taskDir,
  runDir,
  worktreeDir,
  pidfile,
  socketPath,
} from '../src/paths.js';

describe('assertAbs', () => {
  it('throws on relative path', () => {
    expect(() => assertAbs('a/b')).toThrow(/non-absolute path/);
  });
  it('accepts absolute path', () => {
    expect(() => assertAbs('/a/b')).not.toThrow();
  });
  it('throws on empty string', () => {
    expect(() => assertAbs('')).toThrow(/non-absolute path/);
  });
});

describe('oaHome', () => {
  const ORIG = process.env.OA_HOME;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.OA_HOME;
    else process.env.OA_HOME = ORIG;
  });
  it('returns OA_HOME when set', () => {
    process.env.OA_HOME = '/tmp/oa-custom';
    expect(oaHome()).toBe('/tmp/oa-custom');
  });
  it('falls back to ~/.config/overnight-agent when unset', () => {
    delete process.env.OA_HOME;
    expect(oaHome()).toBe(path.resolve(os.homedir(), '.config/overnight-agent'));
  });
  it('always returns absolute path', () => {
    expect(path.isAbsolute(oaHome())).toBe(true);
  });
});

describe('per-id path helpers', () => {
  beforeEach(() => {
    process.env.OA_HOME = '/tmp/oa';
  });
  afterEach(() => {
    delete process.env.OA_HOME;
  });

  it('taskDir is <oaHome>/tasks/<id> and absolute', () => {
    expect(taskDir('t_1')).toBe('/tmp/oa/tasks/t_1');
    expect(path.isAbsolute(taskDir('t_1'))).toBe(true);
  });
  it('runDir is <oaHome>/runs/<id> and absolute', () => {
    expect(runDir('p_1')).toBe('/tmp/oa/runs/p_1');
  });
  it('worktreeDir is <oaHome>/worktrees/<id> and absolute', () => {
    expect(worktreeDir('t_1')).toBe('/tmp/oa/worktrees/t_1');
  });
  it('pidfile is <runDir>/oa.pid', () => {
    expect(pidfile('p_1')).toBe('/tmp/oa/runs/p_1/oa.pid');
  });
  it('socketPath is <runDir>/oa.sock', () => {
    expect(socketPath('p_1')).toBe('/tmp/oa/runs/p_1/oa.sock');
  });
});

// Regression: every per-id path helper must reject malformed ids before
// constructing a filesystem path. Without `assertId(...)` at the top of each
// helper, an attacker (or a buggy caller) could pass `..`, `/etc/passwd`,
// `a/b`, or `a\x00b` and escape `<oaHome>` via `path.resolve`'s normalization
// or NUL-byte truncation in syscalls. Carry-forward from Task 1.1 + 1.5
// reviews; see Task 1.6.
describe('per-id path helpers reject malformed ids (assertId guard)', () => {
  beforeEach(() => {
    process.env.OA_HOME = '/tmp/oa';
  });
  afterEach(() => {
    delete process.env.OA_HOME;
  });

  const badIds: ReadonlyArray<readonly [string, string]> = [
    ['/etc/passwd', 'absolute escape'],
    ['..', 'parent traversal'],
    ['a/b', 'embedded slash'],
    ['a\x00b', 'NUL byte'],
  ];

  for (const [badId, label] of badIds) {
    it(`taskDir rejects ${label} (${JSON.stringify(badId)})`, () => {
      expect(() => taskDir(badId)).toThrow(/invalid id/);
    });
    it(`runDir rejects ${label} (${JSON.stringify(badId)})`, () => {
      expect(() => runDir(badId)).toThrow(/invalid id/);
    });
    it(`worktreeDir rejects ${label} (${JSON.stringify(badId)})`, () => {
      expect(() => worktreeDir(badId)).toThrow(/invalid id/);
    });
    it(`pidfile rejects ${label} (${JSON.stringify(badId)})`, () => {
      expect(() => pidfile(badId)).toThrow(/invalid id/);
    });
    it(`socketPath rejects ${label} (${JSON.stringify(badId)})`, () => {
      expect(() => socketPath(badId)).toThrow(/invalid id/);
    });
  }
});
