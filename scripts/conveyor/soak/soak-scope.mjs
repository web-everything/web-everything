/**
 * Pre-install soak scope: seed the harness tree and config, then follow local
 * imports and literal repository paths (including scripts launched/read by tests).
 * This is a conservative source scan, never an execution of PR code. Unreadable
 * evidence makes the CLI request the soak rather than silently skipping it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
// Code folders: a named path here is followed even when missing (a deleted dependency).
const CODE_ROOT = /^(?:scripts|src|tools|skills-src)\//;

// Decode JavaScript string escapes in one left-to-right pass, so an escaped backslash before
// `u0064` is never read as a Unicode escape: `\u{…}`, `\uXXXX`, `\xXX`, legacy octal (CommonJS
// sloppy mode), line continuations, the single-letter controls and identity escapes (`\/`,
// `\'`). An out-of-range `\u{…}` stays raw.
const JS_ESCAPE = /\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([0-3][0-7]{0,2}|[4-7][0-7]?)|(\r\n|[\n\r\p{Zl}\p{Zp}])|([^]))/gu;
const CONTROL = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
function unescapeJs(text) {
  return text.replace(JS_ESCAPE, (whole, braced, unicode, hex, octal, continuation, other) => {
    if (braced !== undefined) {
      const point = Number.parseInt(braced, 16);
      return point <= 0x10ffff ? String.fromCodePoint(point) : whole;
    }
    if (unicode !== undefined || hex !== undefined) return String.fromCharCode(Number.parseInt(unicode ?? hex, 16));
    if (octal !== undefined) return String.fromCharCode(Number.parseInt(octal, 8));
    if (continuation !== undefined) return '';
    return CONTROL[other] ?? other;
  });
}

// Literal shapes. Each regex has exactly two groups (quote, body) and starts in a lookahead,
// so a quoted keyword (`'import'`) or a stray apostrophe cannot consume a real literal after it.
// PLAIN is the original shape (no quote of any kind inside). STRING and TEMPLATE add the other
// quote, `\'`, escapes, line continuations and (templates only) raw newlines; `forms` decodes
// their bodies. All shapes are scanned and unioned, so scope only widens.
// Linear cost: an escape-aware start is a quote with no backslash right before it, so it is
// never an escaped quote, and it ends at the next unescaped quote of its kind; two starts of
// one kind never scan the same text.
const PLAIN = /(?=(['"`])([^'"`\r\n]+)\1)/.source;
const STRING = /(?=(['"])((?:(?!\1)[^\\\r\n]|\\(?:\r\n|[^]))+)\1)/.source;
const TEMPLATE = /(?=(`)((?:[^`\\]|\\[^])+)\1)/.source;
const shapes = (prefix, escapedPrefix = prefix) => [
  new RegExp(prefix + PLAIN, 'g'),
  new RegExp(escapedPrefix + STRING, 'g'),
  new RegExp(escapedPrefix + TEMPLATE, 'g'),
];
// `import'x'`, `export*from"x"` and `import(\`x\`)` are valid: whitespace is optional, and
// dynamic import/require may take a template literal. A keyword start is never escaped.
const IMPORT_SHAPES = shapes(/(?:\bfrom|\bimport(?:\s*\()?|\brequire\s*\()\s*/.source);
const URL_SHAPES = shapes(/\bnew\s+URL\s*\(\s*/.source);
const LITERAL_SHAPES = [/(['"`])([^'"`\r\n]+)\1/g, ...shapes('', /(?<!\\)/.source).slice(1)];

// The URL parser trims leading and trailing C0 controls and spaces (code points 0-32) only.
function urlTrim(text) {
  let start = 0;
  let end = text.length;
  while (start < end && text.charCodeAt(start) <= 0x20) start += 1;
  while (end > start && text.charCodeAt(end - 1) <= 0x20) end -= 1;
  return text.slice(start, end);
}

export function computeSoakClosure({ root = DEFAULT_ROOT } = {}) {
  root = resolve(root);
  const closure = new Set();
  const scanned = new Set();
  const pending = [];
  const inside = (path) => {
    const rel = relative(root, path);
    return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  const add = (path, scan = true) => {
    if (!inside(path)) return;
    const key = relative(root, path).split(sep).join('/');
    closure.add(key);
    // A file first seen unscanned (a soak unit test) is still scanned once a soak file imports it.
    if (scan && !scanned.has(key)) { scanned.add(key); pending.push(path); }
  };
  // The soak tooling's own unit tests are in scope as files, but the soak never runs them, so
  // their fixture literals are not soak dependencies (and would make their own assertions vacuous).
  const UNIT_TESTS = 'scripts/conveyor/soak/__tests__/';
  const seed = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) seed(path);
      else if (entry.isFile()) add(path, !relative(root, path).split(sep).join('/').startsWith(UNIT_TESTS));
      else throw new Error('Unsupported soak seed entry');
    }
  };
  // Any top-level folder or file can be a runtime dependency (the soak world copies
  // `schemas/…`, `package.json`, `.gitignore` by name), not only the code folders.
  const topLevel = new Set(readdirSync(root).filter((name) => name !== '.git' && name !== 'node_modules'));
  // What the engine loads, in its order: the language decodes string escapes first (`\x64ep`
  // is `dep`). Then an import specifier goes through the URL parser, which drops tab/LF/CR,
  // trims C0 controls and spaces, and reads `\` as `/`. Then `?`/`#` end the path and `%xx`
  // decodes: `./x.mjs?fresh=1#v` and `./a%20b.mjs` load `x.mjs` and `a b.mjs`. Keep every
  // intermediate form too (a plain fs path may legitimately contain `\`, `?`, `#`, `%` or spaces).
  const forms = (specifier) => {
    // Fast path: without these characters every form below equals the specifier itself.
    if (!/[\\?#%\x00-\x1f]|^\x20|\x20$/.test(specifier)) return [specifier];
    const all = new Set();
    for (const text of [specifier, unescapeJs(specifier)]) {
      const url = urlTrim(text.replace(/[\t\n\r]/g, '')).replaceAll('\\', '/');
      for (const value of [text, url]) {
        const cut = value.search(/[?#]/);
        const bare = cut < 0 ? value : value.slice(0, cut);
        let decoded = bare;
        // Guarded: a thrown URIError (a stray `%` in a long body) is costly at scan scale.
        if (/%[0-9a-fA-F]{2}/.test(bare)) {
          try { decoded = decodeURIComponent(bare); } catch { /* malformed escape: keep the raw form */ }
        }
        all.add(value).add(bare).add(decoded);
      }
    }
    // A NUL (`\0`, `%00`) cannot name a file, and the fs calls throw on it rather than ENOENT.
    return [...all].filter((form) => form && !form.includes('\0'));
  };
  const isFile = (path) => {
    try { return statSync(path).isFile(); }
    catch (error) {
      // A name too long for the filesystem cannot exist (a multi-line template literal body).
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'ENAMETOOLONG') return false;
      throw error;
    }
  };
  // Several literal shapes name most literals more than once; the outcome depends only on `base`.
  const followed = new Set();
  const follow = (base) => {
    if (followed.has(base)) return;
    followed.add(base);
    // Always try the suffixes: a dotted basename (`./vitest.shared`) has an extname but is
    // still extensionless to the resolver. Each candidate is checked: `<root>.mjs` (from a
    // literal naming the root itself) lies outside the repository and is never touched.
    const candidates = [base];
    for (const suffix of ['.mjs', '.js', '.cjs', '.ts', '.mts', '.tsx', '/index.mjs', '/index.js', '/index.ts']) {
      candidates.push(`${base}${suffix}`);
    }
    candidates.splice(0, candidates.length, ...candidates.filter(inside));
    for (const candidate of candidates) {
      if (isFile(candidate)) { add(candidate); return; }
    }
    // A deleted dependency is still in scope. Preserve every resolution candidate
    // without trying to read it; this also covers extensionless deleted imports.
    for (const candidate of candidates) add(candidate, false);
  };

  seed(resolve(root, 'scripts/conveyor/soak'));
  const config = resolve(root, 'vitest.soak.config.ts');
  if (!isFile(config)) throw new Error('Missing soak configuration');
  add(config);
  // The files the soak world copies by name (red-green.mjs#RUNTIME_PATHS, which mirrors
  // sim/world.mjs#buildWeTemplate) are in scope even when a PR deletes one. Folders in that
  // list are covered by the import graph. The list must be exactly one non-empty array of
  // plain quoted strings: a spread, a template entry or a second definition could hide entries,
  // so any other shape throws and the CLI requests the soak (run=true).
  const runtimeSource = readFileSync(resolve(root, 'scripts/conveyor/soak/red-green.mjs'), 'utf8');
  const definitions = [...runtimeSource.matchAll(/\bRUNTIME_PATHS\s*=(?!=)/g)].length;
  const runtime = /^export const RUNTIME_PATHS = Object\.freeze\(\[([^\]]*)\]\);$/m.exec(runtimeSource);
  const ENTRY = String.raw`\s*(?:'[^'"\\\r\n$]+'|"[^'"\\\r\n$]+")\s*`;
  if (definitions !== 1 || !runtime || !new RegExp(`^(?:${ENTRY},)*${ENTRY},?\\s*$`).test(runtime[1])) {
    throw new Error('Unreadable soak runtime path list');
  }
  for (const [, , path] of runtime[1].matchAll(/(['"])([^'"]+)\1/g)) {
    const target = resolve(root, path);
    if (!inside(target)) continue;
    let directory = false;
    try { directory = statSync(target).isDirectory(); } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
    if (!directory) add(target);
  }
  while (pending.length) {
    const file = pending.pop();
    if (!SOURCE.test(file)) continue;
    const source = readFileSync(file, 'utf8');
    // Over-approximate: literals in comments/fixtures may widen scope too.
    const isRelative = (specifier) => specifier.startsWith('./') || specifier.startsWith('../');
    const matches = (patterns) => patterns.flatMap((pattern) => [...source.matchAll(pattern)]);
    for (const match of matches(IMPORT_SHAPES)) {
      for (const form of forms(match[2])) {
        if (isRelative(form)) follow(resolve(dirname(file), form));
      }
    }
    // `new URL('data.json', import.meta.url)` is file-relative without a `./` prefix.
    for (const match of matches(URL_SHAPES)) {
      for (const form of forms(match[2])) {
        if (!/^[a-z][a-z0-9+.-]*:|^\/|\$\{/i.test(form)) follow(resolve(dirname(file), form));
      }
    }
    for (const match of matches(LITERAL_SHAPES)) {
      // Non-import literals: file-relative (`setupFiles: ['./x']`, `new URL('../x', import.meta.url)`)
      // and repo-root (spawn/readFile/copy targets, `new URL('./scripts/x', ROOT_URL)`).
      for (const form of forms(match[2])) {
        if (isRelative(form)) follow(resolve(dirname(file), form));
        const path = form.replace(/^\.\//, '');
        if (CODE_ROOT.test(path)) { follow(resolve(root, path)); continue; }
        // Elsewhere only an existing file counts: test fixtures name many fake paths
        // (`backlog/1-x.md`), and a bare folder word (`'docs'`) is not a file dependency.
        // `inside` first: `docs/../../x` names a top-level folder but resolves outside the repo.
        if (!topLevel.has(path.split('/')[0])) continue;
        const target = resolve(root, path);
        if (inside(target) && isFile(target)) add(target);
      }
    }
  }
  return closure;
}

export function soakScopeRun({ root = DEFAULT_ROOT, changed } = {}) {
  try {
    if (!Array.isArray(changed) || changed.some((path) => typeof path !== 'string')) return true;
    // Even with core.quotePath=false, git C-quotes a path holding `"`, `\` or a control
    // character (`"fixture/dep\"s.mjs"`). Such a line never equals a scope key: run the soak.
    if (changed.some((path) => path.startsWith('"'))) return true;
    const closure = computeSoakClosure({ root });
    return changed.some((path) => closure.has(path));
  } catch {
    return true;
  }
}

// Keep the pre-install safeguards executable in CI without npm dependencies.
async function selfTest() {
  const { test } = await import('node:test');
  const assert = await import('node:assert/strict');
  const { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const cli = fileURLToPath(import.meta.url);
  const dependency = 'fixture/dependency.mjs';
  const scopeCase = (name, prepare, changed, expected, check = () => {}) => test(name, () => {
    const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'soak-scope-self-test-'));
    const seed = join(root, 'scripts/conveyor/soak');
    try {
      mkdirSync(seed, { recursive: true });
      mkdirSync(join(root, 'fixture'));
      writeFileSync(join(root, 'vitest.soak.config.ts'), 'export default {};');
      writeFileSync(join(seed, 'red-green.mjs'), "export const RUNTIME_PATHS = Object.freeze(['schemas/rt.json']);");
      writeFileSync(join(root, dependency), 'export const value = true;');
      writeFileSync(join(seed, 'scope.soak.test.mjs'), "import '../../../fixture/dependency.mjs';");
      prepare({ root, seed });
      assert.equal(soakScopeRun({ root, changed: [changed] }), expected);
      const result = spawnSync(process.execPath, [cli], {
        input: `${changed}\n`, encoding: 'utf8', timeout: 25_000,
        maxBuffer: 1024 * 1024, env: { ...process.env, SOAK_SCOPE_ROOT: root },
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `run=${expected}\n`);
      check({ root });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await scopeCase('unreadable seed evidence requests the soak', ({ seed }) => {
    rmSync(seed, { recursive: true });
    // A self-referential link deterministically causes ELOOP, even under root.
    symlinkSync('soak', seed, 'dir');
  }, 'backlog/unrelated.md', true);
  await scopeCase('unreadable dependency evidence requests the soak', ({ root }) => {
    rmSync(join(root, dependency));
    symlinkSync('dependency.mjs', join(root, dependency));
  }, 'backlog/unrelated.md', true);
  await scopeCase('deleted dependency outside legacy scope requests the soak', ({ root }) => {
    rmSync(join(root, dependency));
  }, dependency, true);
  await scopeCase('deleted extensionless dependency requests the soak', ({ root, seed }) => {
    writeFileSync(join(seed, 'scope.soak.test.mjs'), "import '../../../fixture/dependency';");
    rmSync(join(root, dependency));
  }, dependency, true);
  // run=true alone cannot tell scanning from executing (a throw also fails open), so check the
  // closure directly and that the dependency's side effect never happened.
  await scopeCase('discovers dependencies without executing their source', ({ root }) => {
    writeFileSync(join(root, dependency), [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(join(root, 'executed'))}, 'ran');`,
      "throw new Error('executed');",
      "import'./transitive.mjs';",
    ].join('\n'));
    writeFileSync(join(root, 'fixture/transitive.mjs'), 'export const t = 1;');
  }, 'fixture/transitive.mjs', true, ({ root }) => {
    assert.ok(computeSoakClosure({ root }).has('fixture/transitive.mjs'));
    assert.equal(existsSync(join(root, 'executed')), false);
  });
  await scopeCase('a deleted runtime copy-list file requests the soak', () => {}, 'schemas/rt.json', true);
  await scopeCase('import URL query strings still reach the dependency', ({ seed }) => {
    writeFileSync(join(seed, 'scope.soak.test.mjs'), "import '../../../fixture/dependency.mjs?fresh=1#v';");
  }, dependency, true);
  await scopeCase('an escaped import specifier still reaches the dependency', ({ seed }) => {
    writeFileSync(join(seed, 'scope.soak.test.mjs'), "import '../../../fixture/\\x64ependency.mjs';");
  }, dependency, true);
  await scopeCase('a git-quoted changed path requests the soak', () => {}, '"fixture/dep\\"s.mjs"', true);
  await scopeCase('an unreadable runtime copy list requests the soak', ({ seed }) => {
    writeFileSync(join(seed, 'red-green.mjs'), 'export const RUNTIME_PATHS = computed();');
  }, 'backlog/unrelated.md', true);
  await scopeCase('unrelated changes skip the soak with readable evidence', () => {}, 'backlog/unrelated.md', false);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--self-test') {
    await selfTest();
  } else {
    let run = true;
    try {
      const changed = readFileSync(0, 'utf8').split('\n').filter(Boolean);
      run = soakScopeRun({ root: process.env.SOAK_SCOPE_ROOT || DEFAULT_ROOT, changed });
    } catch { /* Missing stdin is incomplete evidence: run the soak. */ }
    process.stdout.write(`run=${run}\n`);
  }
}
