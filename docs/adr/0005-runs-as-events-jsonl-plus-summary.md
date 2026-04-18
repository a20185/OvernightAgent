# ADR-0005 — One events.jsonl per plan; SUMMARY.md rendered from it

**Status:** Accepted
**Date:** 2026-04-18
**Related:** design § 3.6, § 6

## Context

The user wants per-plan logs recording per-taskList/step progress, sessionIds,
outputs, and errors — readable in the morning and machine-tailable during a run.
They also want a human summary file ("read in the morning") and explicitly
deferred all active-push notification channels (webhook/email/macOS) to post-v0.

## Decision

For each plan execution, the supervisor maintains one append-only structured log:

```
~/.config/overnight-agent/runs/<planId>/events.jsonl
```

Each line is one JSON object: `{ "ts": <iso8601>, "kind": <event-name>,
...kind-specific fields }`. The taxonomy starts with the events listed in design
§ 3.6 and is extensible; new event kinds may be added without breaking older log
readers.

Per-step prompts and captured stdout/stderr live alongside the log at
`runs/<planId>/steps/<taskId>/<stepN>/<attempt>/`, referenced from `events.jsonl`
events by relative path. The events log itself is the authoritative state — it
must be sufficient to reconstruct what happened even if the prompt and capture
files are deleted.

**`SUMMARY.md`** is rendered from `events.jsonl` automatically on plan completion
and on demand via `oa summary <planId>`. It contains:

- Per-taskList outcome table (status, duration, commits, blocked reason).
- Per-step status with fix-loop iteration counts.
- Open P0/P1 issues for any blocked steps.
- Links (relative paths) to per-step `prompt.md` / `stdout.log` for inspection.

## Consequences

- Positive: machine-tailable during a run (`oa tail` is a JSONL pretty-printer);
  fully introspectable post hoc; SUMMARY.md is regenerable so we don't have to
  worry about losing it; one source of truth simplifies debugging.
- Negative: events.jsonl can grow large for long plans; deferred auto-prune
  handles long-term cleanup.
- Neutral: schema evolution requires new event kinds, never editing existing kinds.

## Alternatives Considered

- **Plain text logs.** Rejected: hard to reconstruct structured state (sessionIds,
  exit codes, fix-loop iterations) from free-form text.
- **SQLite database.** Rejected: heavier dependency, harder to grep/inspect by
  hand, overkill for v0 throughput.
- **Cloud sink (e.g., Loki).** Rejected: explicit v0 scope decision is local-only.

## Notes

`oa status --json` reads the latest events to compute current task/step/attempt
state — no separate state file needed for live introspection.
