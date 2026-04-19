import { z } from 'zod';

/**
 * Zod schemas for every JSON file `oa-core` writes to disk.
 *
 * All schemas pin `schemaVersion: z.literal(1)` — bumping the version is a
 * deliberate, codified migration moment, not a forgivable drift. v0 keeps
 * payload typing strict where the design is concrete and permissive
 * (`z.unknown()` / `passthrough`) where the design defers detail to a later
 * phase; tightening happens incrementally in the phase that owns the writer.
 *
 * Cross-references:
 * - design §3.1–§3.6 enumerates the file shapes; every field there appears
 *   here with the documented type and required/optional status.
 * - `home.ts` owns `DEFAULT_CONFIG`; `ConfigSchema.safeParse(DEFAULT_CONFIG)`
 *   is a load-bearing test (schemas.test.ts) — if it ever regresses, EITHER
 *   the schema drifted from the doc OR the default config did.
 */

// -----------------------------------------------------------------------------
// ID validation. `IdSchema` enforces the same shape `assertId` (Task 1.6) will
// later impose at runtime — defining it here lets schemas reject malformed
// taskId / planId strings before any path-construction code touches them.
//
// `ID_REGEX` is the canonical regex; Task 1.6 will re-import it for the
// imperative `assertId(id)` so both call sites agree on what counts as legal.
// -----------------------------------------------------------------------------

export const ID_REGEX = /^[A-Za-z0-9_.-]+$/;

export const IdSchema = z
  .string()
  .min(1, 'id must not be empty')
  .regex(ID_REGEX, 'id must match /^[A-Za-z0-9_.-]+$/')
  .refine((s) => s !== '.' && s !== '..', {
    message: 'id must not be bare "." or ".."',
  });

// -----------------------------------------------------------------------------
// Lifecycle enums. Sourced from design §3.2 (task status), §3.5 (plan status),
// §4.4 (extra task statuses surfaced by the supervisor), and §4.5 (step
// status). Where the design enumerates a status verbatim the schema includes
// it; statuses inferred from prose (e.g. `bootstrap-failed`,
// `budget-exhausted`) are also included so the supervisor can write them.
// -----------------------------------------------------------------------------

// Enums are exported so Phase 3+ writers can reference them without
// re-deriving the membership lists. (S2)
export const TaskStatus = z.enum([
  'draft',
  'pending',
  'queued',
  'running',
  'done',
  'failed',
  'blocked-needs-human',
  'stopped',
  'bootstrap-failed',
  'budget-exhausted',
]);

export const PlanStatus = z.enum([
  'building',
  'sealed',
  'running',
  'done',
  'partial',
  'stopped',
]);

export const StepStatus = z.enum(['pending', 'running', 'done', 'failed', 'timeout', 'blocked']);

export const AgentId = z.enum(['claude', 'codex', 'opencode']);

export const CommitMode = z.enum(['per-step', 'per-taskList']);
export const OnFailure = z.enum(['halt', 'skip', 'markBlocked']);
export const ReviewPriority = z.enum(['P0', 'P1', 'P2']);

// -----------------------------------------------------------------------------
// Reusable strategy / config sub-shapes. Lifted out so ConfigSchema's
// `defaults` and IntakeSchema's `strategy` cannot drift from each other.
// Exported per S2 so Phase 3+ writers can compose them.
// -----------------------------------------------------------------------------

export const ReviewFixLoopSchema = z.object({
  enabled: z.boolean(),
  maxLoops: z.number().int().nonnegative(),
  blockOn: z.array(ReviewPriority),
});

export const ParallelSchema = z.object({
  enabled: z.boolean(),
  max: z.number().int().positive(),
});

// `references.strict` is documented in §3.1 but left to phase 4 to define
// further fields — keep this tolerant.
const ReferencesPolicySchema = z.object({
  strict: z.boolean(),
});

const PerAgentModelSchema = z.object({
  claude: z.string(),
  codex: z.string(),
  opencode: z.string(),
});

// -----------------------------------------------------------------------------
// 3.1 ConfigSchema — `<oaHome>/config.json`. Must match `DEFAULT_CONFIG` in
// home.ts byte-for-byte (modulo schema-irrelevant key order).
// -----------------------------------------------------------------------------

