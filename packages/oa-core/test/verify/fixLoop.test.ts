import { describe, it, expect } from 'vitest';
import type { OaReviewIssue } from '../../src/schemas.js';
import { synthesizeFixContext } from '../../src/verify/fixLoop.js';

// -----------------------------------------------------------------------------
// Task 6.6 — Fix-loop synthesizer (v0 passthrough) + Task 3.3 stall warning.
//
// The Phase 7 supervisor calls `synthesizeFixContext(opts)` when the review
// gate (Task 6.3) returns blocking issues AND maxLoops hasn't been exhausted.
// The result feeds the next iteration's context injector (Task 6.4) as
// `openReviewIssues`. v0 is a literal passthrough — the surface exists so
// future tasks can layer richer summarization (deduplication, priority sort,
// issue clustering, synthesized remediation hints) without requiring callers
// to change shape.
//
// Task 3.3 adds stall-warning injection: when attempt >= soft threshold, a P0
// block is prepended to the `blocks` array to signal the executor that the
// current strategy may need to change materially.
//
// Tests pin the properties the supervisor relies on:
//   - empty in → empty out (loop exit predicate works on `length`),
//   - non-empty in → same issues, same order (priority stays meaningful),
//   - returned array is a fresh reference (defensive copy),
//   - stall warning injected when attempt >= soft threshold,
//   - no stall warning when attempt < soft threshold.
// -----------------------------------------------------------------------------

/** Default thresholds used across most tests. */
const THRESHOLDS = { soft: 3, hard: 5 };

describe('synthesizeFixContext', () => {
  it('returns empty openReviewIssues when given an empty array', () => {
    const result = synthesizeFixContext({ attempt: 1, thresholds: THRESHOLDS, issues: [] });
    expect(result.openReviewIssues).toEqual([]);
  });

  it('returns the same issues in the same order when given a non-empty array', () => {
    const issues: OaReviewIssue[] = [
      { priority: 'P0', file: 'a.ts', line: 10, finding: 'null deref', suggestion: 'add guard' },
      { priority: 'P1', file: 'b.ts', finding: 'missing await' },
      { priority: 'P2', file: 'c.ts', finding: 'rename helper' },
    ];
    const result = synthesizeFixContext({ attempt: 1, thresholds: THRESHOLDS, issues });
    expect(result.openReviewIssues).toEqual(issues);
    expect(result.openReviewIssues).toHaveLength(3);
    expect(result.openReviewIssues[0].priority).toBe('P0');
    expect(result.openReviewIssues[1].priority).toBe('P1');
    expect(result.openReviewIssues[2].priority).toBe('P2');
  });

  it('returns a defensive copy — mutating either side does not affect the other', () => {
    const issues: OaReviewIssue[] = [
      { priority: 'P0', file: 'a.ts', finding: 'first' },
      { priority: 'P1', file: 'b.ts', finding: 'second' },
    ];
    const result = synthesizeFixContext({ attempt: 1, thresholds: THRESHOLDS, issues });

    // Different reference: the synthesizer owns the returned array, so future
    // versions can sort/dedupe in place without surprising the caller.
    expect(result.openReviewIssues).not.toBe(issues);

    // Mutating the returned array does NOT affect the caller's input.
    result.openReviewIssues.push({ priority: 'P2', file: 'c.ts', finding: 'third' });
    expect(issues).toHaveLength(2);

    // Mutating the input array does NOT affect the previously-returned result.
    issues.push({ priority: 'P0', file: 'd.ts', finding: 'fourth' });
    // result currently has 3 entries (the original 2 + the push above) — the
    // input's growth to length 3 must not bleed in.
    expect(result.openReviewIssues).toHaveLength(3);
    expect(result.openReviewIssues.map((i) => i.file)).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  // -- Task 3.3: stall-warning injection ----------------------------------------

  it('prepends a P0 stall warning when attempt >= soft', () => {
    const ctx = synthesizeFixContext({
      attempt: 3, thresholds: { soft: 3, hard: 5 },
      issues: [{ priority: 'P1', file: 'x.ts', finding: 'y' }],
    });
    expect(ctx.blocks[0]!.kind).toBe('stall-warning');
    expect(ctx.blocks[0]!.priority).toBe('P0');
    expect(ctx.blocks[0]!.text).toMatch(/STALL WARNING/);
    expect(ctx.blocks[0]!.text).toMatch(/attempt 3.*5/);
  });

  it('does not inject a stall warning when attempt < soft', () => {
    const ctx = synthesizeFixContext({
      attempt: 2, thresholds: { soft: 3, hard: 5 }, issues: [],
    });
    expect(ctx.blocks.find((b) => b.kind === 'stall-warning')).toBeUndefined();
  });
});
