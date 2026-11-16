#!/usr/bin/env node
'use strict';
// PostToolUse(Edit|Write|Bash|Agent): cheaply compare the working tree with the commit .claude/repomap.md was built at,
// write .claude/repomap.stale.json when the change is structural, and (main thread only, once per change) add one
// line of context for the orchestrator. It never starts subagents and never blocks anything.
const fs = require('fs');
const path = require('path');
const C = require('./lib/common');

function header(mapFile) {
  const first = fs.readFileSync(mapFile, 'utf8').split('\n').slice(0, 3).join('\n');
  const m = /repomap\s+([^>]*?)-->/i.exec(first);
  const attrs = {};
  if (m) m[1].replace(/(\w+)=(\S+)/g, (_, k, v) => { attrs[k] = v; return ''; });
  return attrs;
}

function walkNewer(proj, since, cfg) {
  const skip = new Set(cfg.readGuard.ignoreDirs.concat(['.claude', '.git']).map(s => s.toLowerCase()));
  const out = { added: [], modified: [] };
  let seen = 0;
  const stack = [proj];
  while (stack.length && seen < 4000) {
    const dir = stack.pop();
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of ents) {
      if (seen++ >= 4000) break;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!skip.has(e.name.toLowerCase())) stack.push(p); continue; }
      if (!e.isFile()) continue;
      try {
        const st = fs.statSync(p);
        const rel = C.toPosix(path.relative(proj, p));
        if (st.birthtimeMs > since) out.added.push(rel); else if (st.mtimeMs > since) out.modified.push(rel);
      } catch (err) { /* ignore */ }
    }
  }
  return out;
}

