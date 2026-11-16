'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

function ctx(r) { return r.json && r.json.hookSpecificOutput.additionalContext; }

test('SessionStart: silent without handoff/map; hints (not contents) when they exist', () => {
  const sb = H.sandbox();
  const ev = { session_id: 's', cwd: sb.proj, hook_event_name: 'SessionStart', source: 'startup' };
  assert.strictEqual(H.runScript('session-start.js', ev, sb).stdout, '');
  fs.mkdirSync(path.join(sb.proj, '.claude'));
  fs.writeFileSync(path.join(sb.proj, '.claude', 'handoff.md'), '# Handoff\nTOP-SECRET-BODY\n');
  fs.writeFileSync(path.join(sb.proj, '.claude', 'repomap.md'), '<!-- repomap head=none date=x -->\nMAP-BODY\n');
  const r = H.runScript('session-start.js', ev, sb);
  assert.match(ctx(r), /handoff\.md/);
  assert.match(ctx(r), /repomap\.md is a fresh/);
  assert.ok(!ctx(r).includes('TOP-SECRET-BODY') && !ctx(r).includes('MAP-BODY'), 'contents are not injected');
  assert.strictEqual(H.runScript('session-start.js', Object.assign({}, ev, { source: 'resume' }), sb).json.hookSpecificOutput.additionalContext.includes('handoff'), false, 'no handoff hint on resume');
});

test('SessionStart: stale map detected by age; flags can be disabled', () => {
  const sb = H.sandbox();
  fs.mkdirSync(path.join(sb.proj, '.claude'));
  const mp = path.join(sb.proj, '.claude', 'repomap.md');
  fs.writeFileSync(mp, '<!-- repomap head=none -->\nx\n');
  const old = new Date(Date.now() - 40 * 86400000); fs.utimesSync(mp, old, old);
  const ev = { session_id: 's', cwd: sb.proj, hook_event_name: 'SessionStart', source: 'startup' };
  assert.match(ctx(H.runScript('session-start.js', ev, sb)), /STALE.*older than 14 days/);
  H.writeConfig(sb, { repomap: { sessionStartHint: false } });
  assert.strictEqual(H.runScript('session-start.js', ev, sb).stdout, '');
});

test('PreCompact: writes mechanical snapshot (inside and outside git) and prints summary guidance', () => {
  const sb = H.sandbox();
  const ev = { session_id: 's', cwd: sb.proj, hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: null, transcript_path: '/x/y.jsonl' };
  let r = H.runScript('pre-compact.js', ev, sb);
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /When summarizing, keep/);
  let snap = fs.readFileSync(path.join(sb.proj, '.claude', 'handoff.auto.md'), 'utf8');
  assert.match(snap, /trigger: auto/);
  H.initGit(sb.proj); fs.writeFileSync(path.join(sb.proj, 'a.txt'), 'a'); H.sh('git add -A && git commit -qm first', sb.proj); fs.writeFileSync(path.join(sb.proj, 'b.txt'), 'b');
  r = H.runScript('pre-compact.js', ev, sb);
  snap = fs.readFileSync(path.join(sb.proj, '.claude', 'handoff.auto.md'), 'utf8');
  assert.match(snap, /branch: /); assert.match(snap, /\?\? b\.txt/); assert.match(snap, /first/);
  assert.ok(snap.split('\n').length <= 61);
  H.writeConfig(sb, { handoff: { enabled: false } });
  fs.unlinkSync(path.join(sb.proj, '.claude', 'handoff.auto.md'));
  assert.strictEqual(H.runScript('pre-compact.js', ev, sb).stdout, '');
  assert.ok(!fs.existsSync(path.join(sb.proj, '.claude', 'handoff.auto.md')));
});

test('statusline: model, context %, cost, warning at threshold, tolerant of missing data', () => {
  const sb = H.sandbox();
  const run = (o, env) => H.runScript('statusline.js', o, sb, Object.assign({ NO_COLOR: '1' }, env || {}));
  let r = run({ model: { display_name: 'Opus' }, context_window: { used_percentage: 12.4 }, cost: { total_cost_usd: 0.1234 } });
  assert.strictEqual(r.stdout, 'Opus │ ctx 12% │ $0.12');
  r = run({ model: { display_name: 'Opus' }, context_window: { used_percentage: 61 }, cost: { total_cost_usd: 1 } });
  assert.match(r.stdout, /ctx 61% ⚠ \/compact · \/auto-orchestra:handoff/);
  H.writeConfig(sb, { statusline: { warnPercent: 80 } });
  assert.ok(!run({ model: { display_name: 'Opus' }, context_window: { used_percentage: 61 } }).stdout.includes('⚠'));
  assert.strictEqual(run({ model: { display_name: 'Haiku' }, context_window: { used_percentage: null } }).stdout, 'Haiku');
  assert.strictEqual(run('garbage').code, 0);
});

test('savings report from the stats log (estimates labelled)', () => {
  const sb = H.sandbox();
  const r0 = H.runScript('savings.js', '', sb);
  assert.match(r0.stdout, /No savings recorded/);
  fs.mkdirSync(path.join(sb.proj, '.claude'));
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(sb.proj, '.claude', 'auto-orchestra-stats.jsonl'), [
    { ts: now, kind: 'bash_filter', cmd: 'npm test', charsBefore: 40000, charsAfter: 4000 },
    { ts: now, kind: 'read_block', path: 'node_modules/a.js', bytes: 8000 }, { ts: now, kind: 'read_repeat_warn' }
  ].map(o => JSON.stringify(o)).join('\n') + '\nnot json\n');
  const r = H.runScript('savings.js', '', sb);
  assert.match(r.stdout, /36000 chars saved \(~9000 tokens, estimate\)/);
  assert.match(r.stdout, /Reads blocked: 1/);
  assert.match(r.stdout, /rough estimates/);
});

test('mcp-audit: reads names only, counts usage from transcripts, never prints secrets', () => {
  const sb = H.sandbox();
  fs.writeFileSync(path.join(sb.proj, '.mcp.json'), JSON.stringify({ mcpServers: { github: { command: 'x', env: { TOKEN: 'sekret123' } }, unusedsrv: { url: 'https://e.example', headers: { A: 'sekret456' } } } }));
  const enc = sb.proj.replace(/[^a-zA-Z0-9]/g, '-');
  const td = path.join(sb.home, '.claude', 'projects', enc); fs.mkdirSync(td, { recursive: true });
  fs.writeFileSync(path.join(td, 's1.jsonl'), JSON.stringify({ timestamp: '2026-01-02T00:00:00Z', message: { content: [{ type: 'tool_use', name: 'mcp__github__list_prs', input: {} }, { type: 'tool_use', name: 'Read', input: {} }] } }) + '\n');
  const r = H.runScript('mcp-audit.js', '', sb);
  assert.match(r.stdout, /\| github \| config \(project, local\) \| 1 \|/);
  assert.match(r.stdout, /\| unusedsrv \| config \(project, remote\) \| 0 \| never \|/);
  assert.match(r.stdout, /No calls in the last 1 sessions: unusedsrv/);
  assert.ok(!r.stdout.includes('sekret'));
});
