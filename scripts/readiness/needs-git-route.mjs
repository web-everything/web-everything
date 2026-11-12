// Routes test files that spawn git to local execution: Forge's synced copy has no .git, so such tests fail there
// ("fatal: not a git repository") and turn verify red for unrelated PRs. Pure and side-effect free; the caller
// supplies readFile. Wiring into heavy-admission's decideRemote is a separate one-line follow-up.
import { readFileSync, statSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

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
const VALUED = new Set(['--config', '-c', '--root', '-r', '--dir', '--project', '--reporter']);
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
export function selectionUnproven({ argv, cwd = process.cwd(), readFile, helpers = [] } = {}) {
  const files = testFilterArgs(argv);
  const isVitest = (argv?.[0] === 'npx' ? argv[1] : argv?.[0]) === 'vitest' || (argv?.[0] === 'npm' && /^test:/.test(argv[2] ?? ''));
  if (!isVitest) return false;
  if (argv.includes('related')) return true; // the filters are sources, not the tests they select
  if (!files.length) return true;
  const read = readFile ?? containedRead(cwd);
  return files.some((f) => { try { return sourceNeedsGit(read(f), { helpers }); } catch (e) { return e?.code !== 'ENOENT' || /[*?[\]{}]/.test(f); } });
}
