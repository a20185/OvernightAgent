import { describe, it, expect } from 'vitest';
import { assemblePrompt, type AssemblePromptInput } from '../../src/verify/context.js';
import type { OaReviewIssue, Reference, Step } from '../../src/schemas.js';

// -----------------------------------------------------------------------------
// Task 6.4 — Per-step context injector (ADR-0006).
//
// Pure function. Every supervisor turn (Phase 7) builds a fresh prompt by
// calling `assemblePrompt(...)` and writing the result to
// `runs/<planId>/steps/<taskId>/<n>/<attempt>/prompt.md`. ADR-0006 pins the
// section order; ADR-0008 pins the trailing oa-status protocol contract;
// ADR-0003 pins the "previous attempt aborted" status note when the supervisor
// rewound and is re-running the step.
//
// Tests pin:
//   1. snapshot of the canonical, fully populated input — locks ordering and
//      formatting end-to-end (the spec lives in this file).
//   2. empty progress / findings render with placeholders (so the agent never
//      sees a section header followed by nothing — visually confusing).
//   3. isRetry=true emits the ADR-0003 "previous attempt aborted" note.
//   4. openReviewIssues set emits the formatted issue list with [P0] tags,
//      file:line, finding, suggestion (so the agent can act without scanning).
//   5. first-attempt clean output: no Status section at all (a Status section
//      with nothing in it would be noise).
//   6. idempotent: same input → byte-identical output (no Date.now, no random,
//      no Map iteration order leaking through).
//   7. tail protocol block is the LAST section and the assembled prompt ends
//      with a single trailing newline (predictable file shape on disk).
// -----------------------------------------------------------------------------

const STEP: Step = {
  n: 3,
  title: 'Add password reset flow',
  spec: '- [ ] Add password reset flow\n  - Send email\n  - Verify token',
  verify: 'pnpm test',
  expectedOutputs: [],
};

const REFERENCES: Reference[] = [
  { kind: 'file', src: '/abs/spec.md', copiedTo: 'references/spec.md', sha256: 'xyz' },
  { kind: 'dir', src: '/abs/lib', gitRepo: '/abs/lib', gitHead: 'def456' },
  { kind: 'memory', src: '/abs/.claude/memory.md', sha256: 'abc' },
];

const FULL_FIXTURE: AssemblePromptInput = {
  handoff: '# HANDOFF\n\nproject info etc.',
  progress: 'Step 1 done\nStep 2 done',
  findings: 'auth uses JWT',
  stepSpec: STEP,
  gitContext: { branch: 'oa/feature-abc', headSha: 'abc1234', isClean: true },
  references: REFERENCES,
};

