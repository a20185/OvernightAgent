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

## Compact-recovery hook

When `oa shims install --host claude` runs, it also merges a hook into
`.claude/settings.json` (project scope) or `~/.claude/settings.json` (user
scope). The hook lives under `hooks.SessionStart` with the matcher `"compact"`
and fires whenever Claude Code auto-compacts a session.

**What it does:** the hook checks for `OA_TASK_DIR` (set by the supervisor).
If present, it prints the task's `PROGRESS.md` and points the agent at the
current prompt file (`$OA_CURRENT_PROMPT`), so the agent can pick up exactly
where it left off instead of starting over.

**Upgrading:** the hook command is tagged with the sentinel
`# oa:hook=compact-recovery:v1`. Re-running `oa shims install` will find
and replace the old hook in-place — no duplicates, no manual editing needed.

## Requirements

- `oa` CLI installed on PATH (see repo root README or `pnpm add -g @soulerou/oa-cli`).
- `$OA_HOME` set if you want a non-default state dir.
