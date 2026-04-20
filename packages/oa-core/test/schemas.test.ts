import { describe, it, expect } from 'vitest';
import {
  ConfigSchema,
  InboxSchema,
  IntakeSchema,
  StepsSchema,
  PlanSchema,
  QueueSchema,
  EventSchema,
  IdSchema,
  ID_REGEX,
  VerifyConfigSchema,
  TaskStatus,
} from '../src/schemas.js';
import { DEFAULT_CONFIG } from '../src/home.js';

// -----------------------------------------------------------------------------
// Fixture builders. Each returns a fresh, mutable, valid sample so tests can
// negate single fields without poisoning other tests.
// -----------------------------------------------------------------------------

function validConfig(): unknown {
  return structuredClone(DEFAULT_CONFIG);
}

function validInbox(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    tasks: [
      {
        id: 't_2026-04-18_a3f9',
        title: 'Refactor auth',
        status: 'pending',
        createdAt: '2026-04-18T00:00:00Z',
        sourceAgent: 'claude',
        projectDir: '/abs/path',
        folder: 'tasks/t_2026-04-18_a3f9',
      },
    ],
  };
}

function validIntake(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 't_2026-04-18_a3f9',
    title: 'Refactor auth',
    createdAt: '2026-04-18T00:00:00Z',
    source: { agent: 'claude', sessionId: 'sess_abc', cwd: '/abs/path' },
    project: {
      dir: '/abs/path',
      baseBranch: 'main',
      worktreeMode: 'perTaskList',
    },
    executor: {
      agent: 'claude',
      model: 'sonnet',
      extraArgs: ['--permission-mode', 'acceptEdits'],
    },
    reviewer: {
      agent: 'claude',
      model: 'opus',
      extraArgs: [],
      promptPath: null,
    },
    bootstrap: { script: 'pnpm install\n', timeoutSec: 600 },
    verify: {
      command: 'pnpm test && pnpm lint',
      requireCommit: true,
      requireTailMessage: true,
    },
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
        src: '/abs/path/docs/spec.md',
        copiedTo: 'references/spec.md',
        sha256: 'a'.repeat(64),
      },
      {
        kind: 'dir',
        src: '/abs/path/lib/auth',
        gitRepo: '/abs/path',
        gitHead: 'abc123',
      },
      {
        kind: 'memory',
        src: '/abs/path/.claude/feedback_x.md',
        sha256: 'b'.repeat(64),
      },
    ],
  };
}

function validSteps(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    steps: [
      {
        n: 1,
        title: 'Create paths module',
        spec: '- create src/paths.ts\n- export assertAbs',
        verify: null,
        expectedOutputs: [],
      },
      {
        n: 2,
        title: 'Add tests',
        spec: 'write paths.test.ts',
        verify: 'pnpm test',
        expectedOutputs: ['src/paths.ts', 'test/paths.test.ts'],
      },
    ],
  };
}

function validPlan(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'p_2026-04-18_xyz1',
    createdAt: '2026-04-18T01:23:45Z',
    status: 'sealed',
    taskListIds: ['t_2026-04-18_a3f9', 't_2026-04-18_b7c2'],
    overrides: {
      planBudgetSec: 28800,
      parallel: { enabled: false, max: 1 },
    },
  };
}

function validQueue(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    taskListIds: ['t_2026-04-18_a3f9', 't_2026-04-18_b7c2'],
  };
}

// -----------------------------------------------------------------------------
// ID regex / IdSchema
// -----------------------------------------------------------------------------

