# OvernightAgent TaskManager — Design

**Status:** Approved (brainstorming complete) — 2026-04-18
**Owner:** project author
**Supersedes:** none
**Implementation plan:** to be authored next via `superpowers:writing-plans`

---

## 1. Purpose

OvernightAgent (`oa`) collects task plans from coding sessions, lets the user curate an
overnight execution queue, and drives one or more coding agents (claude / codex / opencode)
to execute that queue unattended — surviving terminal close, machine sleep, and per-step
failures, with auditable progress and a clean morning report.

The user must be able to:

1. Hand off a `task.md` from inside a coding agent (Claude, Codex, opencode) with a
   single slash command, answering a small Q&A to attach context, references, and
   execution preferences.
2. Multi-select intaked tasks into an `OvernightExecutionPlan`.
3. `oa run --detach` and walk away.
4. Wake up to per-plan structured logs, a human-readable `SUMMARY.md`, and target
   repos in a known state — branch per taskList, commit per step with structured
   trailers — that the user can review or merge.
5. Resume any interrupted plan from a clean breakpoint.

---

## 2. Architecture

### 2.1 Shape

`oa` is a Node/TypeScript pnpm monorepo. Three deployable artifacts plus core; per-agent
support is isolated in adapter packages so the supervisor never knows which CLI it is
driving.

```
packages/
  oa-core/                         # data model, intake parser, queue, plan,
                                   # supervisor, worktree manager, verify pipeline,
                                   # fix-loop, events log, state stores
  oa-cli/                          # commander tree, output formatting
  oa-adapter-claude/
  oa-adapter-codex/
  oa-adapter-opencode/
  oa-shims/
    claude/                        # /oa-intake, /oa-queue, /oa-plan, /oa-status
    codex/
    opencode/
docs/
  plans/                           # design docs (this file)
  adr/                             # ADR-0001 .. ADR-0011, plus future ADRs
```

### 2.2 Components

- **CLI surface (`oa-cli`)** — Commander-based command tree:
  - `oa intake submit|list|show|rm`
  - `oa queue add|ls|rm|clear`
  - `oa plan create|show|ls`
  - `oa run [--detach] [--dry-run]`
  - `oa status [<planId>]`
  - `oa stop [--now]`
  - `oa tail [<planId>] [--raw]`
  - `oa archive <id>`
  - `oa rerun <planId>`
  - `oa summary <planId>`

