---
description: Show how to enable the auto-orchestra status line (model, context %, cost, warning); never overwrites an existing status line
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/statusline-install.js*)
---

Status line helper (read-only report):

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/statusline-install.js`

Explain to the user:
- Plugins cannot set a status line, so this is opt-in and manual.
- The script above is not installed yet unless it says `Script installed: true`. To install the script into a stable location (`~/.claude/auto-orchestra/statusline/`, it survives plugin updates) run: `node "${CLAUDE_PLUGIN_ROOT}/scripts/statusline-install.js" --copy`. Offer to run it, but only run it if the user says yes.
- Then they add the printed `statusLine` snippet to `~/.claude/settings.json` themselves. If an existing `statusLine` is shown, it is NOT replaced: show both and let the user decide. Do not edit settings.json yourself unless the user explicitly asks.
- The warning threshold is `statusline.warnPercent` (default 60) in `.auto-orchestra.json` or `~/.claude/auto-orchestra.json`.