const ConfigDefaultsSchema = z.object({
  stepTimeoutSec: z.number().int().positive(),
  planBudgetSec: z.number().int().positive(),
  stepStdoutCapBytes: z.number().int().positive(),
  reviewFixLoop: ReviewFixLoopSchema,
  commitMode: CommitMode,
  onFailure: OnFailure,
  parallel: ParallelSchema,
  references: ReferencesPolicySchema,
});

export const ConfigSchema = z.object({
  schemaVersion: z.literal(1),
  defaultAgent: AgentId,
  defaultModel: PerAgentModelSchema,
  defaultReviewer: z.object({
    agent: AgentId,
    model: PerAgentModelSchema,
  }),
  defaults: ConfigDefaultsSchema,
});

// -----------------------------------------------------------------------------
// 3.2 InboxSchema — `<oaHome>/tasks.json`. The inbox is an *index*; the per-
// task folder under `tasks/<id>/` carries the full payload (IntakeSchema).
// `folder` is documented as the relative folder name (`tasks/<id>`), not an
// absolute path; we accept any non-empty string here and let path-helpers
// validate the directory exists.
// -----------------------------------------------------------------------------

// Tighten `createdAt` to ISO 8601 with offset (`Z` or `±HH:MM`). Cheap guard
// against `new Date().toString()` instead of `.toISOString()` in writers.
export const InboxTaskSchema = z.object({
  id: IdSchema,
  title: z.string(),
  status: TaskStatus,
  createdAt: z.iso.datetime({ offset: true }),
  sourceAgent: AgentId,
  projectDir: z.string(),
  folder: z.string(),
});

export const InboxSchema = z.object({
  schemaVersion: z.literal(1),
  tasks: z.array(InboxTaskSchema),
});

// -----------------------------------------------------------------------------
// 3.3 IntakeSchema — `<oaHome>/tasks/<id>/intake.json`. Mirrors the literal
// JSON example in design §3.3 field-for-field.
// -----------------------------------------------------------------------------

const IntakeStrategySchema = z.object({
  commitMode: CommitMode,
  onFailure: OnFailure,
  reviewFixLoop: ReviewFixLoopSchema,
  parallel: ParallelSchema,
  stepTimeoutSec: z.number().int().positive(),
  stepStdoutCapBytes: z.number().int().positive(),
});

// `kind: 'file'` — copied into `references/`; sha256 records source-at-intake.
// `kind: 'dir'` — referenced by absolute path; gitRepo + gitHead let the
//   supervisor detect drift (ADR-0007). gitRepo / gitHead are optional for
//   dirs that aren't git-tracked; the design example shows them populated.
// `kind: 'memory'` — agent memory file (e.g. `.claude/.../feedback_x.md`);
//   hashed for drift detection.
//
// Each variant is `.strict()`: the discriminator promises a closed shape per
// branch, and silently stripping wrong-kind fields (e.g. a `copiedTo` on a
// `dir` reference) would let Phase 4's materializer ship wrong-kind metadata
// undetected. Strict mode fails loudly instead.
export const ReferenceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('file'),
      src: z.string(),
      copiedTo: z.string(),
      sha256: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('dir'),
      src: z.string(),
      gitRepo: z.string().optional(),
      gitHead: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('memory'),
      src: z.string(),
      sha256: z.string(),
    })
    .strict(),
]);

export const IntakeSchema = z.object({
  schemaVersion: z.literal(1),
  id: IdSchema,
  title: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
  source: z.object({
    agent: AgentId,
    sessionId: z.string(),
    cwd: z.string(),
  }),
  project: z.object({
    dir: z.string(),
    baseBranch: z.string(),
    // `worktreeMode` is documented as `perTaskList` in §3.3; the design hints
    // at future modes (e.g. `perStep`) so we keep this an open string for v0
    // rather than a closed enum. Tighten when other modes are introduced.
    worktreeMode: z.string(),
  }),
  executor: z.object({
    agent: AgentId,
    model: z.string(),
    extraArgs: z.array(z.string()),
  }),
  reviewer: z.object({
    agent: AgentId,
    model: z.string(),
    extraArgs: z.array(z.string()),
    promptPath: z.string().nullable(),
  }),
  bootstrap: z.object({
    script: z.string(),
    timeoutSec: z.number().int().positive(),
  }),
  verify: z.object({
    command: z.string(),
    requireCommit: z.boolean(),
    requireTailMessage: z.boolean(),
  }),
  strategy: IntakeStrategySchema,
  references: z.array(ReferenceSchema),
});

