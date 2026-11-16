'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { DEFAULTS } = require('../scripts/lib/common');

test('JSON schema is in sync with the code defaults (run: node scripts/gen-schema.js)', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'auto-orchestra.schema.json'), 'utf8'));
  const walk = (d, s, p) => {
    for (const k of Object.keys(d)) {
      assert.ok(s.properties[k], 'schema lacks ' + p + k);
      if (d[k] && typeof d[k] === 'object' && !Array.isArray(d[k])) walk(d[k], s.properties[k], p + k + '.');
      else assert.deepStrictEqual(s.properties[k].default, d[k], 'default differs for ' + p + k);
    }
  };
  walk(DEFAULTS, schema, '');
});

test('plugin manifest, hooks and commands are consistent', () => {
  const root = path.join(__dirname, '..');
  const plugin = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.match(plugin.version, /^0\.2\./);
  const hooks = JSON.parse(fs.readFileSync(path.join(root, 'hooks', 'hooks.json'), 'utf8')).hooks;
  for (const ev of Object.values(hooks)) for (const m of ev) for (const h of m.hooks) {
    const script = h.args[0].replace('${CLAUDE_PLUGIN_ROOT}', root);
    assert.ok(fs.existsSync(script), 'hook script exists: ' + script);
    assert.strictEqual(h.command, 'node');
  }
  for (const c of ['handoff', 'repomap', 'mcp-audit', 'savings', 'statusline', 'orchestrate']) assert.ok(fs.existsSync(path.join(root, 'commands', c + '.md')), c);
});
