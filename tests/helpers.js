'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const SCRIPTS = path.join(__dirname, '..', 'scripts');

function mkdtemp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'ao-test-')); }

// Isolated environment: fake HOME (global config/state) and a project dir.
function sandbox() {
  const home = mkdtemp('ao-home-');
  const proj = mkdtemp('ao-proj-');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  return { home, proj, env: { HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: proj } };
}

function runScript(script, input, sb, extraEnv, args) {
  const r = cp.spawnSync('node', [path.join(SCRIPTS, script)].concat(args || []), {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env: Object.assign({}, process.env, sb.env, extraEnv || {}),
    cwd: sb.proj, encoding: 'utf8', timeout: 20000
  });
  let json = null;
  try { json = r.stdout ? JSON.parse(r.stdout) : null; } catch (e) { /* plain text output */ }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

function writeConfig(sb, cfg) { fs.writeFileSync(path.join(sb.proj, '.auto-orchestra.json'), JSON.stringify(cfg)); }
function bigOutput(n, errEvery) {
  const lines = [];
  for (let i = 1; i <= n; i++) lines.push(errEvery && i % errEvery === 0 ? 'line ' + i + ': ERROR something failed in module ' + i : 'line ' + i + ': progress ok');
  return lines.join('\n') + '\n';
}
function bashEvent(sb, command, stdout, extra) {
  return Object.assign({
    session_id: 's1', cwd: sb.proj, hook_event_name: 'PostToolUse', tool_name: 'Bash',
    tool_input: { command }, tool_response: { stdout, stderr: '', interrupted: false, isImage: false }
  }, extra || {});
}
function readEvent(sb, tool, input, extra) {
  return Object.assign({ session_id: 's1', cwd: sb.proj, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input }, extra || {});
}
function sh(cmd, cwd) { return cp.execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString(); }
function initGit(dir) {
  sh('git init -q', dir); sh('git config user.email t@t', dir); sh('git config user.name t', dir);
  sh('git config commit.gpgsign false', dir);
}

module.exports = { SCRIPTS, mkdtemp, sandbox, runScript, writeConfig, bigOutput, bashEvent, readEvent, sh, initGit };