// -----------------------------------------------------------------------------
// 3.4 StepsSchema — `<oaHome>/tasks/<id>/steps.json`. `verify` is the optional
// per-step verify command override; `expectedOutputs` is a list of file paths
// the agent is expected to touch (for verify hints).
// -----------------------------------------------------------------------------

export const StepSchema = z.object({
  n: z.number().int().positive(),
  title: z.string(),
  spec: z.string(),
  verify: z.string().nullable(),
  expectedOutputs: z.array(z.string()),
});

export const StepsSchema = z.object({
  schemaVersion: z.literal(1),
  steps: z.array(StepSchema),
});

// -----------------------------------------------------------------------------
// 3.5 PlanSchema — `<oaHome>/plans/<planId>.json`. Sealed plans are immutable.
// `overrides` is a partial of the strategy / budget knobs; v0 documents only
// the two below, but a plan author may need others later — keep open.
// -----------------------------------------------------------------------------

const PlanOverridesSchema = z
  .object({
    planBudgetSec: z.number().int().positive().optional(),
    parallel: ParallelSchema.optional(),
    stepTimeoutSec: z.number().int().positive().optional(),
    stepStdoutCapBytes: z.number().int().positive().optional(),
    commitMode: CommitMode.optional(),
    onFailure: OnFailure.optional(),
    reviewFixLoop: ReviewFixLoopSchema.optional(),
  })
  .passthrough();

export const PlanSchema = z.object({
  schemaVersion: z.literal(1),
  id: IdSchema,
  createdAt: z.iso.datetime({ offset: true }),
  status: PlanStatus,
  taskListIds: z.array(IdSchema),
  overrides: PlanOverridesSchema,
});

// -----------------------------------------------------------------------------
// QueueSchema — `<oaHome>/queue.json`. Transient pre-seal staging; cleared
// when a plan is sealed from it (design §4.2).
// -----------------------------------------------------------------------------

export const QueueSchema = z.object({
  schemaVersion: z.literal(1),
  taskListIds: z.array(IdSchema),
});

// -----------------------------------------------------------------------------
// 3.6 EventSchema — discriminated union over every event kind enumerated in
// the design's event taxonomy. Phase 7 will tighten payloads as the writer
// lands; for now each variant pins its load-bearing fields and `passthrough`s
// the rest, so the discriminator (`kind`) is strict but the payload can grow
// without churning this file.
//
// Every variant carries `ts` as an ISO 8601 datetime with offset (`Z` or
// `±HH:MM`). Step-scoped variants carry `taskId` + `stepN`; per-attempt
// variants additionally carry `attempt`.
//
// TODO(phase-7): once the events writer lands and all load-bearing fields are
// pinned per variant, remove `.passthrough()` and switch to default `strip`
// (or `.strict()` if we want to fail loudly on writer drift). Track in
// design §3.6.
// -----------------------------------------------------------------------------

const EventBase = z.object({
  ts: z.iso.datetime({ offset: true }),
});

// Convenience extenders: avoid repeating the taskId / stepN / attempt blocks
// across the 20-something step.* variants.
const taskRef = { taskId: IdSchema };
const stepRef = { taskId: IdSchema, stepN: z.number().int().positive() };
const attemptRef = {
  taskId: IdSchema,
  stepN: z.number().int().positive(),
  attempt: z.number().int().positive(),
};

const RunStop = EventBase.extend({
  kind: z.literal('run.stop'),
  reason: z.enum(['user', 'user-now', 'budget', 'completed']),
}).passthrough();

const RunStart = EventBase.extend({
  kind: z.literal('run.start'),
  planId: IdSchema,
  hostInfo: z.unknown(),
}).passthrough();

const RunResume = EventBase.extend({
  kind: z.literal('run.resume'),
}).passthrough();

