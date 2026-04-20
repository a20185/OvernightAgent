# /oa-intake — Codex binding

Same behavior as the Claude Code shim under `oa-shims/claude/commands/oa-intake.md`.
Follow the three-step intake Q&A; write the JSON payload to
`/tmp/oa-intake-<ts>.json`; run:

```sh
oa intake submit --payload-file /tmp/oa-intake-<ts>.json
```

Report the taskId back to the user, then delete the temp file.

## Slash-command invocation

```
@oa-intake <path-or-inline>
```

Codex resolves the mention and runs this prompt with `$ARGUMENTS` bound to the
raw argument string.
