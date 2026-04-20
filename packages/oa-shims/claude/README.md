# OvernightAgent shim for Claude Code

Install the slash commands:

```sh
# From a project root where you want `/oa-intake` etc. available:
mkdir -p .claude/commands
ln -s "$(pwd)/packages/oa-shims/claude/commands"/*.md .claude/commands/

# And the skill, if the host separates skills from commands:
mkdir -p .claude/skills
ln -s "$(pwd)/packages/oa-shims/claude/skills/oa-intake" .claude/skills/oa-intake
```

Or copy the files instead of symlinking if you want to edit them locally.

## Available commands

- `/oa-intake <plan-path-or-inline>` — Q&A-driven intake submission.
- `/oa-queue [add|ls|rm|clear]` — manage the queue.
- `/oa-plan [--from-queue|...]` — seal a plan from the queue.
- `/oa-status [planId]` — live daemon status.

## Requirements

- `oa` CLI installed on PATH (see repo root README).
- `$OA_HOME` set if you want a non-default state dir.
