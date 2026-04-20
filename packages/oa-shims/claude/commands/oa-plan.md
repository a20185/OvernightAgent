---
description: Seal a plan from the queue and optionally start the supervisor
argument-hint: "[--from-queue | --tasks <ids...>] [--budget <sec>] [--parallel <n>]"
allowed-tools: Bash
---

Thin wrapper around `oa plan create`.

1. Preview the queue:

```bash
oa queue ls
```

2. Ask the user whether to seal the entire queue (`--from-queue`) or pick a
   subset (`--tasks`). Confirm budget / parallel overrides.

3. Run:

```bash
oa plan create $ARGUMENTS
```

4. Report the new planId. Ask whether to start immediately with
   `oa run --detach <planId>` or keep it sealed.
