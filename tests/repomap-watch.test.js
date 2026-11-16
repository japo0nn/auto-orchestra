'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

function gitProject(sb, files) {
  H.initGit(sb.proj);
  for (const [rel, c] of Object.entries(files)) { const p = path.join(sb.proj, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); }
  H.sh('git add -A && git commit -qm base', sb.proj);
  const head = H.sh('git rev-parse HEAD', sb.proj).trim();
  fs.mkdirSync(path.join(sb.proj, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(sb.proj, '.claude', 'repomap.md'), '<!-- repomap head=' + head + ' date=x -->\n# Map\n- entry `src/main.py:1`\n- lib `src/lib.py`\n');
  return head;
}
const flagPath = sb => path.join(sb.proj, '.claude', 'repomap.stale.json');
const ev = (sb, tool, extra) => Object.assign({ session_id: 's', cwd: sb.proj, hook_event_name: 'PostToolUse', tool_name: tool || 'Agent', tool_input: {}, tool_response: {} }, extra || {});
const readFlag = sb => JSON.parse(fs.readFileSync(flagPath(sb), 'utf8'));

test('no flag for small edits inside existing files', () => {
  const sb = H.sandbox();
  gitProject(sb, { 'src/main.py': 'a\n', 'src/lib.py': 'b\n' });
  fs.writeFileSync(path.join(sb.proj, 'src', 'lib.py'), 'changed\n');
  const r = H.runScript('repomap-watch.js', ev(sb), sb);
  assert.strictEqual(r.stdout, '');
  assert.ok(!fs.existsSync(flagPath(sb)));
});

test('added, deleted and renamed files are counted and flagged; one hint line for the main thread', () => {
  const sb = H.sandbox();
  gitProject(sb, { 'src/main.py': 'a\n', 'src/lib.py': 'b\n', 'src/old.py': 'c\nc\nc\nc\n' });
  fs.writeFileSync(path.join(sb.proj, 'src', 'new_mod.py'), 'n\n');            // untracked add
  fs.unlinkSync(path.join(sb.proj, 'src', 'lib.py'));                           // delete
  H.sh('git mv src/old.py src/renamed.py', sb.proj);                            // rename
  const r = H.runScript('repomap-watch.js', ev(sb), sb);
  const flag = readFlag(sb);
  assert.strictEqual(flag.counts.added, 1);
  assert.strictEqual(flag.counts.deleted, 1);
  assert.strictEqual(flag.counts.renamed, 1);
  assert.match(flag.reason[0], /1 added, 1 deleted, 1 renamed/);
  assert.match(r.json.hookSpecificOutput.additionalContext, /out of date/);
  assert.match(r.json.hookSpecificOutput.additionalContext, /decide/i);
  // same state again: flag stays, no repeated hint
  assert.strictEqual(H.runScript('repomap-watch.js', ev(sb), sb).stdout, '');
  assert.ok(fs.existsSync(flagPath(sb)));
});

test('manifest change and "too many files" flag the map; threshold comes from config', () => {
  const sb = H.sandbox();
  const files = { 'package.json': '{}\n', 'src/main.py': 'a\n' };
  for (let i = 0; i < 12; i++) files['src/f' + i + '.py'] = 'x\n';
  gitProject(sb, files);
  fs.writeFileSync(path.join(sb.proj, 'package.json'), '{"a":1}\n');
  let r = H.runScript('repomap-watch.js', ev(sb), sb);
  assert.match(readFlag(sb).reason.join(';'), /manifest\/build files changed: package\.json/);
  assert.strictEqual(readFlag(sb).counts.manifests, 1);
  H.sh('git checkout package.json', sb.proj);
  for (let i = 0; i < 11; i++) fs.writeFileSync(path.join(sb.proj, 'src', 'f' + i + '.py'), 'y\n');
  r = H.runScript('repomap-watch.js', ev(sb), sb);
  assert.match(readFlag(sb).reason.join(';'), /11 files changed \(> 10\)/);
  H.writeConfig(sb, { repomap: { maxChangedFiles: 50 } });
  H.runScript('repomap-watch.js', ev(sb), sb);
  assert.ok(!fs.existsSync(flagPath(sb)), 'flag removed when changes are no longer structural under new threshold');
});

test('ignored paths (dependencies, .claude) do not count', () => {
  const sb = H.sandbox();
  gitProject(sb, { 'src/main.py': 'a\n' });
  fs.mkdirSync(path.join(sb.proj, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(sb.proj, 'node_modules', 'x', 'i.js'), 'a');
  fs.writeFileSync(path.join(sb.proj, '.claude', 'handoff.md'), 'a');
  assert.strictEqual(H.runScript('repomap-watch.js', ev(sb), sb).stdout, '');
  assert.ok(!fs.existsSync(flagPath(sb)));
});

test('map drift: references to deleted paths trigger a full-rebuild recommendation', () => {
  const sb = H.sandbox();
  gitProject(sb, { 'src/main.py': 'a\n', 'src/lib.py': 'b\n' });
  fs.appendFileSync(path.join(sb.proj, '.claude', 'repomap.md'), '- `gone/a.py` `gone/b.py` `gone/c.py`\n');
  H.runScript('repomap-watch.js', ev(sb), sb);
  const flag = readFlag(sb);
  assert.strictEqual(flag.rebuild, true);
  assert.deepStrictEqual(flag.missingRefs.sort(), ['gone/a.py', 'gone/b.py', 'gone/c.py']);
});

test('subagent calls update the flag but only the main thread gets the hint', () => {
  const sb = H.sandbox();
  gitProject(sb, { 'src/main.py': 'a\n' });
  fs.writeFileSync(path.join(sb.proj, 'src', 'extra.py'), 'x\n');
  const r = H.runScript('repomap-watch.js', ev(sb, 'Edit', { agent_id: 'sub1', agent_type: 'auto-orchestra:coder' }), sb);
  assert.strictEqual(r.stdout, '', 'no hint inside a subagent');
  assert.ok(fs.existsSync(flagPath(sb)), 'flag still written');
  const r2 = H.runScript('repomap-watch.js', ev(sb, 'Agent'), sb);
  assert.match(r2.json.hookSpecificOutput.additionalContext, /out of date/, 'hint reaches the main thread after the Agent call returns');
});

test('throttle: Edit/Bash events are rate-limited, Agent events are not', () => {
  const sb = H.sandbox();
  gitProject(sb, { 'src/main.py': 'a\n' });
  H.runScript('repomap-watch.js', ev(sb, 'Edit'), sb);
  fs.writeFileSync(path.join(sb.proj, 'src', 'extra.py'), 'x\n');
  assert.ok(!fs.existsSync(flagPath(sb)));
  H.runScript('repomap-watch.js', ev(sb, 'Edit'), sb);
  assert.ok(!fs.existsSync(flagPath(sb)), 'second Edit within 5 s is skipped');
  H.runScript('repomap-watch.js', ev(sb, 'Agent'), sb);
  assert.ok(fs.existsSync(flagPath(sb)), 'Agent events always recompute');
});

test('fail-open outside git, with unknown map commit, or without a baseline', () => {
  const sb = H.sandbox();
  fs.mkdirSync(path.join(sb.proj, '.claude'));
  fs.writeFileSync(path.join(sb.proj, '.claude', 'repomap.md'), '<!-- repomap head=deadbeefdeadbeef date=x -->\nmap\n');
  let r = H.runScript('repomap-watch.js', ev(sb), sb);
  assert.strictEqual(r.code, 0); assert.strictEqual(r.stdout, ''); // not a git repo
  H.initGit(sb.proj); fs.writeFileSync(path.join(sb.proj, 'a'), 'a'); H.sh('git add a && git commit -qm x', sb.proj);
  r = H.runScript('repomap-watch.js', ev(sb), sb);
  assert.strictEqual(r.code, 0); assert.strictEqual(r.stdout, ''); // commit not in history
  fs.writeFileSync(path.join(sb.proj, '.claude', 'repomap.md'), 'no header at all\n');
  r = H.runScript('repomap-watch.js', ev(sb), sb);
  assert.strictEqual(r.code, 0); assert.strictEqual(r.stdout, '');
  fs.unlinkSync(path.join(sb.proj, '.claude', 'repomap.md'));
  assert.strictEqual(H.runScript('repomap-watch.js', ev(sb), sb).stdout, '');
});

test('non-git project with an mtime baseline: new and modified files are detected', () => {
  const sb = H.sandbox();
  fs.mkdirSync(path.join(sb.proj, 'src'), { recursive: true });
  fs.mkdirSync(path.join(sb.proj, '.claude'));
  const base = Date.now() - 60000;
  fs.writeFileSync(path.join(sb.proj, 'src', 'a.py'), 'a');
  const old = new Date(base - 5000); fs.utimesSync(path.join(sb.proj, 'src', 'a.py'), old, old);
  fs.writeFileSync(path.join(sb.proj, '.claude', 'repomap.md'), '<!-- repomap head=none mtime=' + base + ' -->\nmap\n');
  fs.writeFileSync(path.join(sb.proj, 'src', 'b.py'), 'b');
  const r = H.runScript('repomap-watch.js', ev(sb), sb);
  assert.strictEqual(r.code, 0);
  assert.ok(readFlag(sb).counts.total >= 1);
});

test('flag disabled by config', () => {
  const sb = H.sandbox();
  gitProject(sb, { 'src/main.py': 'a\n' });
  fs.writeFileSync(path.join(sb.proj, 'src', 'extra.py'), 'x\n');
  H.writeConfig(sb, { repomap: { autoRefresh: false } });
  assert.strictEqual(H.runScript('repomap-watch.js', ev(sb), sb).stdout, '');
  assert.ok(!fs.existsSync(flagPath(sb)));
});

test('stamp: updates the header commit and removes the flag', () => {
  const sb = H.sandbox();
  const head0 = gitProject(sb, { 'src/main.py': 'a\n' });
  fs.writeFileSync(path.join(sb.proj, 'src', 'extra.py'), 'x\n');
  H.sh('git add -A && git commit -qm second', sb.proj);
  const head1 = H.sh('git rev-parse HEAD', sb.proj).trim();
  H.runScript('repomap-watch.js', ev(sb), sb);
  assert.ok(fs.existsSync(flagPath(sb)), 'flagged after a structural commit');
  const r = H.runScript('repomap-stamp.js', '', sb, {}, [sb.proj]);
  assert.match(r.stdout, /Stamped/);
  const first = fs.readFileSync(path.join(sb.proj, '.claude', 'repomap.md'), 'utf8').split('\n')[0];
  assert.ok(first.includes('head=' + head1) && !first.includes(head0));
  assert.ok(!fs.existsSync(flagPath(sb)), 'flag removed');
  assert.strictEqual(fs.readFileSync(path.join(sb.proj, '.claude', 'repomap.md'), 'utf8').split('\n')[1], '# Map', 'body untouched');
  // after the stamp, the next check finds nothing to flag
  fs.writeFileSync(path.join(sb.home, '.claude', 'dummy'), '');
  H.runScript('repomap-watch.js', ev(sb), sb);
  assert.ok(!fs.existsSync(flagPath(sb)));
});

test('stamp: inserts a header when missing, works outside git, never throws', () => {
  const sb = H.sandbox();
  fs.mkdirSync(path.join(sb.proj, '.claude'));
  fs.writeFileSync(path.join(sb.proj, '.claude', 'repomap.md'), '# Map\n');
  const r = H.runScript('repomap-stamp.js', '', sb, {}, [sb.proj]);
  assert.strictEqual(r.code, 0);
  assert.match(fs.readFileSync(path.join(sb.proj, '.claude', 'repomap.md'), 'utf8'), /^<!-- repomap head=none date=\S+ mtime=\d+ -->\n# Map/);
  fs.unlinkSync(path.join(sb.proj, '.claude', 'repomap.md'));
  assert.strictEqual(H.runScript('repomap-stamp.js', '', sb, {}, [sb.proj]).code, 0);
});

test('claude-save: installs a draft into .claude/, stamps the map, clears the flag, deletes the draft', () => {
  const sb = H.sandbox();
  const head0 = gitProject(sb, { 'src/main.py': 'a\n' });
  fs.writeFileSync(path.join(sb.proj, 'src', 'extra.py'), 'x\n');
  H.sh('git add -A && git commit -qm second', sb.proj);
  const head1 = H.sh('git rev-parse HEAD', sb.proj).trim();
  H.runScript('repomap-watch.js', ev(sb), sb);
  assert.ok(fs.existsSync(flagPath(sb)));
  fs.writeFileSync(path.join(sb.proj, 'repomap.draft.md'), '# Map v2\n- new `src/extra.py`\n');
  const r = H.runScript('claude-save.js', '', sb, {}, ['repomap', 'repomap.draft.md']);
  assert.match(r.stdout, /Saved \.claude\/repomap\.md/);
  const text = fs.readFileSync(path.join(sb.proj, '.claude', 'repomap.md'), 'utf8');
  assert.ok(text.startsWith('<!-- repomap head=' + head1) && !text.includes(head0));
  assert.match(text, /# Map v2/);
  assert.ok(!fs.existsSync(path.join(sb.proj, 'repomap.draft.md')), 'draft removed');
  assert.ok(!fs.existsSync(flagPath(sb)), 'flag cleared');
});

test('claude-save: handoff has no header; rejects bad names, outside-project drafts and empty drafts', () => {
  const sb = H.sandbox();
  fs.writeFileSync(path.join(sb.proj, 'h.md'), '# Handoff\n');
  let r = H.runScript('claude-save.js', '', sb, {}, ['handoff', 'h.md']);
  assert.match(r.stdout, /Saved \.claude\/handoff\.md/);
  assert.strictEqual(fs.readFileSync(path.join(sb.proj, '.claude', 'handoff.md'), 'utf8'), '# Handoff\n');
  const outside = path.join(sb.home, 'evil.md'); fs.writeFileSync(outside, 'x');
  r = H.runScript('claude-save.js', '', sb, {}, ['handoff', outside]);
  assert.match(r.stdout, /inside the project/); assert.ok(fs.existsSync(outside), 'outside file untouched');
  r = H.runScript('claude-save.js', '', sb, {}, ['settings', 'h.md']);
  assert.match(r.stdout, /must be "repomap" or "handoff"/);
  fs.writeFileSync(path.join(sb.proj, 'empty.md'), '');
  assert.match(H.runScript('claude-save.js', '', sb, {}, ['handoff', 'empty.md']).stdout, /missing, empty/);
  assert.strictEqual(H.runScript('claude-save.js', '', sb, {}, []).code, 0);
});

test('after a refresh, uncommitted files the map already reflects are not flagged again; newer changes are', () => {
  const sb = H.sandbox();
  gitProject(sb, { 'src/main.py': 'a\n' });
  fs.writeFileSync(path.join(sb.proj, 'src', 'wip.py'), 'wip\n');           // uncommitted, reflected by the refresh below
  H.runScript('repomap-watch.js', ev(sb), sb);
  assert.ok(fs.existsSync(flagPath(sb)), 'flagged before the refresh');
  fs.writeFileSync(path.join(sb.proj, 'repomap.draft.md'), '# Map\n- `src/wip.py`\n');
  H.runScript('claude-save.js', '', sb, {}, ['repomap', 'repomap.draft.md']);
  assert.ok(!fs.existsSync(flagPath(sb)));
  H.runScript('repomap-watch.js', ev(sb), sb);
  assert.ok(!fs.existsSync(flagPath(sb)), 'same dirty state: no flag');
  fs.writeFileSync(path.join(sb.proj, 'src', 'newer.py'), 'n\n');
  H.runScript('repomap-watch.js', ev(sb), sb);
  assert.ok(fs.existsSync(flagPath(sb)), 'a genuinely new file is flagged');
  assert.strictEqual(readFlag(sb).counts.added, 1);
});