function missingRefs(proj, mapFile) {
  const text = fs.readFileSync(mapFile, 'utf8');
  const seen = new Set(); const missing = [];
  const rx = /`([^`\s]+)`/g; let m;
  while ((m = rx.exec(text)) && seen.size < 300) {
    let t = m[1].replace(/:\d+(-\d+)?$/, '').replace(/[,.;]$/, '');
    if (/[*?<>{}$|()=]|^https?:|^[-.]{1,2}$/.test(t) || t.startsWith('--')) continue;
    if (!/[\/\\]/.test(t) && !/\.[A-Za-z0-9]{1,6}$/.test(t)) continue;
    if (seen.has(t)) continue; seen.add(t);
    if (path.isAbsolute(t) || t.startsWith('~') || t.startsWith('..')) continue;
    if (!fs.existsSync(path.join(proj, t))) missing.push(t);
  }
  return missing;
}

C.runHook(async input => {
  const tn = input.tool_name;
  const proj = C.projectDirOf(input);
  const cfg = C.loadConfig(proj);
  if (!C.featureOn(cfg, 'repomap') || !cfg.repomap.autoRefresh) return;
  const mapFile = path.join(proj, '.claude', 'repomap.md');
  if (!fs.existsSync(mapFile)) return;
  const flagFile = path.join(proj, '.claude', 'repomap.stale.json');
  const r = cfg.repomap;

  const st = C.loadState(input.session_id);
  const subagentCall = tn === 'Agent' || tn === 'Task';
  const last = st.data.watchTs || 0;
  if (!subagentCall && Date.now() - last < r.watchThrottleSeconds * 1000) return;
  st.data.watchTs = Date.now(); C.saveState(st);

  const attrs = header(mapFile);
  const counts = { added: 0, deleted: 0, renamed: 0, modified: 0, manifests: 0, entryTouched: 0, total: 0 };
  const changed = []; const manifests = []; const entries = [];
  const ignored = f => { const lf = f.toLowerCase(); return lf.startsWith('.claude/') || lf === '.auto-orchestra.json' || lf.split('/').some(s => cfg.readGuard.ignoreDirs.some(d => d.toLowerCase() === s)) || cfg.readGuard.ignoreFiles.some(g => C.globMatch(g, f)); };
  const isManifest = f => r.manifestFiles.some(g => C.globMatch(g, f));
  const isEntry = f => r.entryFiles.some(g => C.globMatch(g, f.split('/').pop()));
  let baseFiles = null;
  try { const b = JSON.parse(fs.readFileSync(path.join(proj, '.claude', 'repomap.base.json'), 'utf8')); if (b && b.files && attrs.head && b.head && attrs.head.startsWith(b.head.slice(0, 7))) baseFiles = b.files; } catch (e) { /* no baseline */ }
  const note = (status, f) => {
    if (ignored(f)) return;
    if (baseFiles && baseFiles[f] !== undefined && baseFiles[f] === C.fileSig(path.join(proj, f))) return; // already reflected in the map
    counts.total++;
    if (status === 'A') counts.added++; else if (status === 'D') counts.deleted++; else if (status === 'R') counts.renamed++; else counts.modified++;
    if (isManifest(f)) { counts.manifests++; manifests.push(f); }
    if (isEntry(f)) { counts.entryTouched++; entries.push(f); }
    if (changed.length < 20) changed.push(status + ' ' + f);
  };

  const head = attrs.head && attrs.head !== 'none' ? attrs.head : null;
  if (head && C.git(['rev-parse', '--git-dir'], proj) !== null) {
    const diff = C.git(['diff', '--name-status', '-M', head], proj, 4000);
    if (diff === null) return; // map commit not in history or git failed: leave judgement to the SessionStart hint
    for (const line of diff.split('\n').filter(Boolean)) {
      const parts = line.split('\t');
      const s = parts[0][0];
      note(s === 'C' ? 'A' : s, parts[parts.length - 1]);
    }
    const porcelain = C.git(['status', '--porcelain', '-uall'], proj, 4000) || '';
    for (const line of porcelain.split('\n')) if (line.startsWith('??')) note('A', line.slice(3).trim().replace(/^"|"$/g, ''));
  } else if (attrs.mtime && /^\d+$/.test(attrs.mtime)) {
    const w = walkNewer(proj, Number(attrs.mtime), cfg);
    w.added.forEach(f => note('A', f)); w.modified.forEach(f => note('M', f));
  } else return; // no usable baseline in the header

  const missing = missingRefs(proj, mapFile);
  const reasons = [];
  const ops = counts.added + counts.deleted + counts.renamed;
  if (ops >= r.minStructuralOps) reasons.push(counts.added + ' added, ' + counts.deleted + ' deleted, ' + counts.renamed + ' renamed files');
  if (counts.manifests) reasons.push('manifest/build files changed: ' + manifests.slice(0, 5).join(', '));
  if (counts.total > r.maxChangedFiles) reasons.push(counts.total + ' files changed (> ' + r.maxChangedFiles + ')');
  const rebuild = missing.length >= r.driftThreshold;
  if (rebuild) reasons.push(missing.length + ' paths in the map no longer exist');

  if (!reasons.length) { try { fs.unlinkSync(flagFile); } catch (e) { /* none */ } return; }

  const fingerprint = C.sha1(JSON.stringify([counts, rebuild, manifests, missing.length]));
  let prev = null; try { prev = JSON.parse(fs.readFileSync(flagFile, 'utf8')); } catch (e) { /* none */ }
  const alreadyTold = prev && prev.fingerprint === fingerprint && prev.notified;
  const wantNotify = !input.agent_id && !alreadyTold;
  const flag = {
    reason: reasons, counts, rebuild, since: head || ('mtime ' + attrs.mtime), computedAt: new Date().toISOString(),
    changedSample: changed, entryPointsTouched: entries.slice(0, 10), missingRefs: missing.slice(0, 15), fingerprint,
    notified: !!(alreadyTold || wantNotify)
  };
  fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
  fs.writeFileSync(flagFile, JSON.stringify(flag, null, 2) + '\n');
  if (!wantNotify) return;
  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: '[auto-orchestra] .claude/repomap.md is out of date (' + reasons.join('; ') + '). Details: .claude/repomap.stale.json. ' +
        (rebuild ? 'The map drifted a lot: plan a FULL rebuild (/auto-orchestra:repomap --rebuild). ' : 'Refresh it incrementally after the review passes (or earlier if the next steps depend on the map). ') +
        'You decide whether the change is structural.'
    }
  };
});