- **Source-agent shims** — One skill bundle per host agent (Claude / Codex / opencode)
  shipped at `packages/oa-shims/<agent>/`. Each provides `/oa-intake`, `/oa-queue`,
  `/oa-plan`, `/oa-status`. The skill body conducts the Step 2/3 intake Q&A in the
  host agent's chat surface, then shells out exactly once to `oa intake submit
  --payload <json>` (or `oa queue …`, `oa plan …`, `oa status …`).

- **Supervisor / daemon** — Spawned by `oa run --detach`. Owns: pidfile in
  `runs/<planId>/oa.pid`; signal handling (SIGTERM = graceful stop, SIGUSR1 = force
  stop); per-step subprocess lifecycle; wall-clock timers; output-size watchdog;
  `events.jsonl` writer.

- **Worktree manager** — Creates `worktrees/<taskId>/` off the user-specified base
  branch on a new branch `oa/<slug>-<short>`, returns an absolute path, enforces
  absolute paths at every API boundary (`assert(path.isAbsolute(p))`), exposes
  `rewindToHead(absRoot)` for the clean-state-before-rerun protocol. See ADR-0002.

- **Verify pipeline** — Pluggable gate chain executed after every step claims done:
  tail-message parse → commit-since-step-start check → user `verify` command →
  AI-judge review (priority extraction). Drives the fix-loop synthesizer. See ADR-0004.

- **State stores** — Plain JSON files on disk, atomic writes (write-then-rename).
  Inbox at `~/.config/overnight-agent/tasks.json`; per-task at
  `~/.config/overnight-agent/tasks/<id>/`; plans at
  `~/.config/overnight-agent/plans/<id>.json`; runs at
  `~/.config/overnight-agent/runs/<planId>/`. Inbox writes use `proper-lockfile`
  to serialize concurrent intake.

### 2.3 Codebase structure rationale

Monorepo with `oa-core` + per-agent adapters keeps the supervisor agent-agnostic, lets
each adapter be tested in isolation, and lets us add adapters later without touching
core. See ADR-0009 (interface) and the rationale in this document's accompanying ADRs.

---

## 3. Data Model & File Layouts

Everything `oa` owns lives under `~/.config/overnight-agent/` (override via `$OA_HOME`).

```
~/.config/overnight-agent/
├── config.json                    # global defaults
├── tasks.json                     # inbox index
├── queue.json                     # transient pre-seal staging
├── tasks/<taskId>/                # one folder per intake-d taskList
│   ├── intake.json                # full intake payload
│   ├── source-plan.md             # original task.md verbatim
│   ├── steps.json                 # parsed top-level steps + per-step metadata
│   ├── HANDOFF.md                 # human-readable rollup of intake + step list
│   ├── PROGRESS.md                # mutable: per-step status + last-updated
│   ├── FINDINGS.md                # accumulated learnings (agent-appended)
│   └── references/                # copies of file references; dirs are by-path
├── plans/<planId>.json            # OvernightExecutionPlan (sealed queue)
├── runs/<planId>/                 # one folder per `oa run` invocation
│   ├── oa.pid                     # daemon pidfile (deleted on graceful exit)
│   ├── events.jsonl               # append-only structured event log
│   ├── SUMMARY.md                 # rendered from events.jsonl on completion
│   └── steps/<taskId>/<stepN>/<attempt>/
│       ├── prompt.md
│       ├── stdout.log
│       ├── stderr.log
│       └── verify/                # outputs from each verify gate
└── worktrees/<taskId>/            # absolute path; oa-owned
```

### 3.1 `config.json`

Global defaults overridable per-plan or per-taskList:

```json
{
  "schemaVersion": 1,
  "defaultAgent": "claude",
  "defaultModel": { "claude": "opus", "codex": "gpt-5", "opencode": "sonnet" },
  "defaultReviewer": {
    "agent": "claude",
    "model": { "claude": "opus", "codex": "gpt-5", "opencode": "sonnet" }
  },
  "defaults": {
    "stepTimeoutSec": 1800,
    "planBudgetSec": 28800,
    "stepStdoutCapBytes": 52428800,
    "reviewFixLoop": { "enabled": true, "maxLoops": 5, "blockOn": ["P0", "P1"] },
    "commitMode": "per-step",
    "onFailure": "markBlocked",
    "parallel": { "enabled": false, "max": 1 },
    "references": { "strict": false }
  }
}
```

### 3.2 `tasks.json` (inbox index)

```json
{
  "schemaVersion": 1,
  "tasks": [
    {
      "id": "t_2026-04-18_a3f9",
      "title": "...",
      "status": "pending",
      "createdAt": "...",
      "sourceAgent": "claude",
      "projectDir": "/abs/path",
      "folder": "tasks/t_2026-04-18_a3f9"
    }
  ]
}
```

### 3.3 `tasks/<id>/intake.json`

Full payload submitted by the source-agent shim.

```json
{
  "schemaVersion": 1,
  "id": "t_...",
  "title": "...",
  "createdAt": "...",
  "source": { "agent": "claude", "sessionId": "...", "cwd": "/abs/path" },
  "project": {
    "dir": "/abs/path",
    "baseBranch": "main",
    "worktreeMode": "perTaskList"
  },
  "executor": {
    "agent": "claude",
    "model": "sonnet",
    "extraArgs": ["--permission-mode", "acceptEdits"]
  },
  "reviewer": {
    "agent": "claude",
    "model": "opus",
    "extraArgs": [],
    "promptPath": null
  },
  "bootstrap": { "script": "pnpm install\n", "timeoutSec": 600 },
  "verify": {
    "command": "pnpm test && pnpm lint",
    "requireCommit": true,
    "requireTailMessage": true
  },
  "strategy": {
    "commitMode": "per-step",
    "onFailure": "markBlocked",
    "reviewFixLoop": { "enabled": true, "maxLoops": 5, "blockOn": ["P0", "P1"] },
    "parallel": { "enabled": false, "max": 1 },
    "stepTimeoutSec": 1800,
    "stepStdoutCapBytes": 52428800
  },
  "references": [
    {
      "kind": "file",
      "src": "/abs/path/docs/spec.md",
      "copiedTo": "references/spec.md",
      "sha256": "..."
    },
    {
      "kind": "dir",
      "src": "/abs/path/lib/auth",
      "gitRepo": "/abs/path",
      "gitHead": "abc123…"
    },
    {
      "kind": "memory",
      "src": "/abs/path/.claude/.../feedback_x.md",
      "sha256": "..."
    }
  ]
}
```

### 3.4 `tasks/<id>/steps.json`

```json
{
  "schemaVersion": 1,
  "steps": [
    {
      "n": 1,
      "title": "...",
      "spec": "...full markdown body of the step including sub-bullets...",
      "verify": null,
      "expectedOutputs": []
    }
  ]
}
```

### 3.5 `plans/<planId>.json`

```json
{
  "schemaVersion": 1,
  "id": "p_...",
  "createdAt": "...",
  "status": "sealed",
  "taskListIds": ["t_a", "t_b", "t_c"],
  "overrides": {
    "planBudgetSec": 28800,
    "parallel": { "enabled": false, "max": 1 }
  }
}
```

### 3.6 `runs/<planId>/events.jsonl`

Append-only structured event stream. Each line is a single JSON object with `ts`,
`kind`, and kind-specific fields. Initial event taxonomy:

`run.start`, `run.stop`, `run.resume`, `run.error`,
`task.start`, `task.bootstrap.start`, `task.bootstrap.end`, `task.end`,
`step.start`, `step.attempt.start`, `step.prompt.written`,
`step.agent.spawn`, `step.agent.exit`,
`step.verify.tail.{ok,fail}`, `step.verify.commit.{ok,fail}`,
`step.verify.cmd.{ok,fail}`, `step.verify.review.{ok,fail}`,
`step.fix.synthesized`, `step.timeout`, `step.stdoutCapHit`,
`step.attempt.end`, `step.end`,
`reference.driftDetected`, `daemon.signal`.

`SUMMARY.md` is rendered from this stream on plan completion (or on demand via
`oa summary <planId>`). See ADR-0005.

### 3.7 Worktree manager invariants

- All paths in the public API are absolute. Asserts `path.isAbsolute(p)` on every input.
- Branch naming: `oa/<taskSlug>-<shortid>` (slug is a kebab-cased prefix of the task
  title; shortid is 4–6 chars from the taskId).
- Public API: `create({taskId, repoDir, baseBranch}) → { absRoot, branch }`,
  `rewindToHead(absRoot)`, `remove(absRoot)`.
- `rewindToHead` runs `git reset --hard HEAD && git clean -fdx` inside the worktree
  (safe: the worktree is oa-owned; user has no work to lose). See ADR-0003.

---

## 4. Workflows

### 4.1 Intake (`/oa-intake` inside the coding agent)

The skill runs entirely in the host agent's chat surface and shells out exactly once.

1. **Resolve plan source.** Skill accepts `/oa-intake <path>` (file in the project)
   or `/oa-intake` followed by inline content. Skill reads the markdown into memory.
2. **Parse and validate.** Skill parses top-level checkbox/numbered items into a
   step list. If zero steps parse, skill rejects with a clear error. If ambiguous
   (mixed headings + checkboxes at top level), skill asks the user which to use.
3. **Step 2 — Context Preparation Q&A.** Skill asks (one question at a time, in
   the agent chat):
   - Confirm `projectDir` (default = current cwd) and `baseBranch` (default = current
     HEAD of cwd).
   - Reference docs: file paths, directory paths, memory entries. Tiered handling
     per ADR-0007 — files copied; directories referenced by absolute path with
     git HEAD recorded when applicable; memory entries hashed.
   - Optional FINDINGS seed (any pre-existing notes the user wants the agent to
     start with).
4. **Step 3 — Env Confirmation Q&A.** Skill walks the strategy toggles with sane
   defaults — user can Enter through:
   - Executor agent (`claude` | `codex` | `opencode`) + model + extra args.
   - Reviewer agent + model + extra args + promptPath (defaults from `config.json`
     `defaultReviewer`).
   - `bootstrap.script` (multi-line, optional).
   - `verify.command` (shell, optional but strongly suggested).
   - `strategy.*` toggles (`commitMode`, `onFailure`, `reviewFixLoop`, `parallel`,
     `stepTimeoutSec`, `stepStdoutCapBytes`).
5. **Materialize.** Skill assembles the full `intake.json` payload and runs
   `oa intake submit --payload <json>`. The CLI: creates `tasks/<id>/`, copies file
   references, writes `intake.json`, `source-plan.md`, parses `steps.json`, generates
   `HANDOFF.md`, creates empty `PROGRESS.md` and `FINDINGS.md`, appends to
   `tasks.json` with status `pending`. Prints the new `taskId`.

### 4.2 Queue management

Queue is a non-persistent staging area at `~/.config/overnight-agent/queue.json`
holding an ordered list of `taskId`s. Operations: `oa queue add <ids>`,
`oa queue ls`, `oa queue rm <id>`, `oa queue clear`. Inside agents, `/oa-queue`
shows the current queue plus `pending` tasks side-by-side and lets the user
multi-select to add/remove. Queue is reset when a plan is sealed from it.

### 4.3 Plan sealing

`oa plan create [--from-queue] [--budget 8h] [--parallel N] [--tasks <ids>]`
snapshots the current queue (or explicit task ids) into `plans/<planId>.json` with
status `sealed`. Sealed plans are immutable — to change, supersede with a new plan.
Sealing also flips each included task's status from `pending` → `queued`. Inside
agents, `/oa-plan` previews the sequence and any per-plan overrides, then calls
`oa plan create`.

### 4.4 Execution (`oa run`)

```
oa run <planId>                  # foreground (debug / dev)
oa run <planId> --detach         # production: forks daemon, returns plan dir + pid
oa run <planId> --dry-run        # prints the planned step sequence; no agent calls
```

**Supervisor outer loop** (one daemon per plan; sequential by default):

1. Acquire `runs/<planId>/oa.pid`. Refuse to start if a live pid already exists.
2. Open `events.jsonl` for append. Emit `run.start { planId, hostInfo }`.
3. Start the plan budget timer (`planBudgetSec`).
4. For each `taskId` in plan order:
   1. Mark task `running`. Emit `task.start`.
   2. **Worktree.** Worktree manager creates `worktrees/<taskId>/` off the resolved
      base branch on a new branch `oa/<slug>-<short>`. Returns absolute path.
   3. **Bootstrap.** If `intake.bootstrap.script` is set: spawn it in the worktree,
      capture to events, enforce `bootstrap.timeoutSec`. Non-zero exit →
      emit `task.bootstrap.end{ok:false}`, mark task `bootstrap-failed`,
      apply `onFailure`.
   4. **Step inner loop** (next subsection) for each step in `steps.json`.
   5. Mark task `done` | `blocked-needs-human` | `failed`. Emit `task.end`.
5. On budget exhaustion: finish in-flight step, refuse to start new ones, mark
   remaining as `budget-exhausted`. Emit `run.stop{reason:"budget"}`. Render
   `SUMMARY.md`.

### 4.5 Per-step inner loop

```
for attempt in 1..MAX_REVIEW_LOOP:
  # 1. CONTEXT INJECTION — runs every attempt (ADR-0006)
  prompt = assemble({
    intake_handoff,           # tasks/<id>/HANDOFF.md
    progress_so_far,          # tasks/<id>/PROGRESS.md
    findings_so_far,          # tasks/<id>/FINDINGS.md
    current_step_spec,        # steps.json[n]
    git_context,              # branch, last commit, status (always clean)
    references,               # paths under tasks/<id>/references/ + dir refs
    open_review_issues,       # if this is a fix-loop iteration
    protocol_block,           # required tail-message format spec (ADR-0008)
  })
  write prompt → runs/<planId>/steps/<taskId>/<n>/<attempt>/prompt.md

  # 2. SPAWN (via AgentAdapter — ADR-0009)
  emit step.attempt.start
  result = adapter.run({
    cwd: worktree_abs_root,
    promptPath: <abs>,
    model, extraArgs,
    timeoutSec: stepTimeoutSec,
    stdoutCapBytes: stepStdoutCapBytes,
    stdoutPath: <abs>, stderrPath: <abs>,
    signal: stopSignal,
  })
  emit step.agent.exit { exitCode, sessionId?, durationMs, killedBy? }

  # 3. VERIFY GATES (ADR-0004)
  if result.timedOut:    emit step.timeout;       goto onFailure
  if result.stdoutCapHit: emit step.stdoutCapHit; goto onFailure
  tail = parseTail(result.stdoutPath)
  if !tail.ok: emit step.verify.tail.fail; goto retryOrBlock
  if requireCommit && !commitsSince(stepStartHead):
      emit step.verify.commit.fail; goto retryOrBlock
  if verifyCmd:
    rc = exec(verifyCmd, cwd=worktree_abs_root)
    if rc != 0: emit step.verify.cmd.fail; goto retryOrBlock
  if reviewFixLoop.enabled:
    review = runReviewer(stepDiff, reviewerPrompt)   # via AgentAdapter
    blocking = review.issues.filter(i => blockOn.includes(i.priority))
    if blocking.length > 0:
      if attempt >= reviewFixLoop.maxLoops:
        mark step blocked-needs-human; break
      open_review_issues = blocking
      emit step.fix.synthesized
      continue   # next attempt feeds blocking issues back into prompt

  # 4. SUCCESS
  appendToFindings(tail.summary)
  updateProgress(step n → done)
  if commitMode == "per-taskList" && step is last: commitAll()
  emit step.end{status:"done"}
  break
