/**
 * @file scripts/lib/test-result-cache.mjs
 * @description prepare-124 S1 — the cache KEY for a shared test-result cache (shadow mode only; nothing is skipped).
 *
 * One test file's key = sha256 of: cache schema version, the global inputs (vitest config/setup closure, tsconfig*,
 * package.json, both lockfiles), the toolchain (full node version, vitest version, platform/arch), the run options that
 * change pass/fail (timeout factor, environment, pool), a small env allowlist, and the STATIC import closure of the
 * test file (path + content hash of every reachable file, `@frontierui/*` resolved into the sibling FUI checkout).
 *
 * Fail closed (the `standards-cache.mjs` rule): any doubt makes the file UNCACHEABLE (`key: null`, with a reason) —
 * an unresolvable relative import, a missing FUI checkout, a deny entry in the policy file.
 *
 * The closure reuses `related-test-selection.mjs#resolveSpecifier`, so "what a test imports" has one definition.
 * Pure of side effects except reads; no store is touched here (S2 owns the store and the shadow log).
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { arch, platform } from 'node:os';
import { isVitestTestFile, resolveSpecifier } from './related-test-selection.mjs';

/** Bump to invalidate every stored result. */
export const CACHE_SCHEMA_VERSION = 1;

/** Env vars that can change a test's outcome and survive the setup file's scrub (prepare-124 section 1, item 5). */
export const ENV_ALLOWLIST = ['LANG', 'LC_ALL', 'NODE_OPTIONS', 'TZ', 'WE_TELEMETRY', 'WE_TEST_SANDBOX'];

