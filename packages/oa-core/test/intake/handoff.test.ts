import { describe, it, expect } from 'vitest';
import { renderHandoff } from '../../src/intake/handoff.js';
import type { Intake, Step } from '../../src/schemas.js';

/**
 * Comprehensive fixture intake covering every section/branch of renderHandoff:
 *  - executor extraArgs populated
 *  - reviewer with promptPath set (separate test covers null)
 *  - bootstrap script populated (separate test covers empty)
 *  - all three reference kinds (file, dir w/ git metadata, memory)
 *
 * The snapshot test pins the entire rendered markdown so ANY drift in section
 * order, formatting, or escaping fails loudly. Section-specific edge cases
 * (empty refs / steps, missing bootstrap, default reviewer prompt) get their
 * own focused tests so the snapshot doesn't have to be re-baselined every
 * time we tweak one corner.
 */
const fixtureIntake: Intake = {
  schemaVersion: 1,
  id: 't_2026-04-18_a3f9',
  title: 'Add user authentication',
  createdAt: '2026-04-18T12:00:00Z',
  source: { agent: 'claude', sessionId: 'sess_123', cwd: '/Users/me/project' },
  project: { dir: '/Users/me/project', baseBranch: 'main', worktreeMode: 'perTaskList' },
  executor: {
    agent: 'claude',
    model: 'sonnet',
    extraArgs: ['--permission-mode', 'acceptEdits'],
  },
  reviewer: {
    agent: 'claude',
    model: 'opus',
    extraArgs: [],
    promptPath: '/Users/me/.claude/reviewer.md',
  },
  bootstrap: { script: 'pnpm install\n', timeoutSec: 600 },
  verify: { command: 'pnpm test', requireCommit: true, requireTailMessage: true },
  strategy: {
    commitMode: 'per-step',
    onFailure: 'markBlocked',
    reviewFixLoop: { enabled: true, maxLoops: 5, blockOn: ['P0', 'P1'] },
    parallel: { enabled: false, max: 1 },
    stepTimeoutSec: 1800,
    stepStdoutCapBytes: 52428800,
  },
  references: [
    {
      kind: 'file',
      src: '/Users/me/spec.md',
      copiedTo: 'references/spec.md',
      sha256: 'abc',
    },
    {
      kind: 'dir',
      src: '/Users/me/lib',
      gitRepo: '/Users/me/lib',
      gitHead: 'def123',
    },
    {
      kind: 'memory',
      src: '/Users/me/.claude/memory/feedback.md',
      sha256: 'xyz',
    },
  ],
};

const fixtureSteps: Step[] = [
  {
    n: 1,
    title: 'Add login form',
    spec: '- [ ] Add login form\n  Body content here',
    verify: null,
    expectedOutputs: [],
  },
  {
    n: 2,
    title: 'Add session storage',
    spec: '- [ ] Add session storage',
    verify: 'pnpm test',
    expectedOutputs: [],
  },
];

describe('renderHandoff', () => {
  it('renders the comprehensive fixture as the pinned markdown snapshot', () => {
    const out = renderHandoff(fixtureIntake, fixtureSteps);
    expect(out).toMatchInlineSnapshot(`
      "# HANDOFF — Add user authentication

      ## Overview

      - Project dir: \`/Users/me/project\`
      - Base branch: \`main\`
      - Source agent: \`claude\`
      - Created at: \`2026-04-18T12:00:00Z\`

      ## Executor

      - Agent: \`claude\`
      - Model: \`sonnet\`
      - Extra args: \`--permission-mode\` \`acceptEdits\`

      ## Reviewer

      - Agent: \`claude\`
      - Model: \`opus\`
      - Extra args: (none)
      - Prompt path: \`/Users/me/.claude/reviewer.md\`

      ## Bootstrap

      - Timeout: \`600s\`

      \`\`\`bash
      pnpm install
      \`\`\`

      ## Verify

      - Command: \`pnpm test\`
      - Require commit: \`true\`
      - Require tail message: \`true\`

      ## Strategy

      - Commit mode: \`per-step\`
      - On failure: \`markBlocked\`
      - Review fix loop: enabled=\`true\`, maxLoops=\`5\`, blockOn=\`P0\`, \`P1\`
      - Parallel: enabled=\`false\`, max=\`1\`
      - Step timeout: \`1800s\`
      - Step stdout cap: \`52428800\` bytes

      ## References

      - **file** \`/Users/me/spec.md\` → \`references/spec.md\`
      - **dir** \`/Users/me/lib\` (git: \`/Users/me/lib\` @ \`def123\`)
      - **memory** \`/Users/me/.claude/memory/feedback.md\`

      ## Steps

      ### Step 1: Add login form

      - [ ] Add login form
        Body content here

      ### Step 2: Add session storage

      - [ ] Add session storage
      "
    `);
  });

  it('renders "(none)" when references array is empty', () => {
    const intake: Intake = { ...fixtureIntake, references: [] };
    const out = renderHandoff(intake, fixtureSteps);
    // Section header + blank + "(none)" must appear together.
    expect(out).toContain('## References\n\n(none)\n');
  });

  it('renders "(no steps parsed)" when steps array is empty', () => {
    const out = renderHandoff(fixtureIntake, []);
    expect(out).toContain('## Steps\n\n(no steps parsed)\n');
  });

  it('renders "(none)" for an empty bootstrap script', () => {
    const intake: Intake = {
      ...fixtureIntake,
      bootstrap: { script: '', timeoutSec: 600 },
    };
    const out = renderHandoff(intake, fixtureSteps);
    // Section header + timeout still present, but body is "(none)".
    expect(out).toContain('## Bootstrap');
    expect(out).toContain('(none)');
    // No bash fence should appear when the script is empty.
    expect(out).not.toContain('```bash');
  });

  it('renders "(default reviewer prompt)" when reviewer.promptPath is null', () => {
    const intake: Intake = {
      ...fixtureIntake,
      reviewer: { ...fixtureIntake.reviewer, promptPath: null },
    };
    const out = renderHandoff(intake, fixtureSteps);
    expect(out).toContain('Prompt path: (default reviewer prompt)');
  });

  it('is idempotent — same input yields byte-identical output across calls', () => {
    const a = renderHandoff(fixtureIntake, fixtureSteps);
    const b = renderHandoff(fixtureIntake, fixtureSteps);
    expect(a).toBe(b);
    // Single trailing newline contract.
    expect(a.endsWith('\n')).toBe(true);
    expect(a.endsWith('\n\n')).toBe(false);
  });
});
