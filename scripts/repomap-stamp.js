#!/usr/bin/env node
'use strict';
// Stamp .claude/repomap.md with the current git HEAD (or mtime when not a git repo) and delete .claude/repomap.stale.json.
// Usage: node repomap-stamp.js [projectDir]
const path = require('path');
const C = require('./lib/common');

try {
  const proj = path.resolve(process.argv[2] || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const stamp = C.stampRepomap(proj);
  console.log(stamp ? 'Stamped repomap header: ' + stamp + '; stale flag cleared.' : 'No .claude/repomap.md: nothing stamped.');
} catch (e) { console.log('repomap-stamp failed: ' + e.message); }
