/**
 * parseTopLevelSteps — line-based scanner that splits a Markdown plan into
 * top-level steps. Pure function (no I/O, no async). The grammar is small:
 *
 *  - A "top-level item" begins at column 0 (no leading whitespace) and is
 *    either a checkbox bullet (`- [ ]`, `- [x]`, `* [ ]`, `* [x]`,
 *    case-insensitive on the `x`) or a numbered item (`1.`, `42.`, etc.).
 *  - Each step's `spec` is its first line PLUS every following line up to
 *    (but not including) the next top-level item. Indented sub-bullets,
 *    indented prose, blank lines, and code fences all attach to the parent.
 *  - Code fences (lines starting with ```) are tracked so a `- [ ]` *inside*
 *    a fenced block does NOT start a new step.
 *
 * This is the front door for `oa intake submit` (Phase 4.4 widens these
 * `ParsedStep`s into the full `Step` schema by adding verify/expectedOutputs
 * during the Q&A pass). It deliberately does NOT depend on a markdown
 * library — the surface is small enough to hand-roll, and pulling in a
 * full CommonMark parser would be far heavier than the contract requires.
 */

export interface ParsedStep {
  /** 1-indexed position in the plan. */
  n: number;
  /** The item line minus the marker (`- [ ]` / `1.` prefix stripped). */
  title: string;
  /**
   * Full markdown block for the step: the original first line (marker
   * INCLUDED) plus every following non-top-level line, with trailing
   * whitespace trimmed off the joined block.
   */
  spec: string;
}

export interface ParseResult {
  steps: ParsedStep[];
  warnings: string[];
}

// Top-level only: anchored at column 0, no leading whitespace.
const CHECKBOX = /^[-*]\s+\[[ xX]\]\s+(.*)$/;
const NUMBERED = /^(\d+)\.\s+(.*)$/;
const HEADING = /^#{1,6}\s+/;
// A code fence opens/closes on any line whose first non-whitespace run is
// three or more backticks. We match leniently because indented fences inside
// a step still need to flip the in-fence state for the *content* scan.
const CODE_FENCE = /^\s*```/;

const WARN_NO_STEPS =
  'no top-level steps found — use "- [ ] step" or "1. step" at the top of the plan';
const WARN_MIXED_MARKERS =
  'mixed top-level markers (checkbox and numbered) — pick one style for clarity';
const WARN_HEADINGS_PRESENT =
  'mixed: top-level headings present alongside checkbox/numbered items — headings are NOT parsed as steps; they are treated as content';

interface PartialStep {
  title: string;
  lines: string[];
}

export function parseTopLevelSteps(md: string): ParseResult {
  const lines = md.split('\n');
  const warnings: string[] = [];

  // --- Pre-scan: detect marker mix and stray top-level headings -------------
  // We do this in a separate pass so the warning logic stays independent of
  // the step-collection state machine. Code fences are still respected so a
  // `# heading` inside a fence doesn't trip the heading warning.
  let hasCheckbox = false;
  let hasNumbered = false;
  let hasHeading = false;
  let inFence = false;
  for (const line of lines) {
    if (CODE_FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (CHECKBOX.test(line)) hasCheckbox = true;
    else if (NUMBERED.test(line)) hasNumbered = true;
    else if (HEADING.test(line)) hasHeading = true;
  }

  if (hasCheckbox && hasNumbered) warnings.push(WARN_MIXED_MARKERS);
  if ((hasCheckbox || hasNumbered) && hasHeading) warnings.push(WARN_HEADINGS_PRESENT);

  // --- Main scan: collect steps --------------------------------------------
  const steps: ParsedStep[] = [];
  let current: PartialStep | null = null;
  inFence = false;

  const flush = (s: PartialStep): void => {
    steps.push({
      n: steps.length + 1,
      title: s.title,
      spec: s.lines.join('\n').replace(/\s+$/, ''),
    });
  };

  for (const line of lines) {
    if (CODE_FENCE.test(line)) {
      inFence = !inFence;
      if (current) current.lines.push(line);
      // Lines inside a pre-step preamble fence are simply discarded — we
      // have no step to attach them to, and the contract says preamble is
      // ignored.
      continue;
    }
    if (inFence) {
      if (current) current.lines.push(line);
      continue;
    }

    const checkboxMatch = line.match(CHECKBOX);
    if (checkboxMatch) {
      if (current) flush(current);
      current = { title: (checkboxMatch[1] ?? '').trim(), lines: [line] };
      continue;
    }
    const numberedMatch = line.match(NUMBERED);
    if (numberedMatch) {
      if (current) flush(current);
      current = { title: (numberedMatch[2] ?? '').trim(), lines: [line] };
      continue;
    }
    // Non-marker line: attach to current step, or drop if we're still in the
    // pre-step preamble (headings, intro prose, etc.).
    if (current) current.lines.push(line);
  }
  if (current) flush(current);

  if (steps.length === 0) {
    // Surface the no-steps warning *first* — it's the most actionable
    // message for an empty/malformed plan.
    warnings.unshift(WARN_NO_STEPS);
  }

  return { steps, warnings };
}
