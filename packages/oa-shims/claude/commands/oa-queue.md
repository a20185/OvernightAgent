---
description: Manage the OvernightAgent queue (add / list / remove / clear)
argument-hint: "[add <ids...> | ls | rm <id> | clear]"
allowed-tools: Bash
---

Thin wrapper around `oa queue`.

Run the user's subcommand verbatim:

```bash
oa queue $ARGUMENTS
```

For `add` — fetch the current inbox first so the user sees available task ids:

```bash
oa intake list --status pending
```

then invite them to select which ids to queue and shell out to `oa queue add`.
