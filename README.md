# auto-orchestra

Automatic model orchestration for Claude Code, plus token-saving hooks that work on any project and any language.

You type a task; the main agent plans, delegates and verifies. Works the same in the CLI, Claude Code Desktop and the VS Code extension, because all read the same plugin and settings files (only the CLI was exercised, see [Verify yourself](#what-you-should-verify-yourself)).

| Role | Agent | Model | Tools |
|---|---|---|---|
| Orchestrator (main thread) | `auto-orchestra:orchestrator` | Opus | Agent, Read, Grep, Glob, TodoWrite (no Edit/Write/Bash) |
| Scout | `auto-orchestra:scout` | Haiku | Read, Grep, Glob, Bash (read-only by prompt) |
| Coder | `auto-orchestra:coder` | Sonnet | Read, Grep, Glob, Edit, Write, Bash |
| Reviewer | `auto-orchestra:reviewer` | Opus | Read, Grep, Glob, Bash (tests, git diff; no Edit/Write) |

Workflow: repo map check, parallel scouting, plan in TodoWrite, coder per task (parallel only on disjoint files), reviewer PASS/FAIL (by diff first), up to 2 fix rounds, map upkeep if the change was structural, short report of what changed and what was actually verified. Trivial requests skip all of it.

## Install

```
/plugin marketplace add <owner>/<repo>        # or: /plugin marketplace add ./   (local checkout)
/plugin install auto-orchestra@auto-orchestra-marketplace
```

## Activation (important)

The plugin ships `settings.json` with `"agent": "auto-orchestra:orchestrator"`. Claude Code 2.1.326 still honors it but marks a plugin-provided `agent` as **deprecated** ("will stop applying in a future release"). For a durable setup put the same line in your own settings:

```json
// ~/.claude/settings.json (all projects) or .claude/settings.json (one project)
{ "agent": "auto-orchestra:orchestrator" }
```

Or per session: `claude --agent auto-orchestra:orchestrator`. Fallback: `/auto-orchestra:orchestrate <task>` runs the orchestrator prompt on the session's model (tool restrictions are not enforced there; the subagents still use their own models).

## Token-saving features

All hooks are Node.js scripts (stdlib only), registered in `hooks/hooks.json` in exec form (`node <script>`), fail-open, and individually switchable.

**Runtime choice: Node.** The command is spelled `node` on macOS, Linux and Windows; on Windows `python3` is often a Store stub or missing, and `python` vs `py` differs. Node also parses JSON natively. If Node is missing, the hook process fails with a non-2 exit code, which Claude Code treats as non-blocking: the tool call proceeds as normal. Hooks need Node 18+; the tests use `node:test`.

**Fail-open.** Every script catches everything; bad JSON, a broken config, an unreadable file or any exception means: exit 0, no output, the tool runs untouched.

### 1. Noisy Bash output filter (`PostToolUse` Bash)
Output above a threshold is replaced by: first N lines, last M lines, every error/warning-looking line from the omitted middle (with original line numbers, repeats collapsed), and a header with line/char counts. The full output is saved to `<project>/.claude/auto-orchestra/out/bash-*.log` (or the session scratchpad when Claude Code provides one) and the path is in the header, so Claude can `Read` a slice with offset/limit. ANSI codes and progress-bar carriage returns are stripped from the summary. Thresholds: 200 lines / 20k chars for ordinary commands, 60 lines / 6k chars for commands matching `noisyCommands` (install, build, test, lint, logs, deploy words, stack-neutral regexes). A summary that is not at least 20% smaller is not used. Readers (`cat`, `grep`, `git diff`...), secret-looking commands (`env`, `printenv`, `.env`, `token`, `secret`...), and background tasks are never touched and nothing is saved for them.

*Mechanism, and why.* I use `PostToolUse` with `updatedToolOutput` (documented: replaces the output before Claude sees it). The command is not modified, so permission rules, auto-mode checks, shell state and the exit code are unaffected. **Limit found in the docs: `PostToolUse` fires only for commands that succeeded.** A command that exits non-zero fires `PostToolUseFailure`, which can only add context, not replace the output. So by default **failed builds/tests are not compressed** (seen in the end-to-end test: a 301-line failing script came through whole).

*Optional `bash.mode: "wrap"` (experimental).* A `PreToolUse` hook rewrites only noisy commands (`updatedInput`) into `{ <command> } >file 2>&1; ec=$?; node compress-cli.js file $ec; (exit $ec)`. It runs in the same shell, so `cd`/`export` persist and the exit code is kept, and it compresses failures too. Costs: the rewritten command no longer matches your `Bash(...)` allow rules, so Claude Code may prompt for permission (in auto mode the changed call may be denied); stdout and stderr are merged; commands containing `exit`, `exec`, `trap` or `set -e` are skipped; it needs a POSIX shell (Git Bash on Windows). Unit-tested (exit code, compression, passthrough), but not exercised end to end under permission prompts. Leave it off unless you accept those trade-offs.

### 2. Read guard (`PreToolUse` Read|Grep|Glob)
- Blocks (or only warns, `mode: "warn"`) reads of: dependency/build/VCS directories (`node_modules`, `vendor`, `bin`, `obj`, `dist`, `build`, `target`, `.venv`, `__pycache__`, `.git`, ...), lock and minified files, archives and binaries (by extension and by NUL-byte sniffing), and anything matched by the project's root `.gitignore`. Images and PDFs stay readable. `.claude/`, `~/.claude` and the session scratchpad are never guarded.
- Files over `maxLines` (1000) read without `limit` are denied with the exact way to read them (`offset`/`limit`, or Grep).
- Repeated identical read of an unchanged file range in one session: a soft warning (added context, never a block).
- Escape hatches: `readGuard.allow` globs; and a call blocked once is let through when repeated unchanged in the same session (`confirmRepeat`).
- Reads only inside the project, `~/.claude` and the scratchpad. Outside them only the file extension is looked at.
- Nested `.gitignore` files are not read (root file only); `bin/`, `obj/`, `build/`, `vendor/` are in the defaults even though some repos keep real sources there: use `allow`.

### 3. Handoff (`/auto-orchestra:handoff`, `PreCompact`, `SessionStart`)
`/auto-orchestra:handoff` makes the agent write `.claude/handoff.md` (about 60 lines: goal, decisions with reasons, done, remaining, key files, open questions). **Difference from the spec:** a hook cannot run the model, so `PreCompact` cannot write that semantic file itself. It does the nearest working thing: it writes a mechanical snapshot `.claude/handoff.auto.md` (branch, commit, uncommitted files, last commits, transcript path; git facts only) and prints guidance that Claude Code adds to the compaction instructions. `SessionStart` only *mentions* an existing handoff (path, age, size); it never injects the content.

### 4. Repository map (`/auto-orchestra:repomap [--refresh|--rebuild]`)
Scout surveys the repo (stack auto-detected from manifests) and returns a map of about 150 lines; it is saved as `.claude/repomap.md` with a header `<!-- repomap head=<commit|none> date=... -->`. Orchestrator and scout prompts read the map first and only fall back to a full walk when it does not answer. `SessionStart` says the map exists and whether it is stale (older than `staleDays`, more than `staleCommits` commits behind, or flagged), without loading it.

**Auto-refresh.** A `PostToolUse` watcher (Edit/Write/Bash and, for the orchestrator which has none of those, `Agent` returns) cheaply runs `git diff --name-status -M <map commit>` plus untracked files (or a bounded mtime walk outside git). If the change looks structural (files added/deleted/renamed, a manifest/build file touched, more than `maxChangedFiles` files, or the map references `driftThreshold`+ paths that no longer exist) it writes `.claude/repomap.stale.json` (reason, counters, sample paths) and gives the main thread **one** line of context per change. It never starts agents and never blocks anything. After the reviewer returns PASS (or earlier if the next steps depend on the map) the **orchestrator decides**; if structural, scout drafts only the affected sections, coder writes the whole updated map to `repomap.draft.md` and runs `node claude-save.js repomap repomap.draft.md`, which moves it into `.claude/`, stamps the commit and removes the flag. `rebuild: true` in the flag means a full rebuild. The stamp also records which uncommitted files the map already reflects, so they are not flagged again. Entry-point file edits are only reported (`entryPointsTouched`); the hook cannot see interface changes, which is why the judgement stays with the orchestrator.

**Differences from the spec.** (a) Scout is read-only by design, so the *write* is done by coder, with scout only drafting the text. (b) Writes under `.claude/` are treated by Claude Code as sensitive (the end-to-end test showed a Write there asked for approval and was denied in headless mode), so agents write a draft in the project root and the script, run through Bash, moves it.

### 5. Context indicator (status line)
`scripts/statusline.js` prints `Opus │ ctx 42% │ $0.31` from the status line JSON (`model.display_name`, `context_window.used_percentage`, `cost.total_cost_usd`), turning yellow at `statusline.warnPercent` (60) and red 20 points higher with the hint `/compact · /auto-orchestra:handoff · or delegate to a subagent`. **Plugins cannot set a status line**, and this plugin never touches yours. `/auto-orchestra:statusline` reports what you have and prints the snippet; with your consent it copies the script to `~/.claude/auto-orchestra/statusline/` (survives plugin updates). Manual setup:

```
node "<plugin dir>/scripts/statusline-install.js" --copy
```
then add to `~/.claude/settings.json`:
```json
{ "statusLine": { "type": "command", "command": "node ~/.claude/auto-orchestra/statusline/statusline.js" } }
```
(on Windows use the absolute path that `--copy` prints). If you already have a `statusLine`, keep yours and merge by hand.

### 6. MCP audit (`/auto-orchestra:mcp-audit`)
Lists MCP servers configured in `~/.claude.json` (user and this project's local scope) and `.mcp.json`, plus servers seen in this project's last 10 session transcripts, with tool-call counts and last use, and recommends unused ones to disable. It reads server names and types only, never `env`, `args` or `headers`, and disables nothing. **Not possible:** per-server size of tool descriptions is not available from files; use `/context` for the real token cost. Plugin and claude.ai connectors that were never called cannot be enumerated from disk; see `/mcp`.

### 7. Diff-first review
`reviewer` starts from `git diff` (or the listed changed files outside git) and reads whole files only when the diff lacks context; orchestrator tells it so.

### 8. Savings report (`/auto-orchestra:savings`)
Hooks append metadata to `.claude/auto-orchestra-stats.jsonl`: event kind, the first two words of the command (never arguments), path, byte/char counts. Never file or output content. The command summarizes all time and the last 7 days. Tokens are **estimates (chars / 4)**; blocked reads are an upper bound (Claude might not have read the whole file).

Recommended `.gitignore` lines for projects using the plugin:
```
.claude/auto-orchestra-stats.jsonl
.claude/auto-orchestra/
.claude/handoff.auto.md
.claude/repomap.stale.json
.claude/repomap.base.json
*.draft.md
```
(`repomap.md` and `handoff.md` can be committed or ignored, your choice.)

### Permission prompts
Slash commands pre-approve their own script with `allowed-tools`. When agents run `claude-save.js` you will be asked once; allow it (or add a rule such as `Bash(node */auto-orchestra/*/scripts/claude-save.js*)`). Agents are told to run it as a single bare command, because a chained `; echo ...` is a second command that needs its own approval.

## Configuration

Optional files, merged over built-in defaults: `~/.claude/auto-orchestra.json` (global), then `.auto-orchestra.json` in the project root (wins). Keys with a wrong type are ignored. Arrays replace the default list; each list also has an `extra*` twin that appends. A JSON Schema is in `auto-orchestra.schema.json` (generated from the code defaults by `node scripts/gen-schema.js`; a test keeps them in sync):

```json
{
  "$schema": "https://raw.githubusercontent.com/<owner>/<repo>/main/auto-orchestra.schema.json",
  "enabled": true,                         // master switch (JSON has no comments: remove these notes)
  "bash": {
    "enabled": true,
    "mode": "post",                        // "post" (safe) | "wrap" (experimental, compresses failures too)
    "minLines": 200, "minChars": 20000,    // ordinary commands
    "noisyMinLines": 60, "noisyMinChars": 6000,
    "head": 15, "tail": 30, "maxMatches": 50, "maxLineLength": 300,
    "saveFull": true, "tmpTtlHours": 24,
    "extraNoisyCommands": ["\\bnx\\b", "\\bbazel\\b"],   // your stack's heavy tools
    "extraNeverFilter": ["^my-report-tool\\b"],
    "extraSecretCommands": ["vault-export"],
    "extraErrorPatterns": ["\\bBUILD FAILED\\b"]
  },
  "readGuard": {
    "enabled": true, "mode": "block",      // "block" | "warn"
    "useGitignore": true, "confirmRepeat": true, "warnRepeatRead": true,
    "maxLines": 1000,
    "extraIgnore": ["generated", "*.snap"],
    "allow": ["vendor/mylib/**"]           // never guarded
  },
  "handoff": { "enabled": true, "writeAutoSnapshot": true, "sessionStartHint": true },
  "repomap": {
    "enabled": true, "staleDays": 14, "staleCommits": 50, "sessionStartHint": true, "suggestWhenMissing": false,
    "autoRefresh": true, "maxChangedFiles": 10, "minStructuralOps": 1, "driftThreshold": 3
  },
  "statusline": { "warnPercent": 60 },
  "stats": { "enabled": true }
}
```

**Turn things off:** `"enabled": false` (everything); `bash.enabled`, `readGuard.enabled`, `handoff.enabled`, `repomap.enabled` (or just `repomap.autoRefresh`), `stats.enabled` per feature. To remove a hook completely, disable the plugin or delete its entry in `hooks/hooks.json`. `AUTO_ORCHESTRA_DEBUG=1` prints hook errors to stderr.

## What may not work

1. **`CLAUDE_CODE_SUBAGENT_MODEL`**. Model precedence is: per-call `model` parameter, the agent's frontmatter `model`, this variable, then the parent's model; so frontmatter wins. With `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` all `model` fields are ignored and every subagent runs on one model. Unset both for the Opus/Sonnet/Haiku split.
2. **Cost.** An Opus main thread is more expensive. Cheaper: set `model: sonnet` in `agents/orchestrator.md` (and optionally the reviewer). The token-saving hooks are what make a long Opus session affordable.
3. **Orchestrator must be the main thread.** Current docs say subagents *can* spawn subagents (up to 3 levels), but the orchestrator still belongs on the main thread: it owns the conversation and the `Agent` tool restriction `Agent(type)` only applies to a main-thread agent.
4. **Prompt-enforced read-only.** Plugin agents ignore `hooks`, `permissionMode`, `mcpServers`. Scout's and reviewer's "no writes" is a prompt rule; for hard enforcement add `permissions.deny` rules.
5. **TodoWrite in `-p` runs** was reported unavailable by the orchestrator (interactive sessions unaffected).
6. **Permissions.** Subagents inherit the session permission mode; expect prompts for Edit/Bash unless allowed. The plugin-provided `agent` setting is deprecated, see Activation.
7. **Hook limits that shaped the design:** `PostToolUse` does not fire on failed commands (so failures are not compressed by default); a hook cannot run the model (so PreCompact writes a mechanical snapshot); `updatedToolOutput` of the wrong shape is silently ignored (the filter copies the original `tool_response` and replaces only `stdout`/`stderr`); a `deny` from the read guard shows up in the transcript as a "hook error" label although it is a deliberate block.

## Verify it works

Orchestration: in a scratch repo with a failing test ask "Fix the failing test, full cycle". The header shows `@auto-orchestra:orchestrator`; the transcript shows parallel `auto-orchestra:scout` calls, then `coder`, then `reviewer`. Headless proof of models:
```
claude --agent auto-orchestra:orchestrator --permission-mode acceptEdits --allowedTools "Bash(python3:*)" \
  -p "<task>" --output-format stream-json --verbose
```
(each `assistant` event has `message.model`; subagent events have `parent_tool_use_id`).

Hooks: run `node --test tests/*.test.js` in the plugin directory (46 tests: fail-open on garbage input for every script, compression with preserved errors and exit code, blocking and explicit allow, gitignore, large files, repeat reads, SessionStart/PreCompact, status line, map flagging/stamping/drift, non-git fallback, schema sync). In a project, run a command that prints 400 lines and look for `[auto-orchestra] output compressed`; try to Read a file under `node_modules/`; then `/auto-orchestra:savings`.

## What you should verify yourself
- VS Code extension and Claude Code Desktop: the plugin was only run in the CLI. Check that the hooks fire (compressed output header, blocked `node_modules` read), that `/auto-orchestra:*` commands appear, and that the `agent` setting applies.
- Windows: exec-form `node` hooks are per the docs, but nothing here ran on Windows. `bash.mode: "wrap"` needs a POSIX shell.
- `bash.mode: "wrap"` under your real permission setup (prompts, auto mode).
- Interactive approval flow for `claude-save.js` and for writes to `.claude/`.
- Tune the default thresholds (`minLines`, `maxLines`, `ignoreDirs`) to your repos.

## Layout

```
.claude-plugin/{plugin.json,marketplace.json}
agents/{orchestrator,scout,coder,reviewer}.md
commands/{orchestrate,handoff,repomap,mcp-audit,savings,statusline}.md
hooks/hooks.json
scripts/{read-guard,bash-filter,bash-wrap,compress-cli,session-start,pre-compact,repomap-watch,repomap-stamp,claude-save,statusline,statusline-install,mcp-audit,savings,gen-schema}.js
scripts/lib/{common,compress}.js
auto-orchestra.schema.json
tests/
settings.json            { "agent": "auto-orchestra:orchestrator" }  (deprecated mechanism, see Activation)
```

Validate: `claude plugin validate .`
