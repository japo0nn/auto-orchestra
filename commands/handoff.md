---
description: Write a short state file .claude/handoff.md (goal, decisions, done, remaining, key files, open questions) so a new session or a compaction can continue cheaply
---

Write `.claude/handoff.md` for the current work. Hard limit: about 60 lines, no code dumps, no tool output.

Use exactly these sections, in this order, only facts from this conversation (say "unknown" instead of guessing):

1. `# Handoff` plus one line with today's date and the git branch (if any).
2. `## Goal`: what the user wants and the acceptance criteria.
3. `## Decisions`: each decision with the reason, one line each.
4. `## Done`: what is finished, with file paths (`path:line` where useful) and what was actually verified (commands and results).
5. `## Remaining`: ordered next steps.
6. `## Key files`: paths with one phrase each.
7. `## Open questions / risks`.

Writing the file: Claude Code treats `.claude/` as sensitive, so write the text to the DRAFT file `handoff.draft.md` in the project root, then run exactly this single command, nothing appended or chained: `node "${CLAUDE_PLUGIN_ROOT}/scripts/claude-save.js" handoff handoff.draft.md` (it moves the draft to `.claude/handoff.md`). If you have no Write/Bash tools (for example you are the orchestrator), compose the complete final text yourself and call `auto-orchestra:coder` with a self-contained prompt: "Write exactly this text, unchanged, to handoff.draft.md in the project root, then run exactly this single command: node \"<path>/scripts/claude-save.js\" handoff handoff.draft.md, then reply with the script output:" followed by the text (use the real script path `${CLAUDE_PLUGIN_ROOT}/scripts/claude-save.js`). Do not ask the coder to summarize anything: it has no context.

Afterwards reply with one line: the path, the line count, and "start the next session with: read .claude/handoff.md". Do not paste the file content back. $ARGUMENTS
