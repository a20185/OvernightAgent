import { describe, it, expect } from 'vitest';
import { slug } from '../src/slug.js';

describe('slug', () => {
  describe('normal ASCII input', () => {
    it('lowercases and replaces non-alnum with "-"', () => {
      expect(slug('Hello World!')).toBe('hello-world');
    });

    it('preserves alphanumerics untouched', () => {
      expect(slug('abc123')).toBe('abc123');
    });

    it('lowercases uppercase letters', () => {
      expect(slug('ABCdef')).toBe('abcdef');
    });
  });

  describe('collapsing consecutive separators', () => {
    it('collapses runs of spaces into a single "-"', () => {
      expect(slug('a   b   c')).toBe('a-b-c');
    });

    it('collapses mixed non-alnum runs into a single "-"', () => {
      expect(slug('a!!!b???c')).toBe('a-b-c');
    });

    it('collapses pre-existing runs of dashes', () => {
      expect(slug('a---b---c')).toBe('a-b-c');
    });
  });

  describe('trimming', () => {
    it('trims leading and trailing "-"', () => {
      expect(slug('-a-b-')).toBe('a-b');
    });

    it('trims leading/trailing non-alnum generally', () => {
      expect(slug('!!!hello!!!')).toBe('hello');
    });
  });

  describe('edge cases', () => {
    it('returns "" for empty input', () => {
      expect(slug('')).toBe('');
    });

    it('returns "" for all-symbols input', () => {
      expect(slug('!!!###$$$')).toBe('');
    });

    it('returns "" for whitespace-only input', () => {
      expect(slug('   \t\n  ')).toBe('');
    });
  });

  describe('length cap', () => {
    it('caps output at 32 characters for a 50-char alphanumeric input', () => {
      const input = 'a'.repeat(50);
      const out = slug(input);
      expect(out.length).toBe(32);
      expect(out).toBe('a'.repeat(32));
    });

    it('does not leave a trailing "-" when cap lands on a separator', () => {
      // 32 a's followed by a separator: raw kebab is "aaa...aaa-b", and slicing
      // at 32 would give "aaa...aaa-" — the trim must remove that trailing dash.
      const input = 'a'.repeat(32) + '-b';
      const out = slug(input);
      expect(out.length).toBeLessThanOrEqual(32);
      expect(out.endsWith('-')).toBe(false);
      expect(out).toBe('a'.repeat(32));
    });

    it('handles the edge where a multi-word input caps mid-separator', () => {
      // "word-" repeating: "word-word-word-word-word-word-word-" (35 chars).
      // Cap at 32 → "word-word-word-word-word-word-wo" (ends with letter — fine).
      // But input "w-" repeated 20x → "w-w-w-..." capping is a better stress test.
      const input = ('w-'.repeat(20)).replace(/-$/, ''); // "w-w-w-...-w" (39 chars)
      const out = slug(input);
      expect(out.length).toBeLessThanOrEqual(32);
      expect(out.endsWith('-')).toBe(false);
      expect(out.startsWith('-')).toBe(false);
    });
  });

  describe('Unicode handling (ASCII-only via NFKD normalization)', () => {
    // Design decision: we NFKD-normalize the input and strip combining
    // diacritical marks (U+0300–U+036F), then the main regex replaces any
    // remaining non-ASCII character with "-". This yields user-friendly slugs
    // for accented Latin letters while still being safe for git branch names.
    it('strips diacritics from accented Latin letters', () => {
      expect(slug('héllo wörld')).toBe('hello-world');
    });

    it('strips diacritics in common words', () => {
      expect(slug('café')).toBe('cafe');
      expect(slug('naïve résumé')).toBe('naive-resume');
    });

    it('replaces non-Latin characters with "-" (and collapses/trims)', () => {
      // Chinese characters aren't representable in ASCII; they become "-".
      expect(slug('hello 世界')).toBe('hello');
      expect(slug('世界 hello 世界')).toBe('hello');
    });

    it('is pure — repeated calls yield the same output', () => {
      const input = 'Héllo Wörld!!!';
      expect(slug(input)).toBe(slug(input));
    });
  });

  describe('git refname component safety', () => {
    // After slug(), output must be either '' (caller falls back to 'untitled')
    // or a non-empty string of [a-z0-9] chars separated by single '-', with no
    // leading/trailing '-'. This is a strict subset of git's refname-component
    // rules, so concatenating as `oa/<slug>-<shortid>` is always git-safe
    // (provided the empty case is handled by the caller per slug.ts header).
    const REFNAME_SAFE = /^([a-z0-9]+(-[a-z0-9]+)*)?$/;

    const fuzzInputs = [
      '',
      '...',
      '@{',
      '.lock',
      '-leading',
      'trailing-',
      'a',
      'a   '.repeat(20), // long whitespace runs
      'héllo wörld',
      'hello 世界 emoji 🚀',
      '\u200d', // zero-width joiner alone
      'a\u200db', // ZWJ between letters
      '../../etc/passwd',
      'feat: add /something with @{ref} and ~stuff^~?:*[',
      '!@#$%^&*()',
      'CamelCaseWithCAPS',
      'a'.repeat(64), // exceeds cap
      'snake_case_name',
      'kebab-case-name',
      'mixed.dots.and-dashes_and spaces',
    ];

    for (const input of fuzzInputs) {
      it(`slug(${JSON.stringify(input).slice(0, 40)}) is refname-safe`, () => {
        const out = slug(input);
        expect(out).toMatch(REFNAME_SAFE);
        expect(out.length).toBeLessThanOrEqual(32);
      });
    }
  });
});
