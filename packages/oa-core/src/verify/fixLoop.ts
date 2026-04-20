import type { OaReviewIssue } from '../schemas.js';

/**
 * Task 6.6 — Fix-loop synthesizer + Task 3.3 stall warning (ADR-0015).
 *
 * The Phase 7 supervisor's inner loop consults this when the review gate
 * (Task 6.3) returns blocking issues AND `maxLoops` hasn't been exhausted.
 * The synthesized `FixContext` flows into the next iteration's per-step
 * context injector (Task 6.4) as `openReviewIssues`, which renders them under
 * the prompt's "Open review issues" section so the executor sees concrete
 * findings to fix.
 *
 * Task 3.3 adds stall-warning injection: when `attempt >= thresholds.soft`, a
 * P0 block is prepended to `blocks` to signal the executor that the current
 * approach may need to change materially before the hard limit is reached.
 *
 * Pure function, no I/O.
 */

/** A single context block — either a stall-warning or a review-issue summary. */
export interface FixContextBlock {
  kind: 'stall-warning' | 'review-issue';
  priority: 'P0' | 'P1' | 'P2';
  text: string;
}

export interface FixContext {
  /**
   * The blocking issues to surface to the next executor iteration. Owned by
   * the returned object — callers may mutate freely without affecting the
   * synthesizer's input, and vice versa (defensive copy).
   */
  openReviewIssues: OaReviewIssue[];

  /**
   * Ordered context blocks for the prompt. May contain a stall-warning block
   * (prepended when attempt >= soft threshold) followed by per-issue blocks.
   * Task 3.3 (ADR-0015).
   */
  blocks: FixContextBlock[];
}

export interface SynthesizeFixContextOpts {
  /** Current attempt number (1-based). */
  attempt: number;
  /** Resolved soft/hard thresholds from VerifyConfig.attempts. */
  thresholds: { soft: number; hard: number };
  /** Blocking issues from the reviewer. */
  issues: OaReviewIssue[];
}

export function synthesizeFixContext(opts: SynthesizeFixContextOpts): FixContext {
  const blocks: FixContextBlock[] = [];

  // Task 3.3: inject a P0 stall warning when attempt >= soft threshold.
  if (opts.attempt >= opts.thresholds.soft) {
    blocks.push({
      kind: 'stall-warning',
      priority: 'P0',
      text:
        `STALL WARNING: this is attempt ${String(opts.attempt)} of ${String(opts.thresholds.hard)}. ` +
        `${String(opts.thresholds.hard - opts.attempt)} attempts remain before the step is marked BLOCKED. ` +
        `If the prior strategy isn't working, change approach materially.`,
    });
  }

  // Spread (shallow copy) is sufficient: the supervisor only reads
  // `openReviewIssues.length` for the loop predicate and hands the array to
  // the context injector, which itself only reads each element. No nested
  // mutation path makes a deep copy load-bearing for v0.
  return { openReviewIssues: [...opts.issues], blocks };
}