```

`onFailure` policy applies to non-recoverable verify fails (timeout, stdout cap, or
hard tail/commit/cmd failures after exhausting attempts):
- `halt` — stop the whole plan
- `skip` — mark step `failed`, continue (only safe if user accepts dependency risk)
- `markBlocked` — mark step `blocked-needs-human`, continue

**Commit trailer format (ADR-0001):**

```
<one-line summary from agent's tail message>

<optional body>

oa-plan: p_2026-04-18_xyz
oa-task: t_2026-04-18_a3f9
oa-step: 3
oa-attempt: 1
```

### 4.6 Resume (`oa rerun <planId>` or `oa run` against an interrupted plan)

1. Detect interruption: stale `oa.pid` (process not alive) OR plan status `running`
   with no live daemon.
2. Rewind any in-flight worktree to clean state (ADR-0003): for each task whose
   status is `running` or any step is `running`, run `git reset --hard HEAD &&
   git clean -fdx` in its worktree. Mark in-flight steps back to `pending`.
   Emit `run.resume { rewoundSteps: [...] }`.
3. Re-enter the outer loop at the first non-`done` task; skip already-`done` tasks;
   for the first non-done task, skip its already-`done` steps.
4. Per-step inner loop runs unchanged — the next attempt always sees a clean
   worktree and a HANDOFF that includes "previous attempt aborted, working tree
   wiped to last commit, prior committed steps intact" via the context injector.

### 4.7 Stop / cancel

- `oa stop` — graceful. SIGTERM the daemon. Daemon stops accepting new work,
  finishes the in-flight step's verify pipeline if the agent already returned;
  otherwise lets the agent finish, commits any successful step, then writes
  `run.stop{reason:"user"}` and exits.
- `oa stop --now` — force. SIGUSR1 the daemon. Daemon SIGTERMs the agent
  subprocess, leaves the worktree in whatever state it's in, marks the in-flight
  step back to `pending`, exits. The next `oa rerun` will rewind and resume cleanly.

---

## 5. Contracts

### 5.1 `AgentAdapter` interface (ADR-0009)

```ts
export interface AgentAdapter {
  readonly id: "claude" | "codex" | "opencode";
  readonly defaultModel: string;
  capabilities(): { supportsSessionId: boolean; supportsStructuredOutput: boolean };
  run(opts: AgentRunOpts): Promise<AgentRunResult>;
}

