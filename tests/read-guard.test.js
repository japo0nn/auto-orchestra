'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

function mk(sb, rel, content) {
  const p = path.join(sb.proj, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content === undefined ? 'x\n' : content);
  return p;
}
const denied = r => r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.permissionDecision === 'deny';

test('blocks default ignored dirs, lock/minified files, binaries, archives (any stack)', () => {
  const sb = H.sandbox();
  const cases = ['node_modules/a/index.js', 'vendor/x/y.go', 'target/debug/app.rs', '.venv/lib/site.py', '__pycache__/m.cpython-311.pyc',
    'obj/Debug/x.dll', 'dist/app.js', 'build/out.o', '.git/config', 'package-lock.json', 'Cargo.lock', 'poetry.lock', 'web/app.min.js', 'x/a.zip', 'x/b.tar.gz'];
  for (const rel of cases) {
    const p = mk(sb, rel);
    const r = H.runScript('read-guard.js', H.readEvent(sb, 'Read', { file_path: p }), sb);
    assert.ok(denied(r), rel + ' should be denied: ' + r.stdout);
    assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /auto-orchestra/);
  }
});

test('NUL-byte sniffing blocks unknown binaries; images and PDFs stay readable', () => {
  const sb = H.sandbox();
  const bin = mk(sb, 'data/blob.xyz', Buffer.from([1, 2, 0, 3, 4]));
  assert.ok(denied(H.runScript('read-guard.js', H.readEvent(sb, 'Read', { file_path: bin }), sb)));
  const png = mk(sb, 'shot.png', Buffer.from([0x89, 0x50, 0, 0]));
  assert.strictEqual(H.runScript('read-guard.js', H.readEvent(sb, 'Read', { file_path: png }), sb).stdout, '');
});

test('normal source files, .claude files and outside-project paths are allowed', () => {
  const sb = H.sandbox();
  const src = mk(sb, 'src/app.py', 'print(1)\n');
  assert.strictEqual(H.runScript('read-guard.js', H.readEvent(sb, 'Read', { file_path: src }), sb).stdout, '');
  const hand = mk(sb, '.claude/handoff.md', '# h\n');
  assert.strictEqual(H.runScript('read-guard.js', H.readEvent(sb, 'Read', { file_path: hand }), sb).stdout, '');
  assert.strictEqual(H.runScript('read-guard.js', H.readEvent(sb, 'Read', { file_path: path.join(sb.home, 'elsewhere', 'node_modules', 'x.js') }), sb).stdout, '', 'outside project: dir rules do not apply');
});

test('explicit allow (glob) lets an ignored path through; extraIgnore adds paths', () => {
  const sb = H.sandbox();
  const p = mk(sb, 'vendor/mylib/core.go');
  assert.ok(denied(H.runScript('read-guard.js', H.readEvent(sb, 'Read', { file_path: p }), sb)));
  H.writeConfig(sb, { readGuard: { allow: ['vendor/mylib/**'] } });
  assert.strictEqual(H.runScript('read-guard.js', H.readEvent(sb, 'Read', { file_path: p }), sb).stdout, '');
  const g = mk(sb, 'generated/api.ts');
  H.writeConfig(sb, { readGuard: { extraIgnore: ['generated'] } });
  assert.ok(denied(H.runScript('read-guard.js', H.readEvent(sb, 'Read', { file_path: g }), sb)));
});

test('repeat the identical blocked call once and it passes (session scoped)', () => {
  const sb = H.sandbox();
  const p = mk(sb, 'node_modules/pkg/index.js');
  const ev = H.readEvent(sb, 'Read', { file_path: p });
  assert.ok(denied(H.runScript('read-guard.js', ev, sb)));
  assert.strictEqual(H.runScript('read-guard.js', ev, sb).stdout, '', 'second identical attempt passes');
  assert.ok(denied(H.runScript('read-guard.js', Object.assign({}, ev, { session_id: 'other' }), sb)), 'other session still blocked');
  H.writeConfig(sb, { readGuard: { confirmRepeat: false } });
  assert.ok(denied(H.runScript('read-guard.js', ev, sb)));
  assert.ok(denied(H.runScript('read-guard.js', ev, sb)));
});

test('.gitignore patterns are honoured (and can be switched off)', () => {
  const sb = H.sandbox();
  fs.writeFileSync(path.join(sb.proj, '.gitignore'), '# c\n/out/\n*.generated.cs\nlogs\n!keep.generated.cs\n');
  assert.ok(denied(H.runScript('read-guard.js', H.readEvent(sb, 'Read', { file_path: mk(sb, 'out/a.txt') }), sb)));
  assert.ok(denied(H.runScript('read-guard.js', H.readEvent(sb, 'Read', { file_path: mk(sb, 'src/x.generated.cs') }), sb)));
  assert.ok(denied(H.runScript('read-guard.js', H.readEvent(sb, 'Read', { file_path: mk(sb, 'a/logs/z.txt') }), sb)));
  assert.strictEqual(H.runScript('read-guard.js', H.readEvent(sb, 'Read', { file_path: mk(sb, 'src/keep.generated.cs') }), sb).stdout, '', 'negation');
  assert.strictEqual(H.runScript('read-guard.js', H.readEvent(sb, 'Read', { file_path: mk(sb, 'sub/out/a.txt') }), sb).stdout, '', 'anchored /out/ only at root');
  H.writeConfig(sb, { readGuard: { useGitignore: false } });
  assert.strictEqual(H.runScript('read-guard.js', H.readEvent(sb, 'Read', { file_path: mk(sb, 'out/a.txt') }), sb).stdout, '');
});

