import type { OaReviewIssue, Reference, Step } from '../schemas.js';

/**
 * Task 6.4 — Per-step context injector (ADR-0006).
 *
 * The Phase 7 supervisor calls `assemblePrompt(...)` BEFORE every adapter.run
 * invocation, writes the result to
 * `runs/<planId>/steps/<taskId>/<n>/<attempt>/prompt.md`, and passes that path
 * to the adapter. Every step, every attempt — that's the ADR-0006 contract.
 *
 * Pure function: no I/O, no async, no clock, no random. Same input → byte-
 * identical output. The supervisor depends on this for cache key derivation
 * and for resume-from-disk (`prompt.md` on disk after a crash must match what
 * the supervisor would have generated re-running from the same on-disk state).
 *
 * Section order is fixed (ADR-0006). Optional sections appear in their slot
 * iff their input is non-empty:
 *
 *   1. Header              `# Step <n>: <title>`            (always)
 *   2. Status note         `## Status`                       (iff isRetry || openReviewIssues.length>0)
 *   3. Step spec           `## Step spec`                    (always)
 *   4. Open review issues  `## Open review issues …`         (iff openReviewIssues.length>0)
 *   5. Git context         `## Git context`                  (always)
 *   6. Progress so far     `## Progress so far`              (always; placeholder when empty)
 *   7. Findings so far     `## Findings so far`              (always; placeholder when empty)
 *   8. References          `## References`                   (always; placeholder when empty)
 *   9. Intake handoff      `## Intake handoff`               (always)
 *  10. Tail protocol       `## End-of-response protocol`     (always; ADR-0008 contract)
 *
 * Empty PROGRESS / FINDINGS / references render explicit placeholders rather
 * than blank sections — the agent should never have to guess whether a
 * section was omitted vs. genuinely empty.
 *
 * The tail protocol block is the byte-identical contract from ADR-0008. The
 * supervisor's verifyTail gate (Task 6.2) parses what the agent emits with
 * `parseTail(_, 'oa-status')`; this block tells the agent what the parser
 * expects. Drift here would silently break every step.
 *
 * ADR-0003 retry note: when `isRetry: true` the supervisor has already
 * rewound the worktree to the last commit, so the agent's slate is clean.
 * The status note says so explicitly — without it, an agent might silently
 * assume its previous (now-wiped) changes survived and try to build on them.
 */

export interface AssemblePromptInput {
  /** Contents of HANDOFF.md — project/strategy/executor context for the task. */
  handoff: string;
  /** Contents of PROGRESS.md (may be empty / whitespace-only). */
  progress: string;
  /** Contents of FINDINGS.md (may be empty / whitespace-only). */
  findings: string;
  /** The current step (n, title, spec, verify, expectedOutputs). */
  stepSpec: Step;
  /** Current state of the worktree. */
  gitContext: {
    branch: string;
    headSha: string;
    /** Always true after a rewind, but pass through verbatim — a future code
     *  path could legitimately invoke the injector with a dirty tree. */
    isClean: boolean;
  };
  /** Materialized references from intake (file copies, dir refs, memory refs). */
  references: Reference[];
  /** Set iff this is a fix-loop iteration; the issues drive both a status
   *  note and a dedicated "must address" section. */
  openReviewIssues?: OaReviewIssue[];
  /** True iff a prior attempt of this step was aborted/failed and the
   *  supervisor has rewound the worktree (ADR-0003). */
  isRetry?: boolean;
}

// ADR-0008 tail-message protocol block. The fenced ```oa-status block here
// is the LITERAL spec the executor reads to know what `parseTail` will accept
// at the verifyTail gate (Task 6.2). Any drift between this string and what
// `OaStatusSchema` accepts would silently break every step.
const PROTOCOL_BLOCK = [
  '## End-of-response protocol',
  '',
  'When you finish, end your response with a fenced block exactly like this:',
  '',
  '```oa-status',
  '{"status":"done|blocked","summary":"one-line summary","notes":"optional multi-line"}',
  '```',
  '',
  '- Use `status: "done"` when the step is complete and verified.',
  '- Use `status: "blocked"` if you cannot complete the step (explain in `notes`).',
  '- The block must be the LAST fenced block of kind `oa-status` in your output.',
].join('\n');

// Per-reference rendering. Discriminated-union switch so adding a new kind
// later is a localized one-arm change. A `dir` ref's git metadata is
// surfaced inline (the agent uses it to detect drift); when the dir isn't
// git-tracked we omit the bracketed suffix entirely rather than render
// "[git: undefined]".
function renderReference(ref: Reference): string {
  if (ref.kind === 'file') {
    return `- file: \`${ref.src}\` (copied to \`${ref.copiedTo}\`)`;
  }
  if (ref.kind === 'dir') {
    const git =
      ref.gitRepo !== undefined && ref.gitHead !== undefined
        ? ` [git: \`${ref.gitRepo}\` @ \`${ref.gitHead}\`]`
        : '';
    return `- dir: \`${ref.src}\`${git}`;
  }
  // `kind === 'memory'`
  return `- memory: \`${ref.src}\``;
}

