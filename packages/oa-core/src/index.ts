export {
  assertAbs,
  oaHome,
  taskDir,
  runDir,
  worktreeDir,
  pidfile,
  socketPath,
} from './paths.js';
export { assertId, newTaskId, newPlanId } from './ids.js';
export type { IdGeneratorDeps } from './ids.js';
export { slug, DEFAULT_MAX_LENGTH } from './slug.js';
export { readJson, writeJsonAtomic } from './atomicJson.js';
export { ensureHomeLayout, DEFAULT_CONFIG } from './home.js';
export { withInboxLock } from './locks.js';
// Namespaced re-export so `create` doesn't collide with future top-level
// helpers; callers use `worktree.create(...)`. Types stay flat for ergonomics.
export * as worktree from './worktree.js';
export type { CreateWorktreeOpts, WorktreeInfo } from './worktree.js';
// Stores get the same namespace treatment so `inbox.add(...)` / `inbox.list()`
// are unambiguous and won't collide with future store namespaces (queue, plan).
export * as inbox from './stores/inbox.js';
export * as queue from './stores/queue.js';
export * as plan from './stores/plan.js';
export type { CreatePlanOpts } from './stores/plan.js';
// Intake parser: pure-function front door for slash-command shims.
export * as parseSteps from './intake/parseSteps.js';
export type { ParsedStep, ParseResult } from './intake/parseSteps.js';
// Tiered reference materializer (ADR-0007). Namespaced so callers spell
// `references.materializeReferences(...)` and types stay discoverable.
export * as references from './intake/references.js';
export type { ReferenceInput, MaterializedRef } from './intake/references.js';
// HANDOFF.md generator: pure renderer consumed by Phase 4.4 (intakeSubmit).
export * as handoff from './intake/handoff.js';
// intakeSubmit — Phase 4.4 end-to-end. Namespaced (`submit.intakeSubmit(...)`)
// to mirror the per-helper namespacing used elsewhere in the intake module
// and keep the top-level surface uncluttered. Types re-exported flat for
// ergonomics at call sites.
export * as submit from './intake/submit.js';
export type { IntakeSubmitInput, IntakeSubmitResult } from './intake/submit.js';
export {
  ID_REGEX,
  IdSchema,
  ConfigSchema,
  InboxSchema,
  InboxTaskSchema,
  IntakeSchema,
  ReferenceSchema,
  StepsSchema,
  StepSchema,
  PlanSchema,
  QueueSchema,
  EventSchema,
  // Sub-schemas + enums Phase 3+ writers will want to compose with (S2).
  ReviewFixLoopSchema,
  ParallelSchema,
  TaskStatus,
  PlanStatus,
  StepStatus,
  AgentId,
  CommitMode,
  OnFailure,
  ReviewPriority,
} from './schemas.js';
export type {
  Config,
  Inbox,
  InboxTask,
  Intake,
  Reference,
  Steps,
  Step,
  Plan,
  Queue,
  Event,
  TaskStatusT,
  PlanStatusT,
  StepStatusT,
} from './schemas.js';