const GLOBAL_ENTRIES = ['vitest.config.ts', 'vitest.shared.ts', 'vitest.setup.ts', 'vitest.globalSetup.mjs'];
const GLOBAL_PLAIN = ['package.json', 'package-lock.json', 'node_modules/.package-lock.json'];
const SOURCE_EXT_RE = /\.(?:mjs|cjs|js|jsx|ts|tsx|mts|cts)$/;
const SPEC_RE = /\bfrom\s*['"]([^'"\n]+)['"]|\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)|\bimport\s+['"]([^'"\n]+)['"]|\b(?:require|mock|doMock|unmock|doUnmock|importActual|importMock)\s*\(\s*['"]([^'"\n]+)['"]/g;
const FUI_ALIAS = { '@frontierui/plugs': 'plugs', '@frontierui/webtheme': 'webtheme' };

const normalize = (from, spec) => resolve(dirname(from), spec.split('?')[0]);
const sha = (s) => createHash('sha256').update(s).digest('hex');
// Whole-line `//` comments and JSDoc/block-comment body lines (`/*`, ` * ...`) never hold a real import.
const stripLineComments = (src) => src.replace(/^\s*(?:\/\/|\/\*|\*).*$/gm, '');

/** Cache is off in CI (merged-tree authority) and by the `WE_TEST_CACHE=0` kill switch. */
export function cacheEnabled(env = process.env) {
  if (env.WE_TEST_CACHE === '0') return false;
  if (env.CI || env.GITHUB_ACTIONS) return false;
  return true;
}

/** Store location (S2 writes here). Outside every lane so all lanes share it. */
export function cacheDir(env = process.env, home = env.HOME || '') {
  return env.WE_TEST_CACHE_DIR || join(home, '.cache', 'we-vitest-results', `v${CACHE_SCHEMA_VERSION}`);
}

/** The effective test timeout factor (`WE_VERIFY_TEST_TIMEOUT_FACTOR`), as a stable string. */
export function timeoutFactor(env = process.env) {
  const n = Number(env.WE_VERIFY_TEST_TIMEOUT_FACTOR);
  return Number.isFinite(n) && n > 0 ? String(n) : '1';
}

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      re += `(?:${glob.slice(i + 1, end).split(',').map((p) => p.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|')})`;
      i = end;
    } else re += c.replace(/[.+?^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** The quoted strings of `include: [ ... ]` / `exclude: [ ... ]` in vitest.config.ts (comments stripped). */
export function parseVitestGlobs(configText) {
  const text = configText.replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
  const grab = (name) => {
    const start = text.indexOf(`\n    ${name}: [`);
    if (start < 0) return [];
    const end = text.indexOf('\n    ],', start);
    const body = text.slice(start, end < 0 ? text.length : end);
    return [...body.matchAll(/'([^'\n]+)'/g)].map((m) => m[1]);
  };
  const include = { list: grab('include') };
  const exclude = { list: grab('exclude') };
  return { include: include.list, exclude: exclude.list };
}

/** Unit-suite test files (vitest.config.ts's own include/exclude), repo-relative, sorted. */
export function listUnitTestFiles({ root, files }) {
  const { include, exclude } = parseVitestGlobs(readFileSync(join(root, 'vitest.config.ts'), 'utf8'));
  const inc = include.map(globToRegExp);
  const exc = exclude.map(globToRegExp);
  return files.filter((f) => isVitestTestFile(f) && !f.includes('node_modules/')
    && inc.some((r) => r.test(f)) && !exc.some((r) => r.test(f))).sort();
}

/** Tracked plus untracked-not-ignored files, repo-relative. */
export function listRepoFiles(root) {
  const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
  return out.split('\0').filter(Boolean).filter((f) => existsSync(join(root, f)));
}

/** Policy file: `{deny: [{pattern, reason}], allow: [{pattern, reason}]}` — every entry needs a reason. */
export function loadPolicy(root, path = join('scripts', 'lib', 'test-result-cache-policy.json')) {
  const full = join(root, path);
  if (!existsSync(full)) return { deny: [], allow: [] };
  const raw = JSON.parse(readFileSync(full, 'utf8'));
  const norm = (list) => (list ?? []).map((e) => {
    if (!e || typeof e.pattern !== 'string' || typeof e.reason !== 'string' || !e.reason.trim()) throw new Error(`test-result-cache policy: every entry needs a pattern and a reason (${JSON.stringify(e)})`);
    return { ...e, re: globToRegExp(e.pattern) };
  });
  return { deny: norm(raw.deny), allow: norm(raw.allow) };
}

/**
 * Static classification of a test file (prepare-124 section 0 table). Regex first guess; the tracer (S3) is the evidence.
 * Precedence: network > checkout > subprocess (tierB when only temp folders) > fui > repo-reads > date > pure-injected > pure.
 */
export function classifyTier({ testText, closureTexts = [] }) {
  const own = stripLineComments(testText);
  const all = [own, ...closureTexts.map(stripLineComments)].join('\n');
  if (/\b(?:fetch\s*\(|node:https?|from\s*['"]https?['"]|\.listen\s*\(|miniflare)/.test(own)) return 'network';
  const spawns = /\b(?:execFileSync|execSync|spawnSync|spawn|execFile|exec|fork)\s*\(|node:child_process|from\s*['"]child_process['"]/.test(own);
  if (spawns) {
    if (/cwd:\s*(?:ROOT|REPO_ROOT|repoRoot|process\.cwd\(\))/.test(own)) return 'checkout';
    if (/mkdtemp|tmpdir\(|TMPDIR|makeTmp|withRealRepo|mkTmp/.test(all)) return 'tierB';
    return 'other-subprocess';
  }
  if (/@frontierui\//.test(all)) return 'fui';
  if (/\b(?:ROOT|REPO_ROOT|repoRoot)\b.*\b(?:readFileSync|readdirSync|existsSync)|readdirSync|import\.meta\.glob/.test(own)) return 'repo-reads';
  if (/\bDate\.now\s*\(|\bnew Date\s*\(\s*\)/.test(own)) return 'date';
  if (/node:child_process|from\s*['"]child_process['"]/.test(all)) return 'pure-injected';
  return 'pure';
}

/**
 * Build a key context: memoised file hashes and closures, plus the once-per-run global hash.
 * Everything environmental is injectable so unit tests stay in memory-ish temp dirs.
 */
export function createKeyContext({
  root, env = process.env, nodeVersion = process.version, vitestVersion, platformName = platform(), archName = arch(),
  fuiRoot = resolve(root, '../frontierui'), policy, testEnvironment = 'happy-dom', pool = 'threads', schema = CACHE_SCHEMA_VERSION,
} = {}) {
  const contentHash = new Map();
  const directDeps = new Map();
  const fileOk = new Map();
  const fuiAlias = Object.fromEntries(Object.entries(FUI_ALIAS).map(([k, v]) => [k, join(fuiRoot, v)]));

  const isFile = (p) => {
    if (!fileOk.has(p)) { try { fileOk.set(p, statSync(p).isFile()); } catch { fileOk.set(p, false); } }
    return fileOk.get(p);
  };
  const fileSet = { has: isFile };
  const hashOf = (abs) => {
    if (!contentHash.has(abs)) contentHash.set(abs, sha(readFileSync(abs)));
    return contentHash.get(abs);
  };
  const label = (abs) => (abs.startsWith(`${root}/`) ? relative(root, abs) : abs.startsWith(`${fuiRoot}/`) ? `@fui/${relative(fuiRoot, abs)}` : abs);

  /** Direct dependencies of one file: `{deps: abs[], error?: string}`. Non-source files have none. */
  const depsOf = (abs) => {
    if (directDeps.has(abs)) return directDeps.get(abs);
    const result = { deps: [], absent: [] };
    directDeps.set(abs, result);
    if (!SOURCE_EXT_RE.test(abs)) return result;
    const text = stripLineComments(readFileSync(abs, 'utf8'));
    for (const m of text.matchAll(SPEC_RE)) {
      const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
      if (spec.startsWith('@frontierui/')) {
        const alias = Object.keys(fuiAlias).find((a) => spec === a || spec.startsWith(`${a}/`));
        if (!alias) continue;
        if (!existsSync(fuiRoot)) { result.error = `frontierui checkout missing (${fuiRoot})`; return result; }
        const target = resolveSpecifier(join(fuiAlias[alias], '__alias__.mjs'), `./${spec.slice(alias.length + 1) || 'index'}`.replace(/\/$/, ''), fileSet);
        if (!target) { result.error = `unresolvable ${spec} in ${label(abs)}`; return result; }
        result.deps.push(target);
        continue;
      }
      if (!spec.startsWith('./') && !spec.startsWith('../')) continue; // bare/node: specifiers are covered by lockfiles + node version
      const target = resolveSpecifier(abs, spec, fileSet);
      if (!target) {
        // A relative path that names no file. In a real source file: fail closed. In a test or `__tests__` helper it is
        // usually a fixture string (code the test writes into a temp dir), so it is keyed as an ABSENT input instead:
        // if a file ever appears at that path the key changes.
        if (/(?:^|\/)__tests__\//.test(abs) || isVitestTestFile(abs)) { result.absent.push(`${normalize(abs, spec)}`); continue; }
        result.error = `unresolvable ${spec} in ${label(abs)}`;
        return result;
      }
      result.deps.push(target);
    }
    return result;
  };

  /** Static closure of an entry (abs path): `{files: abs[], error?}` sorted. */
  const closureOf = (entry) => {
    const seen = new Set([entry]);
    const absent = new Set();
    const queue = [entry];
    while (queue.length) {
      const file = queue.pop();
      const { deps, absent: gone, error } = depsOf(file);
      if (error) return { files: [...seen].sort(), absent: [...absent].sort(), error };
      for (const a of gone) absent.add(a);
      for (const d of deps) if (!seen.has(d)) { seen.add(d); queue.push(d); }
    }
    return { files: [...seen].sort(), absent: [...absent].sort() };
  };

  let globalCache;
  const globalInputs = () => {
    if (globalCache) return globalCache;
    const entries = GLOBAL_ENTRIES.map((f) => join(root, f)).filter(isFile);
    const files = new Set();
    let error;
    for (const e of entries) {
      const c = closureOf(e);
      if (c.error) error = c.error;
      for (const f of c.files) files.add(f);
    }
    for (const f of readdirSync(root).filter((n) => /^tsconfig.*\.json$/.test(n))) files.add(join(root, f));
    for (const f of GLOBAL_PLAIN) files.add(join(root, f));
    const parts = [...files].sort().map((f) => `${label(f)}=${isFile(f) ? hashOf(f) : 'absent'}`);
    globalCache = { hash: sha(parts.join('\n')), count: files.size, error };
    return globalCache;
  };

  let vitestV = vitestVersion;
  const vitestVer = () => {
    if (vitestV == null) { try { vitestV = JSON.parse(readFileSync(join(root, 'node_modules/vitest/package.json'), 'utf8')).version; } catch { vitestV = 'unknown'; } }
    return vitestV;
  };
  let gitV;
  const gitVersion = () => (gitV ??= (() => { try { return execFileSync('git', ['--version'], { encoding: 'utf8' }).trim(); } catch { return 'unknown'; } })());

  const toolchain = (tier) => [
    `node=${nodeVersion}`, `vitest=${vitestVer()}`, `platform=${platformName}/${archName}`,
    tier === 'tierB' ? `git=${gitVersion()}` : 'git=-',
  ].join('\n');
  const options = () => [`timeoutFactor=${timeoutFactor(env)}`, `environment=${testEnvironment}`, `pool=${pool}`].join('\n');
  const envPart = () => ENV_ALLOWLIST.map((n) => `${n}=${env[n] ?? ''}`).join('\n');

  const pol = policy ?? loadPolicy(root);
  return { root, fuiRoot, env, policy: pol, schema, closureOf, hashOf, label, isFile, globalInputs, toolchain, options, envPart };
}

/**
 * Key for one repo-relative test file.
 * @returns {{file: string, key: string|null, cacheable: boolean, tier: string, reason: string|null, closureSize: number, needsTrace: boolean}}
 */
export function keyFor(file, ctx) {
  const abs = join(ctx.root, file);
  const base = { file, key: null, cacheable: false, tier: 'unknown', reason: null, closureSize: 0, needsTrace: false };
  if (!cacheEnabled(ctx.env)) return { ...base, reason: 'cache disabled (CI or WE_TEST_CACHE=0)' };
  if (!isVitestTestFile(file)) return { ...base, reason: 'not a vitest test file' };
  if (!ctx.isFile(abs)) return { ...base, reason: 'file missing' };
  const { files, absent, error } = ctx.closureOf(abs);
  const closureTexts = files.filter((f) => f === abs || /(?:^|\/)__tests__\//.test(f)).filter((f) => /\.(?:mjs|cjs|js|ts|tsx|mts|cts)$/.test(f))
    .map((f) => readFileSync(f, 'utf8'));
  const tier = classifyTier({ testText: closureTexts[0] ?? readFileSync(abs, 'utf8'), closureTexts: closureTexts.slice(1) });
  const closureSize = files.length;
  const out = { ...base, tier, closureSize, needsTrace: tier === 'tierB' || tier === 'repo-reads' || tier === 'other-subprocess' };
  const allow = ctx.policy.allow.find((e) => e.re.test(file));
  const deny = ctx.policy.deny.find((e) => e.re.test(file));
  if (deny) return { ...out, reason: `denied by policy: ${deny.reason}` };
  if (!allow && (tier === 'network' || tier === 'checkout')) return { ...out, reason: `tier ${tier} is never cached` };
  if (error) return { ...out, reason: error };
  const g = ctx.globalInputs();
  if (g.error) return { ...out, reason: `global inputs: ${g.error}` };
  const closure = [...files.map((f) => `${ctx.label(f)}=${ctx.hashOf(f)}`), ...absent.map((a) => `${ctx.label(a)}=absent`)].join('\n');
  const key = sha([`schema=${ctx.schema}`, `global=${g.hash}`, ctx.toolchain(tier), ctx.options(), ctx.envPart(), `file=${file}`, closure].join('\n--\n'));
  return { ...out, key, cacheable: true };
}

/** Key every unit test file. Returns rows plus tier counts. */
export function keyAll({ root, env = process.env, ...ctxOptions } = {}) {
  const files = listUnitTestFiles({ root, files: listRepoFiles(root) });
  const ctx = createKeyContext({ root, env, ...ctxOptions });
  const rows = files.map((f) => keyFor(f, ctx));
  const tiers = {};
  for (const r of rows) tiers[r.tier] = (tiers[r.tier] ?? 0) + 1;
  return { rows, tiers, cacheable: rows.filter((r) => r.cacheable).length, uncacheable: rows.filter((r) => !r.cacheable) };
}
