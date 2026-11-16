#!/usr/bin/env node
'use strict';
// PreToolUse(Bash), only when bash.mode == "wrap": rewrite NOISY commands so their output (also on failure,
// which PostToolUse cannot reach) goes through compress-cli.js. Runs in the same shell (braces + subshell exit),
// so cd/export persistence and the exit code are preserved. Experimental: the rewritten command no longer
// matches the user's Bash(...) allow rules, so Claude Code may ask for permission.
const fs = require('fs');
const path = require('path');
const C = require('./lib/common');

function sq(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

C.runHook(async input => {
  if (input.tool_name !== 'Bash') return;
  const proj = C.projectDirOf(input);
  const cfg = C.loadConfig(proj);
  if (!C.featureOn(cfg, 'bash') || cfg.bash.mode !== 'wrap') return;
  const b = cfg.bash;
  const ti = input.tool_input || {};
  const cmd = String(ti.command || '');
  if (!cmd.trim() || ti.run_in_background) return;
  if (C.matchesAny(b.secretCommands.concat(b.extraSecretCommands), cmd)) return;
  if (C.anySegmentMatches(b.neverFilter.concat(b.extraNeverFilter), cmd)) return;
  if (!C.anySegmentMatches(b.noisyCommands.concat(b.extraNoisyCommands), cmd)) return;
  // `exit`/`exec`/`set -e` inside the group would end the shell before the compression step runs: do not wrap those.
  if (/(^|[;&|\n({])\s*(exit|exec)\b/.test(cmd) || /(^|[;&|\n({])\s*set\s+-\S*e/.test(cmd) || /\btrap\b/.test(cmd)) return;
  if (process.platform === 'win32' && !process.env.SHELL && !process.env.MSYSTEM) return; // POSIX shell syntax needed

  const sp = typeof input.scratchpad_dir === 'string' && input.scratchpad_dir ? input.scratchpad_dir : path.join(proj, '.claude', 'auto-orchestra', 'out');
  fs.mkdirSync(sp, { recursive: true });
  const file = C.toPosix(path.join(sp, 'bash-' + Date.now() + '-' + C.sha1(cmd + Math.random()) + '.log'));
  const cli = C.toPosix(path.join(__dirname, 'compress-cli.js'));
  const short = C.shortCmd(cmd);
  const wrapped = '{\n' + cmd + '\n} >' + sq(file) + ' 2>&1; __ao_ec=$?; node ' + sq(cli) + ' ' + sq(file) + ' "$__ao_ec" ' + sq(short) + '; (exit $__ao_ec)';
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput: Object.assign({}, ti, { command: wrapped })
    }
  };
});
