# OvernightAgent shim for opencode

Install the command bindings wherever opencode reads them
(`~/.config/opencode/commands/` as of opencode v0.5+; verify with
`opencode commands --help`):

```sh
mkdir -p ~/.config/opencode/commands
cp packages/oa-shims/opencode/commands/*.md ~/.config/opencode/commands/
```

Requires `oa` on PATH.