test('large files must be read with limit; with limit they pass', () => {
  const sb = H.sandbox();
  const big = mk(sb, 'src/huge.txt', H.bigOutput(3000));
  const r = H.runScript('read-guard.js', H.readEvent(sb, 'Read', { file_path: big }), sb);
  assert.ok(denied(r));
  assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /3001 lines|3000 lines/);
  assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /offset and limit/);
  assert.strictEqual(H.runScript('read-guard.js', H.readEvent(sb, 'Read', { file_path: big, offset: 100, limit: 200 }), sb).stdout, '');
  const small = mk(sb, 'src/small.txt', H.bigOutput(200));
  assert.strictEqual(H.runScript('read-guard.js', H.readEvent(sb, 'Read', { file_path: small }), sb).stdout, '');
  H.writeConfig(sb, { readGuard: { maxLines: 5000 } });
  assert.strictEqual(H.runScript('read-guard.js', H.readEvent(sb, 'Read', { file_path: big }), sb).stdout, '');
});

test('warn mode adds context instead of denying', () => {
  const sb = H.sandbox();
  H.writeConfig(sb, { readGuard: { mode: 'warn' } });
  const r = H.runScript('read-guard.js', H.readEvent(sb, 'Read', { file_path: mk(sb, 'node_modules/p/i.js') }), sb);
  assert.ok(!denied(r));
  assert.match(r.json.hookSpecificOutput.additionalContext, /discouraged/);
});

test('repeated identical read gets a soft warning, changed file does not', () => {
  const sb = H.sandbox();
  const p = mk(sb, 'src/a.py', 'a=1\n');
  const ev = H.readEvent(sb, 'Read', { file_path: p });
  assert.strictEqual(H.runScript('read-guard.js', ev, sb).stdout, '');
  const r2 = H.runScript('read-guard.js', ev, sb);
  assert.match(r2.json.hookSpecificOutput.additionalContext, /already read/);
  assert.ok(!denied(r2));
  const later = new Date(Date.now() + 5000); fs.writeFileSync(p, 'a=2\n'); fs.utimesSync(p, later, later);
  assert.strictEqual(H.runScript('read-guard.js', ev, sb).stdout, '');
});

test('Grep and Glob: ignored path or pattern is blocked, normal ones pass', () => {
  const sb = H.sandbox();
  mk(sb, 'node_modules/x/i.js'); mk(sb, 'src/a.js');
  assert.ok(denied(H.runScript('read-guard.js', H.readEvent(sb, 'Grep', { pattern: 'foo', path: path.join(sb.proj, 'node_modules') }), sb)));
  assert.ok(denied(H.runScript('read-guard.js', H.readEvent(sb, 'Glob', { pattern: '**/node_modules/**/*.js' }), sb)));
  assert.ok(denied(H.runScript('read-guard.js', H.readEvent(sb, 'Grep', { pattern: 'foo', glob: 'node_modules/**' }), sb)));
  assert.strictEqual(H.runScript('read-guard.js', H.readEvent(sb, 'Grep', { pattern: 'foo' }), sb).stdout, '');
  assert.strictEqual(H.runScript('read-guard.js', H.readEvent(sb, 'Glob', { pattern: 'src/**/*.js' }), sb).stdout, '');
  assert.strictEqual(H.runScript('read-guard.js', H.readEvent(sb, 'Grep', { pattern: 'foo', path: path.join(sb.proj, 'src') }), sb).stdout, '');
});

test('guard disabled by flag', () => {
  const sb = H.sandbox();
  H.writeConfig(sb, { readGuard: { enabled: false } });
  assert.strictEqual(H.runScript('read-guard.js', H.readEvent(sb, 'Read', { file_path: path.join(sb.proj, 'node_modules', 'a.js') }), sb).stdout, '');
});

test('stats log records blocks with metadata only', () => {
  const sb = H.sandbox();
  H.runScript('read-guard.js', H.readEvent(sb, 'Read', { file_path: mk(sb, 'node_modules/p/i.js', 'SECRET CONTENT') }), sb);
  const s = fs.readFileSync(path.join(sb.proj, '.claude', 'auto-orchestra-stats.jsonl'), 'utf8');
  assert.match(s, /"kind":"read_block"/);
  assert.ok(!s.includes('SECRET CONTENT'));
});
