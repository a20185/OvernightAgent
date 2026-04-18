import { describe, it, expect } from 'vitest';
import { assertId, newTaskId, newPlanId } from '../src/ids.js';

describe('assertId', () => {
  describe('positive cases', () => {
    it('accepts a generated taskId shape', () => {
      expect(() => assertId('t_2026-04-18_abcd')).not.toThrow();
    });
    it('accepts a generated planId shape', () => {
      expect(() => assertId('p_2026-04-18_abcd')).not.toThrow();
    });
    it('accepts the full character class A-Z a-z 0-9 _ . -', () => {
      expect(() => assertId('a.b-c_d')).not.toThrow();
      expect(() => assertId('ABC.def-123_xyz')).not.toThrow();
    });
    it('accepts ids that contain "." or ".." as a substring (only bare is rejected)', () => {
      expect(() => assertId('a.')).not.toThrow();
      expect(() => assertId('.a')).not.toThrow();
      expect(() => assertId('..a')).not.toThrow();
      expect(() => assertId('a..b')).not.toThrow();
    });
  });

  describe('negative cases', () => {
    it('rejects empty string', () => {
      expect(() => assertId('')).toThrow(/invalid id/);
    });
    it('rejects bare "."', () => {
      expect(() => assertId('.')).toThrow(/invalid id/);
    });
    it('rejects bare ".."', () => {
      expect(() => assertId('..')).toThrow(/invalid id/);
    });
    it('rejects ids containing "/"', () => {
      expect(() => assertId('a/b')).toThrow(/invalid id/);
    });
    it('rejects ids containing NUL byte', () => {
      expect(() => assertId('a\x00b')).toThrow(/invalid id/);
    });
    it('rejects ids containing space', () => {
      expect(() => assertId('a b')).toThrow(/invalid id/);
    });
    it('rejects absolute-path-looking ids', () => {
      expect(() => assertId('/etc/passwd')).toThrow(/invalid id/);
    });
    it('rejects backslash', () => {
      expect(() => assertId('a\\b')).toThrow(/invalid id/);
    });
  });
});

describe('newTaskId', () => {
  it('returns deterministic output when deps are injected', () => {
    const id = newTaskId({
      now: () => new Date('2026-04-18T12:34:56.000Z'),
      randomSuffix: () => 'abcd',
    });
    expect(id).toBe('t_2026-04-18_abcd');
  });

  it('default output matches the documented shape', () => {
    const id = newTaskId();
    expect(id).toMatch(/^t_\d{4}-\d{2}-\d{2}_[0-9a-z]{4}$/);
  });

  it('round-trips through assertId', () => {
    expect(() => assertId(newTaskId())).not.toThrow();
  });

  it('formats date in UTC, not local time', () => {
    // 2026-01-01T00:30:00Z is still 2026-01-01 in UTC even if local TZ is behind UTC.
    const id = newTaskId({
      now: () => new Date('2026-01-01T00:30:00.000Z'),
      randomSuffix: () => 'zzzz',
    });
    expect(id).toBe('t_2026-01-01_zzzz');
  });

  it('pads single-digit month and day', () => {
    const id = newTaskId({
      now: () => new Date('2026-03-05T12:00:00.000Z'),
      randomSuffix: () => '0000',
    });
    expect(id).toBe('t_2026-03-05_0000');
  });
});

describe('newPlanId', () => {
  it('returns deterministic output when deps are injected', () => {
    const id = newPlanId({
      now: () => new Date('2026-04-18T12:34:56.000Z'),
      randomSuffix: () => 'abcd',
    });
    expect(id).toBe('p_2026-04-18_abcd');
  });

  it('default output matches the documented shape', () => {
    const id = newPlanId();
    expect(id).toMatch(/^p_\d{4}-\d{2}-\d{2}_[0-9a-z]{4}$/);
  });

  it('round-trips through assertId', () => {
    expect(() => assertId(newPlanId())).not.toThrow();
  });
});

describe('default randomSuffix', () => {
  it('generates 4-character base36 suffixes', () => {
    // Sample many ids; every default suffix should be exactly 4 chars in [0-9a-z].
    for (let i = 0; i < 200; i++) {
      const id = newTaskId();
      const suffix = id.split('_')[2];
      expect(suffix).toMatch(/^[0-9a-z]{4}$/);
    }
  });

  it('produces some variety across calls (not all identical)', () => {
    const suffixes = new Set<string>();
    for (let i = 0; i < 50; i++) {
      suffixes.add(newTaskId().split('_')[2]);
    }
    // 50 draws from ~1.68M space — collisions are essentially impossible if
    // the source is actually random. Anything <2 means rng is broken.
    expect(suffixes.size).toBeGreaterThan(40);
  });
});
