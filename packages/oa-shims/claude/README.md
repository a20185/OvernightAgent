# OvernightAgent shim for Claude Code

## Install via npm (recommended)

```sh
oa shims install --host claude                 # ./.claude/{commands,skills}/
oa shims install --host claude --scope user    # ~/.claude/{commands,skills}/
oa shims install --host claude --force         # overwrite local edits
```

## Install from source

```sh
# Symlink from a repo checkout — useful if you want to edit the markdown live.
mkdir -p .claude/commands .claude/skills
ln -s "$(pwd)/packages/oa-shims/claude/commands"/*.md .claude/commands/
ln -s "$(pwd)/packages/oa-shims/claude/skills/oa-intake" .claude/skills/oa-intake
```

## Available commands

- `/oa-intake <plan-path-or-inline>` — Q&A-driven intake submission.
- `/oa-queue [add|ls|rm|clear]` — manage the queue.
- `/oa-plan [--from-queue|...]` — seal a plan from the queue.
- `/oa-status [planId]` — live daemon status.

## Requirements

- `oa` CLI installed on PATH (see repo root README or `pnpm add -g @soulerou/oa-cli`).
- `$OA_HOME` set if you want a non-default state dir.
