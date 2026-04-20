# /oa-intake — opencode binding

Same intake Q&A as the Claude Code shim. Write JSON to
`/tmp/oa-intake-<ts>.json` and run:

```sh
oa intake submit --payload-file /tmp/oa-intake-<ts>.json
```

Invoke as `/oa-intake <path-or-inline>`.
