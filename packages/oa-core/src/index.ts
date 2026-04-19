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
export { readJson, writeFileAtomic, writeJsonAtomic } from './atomicJson.js';
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
  // Task 6.5 — `_progress.json` shape. The `state/progress.ts` module re-
  // exports the inferred TS types for ergonomics; the schemas live here.
  StepProgressSchema,
  ProgressDocSchema,
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
  StepProgress,
  ProgressDoc,
} from './schemas.js';
// Tail-message parser (ADR-0008, Task 6.1). Pure function: extract the LAST
// fenced ```oa-status / ```oa-review block, JSON-parse, validate. Consumed by
// the verifyTail gate (6.2) and the review gate (6.3).
export { parseTail } from './verify/tail.js';
export type { ParseTailResult } from './verify/tail.js';
// Verify gates (Task 6.2). Three pre-merge gates the Phase 7 supervisor
// consults after every step run: tail-message protocol, commit-since-start,
// and user-supplied verify command. All three return the same tagged
// GateResult shape so the supervisor can shovel `eventKind` into the run log
// without per-gate branching. Namespaced to keep the bare names (`verifyTail`,
// `verifyCommit`, `verifyCmd`) free should we later add adjacent helpers.
export * as verifyGates from './verify/gates.js';
export type { GateOk, GateFail, GateResult } from './verify/gates.js';
// Reviewer invocation + AI-judge review gate (Task 6.3). Composes the full
// reviewer prompt (template + diff + oa-review protocol block), runs the
// configured reviewer adapter, parses the `oa-review` tail block via
// `parseTail`, and decides ok iff no parsed issue's priority is in the
// supervisor's `blockOn` list. Namespaced (`review.runReviewer`) to keep the
// surface tidy as Phase 6.5/6.6 add adjacent gate helpers.
export * as review from './verify/review.js';
export type { RunReviewerOpts, RunReviewerResult } from './verify/review.js';
// Per-step context injector (ADR-0006, Task 6.4). Pure function the Phase 7
// supervisor calls before every adapter.run to assemble a fresh markdown
// prompt (header / status note / step spec / open issues / git context /
// progress / findings / references / handoff / tail protocol). Namespaced
// (`context.assemblePrompt`) to keep the bare name free for adjacent
// injector helpers added in 6.5/6.6.
export * as context from './verify/context.js';
export type { AssemblePromptInput } from './verify/context.js';
// Per-task PROGRESS / FINDINGS mutators (Task 6.5). Phase 7's supervisor calls
// `progress.mark(taskFolder, n, status)` at every step boundary and
// `findings.append(taskFolder, summary)` after every successful step. Both are
// namespaced (`progress.mark`, `findings.append`) so the bare verbs stay free
// for adjacent state helpers added later.
export * as progress from './state/progress.js';
export * as findings from './state/findings.js';
// Fix-loop synthesizer (Task 6.6). Phase 7's supervisor calls this when the
// review gate (6.3) returns blocking issues and maxLoops isn't exhausted; the
// resulting `FixContext` feeds the next iteration's context injector (6.4) as
// `openReviewIssues`. v0 is a literal passthrough — the surface exists so
// future versions (deduplication, priority sort, clustering, remediation
// hints) can land without changing call sites.
export { synthesizeFixContext } from './verify/fixLoop.js';
export type { FixContext } from './verify/fixLoop.js';
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
// Events JSONL writer (Task 7.1). The Phase 7 supervisor opens one writer per
// run (`<runDir>/events.jsonl`) and emits a structured event for every state
// transition (run.start, task.start, step.attempt.start, step.verify.*, …).
// Append-only, line-atomic via POSIX O_APPEND, auto-stamped `ts`. Validation
// is opt-in (dev/test pay zod cost; prod skips for the hot path). See
// writer.ts for the full contract notes.
export { openEventWriter } from './events/writer.js';
export type { EventWriter, EventWriterOpts } from './events/writer.js';
// Bootstrap runner (Task 7.2). Phase 7's supervisor calls this once per task,
// before the first step, to run the per-task setup script (`pnpm install`,
// `cargo fetch`, etc) verbatim from `intake.bootstrap.script`. Empty scripts
// are a no-op (no events emitted); non-empty scripts are bracketed by
// `task.bootstrap.{start,end}` events with truncated stdout/stderr captured
// in the result for post-mortem inspection. See bootstrap.ts for the full
// contract notes.
export { runBootstrap } from './supervisor/bootstrap.js';
export type { RunBootstrapOpts, RunBootstrapResult } from './supervisor/bootstrap.js';
// Supervisor outer loop (Task 7.3). The Phase 7 production glue: given a sealed
// planId, runs every task's bootstrap + steps in order, applies the per-step
// inner loop (assemblePrompt → adapter.run → verify gates → reviewer → maybe
// fix-loop), and surfaces per-task outcomes back to the caller. Aborts cleanly
// on `signal` and budget exhaustion. v0 takes worker/reviewer adapters by
// injection; Task 7.7 will route via the registry.
export { runPlan } from './supervisor/runPlan.js';
export type {
  RunPlanOpts,
  RunPlanResult,
  PlanOutcome,
  TaskOutcome,
} from './supervisor/runPlan.js';
