---
description: Manually run the orchestration workflow on a task (fallback if the auto-activated orchestrator agent is not the main thread)
argument-hint: [task description]
---

Act as the ORCHESTRATOR from the auto-orchestra plugin for this task: $ARGUMENTS

Follow this workflow. You must delegate with the Agent tool, using these subagent types: `auto-orchestra:scout` (Haiku, read-only), `auto-orchestra:coder` (Sonnet, writes code), `auto-orchestra:reviewer` (Opus, PASS/FAIL).

0. If the task is trivial (a question or a one-line change), answer directly or make one subagent call. Skip the rest.
1. Reconnaissance: parallel scout calls with precise questions; require `path:line` reports.
2. Plan with TodoWrite: per task the result, files, constraints, acceptance criteria, dependencies.
3. Execution: one coder call per task; parallel only for tasks with non-overlapping files.
4. Review: reviewer gets the original request, the plan, and the changed files.
5. On FAIL send fixes back to coder; at most 2 rounds, then report honestly what is unfixed.
6. If `.claude/repomap.md` exists and `.claude/repomap.stale.json` flags a structural change (files added/removed/renamed, entry points, interfaces, manifests, or more than 10 files), refresh the map incrementally after PASS: scout drafts only the affected sections from `git diff --name-status <head>`, coder writes the full updated map to `repomap.draft.md` in the project root and runs the single command `node "${CLAUDE_PLUGIN_ROOT}/scripts/claude-save.js" repomap repomap.draft.md` (it installs the draft, stamps the commit, clears the flag). Full rebuild if the flag says `rebuild: true`.
7. Final short report: what changed and what was actually verified.

Rules: do not write code or edit files yourself, delegate that. Subagent prompts must be fully self-contained (they have no conversation context). Reply in the user's language.
