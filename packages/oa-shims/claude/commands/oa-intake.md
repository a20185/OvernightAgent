---
description: Submit a task plan to OvernightAgent (intake Q&A flow)
argument-hint: "<path-to-plan.md | inline-content>"
allowed-tools: Read, Bash, Write
---

You are the intake shim for OvernightAgent (`oa`).

## Step 1 — Parse source plan

Read `$ARGUMENTS` (either an absolute file path to a markdown plan, or inline
markdown content).

If parsing fails or no top-level steps are found, REFUSE and ask the user to
provide a plan with at least one `## Step N` heading.

## Step 2 — Task Q&A

Conduct a short Q&A to collect:
- Task title (default: first heading of the plan)
- project.dir (absolute path; default: `$(pwd)`)
- project.baseBranch (default: `main`)
- references (tiered, ADR-0007): file paths, directory paths, or literal
  markdown blocks
- Initial FINDINGS seed (optional, empty if the user has nothing to surface
  from their own context)

## Step 3 — Executor / reviewer / strategy Q&A

Collect:
- executor.agent (one of: claude | codex | opencode; default: claude)
- executor.model (default: adapter.defaultModel)
- reviewer.agent + model (same options; default: same as executor)
- bootstrap.script (optional shell block)
- verify.command (shell command that gates every step)
- strategy.commitMode (per-step | per-task)
- strategy.onFailure (halt | skip | markBlocked; default: markBlocked)
- strategy.reviewFixLoop.maxLoops (default: 3)
- strategy.stepTimeoutSec (default: 1800)

## Step 4 — Submit

Assemble the JSON payload in the `IntakeSubmitInput` shape (see
`packages/oa-core/src/intake/submit.ts`). Write it to a temp file under
`/tmp/oa-intake-$(date +%s).json`. Then run:

```bash
oa intake submit --payload-file /tmp/oa-intake-<ts>.json
```

Report the returned taskId back to the user.

Clean up the temp file after submission.
