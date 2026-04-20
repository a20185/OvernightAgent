# OvernightAgent shim for Codex

Install the slash command bindings:

```sh
mkdir -p ~/.codex/prompts
cp packages/oa-shims/codex/commands/*.md ~/.codex/prompts/
```

Adjust the destination to wherever your Codex install reads prompt bindings
(check the Codex docs — binding layout has moved between versions).

## Available commands

`@oa-intake`, `@oa-queue`, `@oa-plan`, `@oa-status`. All delegate to the
installed `oa` CLI, so requires `oa` on PATH.
