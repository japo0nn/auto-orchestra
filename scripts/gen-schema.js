#!/usr/bin/env node
'use strict';
// Generates auto-orchestra.schema.json from the in-code defaults so the two cannot drift. Run: node scripts/gen-schema.js
const fs = require('fs');
const path = require('path');
const { DEFAULTS } = require('./lib/common');

const DESC = {
  enabled: 'Master switch for every hook of the plugin.',
  'bash.enabled': 'Compress oversized Bash output.',
  'bash.mode': '"post": compress successful output after it ran (safe). "wrap": also rewrite noisy commands so failed output is compressed (experimental; may trigger permission prompts).',
  'bash.minLines': 'Non-noisy commands: compress above this many lines...', 'bash.minChars': '...or this many characters.',
  'bash.noisyMinLines': 'Noisy commands (noisyCommands): lower line threshold.', 'bash.noisyMinChars': 'Noisy commands: lower character threshold.',
  'bash.head': 'Lines kept from the start.', 'bash.tail': 'Lines kept from the end.', 'bash.maxMatches': 'Max error/warning lines kept from the middle.',
  'bash.maxLineLength': 'Longer lines are cut.', 'bash.saveFull': 'Save the full output to a temp file and name it in the compressed text (if false or saving fails, nothing is compressed).',
  'bash.tmpTtlHours': 'Delete saved outputs older than this.',
  'bash.noisyCommands': 'Regexes (case-insensitive) matched against each command chain; matching commands use the lower thresholds. Replaces the defaults.',
  'bash.extraNoisyCommands': 'Regexes appended to noisyCommands.',
  'bash.neverFilter': 'Regexes for commands whose output is never compressed (readers: cat, grep, git diff...). Replaces the defaults.',
  'bash.extraNeverFilter': 'Regexes appended to neverFilter.',
  'bash.secretCommands': 'Regexes for secret-looking commands: never filtered, nothing saved to disk. Replaces the defaults.',
  'bash.extraSecretCommands': 'Regexes appended to secretCommands.',
  'bash.errorPatterns': 'Regexes (case-insensitive) for lines kept from the omitted middle. Replaces the defaults.',
  'bash.extraErrorPatterns': 'Regexes appended to errorPatterns.',
  'readGuard.enabled': 'Guard Read, Grep and Glob.', 'readGuard.mode': '"block" denies the call; "warn" only adds a note.',
  'readGuard.useGitignore': 'Also treat paths ignored by the root .gitignore as guarded.',
  'readGuard.confirmRepeat': 'Let a blocked call through when it is repeated unchanged in the same session.',
  'readGuard.warnRepeatRead': 'Soft warning when the same unchanged file range is read twice in a session.',
  'readGuard.maxLines': 'Files with more lines must be read with offset and limit.', 'readGuard.sizeCheckBytes': 'Skip the line count for files smaller than this.',
  'readGuard.ignoreDirs': 'Directory names that are never read. Replaces the defaults.', 'readGuard.ignoreFiles': 'File globs that are never read. Replaces the defaults.',
  'readGuard.binaryExtensions': 'Extensions treated as binary/archives (images and PDFs stay readable).',
  'readGuard.extraIgnore': 'Plain names or globs appended to ignoreDirs/ignoreFiles.', 'readGuard.allow': 'Globs relative to the project root that are never guarded.',
  'handoff.enabled': 'Handoff features (PreCompact snapshot, SessionStart hint).', 'handoff.writeAutoSnapshot': 'PreCompact writes .claude/handoff.auto.md (git facts).',
  'handoff.sessionStartHint': 'SessionStart mentions an existing handoff file.',
  'repomap.enabled': 'Repo map features.', 'repomap.staleDays': 'Map older than this is reported stale.', 'repomap.staleCommits': 'Map built this many commits ago is reported stale.',
  'repomap.sessionStartHint': 'SessionStart mentions the map.', 'repomap.suggestWhenMissing': 'Also hint when no map exists.',
  'repomap.autoRefresh': 'PostToolUse watcher writes .claude/repomap.stale.json on structural change.', 'repomap.maxChangedFiles': 'More changed files than this is structural.',
  'repomap.minStructuralOps': 'Added+deleted+renamed files needed to flag the map.', 'repomap.driftThreshold': 'Missing paths referenced by the map that advise a full rebuild.',
  'repomap.watchThrottleSeconds': 'Minimum seconds between checks for Edit/Write/Bash events.', 'repomap.manifestFiles': 'Globs of dependency/build manifests; a change to one is structural.',
  'repomap.entryFiles': 'Globs of typical entry-point file names (reported, not flagged on their own).',
  'statusline.warnPercent': 'Context percentage at which the status line warns.', 'stats.enabled': 'Write .claude/auto-orchestra-stats.jsonl (metadata only).'
};

function build(obj, prefix) {
  const props = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? prefix + '.' + k : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) props[k] = Object.assign({ type: 'object', additionalProperties: false, description: key + ' settings.' }, build(v, key));
    else if (Array.isArray(v)) props[k] = { type: 'array', items: { type: 'string' }, default: v, description: DESC[key] || '' };
    else props[k] = Object.assign({ type: typeof v, default: v, description: DESC[key] || '' }, key === 'bash.mode' ? { enum: ['post', 'wrap'] } : key === 'readGuard.mode' ? { enum: ['block', 'warn'] } : {});
  }
  return { properties: props };
}

const schema = Object.assign({ $schema: 'http://json-schema.org/draft-07/schema#', title: 'auto-orchestra configuration', type: 'object', additionalProperties: false },
  build(DEFAULTS, ''));
schema.properties.$schema = { type: 'string' };
fs.writeFileSync(path.join(__dirname, '..', 'auto-orchestra.schema.json'), JSON.stringify(schema, null, 2) + '\n');
console.log('wrote auto-orchestra.schema.json');
