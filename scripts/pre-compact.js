#!/usr/bin/env node
'use strict';
// PreCompact: (1) its stdout is added to the compaction instructions, (2) writes a mechanical snapshot
// .claude/handoff.auto.md (git facts only). Hooks cannot run the model, so the semantic handoff
// (/auto-orchestra:handoff) stays a manual or agent-driven step.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const C = require('./lib/common');

function git(args, cwd) {
  try { return cp.execFileSync('git', args, { cwd, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch (e) { return null; }
}

C.runHook(async input => {
  const proj = C.projectDirOf(input);
  const cfg = C.loadConfig(proj);
  if (!C.featureOn(cfg, 'handoff')) return;
  if (cfg.handoff.writeAutoSnapshot) {
    try {
      const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], proj);
      const head = git(['rev-parse', '--short', 'HEAD'], proj);
      const status = (git(['status', '--porcelain'], proj) || '').split('\n').filter(Boolean);
      const log = (git(['log', '-5', '--pretty=%h %s'], proj) || '').split('\n').filter(Boolean);
      const lines = ['# Auto snapshot before compaction (mechanical, git facts only)',
        '', 'time: ' + new Date().toISOString(), 'trigger: ' + (input.trigger || 'unknown')];
      if (branch) lines.push('branch: ' + branch + (head ? ' @ ' + head : ''));
      if (input.transcript_path) lines.push('transcript: ' + input.transcript_path);
      lines.push('', '## Uncommitted changes (' + status.length + ')');
      status.slice(0, 40).forEach(s => lines.push('- ' + s));
      if (status.length > 40) lines.push('- ... ' + (status.length - 40) + ' more');
      if (log.length) { lines.push('', '## Recent commits'); log.forEach(s => lines.push('- ' + s)); }
      lines.push('', 'For goals, decisions and remaining work see .claude/handoff.md if it exists (/auto-orchestra:handoff).');
      const dir = path.join(proj, '.claude');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'handoff.auto.md'), lines.slice(0, 60).join('\n') + '\n');
    } catch (e) { /* ignore */ }
  }
  return 'When summarizing, keep: the user\'s goal and acceptance criteria; decisions taken and why; files changed and their state; ' +
    'what is done and what remains; open questions and exact failing commands. Drop raw tool output, file dumps and exploration dead ends. ' +
    'Mention that .claude/handoff.auto.md has a git snapshot and .claude/handoff.md (if present) has the written handoff.';
});
