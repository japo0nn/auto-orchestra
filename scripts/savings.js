#!/usr/bin/env node
'use strict';
// /auto-orchestra:savings: summary of .claude/auto-orchestra-stats.jsonl. Token numbers are rough (chars / 4).
const fs = require('fs');
const path = require('path');
const C = require('./lib/common');

try {
  const proj = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const file = path.join(proj, '.claude', 'auto-orchestra-stats.jsonl');
  let rows = [];
  try { rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); } catch (e) { /* none */ }
  if (!rows.length) { console.log('No savings recorded yet in ' + file + '. (Hooks log only when they actually compress or block something.)'); process.exit(0); }
  const agg = rs => {
    const a = { filter: 0, charsSaved: 0, blocks: 0, blockBytes: 0, warns: 0, repeats: 0, overrides: 0 };
    for (const r of rs) {
      if (r.kind === 'bash_filter') { a.filter++; a.charsSaved += Math.max(0, (r.charsBefore || 0) - (r.charsAfter || 0)); }
      else if (r.kind === 'read_block') { a.blocks++; a.blockBytes += r.bytes || 0; }
      else if (r.kind === 'read_warn') a.warns++;
      else if (r.kind === 'read_repeat_warn') a.repeats++;
      else if (r.kind === 'read_override') a.overrides++;
    }
    return a;
  };
  const week = rows.filter(r => Date.now() - Date.parse(r.ts) < 7 * 86400000);
  const fmt = (title, a) => [
    '### ' + title,
    '- Bash output compressed: ' + a.filter + ' times, ' + a.charsSaved + ' chars saved (~' + C.estTokens(a.charsSaved) + ' tokens, estimate)',
    '- Reads blocked: ' + a.blocks + ' (files totalling ~' + a.blockBytes + ' bytes; at most ~' + C.estTokens(a.blockBytes) + ' tokens avoided, an upper-bound estimate: Claude would not always have read the whole file)',
    '- Warnings only: ' + a.warns + ' ignored-path, ' + a.repeats + ' repeated-read; overrides let through: ' + a.overrides
  ].join('\n');
  console.log('## auto-orchestra savings (tokens ≈ chars / 4, rough estimates, not billing data)\n');
  console.log(fmt('All time (' + rows.length + ' events, since ' + rows[0].ts.slice(0, 10) + ')', agg(rows)));
  console.log('\n' + fmt('Last 7 days', agg(week)));
  const byCmd = {};
  for (const r of rows) if (r.kind === 'bash_filter') { const k = r.cmd || '?'; byCmd[k] = (byCmd[k] || 0) + Math.max(0, (r.charsBefore || 0) - (r.charsAfter || 0)); }
  const top = Object.entries(byCmd).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (top.length) { console.log('\n### Top compressed commands (chars saved)'); top.forEach(([k, v]) => console.log('- `' + k + '`: ' + v)); }
  console.log('\nLog: ' + file + ' (metadata only: command name, sizes, paths; add it to .gitignore)');
} catch (e) { console.log('savings report failed: ' + e.message); }
