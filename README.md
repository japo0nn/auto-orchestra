# auto-orchestra

Automatic model orchestration for Claude Code. You type a task; the main agent plans, delegates and verifies. No manual commands.

| Role | Agent | Model | Tools |
|---|---|---|---|
| Orchestrator (main thread) | `auto-orchestra:orchestrator` | Opus | Agent, Read, Grep, Glob, TodoWrite (no Edit/Write/Bash) |
| Scout | `auto-orchestra:scout` | Haiku | Read, Grep, Glob, Bash (read-only by prompt) |
| Coder | `auto-orchestra:coder` | Sonnet | Read, Grep, Glob, Edit, Write, Bash |
| Reviewer | `auto-orchestra:reviewer` | Opus | Read, Grep, Glob, Bash (tests, git diff; no Edit/Write) |

Workflow: parallel scouting → plan in TodoWrite → coder per task (parallel only on disjoint files) → reviewer PASS/FAIL → up to 2 fix rounds → short report of what changed and what was actually verified. Trivial requests (a question, a one-line edit) skip all of it.

Works the same in the CLI, Claude Code Desktop and the VS Code extension, since all of them read the same plugin and settings files.

## Install

From a local checkout:

```
/plugin marketplace add ./
/plugin install auto-orchestra@auto-orchestra-marketplace
```

Or from a git host: `/plugin marketplace add <owner>/<repo>`.

## Activation (important)

The plugin ships `settings.json` with `"agent": "auto-orchestra:orchestrator"` (plugin agents are namespaced `<plugin>:<agent>`). **Claude Code 2.1.326 still honors it, but marks a plugin-provided `agent` as deprecated** ("will stop applying in a future release"). For a durable setup, put the same line in your own settings:

```json
// ~/.claude/settings.json  (all projects)  or  .claude/settings.json (one project)
{ "agent": "auto-orchestra:orchestrator" }
```

Or start per session: `claude --agent auto-orchestra:orchestrator`. The CLI flag overrides the setting.

Fallback if the main thread is not the orchestrator: `/auto-orchestra:orchestrate <task>`. Note this runs the orchestrator *prompt* on whatever model the session uses, so tool restrictions are not enforced there; the three subagents still run on their own models.

## Verify it works

In a scratch repo, with a deliberately broken function and a failing test, ask: "Fix the failing test, run the full cycle: reconnaissance, execution, review." Then check:

- The startup header shows `@auto-orchestra:orchestrator`; `/agents` lists the four agents.
- In the transcript you see `Agent` calls to `auto-orchestra:scout` (several at once), then `coder`, then `reviewer`.
- Headless proof of models per call:
  ```
  claude --agent auto-orchestra:orchestrator --permission-mode acceptEdits \
    --allowedTools "Bash(python3:*)" -p "<task>" --output-format stream-json --verbose
  ```
  Each `assistant` event carries `message.model` (opus / haiku / sonnet ids) and subagent events carry `parent_tool_use_id`.

## What may not work

1. **`CLAUDE_CODE_SUBAGENT_MODEL`**. Model precedence is: per-call `model` parameter, then the agent's frontmatter `model`, then this env var, then the parent's model. So per the docs the frontmatter beats the variable. But if you also set `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`, every `model` field is ignored and all subagents run on one model. Unset both to get the Opus/Sonnet/Haiku split. Also, the orchestrator may pass a per-call `model`, which beats frontmatter; its prompt does not, but check the transcript if models look wrong.
2. **Cost.** An Opus main thread is more expensive, and it re-reads a growing context every turn. Cheaper variant: change `model: opus` to `model: sonnet` in `agents/orchestrator.md`. Planning is a bit weaker; the independent Opus reviewer still guards quality. Reviewer on Opus can likewise be set to `sonnet` for cost.
3. **Orchestrator must be the main thread.** Corrected from the usual assumption: current docs say subagents *can* spawn subagents (up to 3 levels, `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`). The orchestrator is still best as the main agent: it gets the user conversation, needs `Agent` and `TodoWrite`, and running it nested would waste depth and context. The `Agent(type)` allowlist in `tools` only applies to a main-thread agent, so that restriction is not used here; plain `Agent` is.
4. **Scout read-only is prompt-enforced.** It has Bash, and a plugin agent cannot carry its own hooks (`hooks`, `permissionMode` and `mcpServers` are ignored in plugin agents). For hard enforcement, add a PreToolUse hook or `permissions.deny` rules in your settings. In the same way, reviewer's "no file changes via Bash" is a prompt rule.
5. **TodoWrite in non-interactive mode.** In `-p` runs the task tools may replace TodoWrite (the orchestrator reported it unavailable there). Interactive sessions are unaffected; the orchestrator then just tracks the plan in text.
6. **Permissions.** Subagents inherit the session's permission mode (plugin agents cannot set `permissionMode`). Expect prompts for Edit/Bash unless you allow them.
7. Subagents have no conversation context; quality depends on the orchestrator's self-contained prompts. Overkill for small tasks: that is why the triviality gate exists.

## Layout

```
.claude-plugin/plugin.json        manifest
.claude-plugin/marketplace.json   marketplace "auto-orchestra-marketplace"
agents/{orchestrator,scout,coder,reviewer}.md
commands/orchestrate.md           manual entry point
settings.json                     { "agent": "auto-orchestra:orchestrator" } (deprecated mechanism, see above)
```

Validate: `claude plugin validate .`
