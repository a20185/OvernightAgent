/**
 * HANDOFF.md generator.
 *
 * Pure function — given a parsed `Intake` payload + the parsed `Step[]`,
 * returns a markdown string that the agent can read at run-time to understand
 * what task it's executing and how. Phase 4.4 will write this to
 * `<taskFolder>/HANDOFF.md`; this module deliberately does no I/O so the
 * formatter can be snapshot-tested in isolation.
 *
 * Stability contract:
 *  - Same input → byte-identical output (no Date.now, no env reads, no
 *    iteration-order surprises since we drive everything from arrays).
 *  - Single trailing newline (the `.replace(/\n+$/, '\n')` at the end). We
 *    never want a markdown viewer to render a stray blank line at the bottom.
 *
 * Section order is fixed and load-bearing — the handoff doc is read top-down
 * by humans during incident review and (eventually) by injectors that grep
 * for stable headings. Don't reorder without updating the snapshot test AND
 * any downstream readers.
 */

import type { Intake, Reference, Step } from '../schemas.js';

const NONE = '(none)';
const NO_STEPS = '(no steps parsed)';
const DEFAULT_REVIEWER_PROMPT = '(default reviewer prompt)';

/** Format a list of args as backtick-wrapped tokens, or `(none)` if empty. */
function formatArgs(args: readonly string[]): string {
  if (args.length === 0) return NONE;
  return args.map((a) => `\`${a}\``).join(' ');
}

/** Format a single reference line per its discriminated `kind`. */
function formatReference(ref: Reference): string {
  if (ref.kind === 'file') {
    return `- **file** \`${ref.src}\` → \`${ref.copiedTo}\``;
  }
  if (ref.kind === 'dir') {
    // gitRepo / gitHead are both optional; only emit the suffix when BOTH are
    // present (a half-populated git tuple is meaningless and would mislead).
    if (ref.gitRepo && ref.gitHead) {
      return `- **dir** \`${ref.src}\` (git: \`${ref.gitRepo}\` @ \`${ref.gitHead}\`)`;
    }
    return `- **dir** \`${ref.src}\``;
  }
  // kind === 'memory'
  return `- **memory** \`${ref.src}\``;
}

export function renderHandoff(intake: Intake, steps: Step[]): string {
  const lines: string[] = [];

  // 1. Title
  lines.push(`# HANDOFF — ${intake.title}`);
  lines.push('');

  // 2. Overview
  lines.push('## Overview');
  lines.push('');
  lines.push(`- Project dir: \`${intake.project.dir}\``);
  lines.push(`- Base branch: \`${intake.project.baseBranch}\``);
  lines.push(`- Source agent: \`${intake.source.agent}\``);
  lines.push(`- Created at: \`${intake.createdAt}\``);
  lines.push('');

  // 3. Executor
  lines.push('## Executor');
  lines.push('');
  lines.push(`- Agent: \`${intake.executor.agent}\``);
  lines.push(`- Model: \`${intake.executor.model}\``);
  lines.push(`- Extra args: ${formatArgs(intake.executor.extraArgs)}`);
  lines.push('');

  // 4. Reviewer
  lines.push('## Reviewer');
  lines.push('');
  lines.push(`- Agent: \`${intake.reviewer.agent}\``);
  lines.push(`- Model: \`${intake.reviewer.model}\``);
  lines.push(`- Extra args: ${formatArgs(intake.reviewer.extraArgs)}`);
  const promptPath = intake.reviewer.promptPath;
  lines.push(
    `- Prompt path: ${promptPath === null ? DEFAULT_REVIEWER_PROMPT : `\`${promptPath}\``}`,
  );
  lines.push('');

  // 5. Bootstrap
  lines.push('## Bootstrap');
  lines.push('');
  lines.push(`- Timeout: \`${intake.bootstrap.timeoutSec}s\``);
  lines.push('');
  if (intake.bootstrap.script.length === 0) {
    lines.push(NONE);
  } else {
    // Strip a single trailing newline from the script so the closing fence
    // sits flush against the content (avoids a doubled blank line inside the
    // fence). Multi-line scripts with intentional internal blanks survive.
    const script = intake.bootstrap.script.replace(/\n+$/, '');
    lines.push('```bash');
    lines.push(script);
    lines.push('```');
  }
  lines.push('');

  // 6. Verify
  lines.push('## Verify');
  lines.push('');
  lines.push(`- Command: \`${intake.verify.command}\``);
  lines.push(`- Require commit: \`${intake.verify.requireCommit}\``);
  lines.push(`- Require tail message: \`${intake.verify.requireTailMessage}\``);
  lines.push('');

  // 7. Strategy
  const strat = intake.strategy;
  const blockOn =
    strat.reviewFixLoop.blockOn.length === 0
      ? NONE
      : strat.reviewFixLoop.blockOn.map((p) => `\`${p}\``).join(', ');
  lines.push('## Strategy');
  lines.push('');
  lines.push(`- Commit mode: \`${strat.commitMode}\``);
  lines.push(`- On failure: \`${strat.onFailure}\``);
  lines.push(
    `- Review fix loop: enabled=\`${strat.reviewFixLoop.enabled}\`, maxLoops=\`${strat.reviewFixLoop.maxLoops}\`, blockOn=${blockOn}`,
  );
  lines.push(`- Parallel: enabled=\`${strat.parallel.enabled}\`, max=\`${strat.parallel.max}\``);
  lines.push(`- Step timeout: \`${strat.stepTimeoutSec}s\``);
  lines.push(`- Step stdout cap: \`${strat.stepStdoutCapBytes}\` bytes`);
  lines.push('');

  // 8. References
  lines.push('## References');
  lines.push('');
  if (intake.references.length === 0) {
    lines.push(NONE);
  } else {
    for (const ref of intake.references) {
      lines.push(formatReference(ref));
    }
  }
  lines.push('');

  // 9. Steps
  lines.push('## Steps');
  lines.push('');
  if (steps.length === 0) {
    lines.push(NO_STEPS);
  } else {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      lines.push(`### Step ${step.n}: ${step.title}`);
      lines.push('');
      // Strip trailing newlines from the step spec; we control the spacing
      // between steps via the explicit blank line below.
      lines.push(step.spec.replace(/\n+$/, ''));
      // Blank line between steps (but not after the last one — the final
      // newline-collapse below handles that).
      if (i < steps.length - 1) {
        lines.push('');
      }
    }
  }

  // Single trailing newline: collapse any multi-newline tail to exactly one.
  return lines.join('\n').replace(/\n*$/, '\n');
}
