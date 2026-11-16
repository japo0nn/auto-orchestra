#!/usr/bin/env node
'use strict';
// /auto-orchestra:mcp-audit: which MCP servers are configured and which were actually used in recent sessions.
// Reads only server NAMES/types (never env, args or headers) from ~/.claude.json and .mcp.json, and tool_use
// names from this project's recent transcripts under ~/.claude/projects. Disables nothing.
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('./lib/common');

const proj = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const maxSessions = Number((process.argv.find(a => a.startsWith('--sessions=')) || '').split('=')[1]) || 10;
const norm = n => String(n).replace(/[^a-zA-Z0-9_-]/g, '_');

try {
  const servers = new Map(); // normalized name -> {name, scope, type}
  const add = (name, scope, def) => {
    const k = norm(name);
    if (!servers.has(k)) servers.set(k, { name, scope, type: def && def.url ? 'remote' : def && def.command ? 'local' : '?' });
  };
  const userCfg = C.readJsonSafe(path.join(os.homedir(), '.claude.json')) || {};
  Object.entries(userCfg.mcpServers || {}).forEach(([n, d]) => add(n, 'user', d));
  const pj = (userCfg.projects || {})[proj];
  if (pj) Object.entries(pj.mcpServers || {}).forEach(([n, d]) => add(n, 'local', d));
  const mcpJson = C.readJsonSafe(path.join(proj, '.mcp.json')) || {};
  Object.entries(mcpJson.mcpServers || {}).forEach(([n, d]) => add(n, 'project', d));

  const enc = proj.replace(/[^a-zA-Z0-9]/g, '-');
  const tdir = path.join(os.homedir(), '.claude', 'projects', enc);
  let files = [];
  try {
    files = fs.readdirSync(tdir).filter(f => f.endsWith('.jsonl')).map(f => ({ f: path.join(tdir, f), m: fs.statSync(path.join(tdir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m).slice(0, maxSessions);
  } catch (e) { /* no transcripts */ }
  const usage = new Map(); // server -> {uses, last}
  for (const { f, m } of files) {
    let text;
    try { if (fs.statSync(f).size > 80 * 1024 * 1024) continue; text = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
    for (const line of text.split('\n')) {
      if (line.indexOf('"tool_use"') < 0 || line.indexOf('mcp__') < 0) continue;
      let o; try { o = JSON.parse(line); } catch (e) { continue; }
      const content = o && o.message && Array.isArray(o.message.content) ? o.message.content : [];
      for (const c of content) {
        if (c && c.type === 'tool_use' && typeof c.name === 'string' && c.name.startsWith('mcp__')) {
          const srv = c.name.split('__')[1];
          const u = usage.get(srv) || { uses: 0, last: 0 };
          u.uses++; u.last = Math.max(u.last, Date.parse(o.timestamp) || m);
          usage.set(srv, u);
        }
      }
    }
  }
  const rows = [];
  for (const [k, s] of servers) rows.push({ name: s.name, src: 'config (' + s.scope + ', ' + s.type + ')', u: usage.get(k) || { uses: 0, last: 0 } });
  for (const [k, u] of usage) if (!servers.has(k)) rows.push({ name: k, src: 'plugin / claude.ai connector (seen only via usage)', u });
  console.log('## MCP audit: ' + files.length + ' most recent session transcript(s) of this project\n');
  if (!rows.length) { console.log('No MCP servers found in ~/.claude.json, .mcp.json or recent usage. Plugin-provided and claude.ai connectors that were never used cannot be listed from files; see /mcp.'); process.exit(0); }
  console.log('| Server | Source | Tool calls | Last used |\n|---|---|---|---|');
  rows.sort((a, b) => a.u.uses - b.u.uses).forEach(r => console.log('| ' + r.name + ' | ' + r.src + ' | ' + r.u.uses + ' | ' + (r.u.last ? new Date(r.u.last).toISOString().slice(0, 10) : 'never') + ' |'));
  const unused = rows.filter(r => r.u.uses === 0).map(r => r.name);
  console.log('\n### Recommendations (nothing was changed)');
  console.log(unused.length ? '- No calls in the last ' + files.length + ' sessions: ' + unused.join(', ') + '. Candidates to disable via /mcp (or remove from config) if you do not need them: every enabled server adds its tool descriptions to the context.' : '- All listed servers were used recently.');
  console.log('- Description size per server is not available from files. Run `/context` for the real token cost of MCP tools, and compare it with the usage above.');
  console.log('- Claude.ai connectors and plugin servers that were never called cannot be enumerated from disk; check `/mcp` for them.');
} catch (e) { console.log('mcp-audit failed: ' + e.message); }
