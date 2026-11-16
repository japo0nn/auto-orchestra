#!/usr/bin/env node
'use strict';
// Helper for /auto-orchestra:statusline. Default: only REPORTS (existing statusLine, suggested snippet).
// With --copy: copies statusline.js (+ lib) to ~/.claude/auto-orchestra/statusline/. It never edits settings.json.
const fs = require('fs');
const os = require('os');
const path = require('path');

const destDir = path.join(os.homedir(), '.claude', 'auto-orchestra', 'statusline');
const destFile = path.join(destDir, 'statusline.js');
const snippet = { statusLine: { type: 'command', command: 'node ' + JSON.stringify(destFile.replace(/\\/g, '/')).slice(1, -1) } };

try {
  if (process.argv.includes('--copy')) {
    fs.mkdirSync(path.join(destDir, 'lib'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'statusline.js'), destFile);
    fs.copyFileSync(path.join(__dirname, 'lib', 'common.js'), path.join(destDir, 'lib', 'common.js'));
    console.log('Copied status line script to ' + destFile);
    console.log('settings.json was NOT modified.');
  }
  let existing = null;
  try { existing = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8')).statusLine || null; } catch (e) { /* none */ }
  console.log(existing ? 'Existing statusLine in ~/.claude/settings.json (NOT touched): ' + JSON.stringify(existing) : 'No statusLine is configured in ~/.claude/settings.json.');
  console.log('Script installed: ' + fs.existsSync(destFile));
  console.log('Add this to ~/.claude/settings.json to use it:\n' + JSON.stringify(snippet, null, 2));
} catch (e) { console.log('statusline helper failed: ' + e.message); }
