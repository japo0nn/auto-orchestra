'use strict';
// Shared helpers for auto-orchestra hooks. Node stdlib only. Every hook script must be fail-open:
// any error -> exit 0 with no output, so the tool call proceeds as if the hook did not exist.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DEFAULTS = {
  enabled: true,
  bash: {
    enabled: true,
    // "post": compress successful output after the tool ran (PostToolUse + updatedToolOutput). Safe default.
    // "wrap": also rewrite noisy commands in PreToolUse so FAILED output is compressed too (experimental, see README).
    mode: 'post',
    minLines: 200,          // general commands: compress only above this many lines ...
    minChars: 20000,        // ... or this many characters
    noisyMinLines: 60,      // commands matching noisyCommands use these lower thresholds
    noisyMinChars: 6000,
    head: 15,
    tail: 30,
    maxMatches: 50,
    maxLineLength: 300,
    saveFull: true,
    tmpTtlHours: 24,
    noisyCommands: [
      '\\b(install|ci|add|restore|update|upgrade|sync|fetch)\\b',
      '\\b(build|compile|make|cmake|ninja|bazel|gradle|gradlew|mvn|msbuild|tsc|webpack|vite|rollup|esbuild)\\b',
      '\\b(test|tests|pytest|jest|vitest|mocha|rspec|phpunit|ctest|unittest|nosetests|check|verify)\\b',
      '\\b(lint|eslint|ruff|flake8|pylint|mypy|clippy|rubocop|golangci-lint|prettier|format)\\b',
      '\\b(logs?|journalctl)\\b',
      '\\b(plan|apply|deploy|migrate|pull|push)\\b'
    ],
    extraNoisyCommands: [],
    neverFilter: [
      '^(cat|head|tail|sed|awk|less|more|bat|nl|grep|egrep|fgrep|rg|ag|wc|sort|uniq|diff|cmp|xxd|od|strings|jq|yq)\\b',
      '^git\\s+(show|diff|blame|log|cat-file)\\b'
    ],
    extraNeverFilter: [],
    secretCommands: [
      '(^|[\\s;&|])(env|printenv|set|export|declare\\s+-x)(\\s|$)',
      '\\.env\\b', 'secret', 'token', 'passw', 'credential', 'private[_-]?key', 'api[_-]?key',
      'id_rsa', '\\.pem\\b', '\\.aws[/\\\\]', '\\.ssh[/\\\\]', 'auth\\s+print', 'find-(generic|internet)-password',
      '^(vault|op|pass|gpg|keychain)\\b', 'sts\\s+get-', 'secretsmanager'
    ],
    extraSecretCommands: [],
    errorPatterns: [
      '\\b(error|errors|err!|fail|failed|failure|failing|fatal|exception|panic|traceback|segfault|abort(ed)?)\\b',
      '\\b(warn|warning|deprecated)\\b',
      '\\b(assert(ion)?|cannot|can\'t|could not|unable to|denied|refused|timed? ?out|undefined|not found|no such|unresolved)\\b',
      '(^|\\s)(FAIL|ERROR|E:|✗|✘|×)(\\s|:|$)',
      '^\\s*at .+\\(.+:\\d+(:\\d+)?\\)$'
    ],
    extraErrorPatterns: []
  },
  readGuard: {
    enabled: true,
    mode: 'block',          // "block" | "warn"
    useGitignore: true,
    confirmRepeat: true,    // a blocked call repeated unchanged in the same session is let through
    warnRepeatRead: true,
    maxLines: 1000,         // files longer than this must be read with offset+limit
    sizeCheckBytes: 20000,  // do not count lines for files smaller than this
    ignoreDirs: [
      'node_modules', 'vendor', 'bin', 'obj', 'dist', 'build', 'target', '.venv', 'venv', '__pycache__',
      '.git', '.next', '.nuxt', '.gradle', '.tox', '.mypy_cache', '.pytest_cache', '.terraform', 'Pods', 'coverage'
    ],
    ignoreFiles: [
      '*.lock', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'go.sum', 'Cargo.lock', 'poetry.lock',
      'composer.lock', 'Gemfile.lock', 'packages.lock.json', '*.min.js', '*.min.css', '*.map', '*.bundle.js', '*.pyc'
    ],
    binaryExtensions: [
      'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'jar', 'war', 'class', 'dll', 'exe', 'so', 'dylib',
      'o', 'a', 'bin', 'wasm', 'woff', 'woff2', 'ttf', 'eot', 'mp3', 'mp4', 'mov', 'avi', 'iso', 'dmg', 'sqlite', 'db'
    ],
    extraIgnore: [],        // appended to ignoreDirs/ignoreFiles: plain names or globs, e.g. "generated/**"
    allow: []               // globs relative to the project root that are never guarded, e.g. "vendor/mylib/**"
  },
  handoff: { enabled: true, writeAutoSnapshot: true, sessionStartHint: true },
  repomap: {
    enabled: true, staleDays: 14, staleCommits: 50, sessionStartHint: true, suggestWhenMissing: false,
    autoRefresh: true,          // watch hook: compare the working tree with the commit the map was built at
    maxChangedFiles: 10,        // more changed files than this = structural
    minStructuralOps: 1,        // added + deleted + renamed files needed to flag the map
    driftThreshold: 3,          // paths in the map that no longer exist; at this count a full rebuild is advised
    watchThrottleSeconds: 5,
    manifestFiles: [
      'package.json', 'pyproject.toml', 'requirements*.txt', 'setup.py', 'setup.cfg', 'Pipfile', 'Cargo.toml', 'go.mod',
      'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle*', '*.csproj', '*.fsproj', '*.vbproj', '*.sln',
      'Gemfile', 'composer.json', 'mix.exs', 'build.sbt', 'Package.swift', 'deno.json', 'Makefile', 'CMakeLists.txt',
      'Dockerfile', 'docker-compose*.yml', 'docker-compose*.yaml', 'tsconfig.json', 'justfile', 'Taskfile.yml',
      '.github/workflows/*', '.gitlab-ci.yml', 'Jenkinsfile'
    ],
    entryFiles: ['main.*', 'index.*', '__init__.py', '__main__.py', 'app.*', 'cli.*', 'server.*', 'mod.rs', 'lib.rs', 'Program.cs', 'Startup.cs']
  },
  statusline: { warnPercent: 60 },
  stats: { enabled: true }
};

function isPlainObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }

// Merge `over` into `base`, ignoring keys whose type differs from the default (so a bad config can never break a hook).
function mergeTyped(base, over) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  if (!isPlainObject(over)) return out;
  for (const k of Object.keys(over)) {
    if (!(k in base)) continue;
    const b = base[k], o = over[k];
    if (isPlainObject(b)) out[k] = mergeTyped(b, o);
    else if (Array.isArray(b)) { if (Array.isArray(o)) out[k] = o.filter(x => typeof x === typeof (b[0] === undefined ? x : b[0])); }
    else if (typeof b === typeof o) out[k] = o;
  }
  return out;
}

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function homeClaudeDir() { return path.join(os.homedir(), '.claude'); }

function loadConfig(projectDir) {
  let cfg = mergeTyped(DEFAULTS, readJsonSafe(path.join(homeClaudeDir(), 'auto-orchestra.json')));
  if (projectDir) cfg = mergeTyped(cfg, readJsonSafe(path.join(projectDir, '.auto-orchestra.json')));
  return cfg;
}

function featureOn(cfg, name) {
  return cfg.enabled !== false && !!cfg[name] && cfg[name].enabled !== false;
}

function projectDirOf(input) {
  return process.env.CLAUDE_PROJECT_DIR || (input && input.cwd) || process.cwd();
}

