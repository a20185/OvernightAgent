# OvernightAgent shim for Codex

## Install via npm (recommended)

```sh
oa shims install --host codex         # copies into ~/.codex/prompts/
oa shims install --host codex --force # overwrite local edits
```

Codex is user-scope only in v0 (the prompt dir is `~/.codex/prompts/`, not
project-local). `--scope project` is refused with a clear error.

## Install from source

```sh
mkdir -p ~/.codex/prompts
cp packages/oa-shims/codex/commands/*.md ~/.codex/prompts/
```

Adjust the destination if your Codex install reads prompt bindings from a
different path (check the Codex docs — binding layout has moved between
versions).

## Available commands

`@oa-intake`, `@oa-queue`, `@oa-plan`, `@oa-status`. All delegate to the
installed `oa` CLI, so requires `oa` on PATH.
