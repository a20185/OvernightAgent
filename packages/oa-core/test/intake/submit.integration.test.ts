import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ensureHomeLayout } from '../../src/home.js';
import { intakeSubmit } from '../../src/intake/submit.js';
import type { IntakeSubmitInput } from '../../src/intake/submit.js';
import * as inbox from '../../src/stores/inbox.js';
import { IntakeSchema, StepsSchema } from '../../src/schemas.js';

/**
 * Phase 4.4 integration tests for `intakeSubmit()`.
 *
 * These exercise the full happy path (parse → materialize → write 6 files →
 * inbox append) plus the rejection paths called out in the task spec:
 *   - empty source plan → no taskFolder created
 *   - empty-title parsed step → no taskFolder created
 *   - schema-invalid intake → no disk writes (parse runs before any write)
 *   - reference materialization failure → clear error (taskFolder MAY exist;
 *     we just verify the throw message is informative)
 *   - concurrent calls → both succeed via the inbox lock
 */

let TMP_HOME: string;
let ORIG_HOME: string | undefined;

beforeEach(async () => {
  ORIG_HOME = process.env.OA_HOME;
  TMP_HOME = path.resolve(os.tmpdir(), 'oa-test-submit-' + Math.random().toString(36).slice(2));
  process.env.OA_HOME = TMP_HOME;
  await ensureHomeLayout();
});

afterEach(async () => {
  if (ORIG_HOME === undefined) delete process.env.OA_HOME;
  else process.env.OA_HOME = ORIG_HOME;
  await fs.rm(TMP_HOME, { recursive: true, force: true });
});

function makeInput(overrides: Partial<IntakeSubmitInput> = {}): IntakeSubmitInput {
  return {
    title: 'sample task',
    source: { agent: 'claude', sessionId: 'sess', cwd: '/tmp/proj' },
    project: { dir: '/tmp/proj', baseBranch: 'main', worktreeMode: 'perTaskList' },
    executor: { agent: 'claude', model: 'sonnet', extraArgs: [] },
    reviewer: { agent: 'claude', model: 'opus', extraArgs: [], promptPath: null },
    bootstrap: { script: '', timeoutSec: 600 },
    verify: { command: 'pnpm test', requireCommit: true, requireTailMessage: true },
    strategy: {
      commitMode: 'per-step',
      onFailure: 'markBlocked',
      reviewFixLoop: { enabled: true, maxLoops: 5, blockOn: ['P0', 'P1'] },
      parallel: { enabled: false, max: 1 },
      stepTimeoutSec: 1800,
      stepStdoutCapBytes: 52428800,
    },
    references: [],
    sourcePlanMd: '- [ ] First step\n- [ ] Second step\n',
    ...overrides,
  };
}

/** Returns the number of `tasks/<id>` subdirectories under TMP_HOME. */
async function countTaskFolders(): Promise<number> {
  const tasksRoot = path.resolve(TMP_HOME, 'tasks');
  const entries = await fs.readdir(tasksRoot, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).length;
}

