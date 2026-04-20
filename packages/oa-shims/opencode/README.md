# OvernightAgent shim for opencode

## Install via npm (recommended)

```sh
oa shims install --host opencode         # copies into ~/.config/opencode/commands/
oa shims install --host opencode --force # overwrite local edits
```

Opencode is user-scope only in v0. `--scope project` is refused with a clear error.

## Install from source

```sh
mkdir -p ~/.config/opencode/commands
cp packages/oa-shims/opencode/commands/*.md ~/.config/opencode/commands/
```

If your opencode install reads commands from a different path (check
`opencode commands --help`), adjust the destination accordingly.

## Available commands

`/oa-intake`, `/oa-queue`, `/oa-plan`, `/oa-status`. Requires `oa` on PATH.
