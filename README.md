# OvernightAgent

> Let coding agents ship overnight — safely, verifiably, resumably.

[![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/typescript-6.x-blue)](https://www.typescriptlang.org/)
[![pnpm](https://img.shields.io/badge/pnpm-9.x-orange)](https://pnpm.io/)
[![Tests](https://img.shields.io/badge/tests-488%20passing-success)](#development)
[![Status](https://img.shields.io/badge/status-v0-lightgrey)](#status--v0)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**OvernightAgent (`oa`)** is a Node/TypeScript CLI that runs coding agents
(claude · codex · opencode) **unattended overnight** against a queue of task
plans. You leave a plan on the desk, close the laptop lid, and wake up to a
`SUMMARY.md` with committed code, verification results, and any issues
flagged for review.

Every task runs in an **isolated git worktree**. Every step passes through
**four verify gates** (tail protocol · commit-since-start · user command ·
AI review). Failures trigger a **fix-loop** with the reviewer's findings
injected as context. Interrupted runs **resume cleanly** via `git reset`
+ `git clean`, with zero ambiguity about what was mid-flight.

---

## Table of contents

- [Why OvernightAgent](#why-overnightagent)
- [Features](#features)
- [Install](#install)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [CLI reference](#cli-reference)
- [State layout](#state-layout)
- [Architecture](#architecture)
- [Design docs & ADRs](#design-docs--adrs)
- [Development](#development)
- [Status — v0](#status--v0)
- [License](#license)

---

## Why OvernightAgent

Coding agents are great at 20-minute tasks under a human's eye. They're
less great at 8-hour queues where:

- Any single step failure cascades silently into the next.
- Uncommitted "work" bleeds between retries.
- A crashed run leaves you with no clear way to pick up where you were.
- "Did it actually verify?" is answered by re-reading the chat log.

`oa` is the supervisor layer that solves these directly:

| Pain | `oa`'s answer |
|---|---|
| Agent drift between steps | Four-gate verify pipeline after every step |
| Dirty worktree on retry | `git reset --hard HEAD && git clean -fdx` between attempts (ADR-0003) |
| Mid-run crash | Pidfile + `run.resume` event; next `oa rerun` rewinds and re-enters |
| "What actually happened last night?" | Structured `events.jsonl` + auto-rendered `SUMMARY.md` |
| Agent lock-in | Single `AgentAdapter` interface; adapters for claude, codex, opencode |

---

## Features

- **Worktree-per-task isolation.** Every task checks out on `oa/<slug>-<id>`
  branched from `main`. Your working tree is never touched.
- **Four-gate verify pipeline** per step: tail-message protocol
  (`oa-status` fenced block) → commit-since-step-start → user-supplied
  verify command → AI reviewer. Any gate fails → fix-loop or mark blocked.
- **Fix-loop with context injection.** Reviewer findings are spliced into
  the next attempt's prompt, so the agent sees exactly what to address.
- **Structured event stream.** `runs/<planId>/events.jsonl` with 31 typed
  event kinds (Zod-validated via `EventSchema`). One line per event,
  append-only, `O_APPEND`-atomic.
- **Clean resume.** Detect stale pidfile → rewind in-flight worktrees →
  flip mid-step progress back to `pending` → emit `run.resume` → re-enter
  the supervisor loop. No manual untangling.
- **Detached daemon.** `oa run --detach` spawns a long-lived supervisor
  with its own pidfile and AF_UNIX control socket. Close the shell,
  close the laptop — it keeps working.
- **Operator control socket.** `oa status` / `oa stop [--now]` talk JSON
  over a local socket; the supervisor answers with live step/attempt
  snapshots or graceful/forced shutdown.
- **Atomic-everything.** Temp+rename for every disk write, schema-versioned
  JSON, single-writer convention per per-task state file.
- **Morning report.** Auto-rendered `SUMMARY.md` per run — task outcomes,
  step tables, open P0/P1 issues, links to per-attempt prompts and logs.
- **Compact-recovery hook.** When Claude Code auto-compacts a session,
  a `SessionStart[compact]` hook re-injects the task context
  (`PROGRESS.md`, current prompt, step pointer) so the agent resumes
  without losing its place. Installed automatically by
  `oa shims install` (ADR-0015).
- **Stall detection.** Soft/hard attempt thresholds give operators an early
  warning before a step exhausts its budget, and inject a P0-styled stall
  warning into the agent's prompt so it can self-correct or escalate.
- **Error budget.** Optional plan-level circuit-breaker (`warnAfter` /
  `stopAfter`) that stops scheduling tasks once too many steps are blocked,
  preventing systematic failures from wasting compute.
- **Sandbox-exec isolation.** On macOS, `oa run --sandbox` wraps each
  adapter subprocess in a `sandbox-exec` Seatbelt profile — kernel-level
  filesystem confinement that prevents the agent from reading secrets or
  writing outside the worktree. Opt-in for v0.2 (ADR-0016).
- **Multi-agent.** One CLI, three executors. Pick your executor + reviewer
  independently per task; mix claude-opus for the hard parts and
  codex/opencode for the grind.

---

## Install

Requires **Node ≥ 22** (for JSON import attributes).

### From npm (recommended)

```sh
pnpm add -g @soulerou/oa-cli
# or: npm install -g @soulerou/oa-cli
```

Verify:

```sh
oa --version
oa --help
```

### From source

```sh
git clone https://github.com/a20185/OvernightAgent.git
cd OvernightAgent
pnpm install
pnpm -r build
pnpm --filter @soulerou/oa-cli link --global   # makes `oa` available on PATH
```

### Host-agent shims (optional, recommended)

Drive `oa` from inside your coding agent with slash commands — one command
copies the bundled shim markdown into each host's convention-specific dir:

```sh
oa shims install --host all                # installs all three with host defaults
oa shims install --host claude             # project scope: ./.claude/{commands,skills}/
oa shims install --host claude --scope user  # user scope:    ~/.claude/{commands,skills}/
oa shims install --host codex              # ~/.codex/prompts/
oa shims install --host opencode           # ~/.config/opencode/commands/
oa shims install --host all --dry-run      # preview without writing
oa shims install --host claude --force     # overwrite local edits
```

You now get `/oa-intake`, `/oa-queue`, `/oa-plan`, `/oa-status` inside
your host agent.

**Compact-recovery hook (Claude Code).** When installed for the `claude`
host, `oa shims install` also merges a `SessionStart[compact]` hook into
`.claude/settings.json`. This hook fires automatically whenever Claude Code
auto-compacts a session mid-task. It re-injects the current task context
(`PROGRESS.md`, prompt path, and step pointer) so the agent can resume
without losing its place. The hook is keyed by the sentinel
`# oa:hook=compact-recovery:v1` — re-running `oa shims install` will
upgrade it in-place without duplicating entries.

---

## Quick start

Five commands from zero to a running overnight queue:

```sh
# 1. Submit a task (via the /oa-intake shim or by hand with a JSON payload)
oa intake submit --payload-file /tmp/task-one.json      # prints: t_2026-04-20_0001

# 2. Queue it
oa queue add t_2026-04-20_0001

# 3. Seal the plan
oa plan create --from-queue --budget 28800             # prints: p_2026-04-20_0001

# 4. Launch detached
oa run --detach p_2026-04-20_0001

# 5. Go to bed.  In the morning:
oa status                                              # or tail the log:
oa tail                                                # live events, pretty-printed
cat $OA_HOME/runs/p_2026-04-20_0001/SUMMARY.md
```

If anything crashed mid-run, pick up where you left off:

```sh
oa rerun p_2026-04-20_0001                             # or --detach
```

---

## How it works

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   intake    │───▶│    queue    │───▶│    plan     │───▶│   run(s)    │
│  submit     │    │   add/ls    │    │   create    │    │   --detach  │
└─────────────┘    └─────────────┘    └─────────────┘    └──────┬──────┘
      │                                                          │
      ▼                                                          ▼
  tasks/<id>/                                        runs/<planId>/events.jsonl
  inbox row                                          runs/<planId>/SUMMARY.md
                                                     control.sock + oa.pid
```

Inside a single step, the supervisor drives the following loop until the
step lands `done`, hits the attempt budget, or is marked blocked:

```
  assemblePrompt                          # inject progress, findings, refs, tail protocol
       │
       ▼
  adapter.run ─────────▶ stdout/stderr    # claude -p / codex exec / opencode run
       │
       ▼
  verifyTail ─▶ verifyCommit ─▶ verifyCmd ─▶ reviewer     # four-gate verify
       │                                       │
       │                                       ├─▶ issues?  yes ─▶ fix-loop + retry
       ▼                                       ▼           no
  step.end(done)                           step.end(blocked | done)
```

**Event stream (excerpt).** Every state transition writes one JSONL line:

```jsonl
{"ts":"...","kind":"run.start","planId":"p_...","hostInfo":{...}}
{"ts":"...","kind":"task.start","taskId":"t_..."}
{"ts":"...","kind":"step.start","taskId":"t_...","stepN":1}
{"ts":"...","kind":"step.attempt.start","taskId":"t_...","stepN":1,"attempt":1}
{"ts":"...","kind":"step.verify.tail.ok","taskId":"t_...","stepN":1,"attempt":1}
{"ts":"...","kind":"step.verify.review.fail","taskId":"t_...","issues":[{"priority":"P1",...}]}
{"ts":"...","kind":"step.attempt.start","taskId":"t_...","stepN":1,"attempt":2}
{"ts":"...","kind":"step.end","taskId":"t_...","stepN":1,"status":"done"}
{"ts":"...","kind":"task.end","taskId":"t_...","status":"done"}
{"ts":"...","kind":"run.stop","reason":"completed"}
```

---

## CLI reference

| Command | What it does |
|---|---|
| `oa intake submit --payload-file <abs>` | Validate + mint taskId + write per-task files |
| `oa intake list [--status <s>]` | Tabular inbox view |
| `oa intake show <id>` | Pretty-print `intake.json` + `steps.json` |
| `oa intake rm <id> -y` | Remove from inbox |
| `oa queue add <ids...>` | Append to the queue |
| `oa queue ls` &nbsp;·&nbsp; `rm <id>` &nbsp;·&nbsp; `clear` | Manage the queue |
| `oa plan create [--from-queue\|--tasks <ids>] [--budget <s>] [--parallel <n>]` | Seal a plan |
| `oa plan show <planId>` &nbsp;·&nbsp; `ls` | Inspect plans |
| `oa run [planId] [--detach] [--dry-run] [--sandbox]` | Run foreground or daemon; or print ordering; `--sandbox` wraps adapter spawns in macOS sandbox-exec |
| `oa stop [planId] [--now]` | Graceful stop (or force with `--now`); socket → pidfile fallback |
| `oa status [planId] [--json]` | Live snapshot from the control socket, or events-derived |
| `oa tail [planId] [--raw] [--once]` | Follow `events.jsonl` (pretty or verbatim) |
| `oa rerun <planId> [--detach]` | Resume after crash / stop; rewinds in-flight worktrees |
| `oa summary <planId> [--stdout]` | (Re-)render `SUMMARY.md` from events |
| `oa archive <id>` | Move a task or run folder to `_archive/` |
| `oa shims install [--host <h>] [--scope <s>] [--dry-run] [--force]` | Copy bundled slash-command markdown into the host's convention dir |

Run `oa <cmd> --help` for the full option list on any subcommand.

---

## State layout

The one-and-only root directory: `$OA_HOME` (defaults to `$HOME/.oa/`).

```
$OA_HOME/
├─ tasks.json                        # inbox index (every task, any status)
├─ queue/queue.json                  # FIFO id list
├─ tasks/<taskId>/                   # per-task files
│   ├─ intake.json                   # the full sealed submission
│   ├─ steps.json                    # parsed top-level steps
│   ├─ HANDOFF.md                    # human-readable context block
│   ├─ PROGRESS.md                   # live step status table
│   ├─ FINDINGS.md                   # append-only notes from the agent
│   ├─ source-plan.md                # verbatim markdown submitted at intake
│   └─ refs/                         # materialized references (ADR-0007)
├─ worktrees/<taskId>/               # `git worktree add` target; branch `oa/<slug>-<id>`
├─ plans/<planId>.json               # sealed plan (immutable after seal)
├─ runs/<planId>/
│   ├─ events.jsonl                  # canonical event stream
│   ├─ SUMMARY.md                    # auto-rendered morning report
│   ├─ oa.pid                        # daemon pidfile
│   ├─ control.sock                  # AF_UNIX control socket
│   └─ <taskId>/step-NN/attempt-NN/
│       ├─ prompt.md                 # full assembled prompt
│       ├─ stdout.log                # captured agent stdout
│       └─ stderr.log                # captured agent stderr
└─ _archive/                         # `oa archive` destination
```

Every JSON file carries `schemaVersion: 1`. Every write is `writeFileAtomic`
(temp + rename). Schemas are Zod, `.strict()` for closed shapes.

**Environment variables set by the supervisor per adapter spawn:**

| Variable | Purpose |
|---|---|
| `OA_HOME` | State root (default `$HOME/.oa/`). Override to isolate test runs. |
| `OA_TASK_DIR` | Absolute path to the current task's directory under `$OA_HOME/tasks/<taskId>/`. Used by compact-recovery hook to re-read `PROGRESS.md`. |
| `OA_CURRENT_PROMPT` | Absolute path to the current attempt's `prompt.md`. Used by compact-recovery hook to re-inject the full prompt after compaction. |
| `OA_RESUME` | Set to `1` when the supervisor entry is invoked in resume mode (`oa rerun`). |

---

## Architecture

`oa` is a pnpm monorepo published under the `@soulerou` scope:

| Package | Role |
|---|---|
| [`@soulerou/oa-core`](packages/oa-core) | Schemas, paths, id mint, atomic JSON, worktree manager, intake parser, verify pipeline, fix-loop, events reader/writer, supervisor (`runPlan` + `resumePlan`), daemon launcher, pidfile, control socket, SUMMARY renderer |
| [`@soulerou/oa-cli`](packages/oa-cli) | Commander-based CLI; every subcommand wraps an `@soulerou/oa-core` API. Bundles the host-agent shims under `dist/shims/` and exposes them via `oa shims install`. |
| [`@soulerou/oa-adapter-claude`](packages/oa-adapter-claude) | Headless `claude -p` invoker + `session_id` parser (stream-json) |
| [`@soulerou/oa-adapter-codex`](packages/oa-adapter-codex) | Headless `codex exec` invoker |
| [`@soulerou/oa-adapter-opencode`](packages/oa-adapter-opencode) | Headless `opencode run` invoker |
| [`packages/oa-shims/{claude,codex,opencode}`](packages/oa-shims) | Slash-command resource bundles — pure markdown, no JS. Source of what `oa shims install` ships. Not published separately. |

The supervisor is agent-agnostic — it depends only on the `AgentAdapter`
interface (ADR-0009) and resolves concrete adapters via a lazy registry.
Adding a fourth executor is a ~60-line adapter package plus a registry
id. Schema-level enum tightening makes accidental misroutes a compile
error.

---

## Design docs & ADRs

Everything interesting was argued out in writing before it was coded:

- [**Design doc**](docs/plans/2026-04-18-overnight-agent-taskmanager-design.md) — full §1–§8 system design
- [**Implementation plan**](docs/plans/2026-04-18-overnight-agent-taskmanager-implementation.md) — the 13-phase roadmap this repo was built against
- [**ADRs 0001–0016**](docs/adr/) — every major decision with context + alternatives:

| ADR | Topic |
|---|---|
| 0001 | Branch and commit hygiene |
| 0002 | Worktree per taskList + absolute paths |
| 0003 | Clean rewind on resume |
| 0004 | Verification pipeline + fix loop |
| 0005 | Runs as events.jsonl + summary |
| 0006 | Context injection per step |
| 0007 | References tiered handling |
| 0008 | Agent tail-message protocol |
| 0009 | AgentAdapter interface |
| 0010 | Process model — detached supervisor |
| 0011 | Strategy as orthogonal toggles |
| 0012 | Daemon control via Unix socket |
| 0013 | ESLint path-discipline enforcement gaps |
| 0014 | Scoped npm publish, cycle break, bundled shims |
| 0015 | Harness hardening: compact-recovery hook, stall detection, error budget |
| 0016 | macOS sandbox-exec profile around adapter runs |

---

## Development

```sh
pnpm -r build        # compile every package (oa-cli also bundles shims)
pnpm -r test         # vitest — 488 tests across 5 packages
pnpm -r lint         # eslint
pnpm -r typecheck    # tsc --noEmit
```

### Release

```sh
pnpm version:patch      # or version:minor / version:major — bumps all 5 packages together
pnpm release:dry-run    # show what `pnpm -r publish` would upload
pnpm release            # four-gate verify + `pnpm -r publish --access public`
```

pnpm refuses to publish from a dirty working tree; commit first. The scope
`@soulerou` must be owned by the publishing npm account. See
[ADR-0014](docs/adr/0014-scoped-publish-and-bundled-shims.md).

### House rules

- **Absolute paths at every worktree API boundary.** `assertAbs(p)` is
  mandatory; ESLint bans bare `path.join` in `**/worktree*.ts` and
  `**/paths*.ts` (use `path.resolve`). See ADR-0002 + ADR-0013.
- **Atomic writes only.** `writeJsonAtomic` / `writeFileAtomic` (temp +
  rename). Never `fs.writeFile` the target directly.
- **Schema-versioned JSON.** Every on-disk shape carries `schemaVersion: 1`.
- **TDD per task.** Failing test → minimal implementation → passing test
  → single commit. Sabotage-check load-bearing assertions (break prod,
  see the test red, restore).
- **TypeScript 6 + `module: NodeNext` + `verbatimModuleSyntax`** ⇒
  relative imports in `src/` must spell `.js` even though the file is
  `.ts`. `tsc --build . --force` (not `tsc -p . --force`).

### Testing

- Unit + integration tests live next to their subject.
- Integration tests create a tmp `$OA_HOME` in `os.tmpdir()` and
  `rm -rf` it in `afterEach`.
- Cross-process tests fork real Node children to exercise file-lock
  contention and pidfile ownership.

---

## Status — v0.2

All 64 sub-tasks across Phases 0–12 plus v0.2 hardening features are
complete; 488 tests pass.
Published to npm under `@soulerou` (see [ADR-0014](docs/adr/0014-scoped-publish-and-bundled-shims.md)).

**v0.2 adds** (see [ADR-0015](docs/adr/0015-harness-hardening-post-compact-stall-budget.md) +
[ADR-0016](docs/adr/0016-macos-sandbox-exec-profile.md)):

- Compact-recovery hook for Claude Code (auto-re-injects context after compaction)
- Stall detection with soft/hard attempt thresholds + `step.stall` event
- Plan-level error budget (`warnAfter` / `stopAfter`) with `plan.budget.warn` +
  `plan.budget.exhausted` events
- `skipped` task status for budget-exhausted tasks
- macOS sandbox-exec isolation (`oa run --sandbox`)
- Supervisor-set env vars `OA_TASK_DIR` + `OA_CURRENT_PROMPT` per adapter spawn

**Known v0 limits** (slated for post-v0 follow-up):

- `parallel.max > 1` is accepted by the schema but the supervisor is
  sequential. Two tasks never run concurrently in v0.
- `runs/<planId>/reviewer-default-prompt.md` is materialized once per
  run — would race if parallel mode lands. Add a per-task suffix then.
- ADR-0008 promised `oa-core/prompts/protocol-status.md` +
  `protocol-review.md`; blocks are currently inlined as constants in
  `verify/context.ts` + `verify/review.ts`. Deferred (see the ADR).
- `oa shims` has no `uninstall` / `update` subcommands; reversal is
  manual `rm`. v0 scope (see ADR-0014 follow-ups).

See [`HANDOFF.md`](HANDOFF.md) + [`PROGRESS.md`](PROGRESS.md) for the
session-level audit trail.

---

## License

Released under the [MIT License](LICENSE). Copyright © 2026 Souler Ou.