describe('ID_REGEX / IdSchema', () => {
  it('ID_REGEX matches typical generated ids', () => {
    expect(ID_REGEX.test('t_2026-04-18_a3f9')).toBe(true);
    expect(ID_REGEX.test('p_2026-04-18_xyz1')).toBe(true);
    expect(ID_REGEX.test('a.b-c_d')).toBe(true);
  });

  it('IdSchema accepts a normal id', () => {
    expect(IdSchema.safeParse('t_2026-04-18_a3f9').success).toBe(true);
  });

  it('IdSchema rejects empty string', () => {
    expect(IdSchema.safeParse('').success).toBe(false);
  });

  it('IdSchema rejects bare "." and ".."', () => {
    expect(IdSchema.safeParse('.').success).toBe(false);
    expect(IdSchema.safeParse('..').success).toBe(false);
  });

  it('IdSchema rejects path-traversal-flavored ids', () => {
    expect(IdSchema.safeParse('a/b').success).toBe(false);
    expect(IdSchema.safeParse('foo bar').success).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// ConfigSchema
// -----------------------------------------------------------------------------

describe('ConfigSchema', () => {
  it('parses DEFAULT_CONFIG (cross-validation gate)', () => {
    const result = ConfigSchema.safeParse(structuredClone(DEFAULT_CONFIG));
    expect(result.success).toBe(true);
  });

  it('parses a valid config', () => {
    expect(ConfigSchema.safeParse(validConfig()).success).toBe(true);
  });

  it('rejects when schemaVersion is missing', () => {
    const cfg = structuredClone(DEFAULT_CONFIG) as Record<string, unknown>;
    delete cfg.schemaVersion;
    expect(ConfigSchema.safeParse(cfg).success).toBe(false);
  });

  it('rejects when defaultAgent is missing', () => {
    const cfg = structuredClone(DEFAULT_CONFIG) as Record<string, unknown>;
    delete cfg.defaultAgent;
    expect(ConfigSchema.safeParse(cfg).success).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// InboxSchema
// -----------------------------------------------------------------------------

describe('InboxSchema', () => {
  it('parses a valid inbox', () => {
    expect(InboxSchema.safeParse(validInbox()).success).toBe(true);
  });

  it('parses an empty tasks array', () => {
    const inbox = validInbox();
    inbox.tasks = [];
    expect(InboxSchema.safeParse(inbox).success).toBe(true);
  });

  it('rejects when schemaVersion is missing', () => {
    const inbox = validInbox();
    delete inbox.schemaVersion;
    expect(InboxSchema.safeParse(inbox).success).toBe(false);
  });

  it('rejects when a task lacks an id', () => {
    const inbox = validInbox();
    const tasks = inbox.tasks as Array<Record<string, unknown>>;
    delete tasks[0]!.id;
    expect(InboxSchema.safeParse(inbox).success).toBe(false);
  });

  it('rejects an unknown task status', () => {
    const inbox = validInbox();
    const tasks = inbox.tasks as Array<Record<string, unknown>>;
    tasks[0]!.status = 'totally-fake';
    expect(InboxSchema.safeParse(inbox).success).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// IntakeSchema
// -----------------------------------------------------------------------------

describe('IntakeSchema', () => {
  it('parses a valid intake', () => {
    const result = IntakeSchema.safeParse(validIntake());
    if (!result.success) {
      // Surface the first issue when this regresses; otherwise the assertion
      // below carries the load.
      // eslint-disable-next-line no-console
      console.error('IntakeSchema parse error:', result.error.issues);
    }
    expect(result.success).toBe(true);
  });

  it('rejects when schemaVersion is missing', () => {
    const intake = validIntake();
    delete intake.schemaVersion;
    expect(IntakeSchema.safeParse(intake).success).toBe(false);
  });

  it('rejects when source.agent is missing', () => {
    const intake = validIntake();
    const source = intake.source as Record<string, unknown>;
    delete source.agent;
    expect(IntakeSchema.safeParse(intake).success).toBe(false);
  });

  it('rejects an unknown reference kind', () => {
    const intake = validIntake();
    const refs = intake.references as Array<Record<string, unknown>>;
    refs[0]!.kind = 'totally-fake';
    expect(IntakeSchema.safeParse(intake).success).toBe(false);
  });

  it('rejects a dir reference carrying file-only fields', () => {
    const intake = validIntake();
    const refs = intake.references as Array<Record<string, unknown>>;
    refs[1] = { kind: 'dir', src: '/x', copiedTo: 'r/x' };
    expect(IntakeSchema.safeParse(intake).success).toBe(false);
  });

  it('rejects a memory reference carrying dir-only fields', () => {
    const intake = validIntake();
    const refs = intake.references as Array<Record<string, unknown>>;
    refs[2] = { kind: 'memory', src: '/x', sha256: 'abc', gitRepo: '/y' };
    expect(IntakeSchema.safeParse(intake).success).toBe(false);
  });

  it('accepts an empty references list', () => {
    const intake = validIntake();
    intake.references = [];
    expect(IntakeSchema.safeParse(intake).success).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// StepsSchema
// -----------------------------------------------------------------------------

describe('StepsSchema', () => {
  it('parses a valid steps file', () => {
    expect(StepsSchema.safeParse(validSteps()).success).toBe(true);
  });

  it('rejects when schemaVersion is missing', () => {
    const steps = validSteps();
    delete steps.schemaVersion;
    expect(StepsSchema.safeParse(steps).success).toBe(false);
  });

  it('rejects when a step is missing its `n`', () => {
    const steps = validSteps();
    const list = steps.steps as Array<Record<string, unknown>>;
    delete list[0]!.n;
    expect(StepsSchema.safeParse(steps).success).toBe(false);
  });

  it('rejects when a step has no spec body', () => {
    const steps = validSteps();
    const list = steps.steps as Array<Record<string, unknown>>;
    delete list[0]!.spec;
    expect(StepsSchema.safeParse(steps).success).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// PlanSchema
// -----------------------------------------------------------------------------

describe('PlanSchema', () => {
  it('parses a valid plan', () => {
    expect(PlanSchema.safeParse(validPlan()).success).toBe(true);
  });

  it('rejects when schemaVersion is missing', () => {
    const plan = validPlan();
    delete plan.schemaVersion;
    expect(PlanSchema.safeParse(plan).success).toBe(false);
  });

  it('rejects an unknown plan status', () => {
    const plan = validPlan();
    plan.status = 'totally-fake';
    expect(PlanSchema.safeParse(plan).success).toBe(false);
  });

  it('rejects a plan with a malformed task id', () => {
    const plan = validPlan();
    plan.taskListIds = ['..'];
    expect(PlanSchema.safeParse(plan).success).toBe(false);
  });

  it('parses an existing sealed plan without errorBudget (v0.1.0 shape)', () => {
    // Simulates a plan written by v0.1.0 that lacks the errorBudget field.
    const plan = validPlan();
    expect(plan.errorBudget).toBeUndefined();
    const result = PlanSchema.safeParse(plan);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.errorBudget).toBeUndefined();
    }
  });

  it('accepts errorBudget with only warnAfter or only stopAfter', () => {
    const plan1 = validPlan();
    plan1.errorBudget = { warnAfter: 2 };
    expect(PlanSchema.safeParse(plan1).success).toBe(true);

    const plan2 = validPlan();
    plan2.errorBudget = { stopAfter: 5 };
    expect(PlanSchema.safeParse(plan2).success).toBe(true);
  });

  it('rejects errorBudget where warnAfter > stopAfter', () => {
    const plan = validPlan();
    plan.errorBudget = { warnAfter: 5, stopAfter: 3 };
    const result = PlanSchema.safeParse(plan);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /warnAfter/.test(i.message))).toBe(true);
    }
  });
});

// -----------------------------------------------------------------------------
// QueueSchema
// -----------------------------------------------------------------------------

describe('QueueSchema', () => {
  it('parses a valid queue', () => {
    expect(QueueSchema.safeParse(validQueue()).success).toBe(true);
  });

  it('parses an empty queue', () => {
    const q = validQueue();
    q.taskListIds = [];
    expect(QueueSchema.safeParse(q).success).toBe(true);
  });

  it('rejects when schemaVersion is missing', () => {
    const q = validQueue();
    delete q.schemaVersion;
    expect(QueueSchema.safeParse(q).success).toBe(false);
  });

  it('rejects taskListIds containing a non-string', () => {
    const q = validQueue();
    q.taskListIds = [42];
    expect(QueueSchema.safeParse(q).success).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// EventSchema (discriminated union)
// -----------------------------------------------------------------------------

describe('EventSchema', () => {
  it('parses a run.start event', () => {
    const ev = {
      ts: '2026-04-18T00:00:00Z',
      kind: 'run.start',
      planId: 'p_2026-04-18_xyz1',
      hostInfo: { node: '22', os: 'darwin' },
    };
    expect(EventSchema.safeParse(ev).success).toBe(true);
  });

  it('parses a run.stop event', () => {
    const ev = {
      ts: '2026-04-18T00:01:00Z',
      kind: 'run.stop',
      reason: 'user',
    };
    expect(EventSchema.safeParse(ev).success).toBe(true);
  });

  it('rejects a run.stop with an unknown reason', () => {
    const ev = {
      ts: '2026-04-18T00:01:00Z',
      kind: 'run.stop',
      reason: 'totally-fake',
    };
    expect(EventSchema.safeParse(ev).success).toBe(false);
  });

  it('parses a step.attempt.start event', () => {
    const ev = {
      ts: '2026-04-18T00:02:00Z',
      kind: 'step.attempt.start',
      taskId: 't_2026-04-18_a3f9',
      stepN: 1,
      attempt: 1,
    };
    expect(EventSchema.safeParse(ev).success).toBe(true);
  });

  it('parses a step.agent.exit event with sessionId', () => {
    const ev = {
      ts: '2026-04-18T00:03:00Z',
      kind: 'step.agent.exit',
      taskId: 't_2026-04-18_a3f9',
      stepN: 1,
      attempt: 1,
      exitCode: 0,
      durationMs: 1234,
      sessionId: 'sess_abc',
    };
    expect(EventSchema.safeParse(ev).success).toBe(true);
  });

  it('parses a step.verify.tail.ok event', () => {
    const ev = {
      ts: '2026-04-18T00:04:00Z',
      kind: 'step.verify.tail.ok',
      taskId: 't_2026-04-18_a3f9',
      stepN: 1,
      attempt: 1,
    };
    expect(EventSchema.safeParse(ev).success).toBe(true);
  });

  it('parses a daemon.signal event', () => {
    const ev = {
      ts: '2026-04-18T00:05:00Z',
      kind: 'daemon.signal',
      signal: 'SIGTERM',
    };
    expect(EventSchema.safeParse(ev).success).toBe(true);
  });

  it('rejects an unknown event kind', () => {
    const ev = {
      ts: '2026-04-18T00:00:00Z',
      kind: 'totally-fake',
    };
    expect(EventSchema.safeParse(ev).success).toBe(false);
  });

  it('rejects an event missing ts', () => {
    const ev = { kind: 'run.resume' };
    expect(EventSchema.safeParse(ev).success).toBe(false);
  });

  it('rejects an event missing kind', () => {
    const ev = { ts: '2026-04-18T00:00:00Z' };
    expect(EventSchema.safeParse(ev).success).toBe(false);
  });

  it('parses every documented event kind via a smoke matrix', () => {
    // One representative event per kind. Payloads use minimal valid shapes
    // so this test acts as a "no kind was forgotten" tripwire.
    //
    // Names mirror schemas.ts: `stepRef` = task+step (no attempt);
    // `attemptRef` = task+step+attempt. Don't conflate them — the verify /
    // attempt-scoped events need `attempt`; the per-step boundary events
    // (`step.start`, `step.end`) don't.
    const stepRef = { taskId: 't_x', stepN: 1 };
    const attemptRef = { taskId: 't_x', stepN: 1, attempt: 1 };
    const samples: Array<Record<string, unknown>> = [
      { kind: 'run.start', planId: 'p_x', hostInfo: {} },
      { kind: 'run.stop', reason: 'completed' },
      { kind: 'run.resume' },
      { kind: 'run.error', message: 'boom' },
      { kind: 'task.start', taskId: 't_x' },
      { kind: 'task.bootstrap.start', taskId: 't_x' },
      {
        kind: 'task.bootstrap.end',
        taskId: 't_x',
        ok: true,
        exitCode: 0,
        durationMs: 0,
        timedOut: false,
      },
      { kind: 'task.end', taskId: 't_x', status: 'done' },
      { kind: 'step.start', ...stepRef },
      { kind: 'step.attempt.start', ...attemptRef },
      { kind: 'step.prompt.written', ...attemptRef, promptPath: '/abs/p.md' },
      { kind: 'step.agent.spawn', ...attemptRef },
      { kind: 'step.agent.exit', ...attemptRef, exitCode: 0, durationMs: 10 },
      { kind: 'step.verify.tail.ok', ...attemptRef },
      { kind: 'step.verify.tail.fail', ...attemptRef, reason: 'missing' },
      { kind: 'step.verify.commit.ok', ...attemptRef },
      { kind: 'step.verify.commit.fail', ...attemptRef, reason: 'no commit' },
      { kind: 'step.verify.cmd.ok', ...attemptRef },
      { kind: 'step.verify.cmd.fail', ...attemptRef, exitCode: 1 },
      { kind: 'step.verify.review.ok', ...attemptRef },
      { kind: 'step.verify.review.fail', ...attemptRef, blocking: [] },
      { kind: 'step.fix.synthesized', ...attemptRef },
      { kind: 'step.timeout', ...attemptRef },
      { kind: 'step.stdoutCapHit', ...attemptRef },
      { kind: 'step.attempt.end', ...attemptRef, status: 'done' },
      { kind: 'step.end', ...stepRef, status: 'done' },
      { kind: 'reference.driftDetected', taskId: 't_x', src: '/abs/p' },
      { kind: 'daemon.signal', signal: 'SIGTERM' },
    ];
    for (const s of samples) {
      const ev = { ts: '2026-04-18T00:00:00Z', ...s };
      const r = EventSchema.safeParse(ev);
      if (!r.success) {
        // eslint-disable-next-line no-console
        console.error(`EventSchema rejected kind=${String(s.kind)}:`, r.error.issues);
      }
      expect(r.success).toBe(true);
    }
  });

  it('rejects malformed kind-specific fields per variant', () => {
    // Per-variant negative matrix. The smoke matrix above proves the
    // discriminator routes to a variant; this proves each variant actually
    // validates the load-bearing fields it claims to.
    const attemptRef = { taskId: 't_x', stepN: 1, attempt: 1 };
    const cases: Array<[string, Record<string, unknown>]> = [
      // exitCode is z.number().int().nullable() — string must reject.
      ['step.agent.exit', { ...attemptRef, exitCode: 'nope', durationMs: 1 }],
      // attempt missing — variant requires attemptRef.
      ['step.attempt.start', { taskId: 't_x', stepN: 1 }],
      // ok must be boolean.
      ['task.bootstrap.end', { taskId: 't_x', ok: 'maybe' }],
      // status must be a TaskStatus enum value.
      ['task.end', { taskId: 't_x', status: 'totally-fake' }],
      // exitCode must be int.
      ['step.verify.cmd.fail', { ...attemptRef, exitCode: 'x' }],
      // status must be a StepStatus enum value.
      ['step.attempt.end', { ...attemptRef, status: 'flubber' }],
      // src is a required field of the reference.driftDetected variant.
      ['reference.driftDetected', { taskId: 't_x' }],
    ];
    for (const [kind, body] of cases) {
      const ev = { ts: '2026-04-18T00:00:00Z', kind, ...body };
      const result = EventSchema.safeParse(ev);
      expect(result.success, `expected ${kind} to reject`).toBe(false);
    }
  });
});

// -----------------------------------------------------------------------------
// TaskStatus — 'skipped' value for budget-abort terminal state
describe('TaskStatus', () => {
  it('accepts "skipped" as a valid status', () => {
    expect(TaskStatus.parse('skipped')).toBe('skipped');
  });
});

// -----------------------------------------------------------------------------
// VerifyConfigSchema — attempts field with soft/hard thresholds
// -----------------------------------------------------------------------------

describe('VerifyConfigSchema', () => {
  it('accepts a bare number and normalizes soft=ceil(n*0.6), hard=n', () => {
    const parsed = VerifyConfigSchema.parse({ attempts: 5 });
    expect(parsed.attempts).toEqual({ soft: 3, hard: 5 });
  });

  it('accepts explicit {soft, hard} and preserves it', () => {
    const parsed = VerifyConfigSchema.parse({ attempts: { soft: 2, hard: 7 } });
    expect(parsed.attempts).toEqual({ soft: 2, hard: 7 });
  });

  it('rejects soft >= hard in explicit form', () => {
    expect(() => VerifyConfigSchema.parse({ attempts: { soft: 5, hard: 5 } })).toThrow(
      /soft must be < hard/,
    );
  });

  it('when hard = 1, keeps soft = 1 (no warning possible)', () => {
    const parsed = VerifyConfigSchema.parse({ attempts: 1 });
    expect(parsed.attempts).toEqual({ soft: 1, hard: 1 });
  });
});
