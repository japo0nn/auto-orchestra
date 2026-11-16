'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const H = require('./helpers');

test('fail-open on garbage input (every script)', () => {
  const sb = H.sandbox();
  for (const s of ['bash-filter.js', 'bash-wrap.js', 'read-guard.js', 'session-start.js', 'pre-compact.js', 'repomap-watch.js']) {
    for (const bad of ['', 'not json', '[1,2]', '{"tool_name":', 'null', '{"tool_name":"Bash","tool_input":5,"tool_response":"x"}']) {
      const r = H.runScript(s, bad, sb);
      assert.strictEqual(r.code, 0, s + ' exit code for ' + JSON.stringify(bad));
      // pre-compact legitimately prints its summary guidance for any well-formed JSON object
      if (s === 'pre-compact.js' && bad.startsWith('{"tool_name":"Bash"')) continue;
      assert.strictEqual(r.stdout, '', s + ' must print nothing for ' + JSON.stringify(bad));
    }
  }
});

test('fail-open on broken config files', () => {
  const sb = H.sandbox();
  fs.writeFileSync(path.join(sb.proj, '.auto-orchestra.json'), '{ nope');
  fs.writeFileSync(path.join(sb.home, '.claude', 'auto-orchestra.json'), '{"bash": {"head": "ten", "mode": 5}}');
  const r = H.runScript('bash-filter.js', H.bashEvent(sb, 'npm test', H.bigOutput(400, 50)), sb);
  assert.strictEqual(r.code, 0);
  assert.ok(r.json && r.json.hookSpecificOutput.updatedToolOutput.stdout.includes('[auto-orchestra]'), 'defaults apply');
});

test('compresses large output, keeps errors, saves the full text', () => {
  const sb = H.sandbox();
  const out = H.bigOutput(500, 100);
  const r = H.runScript('bash-filter.js', H.bashEvent(sb, 'npm test', out, { scratchpad_dir: path.join(sb.proj, 'scratch') }), sb);
  assert.strictEqual(r.code, 0);
  const o = r.json.hookSpecificOutput;
  assert.strictEqual(o.hookEventName, 'PostToolUse');
  const text = o.updatedToolOutput.stdout;
  assert.ok(text.length < out.length / 3, 'much smaller');
  assert.match(text, /500 lines/);
  assert.match(text, /ERROR something failed in module 300/, 'middle error line kept');
  assert.match(text, /^\[auto-orchestra\]/);
  assert.match(text, /line 500: ERROR something failed in module 500/, 'tail kept');
  assert.match(text, /line 1: progress ok/, 'head kept');
  assert.strictEqual(o.updatedToolOutput.interrupted, false, 'other fields of tool_response preserved');
  const saved = /Full output: (\S+)/.exec(text)[1];
  assert.strictEqual(fs.readFileSync(saved, 'utf8'), out, 'full output saved verbatim');
  const stats = fs.readFileSync(path.join(sb.proj, '.claude', 'auto-orchestra-stats.jsonl'), 'utf8');
  assert.match(stats, /"kind":"bash_filter"/);
  assert.ok(!stats.includes('progress ok') && !stats.includes('module 300'), 'stats hold metadata only');
});

test('short output and below-threshold output are untouched', () => {
  const sb = H.sandbox();
  assert.strictEqual(H.runScript('bash-filter.js', H.bashEvent(sb, 'npm test', H.bigOutput(20)), sb).stdout, '');
  // 150 lines of a non-noisy command stays under the general threshold (200)
  assert.strictEqual(H.runScript('bash-filter.js', H.bashEvent(sb, 'ls -R', H.bigOutput(150)), sb).stdout, '');
  // noisy command with 150 lines is compressed
  assert.notStrictEqual(H.runScript('bash-filter.js', H.bashEvent(sb, 'make all', H.bigOutput(150)), sb).stdout, '');
});

test('unknown tool with huge output is still compressed by the general threshold', () => {
  const sb = H.sandbox();
  const r = H.runScript('bash-filter.js', H.bashEvent(sb, './my-weird-tool --go', H.bigOutput(900, 300)), sb);
  assert.ok(r.json, 'compressed');
});

test('never filters readers, secrets, background jobs', () => {
  const sb = H.sandbox();
  const big = H.bigOutput(600, 50);
  for (const c of ['cat big.txt', 'git diff', 'grep -rn foo .', 'env', 'printenv', 'cat .env', 'echo $TOKEN_FILE; ls', 'aws sts get-caller-identity', 'npm test && cat .env']) {
    assert.strictEqual(H.runScript('bash-filter.js', H.bashEvent(sb, c, big), sb).stdout, '', c);
  }
  const bg = H.bashEvent(sb, 'npm test', big); bg.tool_response.backgroundTaskId = 'b1';
  assert.strictEqual(H.runScript('bash-filter.js', bg, sb).stdout, '');
  assert.ok(!fs.existsSync(path.join(sb.proj, '.claude', 'auto-orchestra')), 'no temp file for skipped commands');
});