// Per-issue rendering for the open-review-issues section. Format is what the
// executor consumes verbatim, so the test suite pins each part:
//   `- **[P0]** \`src/auth.ts:42\` — token TTL not validated`
//   `  Suggestion: reject when exp < now`
// `line` is optional — when absent we emit just the file (NOT
// `src/auth.ts:undefined`, which a naive interpolation would produce).
// `suggestion` is optional — when absent we omit the indented follow-up line
// entirely rather than render `Suggestion: undefined`.
function renderIssue(issue: OaReviewIssue): string {
  const loc = issue.line !== undefined ? `${issue.file}:${issue.line}` : issue.file;
  const head = `- **[${issue.priority}]** \`${loc}\` — ${issue.finding}`;
  return issue.suggestion !== undefined ? `${head}\n  Suggestion: ${issue.suggestion}` : head;
}

export function assemblePrompt(input: AssemblePromptInput): string {
  const hasIssues = input.openReviewIssues !== undefined && input.openReviewIssues.length > 0;
  const isRetry = input.isRetry === true;

  // Each section is a self-contained markdown block. Joined with a blank
  // line between blocks at the end so individual sections never need to
  // worry about leading/trailing whitespace.
  const sections: string[] = [];

  // (1) Header.
  sections.push(`# Step ${String(input.stepSpec.n)}: ${input.stepSpec.title}`);

  // (2) Status note. Emitted iff isRetry OR there are review issues. The
  // fix-loop note takes precedence over the retry note when both apply (the
  // fix-loop variant carries the issues list, which is the more specific
  // signal — the agent needs to know "address these" more than "start fresh").
  if (hasIssues) {
    sections.push(
      [
        '## Status',
        '',
        'This is a **fix-loop iteration**. The reviewer flagged blocking issues from the previous attempt. Address every issue listed below before declaring the step done.',
      ].join('\n'),
    );
  } else if (isRetry) {
    sections.push(
      [
        '## Status',
        '',
        // The exact phrasing here is load-bearing — the test asserts
        // /previous attempt was aborted/i and /working tree/i, and the
        // wording mirrors the ADR-0003 contract verbatim.
        'This is a **retry**. The previous attempt was aborted; the working tree has been wiped to the last commit. Prior committed steps are intact. Start fresh — do not assume any in-flight changes survived.',
      ].join('\n'),
    );
  }

  // (3) Step spec — the markdown body of the step from steps.json.
  sections.push(['## Step spec', '', input.stepSpec.spec].join('\n'));

  // (4) Open review issues. Header wording flags this as a "must address"
  // list (the executor must clear all of them, not just acknowledge them).
  if (hasIssues) {
    sections.push(
      [
        '## Open review issues (must address)',
        '',
        // openReviewIssues is non-undefined here per `hasIssues` check above.
        input.openReviewIssues!.map(renderIssue).join('\n'),
      ].join('\n'),
    );
  }

  // (5) Git context. `isClean` is rendered as the literal "clean"/"dirty"
  // word the test suite asserts on.
  sections.push(
    [
      '## Git context',
      '',
      `- Branch: \`${input.gitContext.branch}\``,
      `- HEAD: \`${input.gitContext.headSha}\``,
      `- Working tree: ${input.gitContext.isClean ? 'clean' : 'dirty'}`,
    ].join('\n'),
  );

  // (6) Progress so far. Whitespace-only PROGRESS.md (just trailing newlines
  // from an editor) collapses to empty — without trim() the placeholder
  // wouldn't fire and the agent would see a blank section.
  const progressBody = input.progress.trim() !== '' ? input.progress.trim() : '(no prior progress)';
  sections.push(['## Progress so far', '', progressBody].join('\n'));

  // (7) Findings so far. Same placeholder treatment as progress.
  const findingsBody = input.findings.trim() !== '' ? input.findings.trim() : '(no findings yet)';
  sections.push(['## Findings so far', '', findingsBody].join('\n'));

  // (8) References. Empty list collapses to "(none)" so the section header
  // is never followed by nothing.
  const referencesBody =
    input.references.length === 0 ? '(none)' : input.references.map(renderReference).join('\n');
  sections.push(['## References', '', referencesBody].join('\n'));

  // (9) Intake handoff. HANDOFF.md is generated by `intake/handoff.ts` and
  // already markdown-formatted; we trim trailing whitespace so the join
  // below produces a single blank line before the protocol block.
  sections.push(['## Intake handoff', '', input.handoff.trim()].join('\n'));

  // (10) Tail protocol block — always last, byte-identical to the ADR-0008
  // contract.
  sections.push(PROTOCOL_BLOCK);

  // Blank line between sections; single trailing newline at end of file (so
  // `prompt.md` on disk is well-formed for editors and diff tools).
  return sections.join('\n\n') + '\n';
}
