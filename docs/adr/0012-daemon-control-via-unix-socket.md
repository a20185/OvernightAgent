# ADR-0012 — Daemon control via Unix domain socket (supersedes the SIGUSR1 part of ADR-0010)

**Status:** Accepted
**Date:** 2026-04-18
**Supersedes (in part):** ADR-0010 — replaces the SIGUSR1 force-stop signal with a control socket. Pidfile + SIGTERM + foreground SIGINT remain unchanged.

## Context

ADR-0010 specified `SIGUSR1` for force-stop. While drafting the implementation plan,
two concrete issues surfaced:

1. Node.js installs its own SIGUSR1 handler that starts the V8 inspector on the
   debug port. User SIGUSR1 handlers can override it but the collision is a
   well-known footgun — easy to break in test environments or under
   `node --inspect`.
2. Future control operations (e.g., querying live status, requesting a
   plan-budget bump, future pause/resume) fit poorly into the unix-signal model
   (one bit per signal, no payload, no acknowledgement).

A Unix domain socket gives us a structured, extensible control channel without
those problems.

## Decision

The supervisor daemon binds a Unix domain socket at
`runs/<planId>/oa.sock` on startup (alongside the pidfile). It listens for
length-prefixed JSON request messages and writes JSON responses, then closes
the connection.

Client commands map to socket messages:

- `oa stop` → `{type:"stop", now:false}` → daemon ACKs, schedules graceful stop.
- `oa stop --now` → `{type:"stop", now:true}` → daemon ACKs, force-stops the
  in-flight agent, leaves worktree as-is, marks step pending, exits.
- `oa status --json` → `{type:"status"}` → daemon replies with current task,
  step, attempt, elapsed times, budget remaining (no tail of events.jsonl
  needed for live state).

The pidfile-based discovery and SIGTERM-on-graceful-failure paths from
ADR-0010 remain. SIGTERM still triggers graceful stop (so `kill <pid>` from
shell works as a backstop). SIGUSR1 is no longer used. SIGINT in foreground
mode triggers graceful stop.

If the socket file is left behind by a crashed daemon, the next supervisor
unlinks it before `bind()` (after confirming the prior pid is dead via the
pidfile-staleness check).

## Consequences

- Positive: extensible control surface; structured payloads with replies; no
  collision with Node's inspector handler; live `oa status` is cheap (no log
  reparsing); future pause/resume/budget-bump fit naturally.
- Negative: one more file to clean up; Unix-only (Windows would need a named
  pipe shim — out of scope for v0).
- Neutral: `oa stop` and `oa status` resolve the socket path via the plan's
  `runs/<planId>/oa.sock`; if absent or `connect()` fails, fall back to
  pidfile + SIGTERM (only meaningful for `stop`, since `status` without the
  daemon falls back to reading `events.jsonl` directly).

## Alternatives Considered

- **Stick with SIGUSR1.** Rejected for the inspector-collision and zero-payload
  reasons.
- **HTTP loopback server.** Rejected: heavier (port allocation, port
  collisions, firewall prompts on macOS); no advantage over a socket file.
- **Named pipe (FIFO).** Rejected: no request/reply semantics; harder to
  multiplex.

## Notes

The control protocol is versioned (`schemaVersion` in every message) so the
client/daemon pair can evolve independently. v0 ships exactly the three message
types listed above.
