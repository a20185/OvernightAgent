# ADR-0010 — Detached supervisor daemon with pidfile; graceful + force stop

**Status:** Accepted
**Date:** 2026-04-18
**Related:** design § 4.4, § 4.7; ADR-0009 (adapter)

## Context

"Overnight" implies the user closes their terminal or shuts the laptop lid. A
plain foreground process tied to the user's shell would die. The user must also
be able to stop a run cleanly (finish the in-flight step) or forcefully (kill the
agent now).

## Decision

`oa run` has two modes:

- **Foreground** (`oa run <planId>`) — process stays attached to the terminal.
  For development, debugging, dry-runs.
- **Detach** (`oa run <planId> --detach`) — forks a supervisor daemon that
  outlives the launching shell, writes its pid to `runs/<planId>/oa.pid`, and
  redirects stdout/stderr to `events.jsonl` (and per-attempt capture files).
  Exits the launcher with the daemon's pid printed.

The daemon installs signal handlers:

- **SIGTERM** → graceful stop. Stops accepting new work. If the agent has
  already returned for the in-flight step, finishes the verify pipeline and
  records the step result. Otherwise lets the agent finish, then commits any
  successful step. Writes `run.stop{reason:"user"}` and exits cleanly. Pidfile
  removed.
- **SIGUSR1** → force stop. SIGTERMs the agent subprocess, leaves the worktree
  in whatever state it's in, marks the in-flight step back to `pending`, writes
  `run.stop{reason:"user-now"}`, exits. Pidfile removed.
- **SIGINT** (foreground only) — same as SIGTERM.

`oa stop [--now]` resolves the target plan's pidfile and sends SIGTERM (or
SIGUSR1 with `--now`). Two daemons cannot run the same plan: pidfile acquisition
fails if a live pid is already present.

## Consequences

- Positive: survives terminal close and laptop sleep; clean shutdown semantics;
  no third-party process supervisor required (no tmux/screen/launchd in v0).
- Negative: must implement pidfile lifecycle correctly (stale-pid cleanup on
  resume per ADR-0003); harder to debug than foreground mode (mitigated by
  events.jsonl + `oa tail`).
- Neutral: pause-as-distinct-state (`oa pause` / `oa resume`) is deferred — only
  graceful and force stop in v0.

## Alternatives Considered

- **Foreground only; user wraps in tmux/nohup themselves.** Rejected: worse UX,
  pushes terminal-multiplexer choice onto users.
- **Always-on system daemon (launchd).** Rejected for v0: installation and
  uninstallation friction; overkill for single-user single-machine.
- **Pause/resume as first-class states.** Deferred — adds a third runtime state
  and resume semantics that v0 doesn't yet need.

## Notes

Stale pidfile detection: at startup, read `oa.pid` and `kill -0 <pid>` to test
liveness; if dead, delete and proceed. This is also how `oa rerun` recovers
from machine reboots that interrupted a daemon mid-flight.