const RunError = EventBase.extend({
  kind: z.literal('run.error'),
  message: z.string(),
}).passthrough();

const TaskStart = EventBase.extend({
  kind: z.literal('task.start'),
  ...taskRef,
}).passthrough();

const TaskBootstrapStart = EventBase.extend({
  kind: z.literal('task.bootstrap.start'),
  ...taskRef,
}).passthrough();

const TaskBootstrapEnd = EventBase.extend({
  kind: z.literal('task.bootstrap.end'),
  ...taskRef,
  ok: z.boolean(),
}).passthrough();

const TaskEnd = EventBase.extend({
  kind: z.literal('task.end'),
  ...taskRef,
  status: TaskStatus,
}).passthrough();

const StepStart = EventBase.extend({
  kind: z.literal('step.start'),
  ...stepRef,
}).passthrough();

const StepAttemptStart = EventBase.extend({
  kind: z.literal('step.attempt.start'),
  ...attemptRef,
}).passthrough();

const StepPromptWritten = EventBase.extend({
  kind: z.literal('step.prompt.written'),
  ...attemptRef,
  promptPath: z.string(),
}).passthrough();

const StepAgentSpawn = EventBase.extend({
  kind: z.literal('step.agent.spawn'),
  ...attemptRef,
}).passthrough();

const StepAgentExit = EventBase.extend({
  kind: z.literal('step.agent.exit'),
  ...attemptRef,
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative(),
  sessionId: z.string().optional(),
  killedBy: z.enum(['timeout', 'stdoutCap', 'signal']).nullable().optional(),
}).passthrough();

const StepVerifyTailOk = EventBase.extend({
  kind: z.literal('step.verify.tail.ok'),
  ...attemptRef,
}).passthrough();

const StepVerifyTailFail = EventBase.extend({
  kind: z.literal('step.verify.tail.fail'),
  ...attemptRef,
  reason: z.string(),
}).passthrough();

const StepVerifyCommitOk = EventBase.extend({
  kind: z.literal('step.verify.commit.ok'),
  ...attemptRef,
}).passthrough();

const StepVerifyCommitFail = EventBase.extend({
  kind: z.literal('step.verify.commit.fail'),
  ...attemptRef,
  reason: z.string(),
}).passthrough();

const StepVerifyCmdOk = EventBase.extend({
  kind: z.literal('step.verify.cmd.ok'),
  ...attemptRef,
}).passthrough();

const StepVerifyCmdFail = EventBase.extend({
  kind: z.literal('step.verify.cmd.fail'),
  ...attemptRef,
  exitCode: z.number().int(),
}).passthrough();

const StepVerifyReviewOk = EventBase.extend({
  kind: z.literal('step.verify.review.ok'),
  ...attemptRef,
}).passthrough();

const StepVerifyReviewFail = EventBase.extend({
  kind: z.literal('step.verify.review.fail'),
  ...attemptRef,
  blocking: z.array(z.unknown()),
}).passthrough();

const StepFixSynthesized = EventBase.extend({
  kind: z.literal('step.fix.synthesized'),
  ...attemptRef,
}).passthrough();

const StepTimeout = EventBase.extend({
  kind: z.literal('step.timeout'),
  ...attemptRef,
}).passthrough();

const StepStdoutCapHit = EventBase.extend({
  kind: z.literal('step.stdoutCapHit'),
  ...attemptRef,
}).passthrough();

const StepAttemptEnd = EventBase.extend({
  kind: z.literal('step.attempt.end'),
  ...attemptRef,
  status: StepStatus,
}).passthrough();

const StepEnd = EventBase.extend({
  kind: z.literal('step.end'),
  ...stepRef,
  status: StepStatus,
}).passthrough();

const ReferenceDriftDetected = EventBase.extend({
  kind: z.literal('reference.driftDetected'),
  taskId: IdSchema,
  src: z.string(),
}).passthrough();

const DaemonSignal = EventBase.extend({
  kind: z.literal('daemon.signal'),
  signal: z.string(),
}).passthrough();

