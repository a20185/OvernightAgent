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
