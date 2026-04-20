# /oa-queue — Codex binding

Thin wrapper for `oa queue`. Fetch the inbox for context, then shell out:

```sh
oa intake list --status pending
oa queue $ARGUMENTS
```

Accepts: `add <ids...>`, `ls`, `rm <id>`, `clear`.
