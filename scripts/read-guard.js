#!/usr/bin/env node
'use strict';
// PreToolUse(Read|Grep|Glob): keep dependency/build/lock/binary files and huge files out of the context.
// Reads only inside the project, ~/.claude and the session scratchpad (never anywhere else).
const fs = require('fs');
const path = require('path');
const C = require('./lib/common');

const NO_LINECOUNT_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'pdf', 'ico']);
const GLOB_CHARS = /[*?\[]/;

function extOf(p) { const m = /\.([A-Za-z0-9]+)$/.exec(p); return m ? m[1].toLowerCase() : ''; }

function countLines(file, size) {
  if (size > 50 * 1024 * 1024) return Infinity;
  const buf = fs.readFileSync(file);
  let n = 1;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
  return n;
}

function looksBinary(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, 4096, 0);
    for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
    return false;
  } catch (e) { return false; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (e) { /* ignore */ } }
}

function inside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

C.runHook(async input => {
  const tool = input.tool_name;
  if (tool !== 'Read' && tool !== 'Grep' && tool !== 'Glob') return;
  const proj = C.projectDirOf(input);
  const cfg = C.loadConfig(proj);
  if (!C.featureOn(cfg, 'readGuard')) return;
  const g = cfg.readGuard;
  const ti = input.tool_input || {};
  const sp = typeof input.scratchpad_dir === 'string' && input.scratchpad_dir ? path.resolve(input.scratchpad_dir) : null;
  const claudeHome = path.resolve(C.homeClaudeDir());
  const projAbs = path.resolve(proj);
  const trusted = abs => inside(projAbs, abs) || inside(claudeHome, abs) || (sp && inside(sp, abs));

  const extraNames = g.extraIgnore.filter(x => !GLOB_CHARS.test(x) && x.indexOf('/') < 0);
  const extraGlobs = g.extraIgnore.filter(x => GLOB_CHARS.test(x) || x.indexOf('/') >= 0);
  const dirSet = new Set(g.ignoreDirs.concat(extraNames).map(s => s.toLowerCase()));
  const fileGlobs = g.ignoreFiles.concat(extraGlobs);
  const gi = g.useGitignore ? C.loadGitignore(projAbs) : [];

  function allowed(relPosix) { return g.allow.some(a => C.globMatch(a, relPosix)); }

  // Returns {kind, why} when this path should not be read, otherwise null.
  function classify(p, isFile) {
    const abs = path.resolve(proj, p);
    const ext = extOf(abs);
    if (isFile && g.binaryExtensions.indexOf(ext) >= 0) {
      const rel0 = path.relative(projAbs, abs);
      if (!(inside(projAbs, abs) && allowed(C.toPosix(rel0)))) return { kind: 'binary', why: 'a binary/archive file (.' + ext + ')', abs };
    }
    if (!trusted(abs)) return null;
    if (inside(claudeHome, abs) || (sp && inside(sp, abs))) return null;
    const rel = C.toPosix(path.relative(projAbs, abs));
    if (!rel || rel === '.claude' || rel.startsWith('.claude/')) return null;
    if (allowed(rel)) return null;
    const segs = rel.split('/');
    for (const s of segs) if (dirSet.has(s.toLowerCase())) return { kind: 'ignored', why: 'inside "' + s + '/" (dependencies / build output / VCS data)', abs, rel };
    for (const gl of fileGlobs) if (C.globMatch(gl, rel)) return { kind: 'ignored', why: 'matches the ignore pattern "' + gl + '" (lock/minified/generated file)', abs, rel };
    if (gi.length && C.isGitIgnored(gi, rel)) return { kind: 'ignored', why: 'is ignored by the project .gitignore', abs, rel };
    if (isFile && !NO_LINECOUNT_EXT.has(ext)) {
      try { if (fs.statSync(abs).isFile() && looksBinary(abs)) return { kind: 'binary', why: 'a binary file', abs, rel }; } catch (e) { /* missing file: let the tool report it */ }
    }
    return null;
  }

  function patternHitsIgnoredDir(pat) {
    if (typeof pat !== 'string') return null;
    for (const s of pat.replace(/\\/g, '/').split('/')) if (s && !GLOB_CHARS.test(s) && dirSet.has(s.toLowerCase())) return s;
    return null;
  }

  const howTo = ' To read it anyway: ask the user to add the path to "readGuard.allow" in .auto-orchestra.json' +
    (g.confirmRepeat ? ', or, if it is really needed, repeat the identical call once (it is let through the second time in this session).' : '.');

  const st = C.loadState(input.session_id);
  const warnOnly = g.mode === 'warn';
  const reply = (msg, hard) => (warnOnly && !hard)
    ? { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: '[auto-orchestra] ' + msg } }
    : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: '[auto-orchestra] ' + msg } };

  // 1) ignored / binary targets
  let hit = null, label = '';
  if (tool === 'Read' && typeof ti.file_path === 'string') { hit = classify(ti.file_path, true); label = ti.file_path; }
  else if (tool === 'Grep') {
    if (typeof ti.path === 'string' && ti.path) { hit = classify(ti.path, false); label = ti.path; }
    if (!hit) { const d = patternHitsIgnoredDir(ti.glob); if (d) { hit = { kind: 'ignored', why: 'the glob filter targets "' + d + '/"', abs: label }; label = ti.glob; } }
  } else if (tool === 'Glob') {
    if (typeof ti.path === 'string' && ti.path) { hit = classify(ti.path, false); label = ti.path; }
    if (!hit) { const d = patternHitsIgnoredDir(ti.pattern); if (d) { hit = { kind: 'ignored', why: 'the pattern targets "' + d + '/"', abs: label }; label = ti.pattern; } }
  }
  if (hit) {
    const key = tool + ':' + (hit.abs || label);
    if (!warnOnly && g.confirmRepeat && st.data.blocked[key]) {
      C.appendStat(proj, cfg, { kind: 'read_override', tool, path: hit.rel || label });
      return; // second identical attempt: let it through
    }
    let size = 0;
    try { size = fs.statSync(hit.abs).size; } catch (e) { /* ignore */ }
    st.data.blocked[key] = Date.now();
    C.saveState(st);
    C.appendStat(proj, cfg, { kind: warnOnly ? 'read_warn' : 'read_block', tool, path: hit.rel || label, reason: hit.kind, bytes: size });
    return reply(tool + ' of "' + label + '" ' + (warnOnly ? 'is discouraged' : 'was blocked') + ': it is ' + hit.why + ', which wastes context.' +
      ' Use Grep with a narrow pattern on source files instead, or read the specific source file you need.' + howTo);
  }

  // 2) oversized files must be read in parts
  if (tool === 'Read' && typeof ti.file_path === 'string' && ti.limit === undefined) {
    const abs = path.resolve(proj, ti.file_path);
    if (trusted(abs) && !NO_LINECOUNT_EXT.has(extOf(abs))) {
      const rel = C.toPosix(path.relative(projAbs, abs));
      if (!(inside(projAbs, abs) && allowed(rel))) {
        let size = 0;
        try { const s = fs.statSync(abs); if (s.isFile()) size = s.size; } catch (e) { size = 0; }
        if (size > g.sizeCheckBytes) {
          const lines = countLines(abs, size);
          if (lines > g.maxLines) {
            C.appendStat(proj, cfg, { kind: 'read_block', tool, path: rel || ti.file_path, reason: 'large', bytes: size });
            return reply('"' + ti.file_path + '" has ' + (lines === Infinity ? 'a very large number of' : lines) + ' lines (limit for whole-file reads: ' + g.maxLines +
              '). Read it in parts with Read offset and limit (for example offset=1, limit=200), or use Grep to find the part you need.', true);
          }
        }
      }
    }
  }

  // 3) soft warning for repeated identical reads in one session
  if (tool === 'Read' && g.warnRepeatRead && typeof ti.file_path === 'string') {
    const abs = path.resolve(proj, ti.file_path);
    let mtime = 0;
    try { mtime = fs.statSync(abs).mtimeMs; } catch (e) { return; }
    const key = (ti.offset || 0) + ':' + (ti.limit === undefined ? 'all' : ti.limit);
    const prev = st.data.reads[abs];
    st.data.reads[abs] = { mtime, key };
    C.saveState(st);
    if (prev && prev.mtime === mtime && prev.key === key) {
      C.appendStat(proj, cfg, { kind: 'read_repeat_warn', tool, path: C.toPosix(path.relative(projAbs, abs)) });
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: '[auto-orchestra] This file range was already read earlier in this session and has not changed. Reuse that content instead of re-reading.' } };
    }
  }
  if (Math.random() < 0.02) C.cleanupOld(path.dirname(st.file), 7 * 24 * 3600 * 1000, f => f.endsWith('.json'));
});
