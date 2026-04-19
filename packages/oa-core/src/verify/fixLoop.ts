import type { OaReviewIssue } from '../schemas.js';

/**
 * Task 6.6 — Fix-loop synthesizer (v0 passthrough).
 *
 * The Phase 7 supervisor's inner loop consults this when the review gate
 * (Task 6.3) returns blocking issues AND `maxLoops` hasn't been exhausted.
 * The synthesized `FixContext` flows into the next iteration's per-step
 * context injector (Task 6.4) as `openReviewIssues`, which renders them under
 * the prompt's "Open review issues" section so the executor sees concrete
 * findings to fix.
 *
 * v0 is a literal passthrough: the issues list comes in, the issues list goes
 * out (defensive copy). The interface exists NOW so the supervisor wiring
 * lands against a stable shape, and richer summarization — deduplication,
 * priority-based sorting, issue clustering, synthesized remediation hints —
 * can land in future tasks without touching callers.
 *
 * Pure function, no I/O.
 */

export interface FixContext {
  /**
   * The blocking issues to surface to the next executor iteration. Owned by
   * the returned object — callers may mutate freely without affecting the
   * synthesizer's input, and vice versa (defensive copy).
   */
  openReviewIssues: OaReviewIssue[];
}

export function synthesizeFixContext(blockingIssues: OaReviewIssue[]): FixContext {
  // Spread (shallow copy) is sufficient: the supervisor only reads
  // `openReviewIssues.length` for the loop predicate and hands the array to
  // the context injector, which itself only reads each element. No nested
  // mutation path makes a deep copy load-bearing for v0.
  return { openReviewIssues: [...blockingIssues] };
}