function readInput() {
  return new Promise(resolve => {
    let data = '';
    const t = setTimeout(() => resolve(null), 5000);
    t.unref();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => { data += c; });
    process.stdin.on('end', () => { clearTimeout(t); try { resolve(JSON.parse(data)); } catch (e) { resolve(null); } });
    process.stdin.on('error', () => resolve(null));
  });
}

// Run a hook: parse stdin, call main(input, cfg), print its JSON result. Never throws, always exits 0.
async function runHook(main) {
  try {
    const input = await readInput();
    if (!isPlainObject(input)) return;
    const out = await main(input);
    if (out) process.stdout.write(typeof out === 'string' ? out : JSON.stringify(out));
  } catch (e) {
    if (process.env.AUTO_ORCHESTRA_DEBUG) process.stderr.write('auto-orchestra hook error: ' + (e && e.stack || e) + '\n');
  }
  process.exitCode = 0;
}

function matchesAny(patterns, text) {
  for (const p of patterns) {
    try { if (new RegExp(p, 'i').test(text)) return true; } catch (e) { /* skip invalid regex */ }
  }
  return false;
}

// One entry per command chain (split on && || ; newline); for pipelines only the FIRST stage counts, because it
// decides what the output is (`cat x | grep y` is a reader, `make | tee log` is a build).
function segmentsOf(cmd) {
  return String(cmd).split(/&&|\|\||;|\n/).map(s => s.split('|')[0].trim()).filter(Boolean);
}

function anySegmentMatches(patterns, cmd) {
  const segs = segmentsOf(cmd);
  for (const s of segs) if (matchesAny(patterns, s)) return true;
  return false;
}

function toPosix(p) { return p.split(path.sep).join('/'); }

function globToRegex(g) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') { re += '.*'; i++; if (g[i + 1] === '/') i++; } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('.+^${}()|[]\\'.indexOf(c) >= 0) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$', 'i');
}

function globMatch(glob, relPosix) {
  const g = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  const rx = globToRegex(g);
  if (g.indexOf('/') < 0) return rx.test(relPosix.split('/').pop());
  return rx.test(relPosix) || rx.test(relPosix + '/');
}

// Minimal .gitignore support (root file only): comments, negation, anchoring, dir-only, *, **, ?.
function loadGitignore(projectDir) {
  let text;
  try { text = fs.readFileSync(path.join(projectDir, '.gitignore'), 'utf8'); } catch (e) { return []; }
  const rules = [];
  for (let raw of text.split(/\r?\n/)) {
    let line = raw.replace(/\s+$/, '');
    if (!line || line[0] === '#') continue;
    let neg = false;
    if (line[0] === '!') { neg = true; line = line.slice(1); }
    let dirOnly = false;
    if (line.endsWith('/')) { dirOnly = true; line = line.slice(0, -1); }
    let anchored = false;
    if (line[0] === '/') { anchored = true; line = line.slice(1); }
    else if (line.indexOf('/') >= 0) anchored = true;
    if (!line) continue;
    rules.push({ neg, dirOnly, anchored, rx: globToRegex(line) });
  }
  return rules;
}

function gitignoreDecision(rules, relPosix, isDir) {
  let ignored = false;
  const segs = relPosix.split('/');
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue;
    const hit = r.anchored ? r.rx.test(relPosix) : r.rx.test(segs[segs.length - 1]);
    if (hit) ignored = !r.neg;
  }
  return ignored;
}

function isGitIgnored(rules, relPosix) {
  if (!rules.length) return false;
  const segs = relPosix.split('/');
  for (let i = 1; i < segs.length; i++) {
    if (gitignoreDecision(rules, segs.slice(0, i).join('/'), true)) return true;
  }
  return gitignoreDecision(rules, relPosix, false);
}

function git(args, cwd, timeout) {
  try {
    return require('child_process').execFileSync('git', args, { cwd, timeout: timeout || 3000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 }).toString();
  } catch (e) { return null; }
}