test('disable flags work (global and per feature)', () => {
  const sb = H.sandbox();
  H.writeConfig(sb, { bash: { enabled: false } });
  assert.strictEqual(H.runScript('bash-filter.js', H.bashEvent(sb, 'npm test', H.bigOutput(500)), sb).stdout, '');
  H.writeConfig(sb, { enabled: false });
  assert.strictEqual(H.runScript('bash-filter.js', H.bashEvent(sb, 'npm test', H.bigOutput(500)), sb).stdout, '');
});

test('project config overrides global config; extra* lists append', () => {
  const sb = H.sandbox();
  fs.writeFileSync(path.join(sb.home, '.claude', 'auto-orchestra.json'), JSON.stringify({ bash: { noisyMinLines: 1000, minLines: 1000, minChars: 10000000, noisyMinChars: 10000000 } }));
  assert.strictEqual(H.runScript('bash-filter.js', H.bashEvent(sb, 'npm test', H.bigOutput(300)), sb).stdout, '', 'global raises thresholds');
  H.writeConfig(sb, { bash: { noisyMinLines: 50 } });
  assert.notStrictEqual(H.runScript('bash-filter.js', H.bashEvent(sb, 'npm test', H.bigOutput(300)), sb).stdout, '', 'project wins');
  H.writeConfig(sb, { bash: { noisyMinLines: 50, extraNeverFilter: ['^npm test'] } });
  assert.strictEqual(H.runScript('bash-filter.js', H.bashEvent(sb, 'npm test', H.bigOutput(300)), sb).stdout, '', 'extraNeverFilter');
});

test('stack-agnostic: custom error pattern is honoured', () => {
  const sb = H.sandbox();
  H.writeConfig(sb, { bash: { extraErrorPatterns: ['CUSTOMBAD'] } });
  const lines = []; for (let i = 1; i <= 300; i++) lines.push(i === 150 ? 'zzz CUSTOMBAD zzz' : 'fine ' + i);
  const r = H.runScript('bash-filter.js', H.bashEvent(sb, 'xtool build', lines.join('\n')), sb);
  assert.match(r.json.hookSpecificOutput.updatedToolOutput.stdout, /CUSTOMBAD/);
});

test('wrap mode: exit code preserved, output compressed (also on failure), cd persists', () => {
  const sb = H.sandbox();
  H.writeConfig(sb, { bash: { mode: 'wrap' } });
  const ev = { session_id: 's', cwd: sb.proj, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo build; ' + 'seq 1 300 | sed "s/^/ok /"; echo "ERROR boom"; seq 1 100; sh -c \'exit 7\'' } };
  const r = H.runScript('bash-wrap.js', ev, sb);
  assert.ok(r.json, 'wrap produced updatedInput: ' + r.stdout + r.stderr);
  const wrapped = r.json.hookSpecificOutput.updatedInput.command;
  const run = cp.spawnSync('bash', ['-c', wrapped + '\necho "STATE:$?:$(pwd | sed \'s/.*\\///\')"'], { cwd: sb.proj, env: Object.assign({}, process.env, sb.env), encoding: 'utf8' });
  assert.match(run.stdout, /\[auto-orchestra\] output compressed/);
  assert.match(run.stdout, /Exit code: 7/);
  assert.match(run.stdout, /ERROR boom/);
  assert.match(run.stdout, /STATE:7:/, 'exit code of the wrapped command is the final status');
  // not wrapped: reader, secret, background, non-noisy, post mode
  for (const c of ['cat x', 'printenv', 'npm test --token abc', 'mytool --go', 'make x; exit 2', 'make x && exec ls', 'set -e; make x', 'trap "" INT; make x']) {
    assert.strictEqual(H.runScript('bash-wrap.js', Object.assign({}, ev, { tool_input: { command: c } }), sb).stdout, '', c);
  }
  assert.strictEqual(H.runScript('bash-wrap.js', Object.assign({}, ev, { tool_input: { command: 'make x', run_in_background: true } }), sb).stdout, '');
  H.writeConfig(sb, { bash: { mode: 'post' } });
  assert.strictEqual(H.runScript('bash-wrap.js', ev, sb).stdout, '', 'default mode does not rewrite commands');
});

test('wrap mode: short output passes through unchanged and the temp file is removed', () => {
  const sb = H.sandbox();
  H.writeConfig(sb, { bash: { mode: 'wrap' } });
  const ev = { session_id: 's', cwd: sb.proj, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo build; echo hello; sh -c \'exit 3\'' } };
  const wrapped = H.runScript('bash-wrap.js', ev, sb).json.hookSpecificOutput.updatedInput.command;
  const run = cp.spawnSync('bash', ['-c', wrapped + '\necho "CODE:$?"'], { cwd: sb.proj, env: Object.assign({}, process.env, sb.env), encoding: 'utf8' });
  assert.match(run.stdout, /^build\nhello\nCODE:3/);
  const dir = path.join(sb.proj, '.claude', 'auto-orchestra', 'out');
  assert.deepStrictEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], []);
});