describe('assemblePrompt', () => {
  // (1) Snapshot of the canonical, fully populated input. This is THE spec for
  // the assembled prompt — any reordering, retitling, or whitespace change is
  // a behavior change that downstream prompt-engineering work depends on, so
  // the snapshot is inline (visible in code review) rather than off in a
  // separate __snapshots__ file.
  it('renders the canonical fully-populated fixture', () => {
    const out = assemblePrompt(FULL_FIXTURE);
    expect(out).toMatchInlineSnapshot(`
      "# Step 3: Add password reset flow

      ## Step spec

      - [ ] Add password reset flow
        - Send email
        - Verify token

      ## Git context

      - Branch: \`oa/feature-abc\`
      - HEAD: \`abc1234\`
      - Working tree: clean

      ## Progress so far

      Step 1 done
      Step 2 done

      ## Findings so far

      auth uses JWT

      ## References

      - file: \`/abs/spec.md\` (copied to \`references/spec.md\`)
      - dir: \`/abs/lib\` [git: \`/abs/lib\` @ \`def456\`]
      - memory: \`/abs/.claude/memory.md\`

      ## Intake handoff

      # HANDOFF

      project info etc.

      ## End-of-response protocol

      When you finish, end your response with a fenced block exactly like this:

      \`\`\`oa-status
      {"status":"done|blocked","summary":"one-line summary","notes":"optional multi-line"}
      \`\`\`

      - Use \`status: "done"\` when the step is complete and verified.
      - Use \`status: "blocked"\` if you cannot complete the step (explain in \`notes\`).
      - The block must be the LAST fenced block of kind \`oa-status\` in your output.
      "
    `);
  });

  // (2) Empty progress / findings: placeholder strings rather than empty
  // sections. The agent should never see "## Findings so far" followed by
  // blank space — that's visually ambiguous (was the file empty? was it
  // omitted?). Placeholders make the absence explicit.
  it('renders placeholders when progress and findings are empty', () => {
    const out = assemblePrompt({ ...FULL_FIXTURE, progress: '', findings: '' });
    expect(out).toContain('## Progress so far\n\n(no prior progress)');
    expect(out).toContain('## Findings so far\n\n(no findings yet)');
  });

  // (2b) Whitespace-only PROGRESS/FINDINGS files (just trailing newlines from
  // an editor) should also fall back to the placeholder. Without the trim()
  // guard, a single "\n" would render as a blank "Progress so far" section,
  // defeating the placeholder's purpose.
  it('treats whitespace-only progress and findings as empty', () => {
    const out = assemblePrompt({ ...FULL_FIXTURE, progress: '   \n\n', findings: '\t\n' });
    expect(out).toContain('## Progress so far\n\n(no prior progress)');
    expect(out).toContain('## Findings so far\n\n(no findings yet)');
  });

  // (3) ADR-0003 retry note. When the supervisor rewound the worktree and is
  // re-running the step from scratch, the prompt must explicitly say so —
  // otherwise the agent might silently assume its previous (now-wiped)
  // changes survived and try to build on them.
  it('includes the "previous attempt aborted" note when isRetry is true', () => {
    const out = assemblePrompt({ ...FULL_FIXTURE, isRetry: true });
    expect(out).toContain('## Status');
    expect(out).toMatch(/previous attempt was aborted/i);
    // The note should also reference the worktree-wiped invariant so the
    // agent knows the slate is clean (vs. a partial / dirty prior state).
    expect(out).toMatch(/working tree/i);
  });

  // (4) openReviewIssues drives BOTH a status note ("fix-loop iteration") AND
  // a dedicated issue list section. The list format is what the executor
  // consumes — pin [Pn], file:line, finding text, and suggestion text.
  it('renders the open review issues block with [Pn] tags, file:line, finding, suggestion', () => {
    const issues: OaReviewIssue[] = [
      {
        priority: 'P0',
        file: 'src/auth.ts',
        line: 42,
        finding: 'token TTL not validated',
        suggestion: 'reject when exp < now',
      },
      {
        priority: 'P1',
        file: 'src/email.ts',
        finding: 'no retry on transient SMTP failure',
      },
    ];
    const out = assemblePrompt({ ...FULL_FIXTURE, openReviewIssues: issues });
    // Status section flags this as a fix-loop iteration.
    expect(out).toContain('## Status');
    expect(out).toMatch(/fix-loop iteration/i);
    // Dedicated section header for the issue list.
    expect(out).toContain('## Open review issues');
    // Each issue is rendered with its priority bracketed, file:line (or just
    // file when line is absent), finding, and optional suggestion.
    expect(out).toContain('[P0]');
    expect(out).toContain('src/auth.ts:42');
    expect(out).toContain('token TTL not validated');
    expect(out).toContain('reject when exp < now');
    expect(out).toContain('[P1]');
    expect(out).toContain('src/email.ts');
    expect(out).toContain('no retry on transient SMTP failure');
    // The line-less issue must NOT render a phantom ":undefined" suffix.
    expect(out).not.toContain('src/email.ts:undefined');
  });

  // (4b) Empty openReviewIssues array is treated the same as undefined: no
  // status note, no issues section. The supervisor only passes an empty array
  // by mistake but we'd rather render a clean prompt than a confusing one.
  it('treats empty openReviewIssues array as absent', () => {
    const out = assemblePrompt({ ...FULL_FIXTURE, openReviewIssues: [] });
    expect(out).not.toContain('## Status');
    expect(out).not.toContain('## Open review issues');
  });

  // (5) First-attempt, no review issues: no Status section header at all.
  // Keeps the prompt lean for the common case (every step starts as a
  // first-attempt with zero feedback to address).
  it('emits no Status section when isRetry=false and openReviewIssues is unset', () => {
    const out = assemblePrompt(FULL_FIXTURE);
    expect(out).not.toContain('## Status');
    expect(out).not.toContain('## Open review issues');
  });

  // (6) Idempotent: the function must be a pure mapping from input to output.
  // No Date.now, no random suffix, no Map iteration leaking through. Two
  // back-to-back calls must produce byte-identical strings.
  it('produces byte-identical output for the same input (idempotent / pure)', () => {
    const a = assemblePrompt(FULL_FIXTURE);
    const b = assemblePrompt(FULL_FIXTURE);
    expect(a).toBe(b);
    // Sanity check: stringification round-trip of the input doesn't change
    // the output either (so we're not depending on object reference identity).
    const cloned = JSON.parse(JSON.stringify(FULL_FIXTURE)) as AssemblePromptInput;
    expect(assemblePrompt(cloned)).toBe(a);
  });

  // (7) Tail protocol block is the LAST section, and the assembled prompt
  // ends with exactly one trailing newline. The supervisor writes this to
  // disk as `prompt.md`; predictable trailing-newline behavior keeps diffs
  // (and editor save-without-changes) clean.
  it('places the End-of-response protocol block last and ends with one trailing newline', () => {
    const out = assemblePrompt(FULL_FIXTURE);
    // Last section header is the protocol block.
    const lastHeader = out.lastIndexOf('## ');
    expect(out.slice(lastHeader)).toMatch(/^## End-of-response protocol/);
    // Exactly one trailing newline.
    expect(out.endsWith('\n')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(false);
    // The protocol block must contain the literal oa-status fence spec from
    // ADR-0008 — the contract the executor reads to know what to emit.
    expect(out).toContain('```oa-status');
  });

  // (7b) Tail protocol block is present even when retry / fix-loop notes are
  // present — the contract is unconditional.
  it('emits the protocol block on every variant (retry, fix-loop, both)', () => {
    const issues: OaReviewIssue[] = [{ priority: 'P0', file: 'x.ts', finding: 'y' }];
    for (const variant of [
      { isRetry: true },
      { openReviewIssues: issues },
      { isRetry: true, openReviewIssues: issues },
    ]) {
      const out = assemblePrompt({ ...FULL_FIXTURE, ...variant });
      expect(out).toContain('## End-of-response protocol');
      expect(out).toContain('```oa-status');
      expect(out.endsWith('\n')).toBe(true);
    }
  });

  // (8) Empty references render an explicit "(none)" placeholder rather than
  // a section header followed by nothing. Same rationale as (2): the agent
  // should never have to guess whether a section was omitted.
  it('renders "(none)" when references list is empty', () => {
    const out = assemblePrompt({ ...FULL_FIXTURE, references: [] });
    expect(out).toContain('## References\n\n(none)');
  });

  // (9) Dir reference without git metadata renders without the bracketed
  // [git: …] suffix (omitting noise rather than rendering "[git: undefined]").
  it('omits the [git: …] suffix on dir references that lack gitRepo/gitHead', () => {
    const refs: Reference[] = [{ kind: 'dir', src: '/abs/plain' }];
    const out = assemblePrompt({ ...FULL_FIXTURE, references: refs });
    expect(out).toContain('- dir: `/abs/plain`');
    expect(out).not.toContain('[git:');
  });

  // (10) Dirty working tree is reflected in the Git context section. Mirrors
  // the design's note that `isClean` is always true after a rewind but is
  // passed through verbatim — a future code path could legitimately invoke
  // the injector with `isClean: false`, and the prompt must say so honestly.
  it('reflects a dirty working tree in the Git context section', () => {
    const out = assemblePrompt({
      ...FULL_FIXTURE,
      gitContext: { ...FULL_FIXTURE.gitContext, isClean: false },
    });
    expect(out).toContain('Working tree: dirty');
  });
});