describe('intakeSubmit (integration)', () => {
  it('happy path: writes all 6 files, materializes refs, appends inbox entry', async () => {
    // Arrange: a tmp source file for the file-ref + a tmp dir for the dir-ref.
    const srcDir = path.resolve(
      os.tmpdir(),
      'oa-test-submit-src-' + Math.random().toString(36).slice(2),
    );
    await fs.mkdir(srcDir, { recursive: true });
    const srcFile = path.resolve(srcDir, 'spec.md');
    await fs.writeFile(srcFile, '# spec\nbody\n', 'utf8');
    const srcSubdir = path.resolve(srcDir, 'subdir');
    await fs.mkdir(srcSubdir, { recursive: true });

    try {
      const input = makeInput({
        references: [
          { kind: 'file', src: srcFile },
          { kind: 'dir', src: srcSubdir },
        ],
        sourcePlanMd: '- [ ] First step\n  Body line\n- [ ] Second step\n',
      });

      // Act
      const { taskId, taskFolder } = await intakeSubmit(input);

      // Assert: id + folder shape
      expect(taskId).toMatch(/^t_\d{4}-\d{2}-\d{2}_[0-9a-z]{4}$/);
      expect(taskFolder).toBe(path.resolve(TMP_HOME, 'tasks', taskId));

      // Assert: all 6 files exist
      const expected = [
        'intake.json',
        'source-plan.md',
        'steps.json',
        'HANDOFF.md',
        'PROGRESS.md',
        'FINDINGS.md',
      ];
      for (const name of expected) {
        const stat = await fs.stat(path.resolve(taskFolder, name));
        expect(stat.isFile(), `${name} should be a file`).toBe(true);
      }

      // Assert: intake.json round-trips through IntakeSchema
      const intakeRaw = JSON.parse(
        await fs.readFile(path.resolve(taskFolder, 'intake.json'), 'utf8'),
      );
      const intake = IntakeSchema.parse(intakeRaw);
      expect(intake.id).toBe(taskId);
      expect(intake.title).toBe('sample task');
      expect(intake.references).toHaveLength(2);

      // Assert: file-ref was copied into references/
      const fileRef = intake.references.find((r) => r.kind === 'file');
      expect(fileRef).toBeDefined();
      if (fileRef && fileRef.kind === 'file') {
        const copied = path.resolve(taskFolder, fileRef.copiedTo);
        const stat = await fs.stat(copied);
        expect(stat.isFile()).toBe(true);
        const body = await fs.readFile(copied, 'utf8');
        expect(body).toBe('# spec\nbody\n');
      }

      // Assert: source-plan.md is verbatim
      const sourcePlan = await fs.readFile(
        path.resolve(taskFolder, 'source-plan.md'),
        'utf8',
      );
      expect(sourcePlan).toBe('- [ ] First step\n  Body line\n- [ ] Second step\n');

      // Assert: steps.json round-trips through StepsSchema
      const stepsRaw = JSON.parse(
        await fs.readFile(path.resolve(taskFolder, 'steps.json'), 'utf8'),
      );
      const stepsDoc = StepsSchema.parse(stepsRaw);
      expect(stepsDoc.steps).toHaveLength(2);
      expect(stepsDoc.steps[0]?.title).toBe('First step');
      expect(stepsDoc.steps[0]?.spec).toContain('- [ ] First step');
      expect(stepsDoc.steps[0]?.verify).toBeNull();
      expect(stepsDoc.steps[0]?.expectedOutputs).toEqual([]);

      // Assert: HANDOFF.md non-empty + has the title heading
      const handoff = await fs.readFile(path.resolve(taskFolder, 'HANDOFF.md'), 'utf8');
      expect(handoff).toContain('# HANDOFF — sample task');

      // Assert: PROGRESS + FINDINGS are empty
      expect(await fs.readFile(path.resolve(taskFolder, 'PROGRESS.md'), 'utf8')).toBe('');
      expect(await fs.readFile(path.resolve(taskFolder, 'FINDINGS.md'), 'utf8')).toBe('');

      // Assert: inbox has the new task
      const list = await inbox.list();
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        id: taskId,
        title: 'sample task',
        status: 'pending',
        sourceAgent: 'claude',
        projectDir: '/tmp/proj',
        folder: `tasks/${taskId}`,
      });
    } finally {
      await fs.rm(srcDir, { recursive: true, force: true });
    }
  });

  it('rejects when source plan has zero parseable steps (no taskFolder created)', async () => {
    const input = makeInput({ sourcePlanMd: 'just some prose, no checkboxes\n' });
    await expect(intakeSubmit(input)).rejects.toThrow(/no top-level steps found/);
    // No new folder under tasks/.
    expect(await countTaskFolders()).toBe(0);
  });

  it('rejects when a parsed step has empty title (no taskFolder created)', async () => {
    // `- [ ] ` with no title text → ParsedStep.title === ''
    const input = makeInput({ sourcePlanMd: '- [ ] Real step\n- [ ] \n' });
    await expect(intakeSubmit(input)).rejects.toThrow(/parsed step 2 has empty title/);
    expect(await countTaskFolders()).toBe(0);
  });

  it('rejects when intake fails schema validation (no taskFolder created)', async () => {
    // Invalid: bad agent enum on executor — schema parse should reject.
    const input = makeInput({
      executor: {
        agent: 'not-a-real-agent' as 'claude',
        model: 'sonnet',
        extraArgs: [],
      },
    });
    await expect(intakeSubmit(input)).rejects.toThrow();
    // The schema parse fires BEFORE any disk write, so we expect zero folders.
    expect(await countTaskFolders()).toBe(0);
  });

  it('throws a clear error when a file reference points at a missing file', async () => {
    const missing = path.resolve(
      os.tmpdir(),
      'oa-test-submit-missing-' + Math.random().toString(36).slice(2),
      'nope.md',
    );
    const input = makeInput({
      references: [{ kind: 'file', src: missing }],
    });
    await expect(intakeSubmit(input)).rejects.toThrow(/reference file not found/);
    // Note: at this point taskFolder MAY have been created (mkdir runs before
    // materialize). That's acceptable for v0 — orphan task folders are cleaned
    // up by `oa archive`. We deliberately do NOT assert folder count here.
  });

  it('concurrent calls succeed: both inbox entries land', async () => {
    const a = makeInput({ title: 'task A', source: { agent: 'claude', sessionId: 's-a', cwd: '/tmp/a' } });
    const b = makeInput({ title: 'task B', source: { agent: 'codex', sessionId: 's-b', cwd: '/tmp/b' } });

    const [resA, resB] = await Promise.all([intakeSubmit(a), intakeSubmit(b)]);

    expect(resA.taskId).not.toBe(resB.taskId);

    const list = await inbox.list();
    expect(list).toHaveLength(2);
    const ids = list.map((t) => t.id).sort();
    expect(ids).toEqual([resA.taskId, resB.taskId].sort());
    // Sanity: both folders exist on disk.
    for (const r of [resA, resB]) {
      const stat = await fs.stat(path.resolve(r.taskFolder, 'intake.json'));
      expect(stat.isFile()).toBe(true);
    }
  });
});
