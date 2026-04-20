---
name: oa-intake
description: Convert a markdown task plan into an OvernightAgent intake payload via a two-stage Q&A, then submit it via `oa intake submit`.
---

# oa-intake skill

Used by `/oa-intake` slash command. See `../../commands/oa-intake.md` for the
full Q&A script.

Invariants:
- Refuse if the source plan has zero top-level `## Step N` headings.
- All paths collected via Q&A must be absolute (reject relative with a clear
  message and ask again).
- The final submission is a JSON file + `oa intake submit --payload-file`;
  never pass the payload as `--payload <inline>` (ARG_MAX risk on long plans).
