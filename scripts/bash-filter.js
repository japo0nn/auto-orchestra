#!/usr/bin/env node
'use strict';
// PostToolUse(Bash): replace oversized successful output with a compressed version (updatedToolOutput).
// The command itself is never touched, so permission rules, exit codes and shell state are unaffected.
const fs = require('fs');
const path = require('path');
const C = require('./lib/common');
const { compress } = require('./lib/compress');

function outDir(input, proj) {
  const sp = input.scratchpad_dir;
  if (typeof sp === 'string' && sp) { try { fs.mkdirSync(sp, { recursive: true }); return sp; } catch (e) { /* fall through */ } }
  const d = path.join(proj, '.claude', 'auto-orchestra', 'out');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

C.runHook(async input => {
  if (input.tool_name !== 'Bash') return;
  const proj = C.projectDirOf(input);
  const cfg = C.loadConfig(proj);
  if (!C.featureOn(cfg, 'bash')) return;
  const b = cfg.bash;
  const tr = input.tool_response;
  if (!tr || typeof tr !== 'object' || tr.backgroundTaskId || tr.isImage) return;
  const stdout = typeof tr.stdout === 'string' ? tr.stdout : '';
  const stderr = typeof tr.stderr === 'string' ? tr.stderr : '';
  if (!stdout && !stderr) return;
  if (stdout.startsWith('[auto-orchestra]')) return; // already compressed by wrap mode
  const cmd = String((input.tool_input || {}).command || '');

  if (C.matchesAny(b.secretCommands.concat(b.extraSecretCommands), cmd)) return;
  if (C.anySegmentMatches(b.neverFilter.concat(b.extraNeverFilter), cmd)) return;

  const noisy = C.anySegmentMatches(b.noisyCommands.concat(b.extraNoisyCommands), cmd);
  const minLines = noisy ? b.noisyMinLines : b.minLines;
  const minChars = noisy ? b.noisyMinChars : b.minChars;
  const combined = stderr ? stdout + (stdout.endsWith('\n') ? '' : '\n') + '[stderr]\n' + stderr : stdout;
  const lineCount = combined.split('\n').length;
  if (lineCount < minLines && combined.length < minChars) return;

  let savedPath = null;
  if (b.saveFull) {
    try {
      const dir = outDir(input, proj);
      savedPath = path.join(dir, 'bash-' + Date.now() + '-' + C.sha1(cmd + Math.random()) + '.log');
      fs.writeFileSync(savedPath, combined);
      C.cleanupOld(dir, b.tmpTtlHours * 3600 * 1000, f => f.startsWith('bash-') && f.endsWith('.log'));
    } catch (e) { savedPath = null; }
  }
  if (b.saveFull && !savedPath) return; // never drop output we could not save

  const res = compress(combined, {
    head: b.head, tail: b.tail, maxMatches: b.maxMatches, maxLineLength: b.maxLineLength,
    errorPatterns: b.errorPatterns.concat(b.extraErrorPatterns), savedPath
  });
  if (!res.changed) { if (savedPath) { try { fs.unlinkSync(savedPath); } catch (e) { /* ignore */ } } return; }

  C.appendStat(proj, cfg, { kind: 'bash_filter', cmd: C.shortCmd(cmd), charsBefore: combined.length, charsAfter: res.text.length });
  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      updatedToolOutput: Object.assign({}, tr, { stdout: res.text, stderr: '' })
    }
  };
});
