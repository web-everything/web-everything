// Routes test files that spawn git to local execution: Forge's synced copy has no .git, so such tests fail there
// ("fatal: not a git repository") and turn verify red for unrelated PRs. Pure and side-effect free; the caller
// supplies readFile. Wiring into heavy-admission's decideRemote is a separate one-line follow-up.
import { readFileSync, statSync, realpathSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export const NEEDS_GIT_REASON = 'needs-git';
const MAX_BYTES = 1024 * 1024;

// String-aware: quoted/template literals are kept verbatim, only real comments are dropped.
const stripComments = (t) => t.replace(/('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m, str) => str ?? ' ');
// A test spawns git when it reaches child_process (any import form or alias) AND names git as an executable:
// a quoted git / git-path literal or a shell string starting with git. Mocked spawns without a child_process
// import, comments and prose are not flagged. A declared helper matches an import specifier by basename only.
const CHILD = /\b(?:node:)?child_process\b/;
const GIT_LITERAL = /(['"`])(?:[^'"`\n]*\/)?git(?:\s[^'"`\n]*)?\1|(['"`])git\s/;

export function sourceNeedsGit(text, { helpers = [] } = {}) {
  if (typeof text !== 'string' || !text) return false;
  const code = stripComments(text);
  if (CHILD.test(code) && GIT_LITERAL.test(code)) return true;
  return helpers.some(h => new RegExp(`from\\s*['"][^'"]*${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`).test(code));
}

// Positional (non-flag) arguments after the vitest/test:unit invocation. Values of known valued flags are skipped.
// Includes the test-name options: their value is a name pattern, never a file filter (so `-t package.json` names no file).
const VALUED = new Set(['--config', '-c', '--root', '-r', '--dir', '--project', '--reporter',
  '-t', '--testNamePattern', '--test-name-pattern', '--exclude', '--shard', '--pool', '--environment', '--outputFile', '--output-file', '--mode', '--workspace', '--runner', '--typecheck.tsconfig']);
export function testFilterArgs(argv) {
  if (!Array.isArray(argv)) return [];
  let rest;
  if (argv[0] === 'npm' && argv[1] === 'run' && /^test:/.test(argv[2] ?? '')) {
    const dd = argv.indexOf('--');
    rest = dd < 0 ? [] : argv.slice(dd + 1);
  } else if (argv[0] === 'vitest' && (argv[1] === 'run' || argv[1] === 'related')) rest = argv.slice(2);
  else if (argv[0] === 'npx' && argv[1] === 'vitest' && (argv[2] === 'run' || argv[2] === 'related')) rest = argv.slice(3);
  else return [];
  const out = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (typeof a !== 'string') continue;
    if (a.startsWith('-')) { if (VALUED.has(a)) i++; continue; }
    out.push(a);
  }
  return out;
}

// Default reader: only regular files inside cwd (symlinks resolved), at most MAX_BYTES; anything else throws.
function containedRead(cwd) {
  const root = realpathSync(cwd);
  return (p) => {
    const real = realpathSync(resolve(root, p));
    const rel = relative(root, real);
    if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('outside-root');
    const st = statSync(real);
    if (!st.isFile() || st.size > MAX_BYTES) throw new Error('not-readable-file');
    return readFileSync(real, 'utf8');
  };
}

// Only filters naming a readable test file are judged; directory, glob, substring and unfiltered selections are
// unresolved and stay remote (no over-routing). The wiring follow-up should expand them via forge-test-selection.
export function routeNeedsGit({ argv, cwd = process.cwd(), readFile, declared = [], helpers = [] } = {}) {
  const read = readFile ?? containedRead(cwd);
  const hits = [];
  for (const file of testFilterArgs(argv)) {
    if (declared.includes(file)) { hits.push(file); continue; }
    // R807: fail closed. An unreadable file, a directory, a glob or an out-of-root path cannot be proven git-free, so it routes local.
    try { if (sourceNeedsGit(read(file), { helpers })) hits.push(file); } catch (e) { if (e?.code !== 'ENOENT' || /[*?[\]{}]/.test(file)) hits.push(file); } // a plain absent name stays remote (substring filter; documented gap)
  }
  return hits.length ? { local: true, reason: NEEDS_GIT_REASON, files: hits } : { local: false };
}

// Bundle transport only: a vitest selection whose files cannot ALL be proven git-free (no filter, a directory, a glob,
// a substring) may still spawn git, and the git-less snapshot would fail it ("not a git repository"). Such a run ships
// the bundle instead of guessing. Network/real-origin tests are not detectable here and stay a local-only concern.
// Vitest keeps a test file when its lower-cased root-relative path CONTAINS the filter, OR contains the filter re-based on
// the root (`relative(root, filter)`: absolute paths, `./`, `x/../`). So a readable filter can also select other files
// (`pure.test.mjs` selects `nested/prefix-pure.test.mjs`). To prove the whole selection we list the code files under cwd
// (never node_modules/.git; symlinked directories ARE followed, as vitest's glob does) and scan every one whose path
// contains either form. Bounded: an overflow (also a symlink cycle) or an unreadable directory throws, which the caller
// treats as unproven. Options that move vitest's root or project set (--dir, --root, --workspace, --project, --config)
// are unproven outright: the filter is then matched against a root this scan does not know.
const CODE_FILE = /\.[cm]?[jt]sx?$/i;
const SKIP_DIRS = new Set(['node_modules', '.git']);
const MAX_WALK_ENTRIES = 200000;
export function listCodeFiles(cwd) {
  const out = [];
  let seen = 0;
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    for (const e of readdirSync(join(cwd, rel), { withFileTypes: true })) {
      if (++seen > MAX_WALK_ENTRIES) throw new Error('walk-too-large');
      const path = rel ? `${rel}/${e.name}` : e.name;
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) { try { isDir = statSync(join(cwd, path)).isDirectory(); } catch { continue; } } // a dangling link selects nothing
      if (isDir) { if (!SKIP_DIRS.has(e.name)) stack.push(path); }
      else if (CODE_FILE.test(e.name)) out.push(path);
    }
  }
  return out;
}
const fold = (s) => s.normalize('NFC').toLowerCase();
const ROOT_OPTIONS = new Set(['--dir', '--root', '-r', '--workspace', '--project', '--config', '-c']);
const movesRoot = (argv) => argv.some((a) => typeof a === 'string' && a.startsWith('-') && ROOT_OPTIONS.has(a.split('=')[0]));
// A caller that injects readFile is exercising a fake file system, so it supplies its own listFiles (default: none).
export function selectionUnproven({ argv, cwd = process.cwd(), readFile, listFiles, helpers = [] } = {}) {
  const files = testFilterArgs(argv);
  const isVitest = (argv?.[0] === 'npx' ? argv[1] : argv?.[0]) === 'vitest' || (argv?.[0] === 'npm' && /^test:/.test(argv[2] ?? ''));
  if (!isVitest) return false;
  if (argv.includes('related')) return true; // the filters are sources, not the tests they select
  if (argv.some((a) => typeof a === 'string' && (a === '--changed' || a.startsWith('--changed=')))) return true; // selected by a git diff, which the snapshot cannot compute
  if (!files.length) return true;
  const read = readFile ?? containedRead(cwd);
  // Fail closed: an unreadable name (including an absent one) is a vitest substring filter that may select a git-using
  // test elsewhere, so it is unproven. (routeNeedsGit keeps absent plain names remote: it routes local, this only bundles.)
  if (movesRoot(argv)) return true;
  // A readable filter is still a substring filter: every other file whose path contains it is selected too, so each of
  // those is scanned as well. A listing failure (too many entries, unreadable directory) is unproven.
  let all;
  const list = () => (all ??= (listFiles ?? (readFile ? () => [] : () => listCodeFiles(cwd)))(cwd).map((p) => [p, fold(p)]));
  return files.some((f) => {
    try {
      if (sourceNeedsGit(read(f), { helpers })) return true;
      const rebased = relative(resolve(cwd), resolve(cwd, f)).split(sep).join('/');
      const needles = [fold(f), fold(rebased)].filter((n) => !n.startsWith('..'));
      if (needles.some((n) => !n)) return true;
      return list().some(([p, folded]) => needles.some((n) => folded.includes(n)) && sourceNeedsGit(read(p), { helpers }));
    } catch { return true; }
  });
}