export const EventSchema = z.discriminatedUnion('kind', [
  RunStart,
  RunStop,
  RunResume,
  RunError,
  TaskStart,
  TaskBootstrapStart,
  TaskBootstrapEnd,
  TaskEnd,
  StepStart,
  StepAttemptStart,
  StepPromptWritten,
  StepAgentSpawn,
  StepAgentExit,
  StepVerifyTailOk,
  StepVerifyTailFail,
  StepVerifyCommitOk,
  StepVerifyCommitFail,
  StepVerifyCmdOk,
  StepVerifyCmdFail,
  StepVerifyReviewOk,
  StepVerifyReviewFail,
  StepFixSynthesized,
  StepTimeout,
  StepStdoutCapHit,
  StepAttemptEnd,
  StepEnd,
  ReferenceDriftDetected,
  DaemonSignal,
]);

// -----------------------------------------------------------------------------
// ADR-0008 tail-message protocol. Two fenced-block payloads the agent / reviewer
// emit at the end of stdout, parsed by `verify/tail.ts`:
//
//   - `oa-status` (executor) — `{status,summary,notes?}` reporting the outcome
//     of the step. Drives the verifyTail gate (Task 6.2).
//   - `oa-review` (reviewer) — `{issues:[{priority,file,line?,finding,suggestion?}]}`
//     enumerating per-file findings. Drives the review gate (Task 6.3).
//
// Both schemas are `.strict()` so any extra key from a misbehaving agent fails
// loudly rather than silently dropping data the supervisor would later need.
// -----------------------------------------------------------------------------

export const OaStatusSchema = z
  .object({
    status: z.enum(['done', 'blocked']),
    summary: z.string(),
    notes: z.string().optional(),
  })
  .strict();

// -----------------------------------------------------------------------------
// Task 6.5 — `_progress.json` shape. Source of truth backing the human-readable
// PROGRESS.md table. Each step has at most one entry (keyed by `n`); the
// supervisor upserts via `state/progress.ts::mark`. `attempt` and `detail` are
// optional — the supervisor populates them for running/failed states but not
// every status carries them. `updatedAt` is required and ISO-8601-with-offset
// (matching every other timestamp in the codebase).
// -----------------------------------------------------------------------------

export const StepProgressSchema = z
  .object({
    n: z.number().int().positive(),
    status: StepStatus,
    attempt: z.number().int().positive().optional(),
    detail: z.string().optional(),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const ProgressDocSchema = z
  .object({
    schemaVersion: z.literal(1),
    steps: z.array(StepProgressSchema),
  })
  .strict();

export const OaReviewIssueSchema = z
  .object({
    priority: ReviewPriority,
    file: z.string(),
    line: z.number().int().optional(),
    finding: z.string(),
    suggestion: z.string().optional(),
  })
  .strict();

export const OaReviewSchema = z
  .object({
    issues: z.array(OaReviewIssueSchema),
  })
  .strict();

// -----------------------------------------------------------------------------
// Inferred TypeScript types. Re-exported through `index.ts`. Downstream
// modules should prefer importing these over hand-rolling the same shape.
// -----------------------------------------------------------------------------

export type Config = z.infer<typeof ConfigSchema>;
export type Inbox = z.infer<typeof InboxSchema>;
export type InboxTask = z.infer<typeof InboxTaskSchema>;
export type Intake = z.infer<typeof IntakeSchema>;
export type Reference = z.infer<typeof ReferenceSchema>;
export type Steps = z.infer<typeof StepsSchema>;
export type Step = z.infer<typeof StepSchema>;
export type Plan = z.infer<typeof PlanSchema>;
export type Queue = z.infer<typeof QueueSchema>;
export type Event = z.infer<typeof EventSchema>;
export type TaskStatusT = z.infer<typeof TaskStatus>;
export type PlanStatusT = z.infer<typeof PlanStatus>;
export type StepStatusT = z.infer<typeof StepStatus>;
export type OaStatus = z.infer<typeof OaStatusSchema>;
export type OaReview = z.infer<typeof OaReviewSchema>;
export type OaReviewIssue = z.infer<typeof OaReviewIssueSchema>;
export type StepProgress = z.infer<typeof StepProgressSchema>;
export type ProgressDoc = z.infer<typeof ProgressDocSchema>;
