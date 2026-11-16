---
description: Build or refresh the compact repository map .claude/repomap.md (stack auto-detected). Flags --refresh (incremental) and --rebuild (from scratch)
argument-hint: [--refresh | --rebuild]
---

Maintain the compact repository map `.claude/repomap.md` (hard limit: about 150 lines). The stack is unknown in advance: detect it from files (manifests, lockfiles, build files, CI config), assume nothing.

Mode from the arguments `$ARGUMENTS`:
- `--rebuild`: build from scratch (section A).
- `--refresh`: incremental update (section B). If the map does not exist, fall back to A.
- no flag: A if the map is missing or `.claude/repomap.stale.json` says `rebuild: true`; B if it exists; if it exists and nothing is flagged, say it is fresh and stop.

## A. Rebuild
1. Call `auto-orchestra:scout` (read-only) with this self-contained prompt: "Survey the repository in the current directory and return a compact map, maximum 140 lines, as Markdown with these sections: Purpose (2-3 lines); Stack (languages, frameworks, package managers, detected from manifests); Layout (top-level and important second-level directories, one phrase each, ignoring dependency/build/VCS folders); Entry points (main files, CLIs, servers, with path:line); Key modules and how they depend on each other (short 'A -> B' edges); Conventions (naming, testing layout, error handling, config); Commands (build, test, lint, run, from manifests/CI/README; mark inferred ones); Gotchas. Every claim needs a path. Use Glob/Grep/Read and read-only git commands only. Write 'unknown' where you do not know."
2. Save it. Claude Code treats `.claude/` as a sensitive path, so write the scout's text unchanged to the DRAFT file `repomap.draft.md` in the project root (Write directly if you have it; otherwise call `auto-orchestra:coder` with the exact text and that instruction), then run exactly this single command, nothing appended or chained: `node "${CLAUDE_PLUGIN_ROOT}/scripts/claude-save.js" repomap repomap.draft.md`.
3. The script moves the draft to `.claude/repomap.md`, inserts the header `<!-- repomap head=<commit|none> date=<ISO> -->` and removes the stale flag.

## B. Refresh (incremental)
1. Read `.claude/repomap.stale.json` if present (counts and changed paths) and the first line of the map (`head=`).
2. Call `auto-orchestra:scout` with: "Read .claude/repomap.md. Its first line holds the commit it was built at. Run read-only `git diff --name-status -M <head>` and `git status --porcelain` (if there is no commit, list files newer than the map). Inspect only the changed files as needed. Return ONLY complete replacement blocks (`## Section` heading plus new body) for the sections that these changes affect, plus a list of lines to delete because their paths no longer exist. Do not rebuild untouched sections; keep the whole map under about 150 lines."
3. Apply the blocks to the current map content changing nothing else, write the whole updated map to the DRAFT file `repomap.draft.md` in the project root (Write directly, or via `auto-orchestra:coder` with the scout's text verbatim), then run exactly this single command, nothing appended: `node "${CLAUDE_PLUGIN_ROOT}/scripts/claude-save.js" repomap repomap.draft.md` (it installs the draft, stamps the commit and clears the stale flag).

If many referenced paths turn out to be missing, do A instead.

Finally reply with the path, line count, detected stack and which sections changed, in a few lines. Do not paste the map.

Hooks involved: SessionStart reminds that the map exists and whether it is stale; a PostToolUse watcher writes `.claude/repomap.stale.json` when changes look structural. Neither starts agents.
