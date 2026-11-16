'use strict';
// Output compression: head + tail + every error/warning line from the middle. Pure functions, no I/O.
function stripAnsi(s) {
  return s.replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\u001b\][^\u0007]*\u0007/g, '');
}

function normalizeLines(text) {
  // Keeps the number of lines identical to the raw text so line numbers match the saved full output.
  return stripAnsi(String(text)).replace(/\r\n/g, '\n').split('\n').map(l => {
    if (l.indexOf('\r') < 0) return l;
    const parts = l.split('\r').filter(x => x.length);
    return parts.length ? parts[parts.length - 1] : '';
  });
}

function compile(patterns) {
  const out = [];
  for (const p of patterns) { try { out.push(new RegExp(p, 'i')); } catch (e) { /* skip */ } }
  return out;
}

function clip(line, max) { return line.length > max ? line.slice(0, max) + ' …[+' + (line.length - max) + ' chars]' : line; }

// opts: head, tail, maxMatches, maxLineLength, errorPatterns[], savedPath, exitCode (optional)
function compress(text, opts) {
  const raw = String(text);
  const lines = normalizeLines(raw);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const n = lines.length;
  const head = opts.head, tail = opts.tail;
  if (n <= head + tail + 5) return { changed: false, text: raw, totalLines: n };
  const rx = compile(opts.errorPatterns || []);
  const matches = [];
  let totalMatches = 0;
  for (let i = head; i < n - tail; i++) {
    if (rx.some(r => r.test(lines[i]))) {
      totalMatches++;
      if (matches.length < opts.maxMatches) matches.push(i);
    }
  }
  const L = i => clip(lines[i], opts.maxLineLength);
  const out = [];
  out.push('[auto-orchestra] output compressed: ' + n + ' lines / ' + raw.length + ' chars' +
    (opts.savedPath ? '. Full output: ' + opts.savedPath + ' (read a part with Read offset/limit)' : '. Full output was not saved') +
    (opts.exitCode !== undefined && opts.exitCode !== null ? '. Exit code: ' + opts.exitCode : ''));
  out.push('--- first ' + head + ' lines ---');
  for (let i = 0; i < head; i++) out.push(L(i));
  if (matches.length) {
    out.push('--- ' + matches.length + (totalMatches > matches.length ? ' of ' + totalMatches : '') + ' error/warning lines from the middle (line number: text) ---');
    let prev = null, rep = 0;
    const flush = () => { if (rep > 0) out.push('  (previous line repeated ' + rep + ' more time' + (rep > 1 ? 's' : '') + ')'); rep = 0; };
    for (const i of matches) {
      if (prev !== null && lines[i] === prev) { rep++; continue; }
      flush(); prev = lines[i]; out.push((i + 1) + ': ' + L(i));
    }
    flush();
  } else {
    out.push('--- no error/warning lines in the omitted ' + (n - head - tail) + ' middle lines ---');
  }
  out.push('--- last ' + tail + ' lines ---');
  for (let i = n - tail; i < n; i++) out.push(L(i));
  const res = out.join('\n');
  if (res.length > raw.length * 0.8) return { changed: false, text: raw, totalLines: n };
  return { changed: true, text: res, totalLines: n, totalMatches, shownMatches: matches.length };
}

module.exports = { compress, normalizeLines, stripAnsi };
