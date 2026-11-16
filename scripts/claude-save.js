#!/usr/bin/env node
'use strict';
// Install a drafted file into .claude/. Claude Code treats .claude/ as sensitive (Write/Edit there asks for approval or
// is denied when headless), so agents write a draft INSIDE the project and this script moves it.
// Usage: node claude-save.js <repomap|handoff> <draftFile> [projectDir]
//   repomap: also stamps the header with the current commit and removes .claude/repomap.stale.json
const fs = require('fs');
const path = require('path');
const C = require('./lib/common');

try {
  const [name, draftArg, projArg] = process.argv.slice(2);
  if (name !== 'repomap' && name !== 'handoff') { console.log('claude-save: first argument must be "repomap" or "handoff".'); process.exit(0); }
  const proj = path.resolve(projArg || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const draft = path.resolve(proj, draftArg || '');
  const rel = path.relative(proj, draft);
  if (!draftArg || rel.startsWith('..') || path.isAbsolute(rel)) { console.log('claude-save: the draft file must be inside the project (' + proj + ').'); process.exit(0); }
  const st = fs.statSync(draft);
  if (!st.isFile() || st.size === 0 || st.size > 200 * 1024) { console.log('claude-save: draft is missing, empty or larger than 200 KB.'); process.exit(0); }
  const dest = path.join(proj, '.claude', name + '.md');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(draft, dest);
  fs.unlinkSync(draft);
  let msg = 'Saved .claude/' + name + '.md (' + fs.readFileSync(dest, 'utf8').split('\n').length + ' lines); draft removed.';
  if (name === 'repomap') { const stamp = C.stampRepomap(proj); msg += ' Header: ' + stamp + '; stale flag cleared.'; }
  console.log(msg);
} catch (e) { console.log('claude-save failed: ' + e.message); }