// Stamp .claude/repomap.md with the current commit (or mtime outside git) and drop the stale flag.
function stampRepomap(proj) {
  const mapFile = path.join(proj, '.claude', 'repomap.md');
  if (!fs.existsSync(mapFile)) return null;
  const headOut = git(['rev-parse', 'HEAD'], proj);
  const head = headOut ? headOut.trim() : 'none';
  const stamp = '<!-- repomap head=' + head + ' date=' + new Date().toISOString() + (head === 'none' ? ' mtime=' + Date.now() : '') + ' -->';
  const lines = fs.readFileSync(mapFile, 'utf8').split('\n');
  if (/^<!--\s*repomap\b/i.test(lines[0])) lines[0] = stamp; else lines.unshift(stamp);
  fs.writeFileSync(mapFile, lines.join('\n'));
  try { fs.unlinkSync(path.join(proj, '.claude', 'repomap.stale.json')); } catch (e) { /* no flag */ }
  // Remember which uncommitted files the refreshed map already reflects, so the watcher only reports newer changes.
  try {
    const base = { head, created: new Date().toISOString(), files: {} };
    if (head !== 'none') {
      const por = git(['status', '--porcelain', '-uall'], proj, 4000) || '';
      for (const line of por.split('\n').filter(Boolean).slice(0, 2000)) {
        const rel = line.slice(3).replace(/^.* -> /, '').trim().replace(/^"|"$/g, '');
        base.files[rel] = fileSig(path.join(proj, rel));
      }
    }
    fs.writeFileSync(path.join(proj, '.claude', 'repomap.base.json'), JSON.stringify(base));
  } catch (e) { /* ignore */ }
  return stamp;
}

function fileSig(abs) {
  try { const st = fs.statSync(abs); return st.mtimeMs + ':' + st.size; } catch (e) { return 'deleted'; }
}

function estTokens(chars) { return Math.round(chars / 4); }

function shortCmd(cmd) {
  // metadata only: first two tokens, never arguments that may hold secrets
  const toks = String(cmd).trim().split(/\s+/).slice(0, 2).map(t => t.replace(/=.*/, '=…'));
  return toks.join(' ').slice(0, 40);
}

function appendStat(projectDir, cfg, rec) {
  try {
    if (cfg.stats && cfg.stats.enabled === false) return;
    const dir = path.join(projectDir, '.claude');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'auto-orchestra-stats.jsonl'), JSON.stringify(Object.assign({ ts: new Date().toISOString() }, rec)) + '\n');
  } catch (e) { /* ignore */ }
}

function stateDir() {
  const d = path.join(homeClaudeDir(), 'auto-orchestra', 'state');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function loadState(sessionId) {
  const f = path.join(stateDir(), String(sessionId || 'nosession').replace(/[^\w.-]/g, '_') + '.json');
  const s = readJsonSafe(f);
  return { file: f, data: isPlainObject(s) ? s : { reads: {}, blocked: {} } };
}

function saveState(st) {
  try { fs.writeFileSync(st.file, JSON.stringify(st.data)); } catch (e) { /* ignore */ }
}

function cleanupOld(dir, ttlMs, filter) {
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(dir)) {
      if (filter && !filter(f)) continue;
      const p = path.join(dir, f);
      try { if (now - fs.statSync(p).mtimeMs > ttlMs) fs.unlinkSync(p); } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }
}

function sha1(s) { return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 10); }

module.exports = {
  DEFAULTS, mergeTyped, loadConfig, featureOn, projectDirOf, readInput, runHook, readJsonSafe, homeClaudeDir,
  matchesAny, anySegmentMatches, segmentsOf, toPosix, globMatch, loadGitignore, isGitIgnored,
  estTokens, git, stampRepomap, fileSig, shortCmd, appendStat, loadState, saveState, cleanupOld, sha1
};
