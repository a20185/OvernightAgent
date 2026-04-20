---
description: Show live OvernightAgent status (or last known from events)
argument-hint: "[planId]"
allowed-tools: Bash
---

Run:

```bash
oa status --json $ARGUMENTS
```

Render the JSON as a compact human-readable summary:
- Plan id, live/snapshot source, current task, current step, elapsed.
- If the daemon is not running, report the last event kind and timestamp.

If the user omits the planId, `oa status` auto-selects the latest
running or most recent plan.