export interface AgentRunOpts {
  cwd: string;                 // absolute path to worktree root (asserted)
  promptPath: string;          // absolute path to assembled prompt.md (asserted)
  model: string;
  extraArgs: string[];
  env?: Record<string, string>;
  timeoutSec: number;          // hard wall-clock kill
  stdoutCapBytes: number;      // kill if exceeded
  stdoutPath: string;          // absolute path to capture file (asserted)
  stderrPath: string;          // absolute path
  signal: AbortSignal;         // for graceful stop
}

export interface AgentRunResult {
  exitCode: number | null;     // null if killed
  durationMs: number;
  timedOut: boolean;
  stdoutCapHit: boolean;
  killedBy: "timeout" | "stdoutCap" | "signal" | null;
  sessionId?: string;          // logged to events.jsonl when adapter surfaces one
}
```

The supervisor never imports any adapter directly — it uses
`core/adapters.ts → getAdapter(id)` which lazy-loads the matching package.

### 5.2 Tail-message protocol (ADR-0008)

Context injector appends this block to every prompt:

> When you finish, end your response with a fenced block exactly like this:
>
> ````
> ```oa-status
> {"status":"done|blocked","summary":"one-line summary","notes":"optional multi-line"}
> ```
> ````
>
> Reviewer agents must instead emit:
>
> ````
> ```oa-review
> {"issues":[{"priority":"P0|P1|P2","file":"...","line":123,"finding":"...","suggestion":"..."}]}
> ```
> ````

The verify pipeline parses the **last** matching fenced block in stdout. Missing
or malformed → `step.verify.tail.fail`.

### 5.3 Concurrency & locking

- Inbox writes (`tasks.json`, `queue.json`) take a process-level file lock
  (`proper-lockfile`).
- Plan files are immutable after seal; no lock for reads.
- Per-task PROGRESS / FINDINGS writes happen only inside the supervisor (single
  writer); no lock needed.
- Supervisor pidfile prevents two daemons running the same plan.
- v0 does not actively prevent two daemons running **different** plans; we detect
  plan overlap on the same project dir and warn.

---

## 6. Observability

- **`events.jsonl`** — single source of truth (taxonomy in §3.6).
- **`SUMMARY.md`** — generated by `oa summary <planId>` and on plan completion.
  Sections: per-taskList outcome table, durations, blocked items with reasons,
  P0/P1 issues remaining, fix-loop iteration counts, links to per-step
  `prompt.md` / `stdout.log` for inspection.
- **`oa status [<planId>]`** — reads `oa.pid` + tails `events.jsonl`; shows current
  task, current step, current attempt, elapsed step time vs timeout, plan elapsed
  vs budget. JSON output via `--json` for slash-command consumption.
- **`oa tail [<planId>]`** — `tail -f` over `events.jsonl` with pretty rendering;
  `--raw` for the JSONL.

---

## 7. ADR Catalog

Each decision in this design has a separate immutable ADR file under `docs/adr/`.
ADRs are not edited in place; supersede with a new ADR when reversing course.

```
docs/adr/
├── 0000-template.md
├── 0001-branch-and-commit-hygiene.md
├── 0002-worktree-per-tasklist-and-absolute-paths.md
├── 0003-clean-rewind-on-resume.md
├── 0004-verification-pipeline-and-fix-loop.md
├── 0005-runs-as-events-jsonl-plus-summary.md
├── 0006-context-injection-per-step.md
├── 0007-references-tiered-handling.md
├── 0008-agent-tail-message-protocol.md
├── 0009-agent-adapter-interface.md
├── 0010-process-model-detached-supervisor.md
└── 0011-strategy-as-orthogonal-toggles.md
```

---

## 8. v0 Scope vs Deferred

### In v0

- Three executors: claude, codex, opencode (all headless).
- Single-machine, manual-trigger only.
- Sequential by default; opt-in fan-out within a single plan via `parallel.enabled`.
- Worktree-per-taskList; branch-per-taskList; commit-per-step with structured trailer.
- Full verify pipeline (4 gates) + review-fix loop with P0/P1 block, MAX 5.
- Detach daemon; graceful + force stop; full resume from clean rewind.
- `events.jsonl` + `SUMMARY.md` + `oa status` + `oa tail`.
- Slash commands `/oa-intake`, `/oa-queue`, `/oa-plan`, `/oa-status` per host agent.
- Tiered references (file copy, dir by-path + git SHA).
- Reviewer as a full executor spec (agent + model + extraArgs + promptPath).

### Deferred (post-v0 backlog)

- `pushOnFinish` and draft-PR creation (`gh` integration).
- Pause-as-distinct-state (`oa pause` / `oa resume` semantics).
- Token-spend caps via reported usage.
- Cross-plan / cross-machine parallelism.
- Auto-prune of old runs.
- Teardown scripts.
- Multi-phase bootstrap hooks (`pre-clone`, `post-step`, etc.).
- Plugin loader for third-party adapters.
- Remote / SSH execution.
- Cron / scheduling.
- Email / webhook / macOS native notifications.
- Cloud sync of inbox.

---

## 9. Open Questions for Implementation

These are not blockers for the design; capture during the writing-plans pass.

- Concrete CLI invocation strings for each adapter (`claude -p` vs current flag set,
  `codex exec` shape, `opencode run` shape) — verify against installed CLIs at impl
  time.
- `HANDOFF.md` rendering template (bullet structure, what to include verbatim vs
  what to summarize from intake.json).
- `SUMMARY.md` rendering template.
- Default reviewer prompt content (`oa-core/prompts/reviewer-default.md`).
- Slug generation rules (max length, forbidden chars) for branch names.
- Exact pidfile / lockfile cleanup on crash recovery.
