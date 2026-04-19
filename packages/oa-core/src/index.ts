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
  // The zod enum is re-exported as `AgentIdSchema` to free the bare `AgentId`
  // name for the literal-string TS type from `adapter/types.ts` (ADR-0009).
  // Internal `schemas.ts` references still spell it `AgentId` — only the
  // public re-export is aliased.
  AgentId as AgentIdSchema,
  CommitMode,
  OnFailure,
  ReviewPriority,
  // ADR-0008 tail-message protocol payload schemas. Consumed by `parseTail`
  // (Task 6.1) and re-exposed for the supervisor / fix-loop synthesizer
  // (Tasks 6.2 / 6.3 / 6.6) which assert against `OaStatus`/`OaReview`
  // shapes when composing follow-up prompts.
  OaStatusSchema,
  OaReviewSchema,
  OaReviewIssueSchema,
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
  OaStatus,
  OaReview,
  OaReviewIssue,
} from './schemas.js';
// Tail-message parser (ADR-0008, Task 6.1). Pure function: extract the LAST
// fenced ```oa-status / ```oa-review block, JSON-parse, validate. Consumed by
// the verifyTail gate (6.2) and the review gate (6.3).
export { parseTail } from './verify/tail.js';
export type { ParseTailResult } from './verify/tail.js';
// AgentAdapter contract (ADR-0009). Types-only — adapter packages depend on
// `oa-core`'s public surface and consume these without importing any runtime.
export type { AgentAdapter, AgentId, AgentRunOpts, AgentRunResult } from './adapter/types.js';
// Headless subprocess primitive every adapter wraps (Task 5.2). Exposed on the
// public surface so adapter packages (oa-adapter-claude, codex, opencode) can
// import the helper without reaching into oa-core's internal layout. The
// `SpawnOpts` interface is exported alongside so adapter authors can name the
// argument shape in their own type signatures. This pair plus the AgentAdapter
// types above are the entire adapter-author public API.
export { spawnHeadless } from './adapter/spawn.js';
export type { SpawnOpts } from './adapter/spawn.js';
// Adapter registry (Task 5.4). Lazy-loads `oa-adapter-<id>` packages and
// caches each resolved instance. `__resetAdapterCacheForTest` is exported
// alongside but is, as the name says, test-only — production callers should
// never need it. Phase 7's supervisor consumes `getAdapter` exclusively.
export { getAdapter, __resetAdapterCacheForTest } from './adapter/registry.js';
