#!/usr/bin/env node
'use strict';
// SessionStart: a one-paragraph hint about .claude/handoff.md and .claude/repomap.md. Never injects their contents.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const C = require('./lib/common');

function git(args, cwd) {
  try { return cp.execFileSync('git', args, { cwd, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch (e) { return null; }
}

function ageText(ms) {
  const m = Math.round(ms / 60000);
  if (m < 90) return m + ' min';
  const h = Math.round(m / 60);
  return h < 48 ? h + ' h' : Math.round(h / 24) + ' days';
}

function repomapStatus(file, proj, rcfg) {
  const st = fs.statSync(file);
  const ageDays = (Date.now() - st.mtimeMs) / 86400000;
  const head = (fs.readFileSync(file, 'utf8').split('\n').slice(0, 3).join('\n').match(/repomap\s+head=([0-9a-f]{7,40})/i) || [])[1];
  const reasons = [];
  if (ageDays > rcfg.staleDays) reasons.push('older than ' + rcfg.staleDays + ' days');
  if (head) {
    const cur = git(['rev-parse', 'HEAD'], proj);
    if (cur && !cur.startsWith(head) && !head.startsWith(cur)) {
      const n = git(['rev-list', '--count', head + '..HEAD'], proj);
      if (n === null) reasons.push('built at a commit that is no longer in history');
      else if (Number(n) > rcfg.staleCommits) reasons.push(n + ' commits since it was built');
    }
  }
  return { age: ageText(Date.now() - st.mtimeMs), stale: reasons.length > 0, reasons };
}

C.runHook(async input => {
  const proj = C.projectDirOf(input);
  const cfg = C.loadConfig(proj);
  if (cfg.enabled === false) return;
  const source = input.source || 'startup';
  const parts = [];

  if (C.featureOn(cfg, 'handoff') && cfg.handoff.sessionStartHint && source !== 'resume') {
    for (const [name, label] of [['handoff.md', 'handoff'], ['handoff.auto.md', 'auto snapshot']]) {
      const f = path.join(proj, '.claude', name);
      try {
        const st = fs.statSync(f);
        const lines = fs.readFileSync(f, 'utf8').split('\n').length;
        parts.push('.claude/' + name + ' (' + label + ', ' + ageText(Date.now() - st.mtimeMs) + ' old, ' + lines + ' lines) exists. Read it only if the user\'s task continues that earlier work.');
        break;
      } catch (e) { /* not present */ }
    }
  }
  if (C.featureOn(cfg, 'repomap') && cfg.repomap.sessionStartHint) {
    const f = path.join(proj, '.claude', 'repomap.md');
    try {
      const s = repomapStatus(f, proj, cfg.repomap);
      let flagged = null;
      try { flagged = JSON.parse(fs.readFileSync(path.join(proj, '.claude', 'repomap.stale.json'), 'utf8')); } catch (e) { /* no flag */ }
      if (flagged && Array.isArray(flagged.reason)) { s.stale = true; s.reasons = s.reasons.concat('structural changes pending: ' + flagged.reason.join('; ')); }
      parts.push(s.stale
        ? '.claude/repomap.md exists but may be STALE (' + s.reasons.join('; ') + '). Use it as a starting point and verify; offer /auto-orchestra:repomap to refresh.'
        : '.claude/repomap.md is a fresh repository map (' + s.age + ' old). Read it before exploring the repo instead of walking directories.');
    } catch (e) {
      if (cfg.repomap.suggestWhenMissing) parts.push('No repository map yet. For a non-trivial repo, /auto-orchestra:repomap builds a compact one.');
    }
  }
  if (!parts.length) return;
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '[auto-orchestra] ' + parts.join(' ') } };
});
