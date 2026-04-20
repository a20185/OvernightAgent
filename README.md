# OvernightAgent (`oa`)

A Node/TypeScript CLI that runs coding agents (claude / codex / opencode)
unattended overnight against a queue of task plans. Every task runs in an
isolated git worktree with a four-gate verify pipeline, a review-fix loop,
structured event logs, clean resume after interruption, and a morning
SUMMARY.md.

## Install

```sh
pnpm install
pnpm -r build
pnpm link --global  # once, from packages/oa-cli
```

Requires Node >= 22 (the import-attributes syntax used by the CLI landed
then).

Install per-host shims so you can drive the pipeline from inside your coding
agent:

```sh
# Claude Code
mkdir -p .claude/commands
ln -s "$(pwd)/packages/oa-shims/claude/commands"/*.md .claude/commands/

# Codex / opencode — see packages/oa-shims/<host>/README.md
```

## Lifecycle

```
  intake submit   →   queue add   →   plan create   →   run (detached)
         │                                  │                     │
         ▼                                  ▼                     ▼
  tasks/<id>/ + inbox              plans/<planId>.json    runs/<planId>/events.jsonl
                                                              runs/<planId>/SUMMARY.md
```

1. **Intake.** `/oa-intake <plan.md>` (via shim) runs a two-stage Q&A that
   collects project / executor / reviewer / strategy knobs, then invokes
   `oa intake submit --payload-file`. A new `taskId` is minted; the six
   per-task files (`intake.json`, `steps.json`, `HANDOFF.md`, `PROGRESS.md`,
   `FINDINGS.md`, `source-plan.md`) land under `tasks/<id>/`.

2. **Queue.** `oa queue add <taskId>` appends the task to
   `queue/queue.json`. The queue is a simple FIFO list of task ids; you
   can also use `oa queue ls|rm|clear`.

3. **Plan.** `oa plan create --from-queue [--budget <sec>] [--parallel <n>]`
   seals the current queue snapshot into an immutable plan. The plan file
   at `plans/<planId>.json` is the source of truth for the supervisor.

4. **Run.** `oa run --detach <planId>` spawns the detached supervisor
   daemon. The daemon opens a control socket at `runs/<planId>/control.sock`,
   writes its pid to `runs/<planId>/oa.pid`, and streams events to
   `runs/<planId>/events.jsonl`. Foreground mode (no `--detach`) runs in
   the current shell with SIGINT wired for clean abort.

5. **Observe.** `oa status [planId] [--json]`, `oa tail [planId] [--raw]`.
   Status queries the control socket; falls back to events.jsonl tail if
   the daemon is gone.

6. **Stop.** `oa stop [planId] [--now]`. Graceful by default (SIGTERM via
   socket, let the current step drain); `--now` force-kills the adapter
   spawn. If the socket is unreachable, falls back to SIGTERM via pidfile.

7. **Resume.** `oa rerun <planId>` (optionally `--detach`) rewinds any
   in-flight worktree via `git reset --hard HEAD && git clean -fdx`, flips
   in-flight steps back to `pending`, emits `run.resume {rewoundSteps}`,
   then re-enters the supervisor loop. ADR-0003.

8. **Morning report.** `oa summary <planId>` renders SUMMARY.md from
   events.jsonl. The supervisor also auto-renders on plan end.

9. **Archive.** `oa archive <id>` moves a task or run folder to
   `<oaHome>/_archive/<id>-<timestamp>/`.

## State layout

Default root: `$OA_HOME` (falls back to `$HOME/.oa/` on Linux / macOS).

```
$OA_HOME/
  tasks.json                 # inbox index
  queue/queue.json           # FIFO task ids
  tasks/<taskId>/            # per-task files (intake, steps, handoff, progress, findings, source-plan)
  worktrees/<taskId>/        # git worktree checked out to `oa/<slug>-<shortId>`
  plans/<planId>.json        # sealed plan
  runs/<planId>/             # per-run logs + control state
    events.jsonl             # canonical event stream
    SUMMARY.md               # auto-rendered report
    oa.pid                   # daemon pidfile
    control.sock             # AF_UNIX control socket
    <taskId>/step-NN/attempt-NN/{prompt.md,stdout.log,stderr.log}
  _archive/                  # oa archive destination
```

Every on-disk JSON file carries `schemaVersion: 1` and is written via
temp+rename for crash safety.

## Architecture

- **`oa-core`** — data model (Zod schemas), atomic JSON helpers, paths,
  id mint, worktree manager, intake parser, verify pipeline (tail / commit
  / cmd / review gates), fix-loop, events writer + reader, supervisor
  (`runPlan` + `resumePlan`), detached daemon launcher, pidfile + control
  socket, SUMMARY renderer.
- **`oa-cli`** — Commander-based CLI that wraps oa-core's public surface.
- **`oa-adapter-{claude,codex,opencode}`** — per-agent headless invocation
  helpers implementing a single `AgentAdapter` interface (ADR-0009).
- **`oa-shims/{claude,codex,opencode}`** — slash-command bundles for host
  agents. Pure markdown/JSON resources; no JS.

## Design docs

- `docs/plans/2026-04-18-overnight-agent-taskmanager-design.md` — full
  design doc.
- `docs/plans/2026-04-18-overnight-agent-taskmanager-implementation.md` —
  per-phase implementation plan.
- `docs/adr/0001..0013.md` — architectural decisions (ADRs).

## Development

```sh
pnpm -r build        # compile every package
pnpm -r test         # vitest, all 420+ tests
pnpm -r lint         # eslint
pnpm -r typecheck    # tsc --noEmit
```

### TypeScript / path convention

- `module: NodeNext` + `verbatimModuleSyntax: true`: relative imports in
  `src/` must spell the `.js` extension (e.g. `from './foo.js'` even though
  the file is `foo.ts`).
- `tsc --force` requires `--build` mode in TS6 (`tsc --build . --force`).
- Worktree / paths code must use absolute paths at every public-API
  boundary. ESLint enforces `path.resolve` over `path.join` in
  `**/worktree*.ts` and `**/paths*.ts`. See ADR-0002 + ADR-0013.

### Testing

- **TDD.** Every task has failing-test-then-passing evidence in the
  implementer's report.
- **Sabotage checks.** On load-bearing assertions, temporarily break the
  production code and confirm the test catches it.
- **Integration tests** use tmpdir OA_HOMEs; `afterEach` rm -rf.

## Known limits in v0

- `parallel.max > 1` is accepted by the schema but the supervisor is
  sequential. See `intake.strategy.parallel` + the Phase 8 carry-forward.
- Workspace has a cyclic dep (`oa-core` devDeps the adapter packages for
  the registry). Blocks `npm publish`. Fix is planned via `vi.mock` in
  registry tests.
- The reviewer default prompt is materialized at
  `<runDir>/reviewer-default-prompt.md` — would race between concurrent
  tasks once parallel mode lands.
