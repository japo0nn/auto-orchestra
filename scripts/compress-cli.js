#!/usr/bin/env node
'use strict';
// Used by bash-wrap.js: node compress-cli.js <outputFile> <exitCode> <shortCmd>
// Prints the (possibly compressed) output. Always prints something and exits 0; the wrapper restores the exit code.
const fs = require('fs');
const C = require('./lib/common');
const { compress } = require('./lib/compress');

try {
  const file = process.argv[2];
  const exitCode = process.argv[3];
  const short = process.argv[4] || '';
  const raw = fs.readFileSync(file, 'utf8');
  const proj = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const cfg = C.loadConfig(proj);
  const b = cfg.bash;
  const lineCount = raw.split('\n').length;
  if (lineCount < b.noisyMinLines && raw.length < b.noisyMinChars) {
    process.stdout.write(raw);
    try { fs.unlinkSync(file); } catch (e) { /* ignore */ }
  } else {
    const res = compress(raw, {
      head: b.head, tail: b.tail, maxMatches: b.maxMatches, maxLineLength: b.maxLineLength,
      errorPatterns: b.errorPatterns.concat(b.extraErrorPatterns), savedPath: file, exitCode
    });
    if (res.changed) {
      process.stdout.write(res.text + '\n');
      C.appendStat(proj, cfg, { kind: 'bash_filter', cmd: short, charsBefore: raw.length, charsAfter: res.text.length, wrapped: true });
    } else {
      process.stdout.write(raw);
      try { fs.unlinkSync(file); } catch (e) { /* ignore */ }
    }
  }
} catch (e) {
  try { process.stdout.write(fs.readFileSync(process.argv[2], 'utf8')); } catch (e2) { /* nothing to show */ }
}
process.exitCode = 0;
