/**
 * @file hermetic-tests.mjs — HERMETIC TESTS BY DEFAULT (card xcu4cqf).
 *
 * WHY. 2026-10-08: `main` was red for ~5.5 h with no code change. The soak scenario
 * `scripts/conveyor/soak/breaks/build-dispatch-orphan-adopt.mjs` used real card numbers, and the pass it drove read
 * live GitHub (`gh pr list` for `lane/<num>-…` PRs) and the live backlog (`git show origin/main:backlog/<num>-…`).
 * When those cards really were delivered, the scenario flipped red. The test was right on Monday and wrong on
 * Tuesday, and nothing in the tree changed. Fix PR #4522 made that one scenario declare its own evidence; this
 * module stops the whole class.
 *
 * WHAT "LIVE" MEANS HERE. Anything that can change without a commit to the tree under test:
 *   - GitHub: the `gh` CLI, and `fetch` to github.com / api.github.com;
 *   - the remote: `git fetch|pull|push|ls-remote` or any `origin/…` / `refs/remotes/…` ref, run inside the real
 *     checkout (that is where the live backlog of `origin/main` is read from);
 *   - host state outside the checkout: the conveyor queue/state root, the jobs registry, the lane pool (other lanes
 *     and the pool's own state files), the primary checkout's backlog and queue (see `guardedRoots` in the settings).
 * The checkout's OWN tree at HEAD is not live: it is versioned with the code, so a test reading it is hermetic.
 *
 * HOW. Blocking suites (unit, integration, soak) run in hermetic mode. Every access above is RECORDED against the
 * running test and the test FAILS in `afterEach` with {@link LIVE_ACCESS_MESSAGE} — even when the code under test
 * catches the error, which is exactly how the orphan-adopt pass hid it (an unreadable delivery is "unknown").
 *   - `gh` and `git` shims on PATH ({@link fakeGhScript}, {@link gitShimScript}) cover child processes;
 *   - an fs + fetch guard ({@link installHermeticGuards}) covers in-process reads.
 * Tests that must touch the real thing do not belong in a blocking suite at all: they are listed in
 * `liveSuite.tests` of we:scripts/hermetic-tests.settings.json and run only in `vitest.live.config.ts`, on a
 * schedule (we:.github/workflows/live-tests.yml), reporting failures as a health-smell issue, never gating a PR.
 *
 * Standard-shaped: the decision ("is this access allowed in a test?") is the pure half of this file
 * ({@link isHermetic}, {@link classifyFsPath}, {@link classifyGitArgs}, {@link classifyFetchUrl}); the settings
 * are declared data; the fixtures are what a test injects instead. The runtime half only applies the decision.
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SETTINGS_PATH = 'scripts/hermetic-tests.settings.json';
/** `'0'` turns hermetic mode off. Only `vitest.live.config.ts` sets it; every blocking config sets `'1'`. */
export const HERMETIC_ENV = 'WE_TEST_HERMETIC';
/** `'report'` records without failing (a diagnostic run to list offenders). Ignored under CI: CI always enforces. */
export const HERMETIC_MODE_ENV = 'WE_HERMETIC_MODE';
/** Where shims append violations (one TSV line each): per test file, under the run's private temp root. */
export const VIOLATIONS_DIR_ENV = 'WE_HERMETIC_VIOLATIONS_DIR';
export const VIOLATIONS_FILE = 'violations.tsv';
/** The running test's id + name, set in `beforeEach` so a child process can attribute its access. */
export const TEST_ID_ENV = 'WE_HERMETIC_TEST_ID';
export const TEST_NAME_ENV = 'WE_HERMETIC_TEST_NAME';
/** Colon-separated physical paths of the real checkouts (the one under test + the primary). */
export const REAL_REPOS_ENV = 'WE_HERMETIC_REAL_REPOS';
/** A test that WANTS the deterministic "gh is not logged in" failure declares it: `WE_HERMETIC_GH=unauthenticated`. */
export const GH_FIXTURE_ENV = 'WE_HERMETIC_GH';
export const GH_FIXTURE_UNAUTHENTICATED = 'unauthenticated';
/** Diagnostic run only: append every violation as JSON lines here instead of failing. */
export const REPORT_FILE_ENV = 'WE_HERMETIC_REPORT_FILE';

export const LIVE_ACCESS_MESSAGE = 'live GitHub/backlog access in test';
const REMEDY = 'inject a fixture (a fake gh/runner, an explicit root, a reader), or list the test under liveSuite.tests '
  + `in ${SETTINGS_PATH} (scheduled, non-blocking live suite)`;

/** Env keys that pin a REAL GitHub binary or credential. Hermetic mode removes them so nothing bypasses the shim. */
export const LIVE_GITHUB_ENV_KEYS = Object.freeze(['WE_GH_THROTTLE_GH_BIN', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']);

export class HermeticAccessError extends Error {
  constructor(violation) {
    super(hermeticMessage(violation));
    this.name = 'HermeticAccessError';
    this.code = 'EHERMETIC';
    this.violation = violation;
  }
}

// ── pure decision ─────────────────────────────────────────────────────────────────────────────────────────────

/** Hermetic unless explicitly `'0'` — the default is ON, an opt-out has to be written down. */
export function isHermetic(env = process.env) {
  return env[HERMETIC_ENV] !== '0';
}

/** `'enforce'` (fail the test) or `'report'` (record only). CI always enforces. */
export function hermeticMode(env = process.env) {
  if (env.CI || env.GITHUB_ACTIONS) return 'enforce';
  return env[HERMETIC_MODE_ENV] === 'report' ? 'report' : 'enforce';
}

/** One-line description of a violation, used by the error, the shims and the afterEach failure alike. */
export function hermeticMessage({ kind, target, test } = {}) {
  return `${LIVE_ACCESS_MESSAGE} (hermetic mode): ${kind} ${target}${test ? ` — test: ${test}` : ''}. Fix: ${REMEDY}.`;
}

/** Parse + validate the declared settings. Throws on a malformed file (a broken allowlist must not fail open). */
export function parseHermeticSettings(raw) {
  const s = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const problems = [];
  const live = s?.liveSuite;
  if (!live || !Array.isArray(live.tests)) problems.push('liveSuite.tests must be an array');
  for (const [i, t] of (live?.tests || []).entries()) {
    if (!t || typeof t.file !== 'string' || !t.file) problems.push(`liveSuite.tests[${i}].file is required`);
    if (!t || typeof t.reason !== 'string' || t.reason.trim().length < 10) problems.push(`liveSuite.tests[${i}].reason must say why it needs live data`);
  }
  if (typeof live?.schedule?.cron !== 'string') problems.push('liveSuite.schedule.cron is required');
  if (!Number.isFinite(live?.schedule?.intervalHours) || live.schedule.intervalHours <= 0) problems.push('liveSuite.schedule.intervalHours must be > 0');
  if (!Array.isArray(s?.guardedRoots)) problems.push('guardedRoots must be an array');
  for (const [i, g] of (s?.guardedRoots || []).entries()) {
    if (!g?.id || !g?.path) problems.push(`guardedRoots[${i}] needs id + path`);
  }
  if (problems.length) throw new Error(`${SETTINGS_PATH}: ${problems.join('; ')}`);
  return s;
}

/**
 * A file URL → filesystem path that also survives vite's SSR transform, which can hand a config module an
 * `import.meta.url` of the form `file:///@fs/<abs path>` (seen when a test imports `vitest.config.ts`).
 */
export function urlToFsPath(url) {
  let p;
  try { p = fileURLToPath(url); } catch { p = new URL(url).pathname; }
  return p.replace(/^\/@fs(?=\/)/, '');
}

/** This checkout's root, derived from this module's own location (never from a caller's `import.meta.url`). */
export const DEFAULT_REPO_ROOT = urlToFsPath(new URL('../../', import.meta.url));

export function loadHermeticSettings(repoRoot = DEFAULT_REPO_ROOT) {
  return parseHermeticSettings(readFileSync(join(repoRoot, SETTINGS_PATH), 'utf8'));
}

/** The files of the scheduled live suite — what every BLOCKING config must exclude. */
export function liveSuiteFiles(settings) {
  return settings.liveSuite.tests.map((t) => t.file);
}

function expandHome(p, home) {
  return p === '~' ? home : p.startsWith('~/') ? join(home, p.slice(2)) : p;
}

const trimSlash = (p) => (p.length > 1 && p.endsWith(sep) ? p.slice(0, -1) : p);
const within = (p, root) => p === root || p.startsWith(root + sep);

/**
 * The guard context: which absolute roots are live, and which subtrees inside them are the code under test.
 * @param {{home:string, repoRoot:string, settings:object, ambient?:Record<string,string|undefined>}} o
 *   `ambient` = the LAUNCHING env (before any sandbox strip), so an operator's own pinned state root is guarded too.
 */
export function buildGuardContext({ home, repoRoot, settings, ambient = {} }) {
  const roots = [];
  for (const g of settings.guardedRoots) roots.push({ id: g.id, path: trimSlash(expandHome(g.path, home)) });
  for (const key of settings.ambientRootEnv || []) {
    const v = ambient[key];
    if (v && isAbsolute(expandHome(v, home))) roots.push({ id: `env:${key}`, path: trimSlash(expandHome(v, home)) });
  }
  const repo = trimSlash(repoRoot);
  const parent = repo.slice(0, repo.lastIndexOf(sep)) || sep;
  // Code under test: the checkout itself, and the sibling repos it imports at dev time (vitest.shared.ts aliases
  // `../frontierui/*`) — inside a lane those siblings sit in the lane pool directory, but they are not pool state.
  const exempt = [repo, ...(settings.siblingRepos || []).map((name) => join(parent, name))];
  // A guarded root that CONTAINS the checkout (the lane pool contains every lane) stays guarded around it: the
  // exemption is checked per path, so `<pool>/lane-7` is live while `<pool>/lane-2` (this checkout) is not.
  return { roots, exempt, repo };
}

/**
 * Is this absolute path live host state? Returns `{ id, root }` or null. Pure string logic, no fs.
 * `node_modules` anywhere is always allowed (module resolution walks real paths).
 */
export function classifyFsPath(absPath, ctx) {
  if (!absPath || absPath.includes(`${sep}node_modules${sep}`)) return null;
  for (const r of ctx.roots) {
    if (!within(absPath, r.path)) continue;
    if (ctx.exempt.some((e) => within(absPath, e))) return null;
    return { id: r.id, root: r.path };
  }
  return null;
}

const REMOTE_SUBCOMMANDS = new Set(['fetch', 'pull', 'push', 'ls-remote']);
const REMOTE_REF = /(?:^|[^\w-])origin\/|^refs\/remotes\/|^FETCH_HEAD$|@\{(?:u|upstream|push)\}/;

/**
 * Does this git invocation read the REMOTE (live) side? Pure. `{subcommand, hit}` or null. The caller decides
 * whether the cwd is a real checkout ({@link gitShimScript} mirrors this exact rule in sh; a test pins parity).
 */
export function classifyGitArgs(args) {
  let sub = null; let hit = null;
  for (let i = 0; i < args.length; i += 1) {
    const a = String(args[i]);
    if (sub === null) {
      if (a === '-C' || a === '-c' || a === '--git-dir' || a === '--work-tree' || a === '--namespace') { i += 1; continue; }
      if (a.startsWith('-')) continue;
      sub = a; continue;
    }
    if (!hit && REMOTE_REF.test(a)) hit = a;
  }
  if (sub && REMOTE_SUBCOMMANDS.has(sub)) hit = hit || sub;
  return hit ? { subcommand: sub, hit } : null;
}

/**
 * The repository a git invocation acts on: `--git-dir`/`--work-tree` (a throwaway repo addressed from any cwd) win,
 * else the `-C <dir>` (last one wins, relative to cwd), else cwd. Only global options before the subcommand count.
 */
export function gitTargetDir(args, cwd) {
  let dir = cwd; let explicit = null;
  for (let i = 0; i < args.length; i += 1) {
    const a = String(args[i]);
    if ((a === '-C' || a === '--git-dir' || a === '--work-tree') && i + 1 < args.length) {
      const next = resolve(dir, String(args[i + 1]));
      if (a === '-C') dir = next; else explicit = next;
      i += 1; continue;
    }
    const eq = /^--(?:git-dir|work-tree)=(.+)$/.exec(a);
    if (eq) { explicit = resolve(dir, eq[1]); continue; }
    if (a === '-c' || a === '--namespace') { i += 1; continue; }
    if (!a.startsWith('-')) break;
  }
  return explicit || dir;
}

const GITHUB_HOST = /(^|\.)github\.com$|(^|\.)githubusercontent\.com$/i;
/** Is this URL GitHub? Pure. */
export function classifyFetchUrl(url) {
  try {
    const u = new URL(String(url));
    return GITHUB_HOST.test(u.hostname) ? { host: u.hostname } : null;
  } catch { return null; }
}

/**
 * The env a hermetic test file runs with instead of the real home (pure). `HOME` → `fakeHome`; each declared tool
 * cache (`fakeHome.toolEnv` in the settings) is pinned to the REAL home's copy when the caller has not set it and it
 * exists, so a fake home never makes npx/playwright/cargo fetch from the network.
 * @param {{realHome:string, fakeHome:string, settings:object, env?:Record<string,string|undefined>, exists?:(p:string)=>boolean}} o
 */
export function fakeHomeEnv({ realHome, fakeHome, settings, env = {}, exists = () => true }) {
  const out = { HOME: fakeHome };
  for (const [key, p] of Object.entries(settings?.fakeHome?.toolEnv || {})) {
    if (env[key]) continue;
    const abs = expandHome(p, realHome);
    if (exists(abs)) out[key] = abs;
  }
  return out;
}

/** Parse the shims' TSV log into violations. Lines: `<testId>\t<kind>\t<target>`. */
export function parseViolationLog(text) {
  return String(text || '').split('\n').filter(Boolean).map((line) => {
    const [testId, kind, ...rest] = line.split('\t');
    return { testId, kind, target: rest.join('\t') };
  });
}

// ── shims (child processes) ────────────────────────────────────────────────────────────────────────────────────

const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

const SH_RECORD = (kind) => `_we_record() {
  if [ -n "\${${VIOLATIONS_DIR_ENV}:-}" ]; then
    mkdir -p "\$${VIOLATIONS_DIR_ENV}" 2>/dev/null
    _we_t=$(printf '%s' "\$1" | tr '\\n\\t\\r' '   ')
    printf '%s\\t%s\\t%s\\n' "\${${TEST_ID_ENV}:-unattributed}" ${shQuote(kind)} "\$_we_t" >> "\$${VIOLATIONS_DIR_ENV}/${VIOLATIONS_FILE}" 2>/dev/null
  fi
  echo "${LIVE_ACCESS_MESSAGE} (hermetic mode): ${kind} \$1 — test: \${${TEST_NAME_ENV}:-unknown}. Fix: ${REMEDY}." >&2
}`;

/**
 * The fake `gh` every hermetic run puts first on PATH. It never reaches GitHub. By default it RECORDS the call
 * against the running test (which then fails) and exits 1 with {@link LIVE_ACCESS_MESSAGE}. A test that wants
 * the old deterministic "not logged in" failure as its fixture says so with `WE_HERMETIC_GH=unauthenticated`.
 */
export function fakeGhScript() {
  return `#!/bin/sh
# Generated by we:scripts/lib/hermetic-tests.mjs#fakeGhScript — the hermetic test harness's fake gh.
if [ "\${${GH_FIXTURE_ENV}:-}" = "${GH_FIXTURE_UNAUTHENTICATED}" ] || [ "\${${HERMETIC_ENV}:-1}" = "0" ]; then
  echo "To get started with GitHub CLI, please run:  gh auth login" >&2
  echo "Alternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token." >&2
  exit 1
fi
${SH_RECORD('gh')}
_we_record "gh $*"
exit 1
`;
}

/**
 * The `git` shim every hermetic run puts first on PATH: passes everything through to the real git EXCEPT a remote
 * read ({@link classifyGitArgs}) whose target dir is one of the real checkouts ({@link REAL_REPOS_ENV}). That one is
 * recorded and refused (exit 128) — in report mode it is recorded and still run.
 */
export function gitShimScript({ realGit }) {
  return `#!/bin/sh
# Generated by we:scripts/lib/hermetic-tests.mjs#gitShimScript — the hermetic test harness's git pass-through.
_we_real=${shQuote(realGit)}
if [ "\${${HERMETIC_ENV}:-1}" = "0" ] || [ -z "\${${REAL_REPOS_ENV}:-}" ]; then exec "$_we_real" "$@"; fi
${SH_RECORD('git')}
_we_sub=""; _we_hit=""; _we_dir="."; _we_next=""; _we_explicit="\${GIT_DIR:-}"
for _we_a in "$@"; do
  if [ -n "$_we_next" ]; then
    case "$_we_next" in
      C) case "$_we_a" in /*) _we_dir="$_we_a";; *) _we_dir="$_we_dir/$_we_a";; esac;;
      X) case "$_we_a" in /*) _we_explicit="$_we_a";; *) _we_explicit="$_we_dir/$_we_a";; esac;;
    esac
    _we_next=""; continue
  fi
  if [ -z "$_we_sub" ]; then
    case "$_we_a" in
      -C) _we_next="C"; continue;;
      --git-dir|--work-tree) _we_next="X"; continue;;
      --git-dir=*|--work-tree=*) _we_v="\${_we_a#*=}"; case "$_we_v" in /*) _we_explicit="$_we_v";; *) _we_explicit="$_we_dir/$_we_v";; esac; continue;;
      -c|--namespace) _we_next="skip"; continue;;
      -*) continue;;
      *) _we_sub="$_we_a"; continue;;
    esac
  fi
  if [ -z "$_we_hit" ]; then
    case "$_we_a" in
      origin/*|*[!a-zA-Z0-9_-]origin/*|refs/remotes/*|FETCH_HEAD|*@{u}*|*@{upstream}*|*@{push}*) _we_hit="$_we_a";;
    esac
  fi
done
case "$_we_sub" in fetch|pull|push|ls-remote) [ -z "$_we_hit" ] && _we_hit="$_we_sub";; esac
if [ -n "$_we_hit" ]; then
  [ -n "$_we_explicit" ] && _we_dir="$_we_explicit"
  _we_abs=$(cd "$_we_dir" 2>/dev/null && pwd -P)
  _we_ifs=$IFS; IFS=:
  for _we_r in $${REAL_REPOS_ENV}; do
    case "$_we_abs/" in "$_we_r"/*)
      IFS=$_we_ifs
      _we_record "git $* (in $_we_abs)"
      if [ "\${${HERMETIC_MODE_ENV}:-}" = "report" ] && [ -z "\${CI:-}" ]; then exec "$_we_real" "$@"; fi
      exit 128;;
    esac
  done
  IFS=$_we_ifs
fi
exec "$_we_real" "$@"
`;
}

// ── in-process guard (fs + fetch) ──────────────────────────────────────────────────────────────────────────────

const FS_SYNC = ['readFileSync', 'readdirSync', 'statSync', 'lstatSync', 'openSync', 'opendirSync', 'writeFileSync',
  'appendFileSync', 'mkdirSync', 'rmSync', 'rmdirSync', 'unlinkSync', 'renameSync', 'copyFileSync', 'cpSync', 'accessSync',
  'readlinkSync', 'mkdtempSync', 'utimesSync', 'truncateSync'];
const FS_CALLBACK = ['readFile', 'readdir', 'stat', 'lstat', 'open', 'opendir', 'writeFile', 'appendFile', 'mkdir', 'rm',
  'rmdir', 'unlink', 'rename', 'copyFile', 'cp', 'access', 'readlink', 'mkdtemp'];
const TWO_PATH = new Set(['renameSync', 'copyFileSync', 'cpSync', 'rename', 'copyFile', 'cp']);

function toAbs(p, cwd) {
  let s;
  if (typeof p === 'string') s = p;
  else if (p instanceof URL) { if (p.protocol !== 'file:') return null; s = fileURLToPath(p); }
  else if (p && typeof p === 'object' && typeof p.toString === 'function' && Buffer.isBuffer(p)) s = p.toString();
  else return null;
  return isAbsolute(s) ? s : resolve(cwd(), s);
}

const GUARD_KEY = Symbol.for('we.hermetic.guard');

/**
 * Patch `node:fs` (sync, callback and promises) and `globalThis.fetch` so a live access is reported to
 * `state.onViolation` and — in enforce mode — refused with {@link HermeticAccessError}. `existsSync` on a live path
 * returns false (it never throws). `syncBuiltinESMExports()` is what makes this reach `import { readFileSync } from
 * 'node:fs'` named imports too (verified in a vitest `threads` worker, card xcu4cqf).
 *
 * Installed ONCE per fs object (once per worker for the real one); later calls only swap `state` (the guard context
 * + sink of the current test file).
 * @param {{fs:object, fsPromises:object, syncBuiltinESMExports:Function, state:{ctx:object, enforce:boolean, onViolation:Function, enabled:boolean}}} o
 */
export function installHermeticGuards({ fs, fsPromises, syncBuiltinESMExports, state, fetchHost = globalThis }) {
  const existing = fs[GUARD_KEY];
  if (existing) { Object.assign(existing, state); return existing; }
  const live = Object.assign({}, state);
  Object.defineProperty(fs, GUARD_KEY, { value: live, enumerable: false });
  const cwd = () => process.cwd();
  const check = (name, args) => {
    if (!live.enabled) return null;
    const paths = TWO_PATH.has(name) ? [args[0], args[1]] : [args[0]];
    for (const p of paths) {
      const abs = toAbs(p, cwd);
      const hit = abs && classifyFsPath(abs, live.ctx);
      if (hit) {
        const v = { kind: `fs.${name}`, target: `${abs} (${hit.id})` };
        live.onViolation(v);
        return v;
      }
    }
    return null;
  };
  const origExists = fs.existsSync;
  fs.existsSync = function existsSync(p) {
    const v = check('existsSync', [p]);
    if (v && live.enforce) return false;
    return origExists.call(this, p);
  };
  for (const name of FS_SYNC) {
    const orig = fs[name];
    if (typeof orig !== 'function') continue;
    fs[name] = function hermeticFs(...args) {
      const v = check(name, args);
      if (v && live.enforce) throw new HermeticAccessError({ ...v, test: live.testName?.() });
      return orig.apply(this, args);
    };
  }
  for (const name of FS_CALLBACK) {
    const orig = fs[name];
    if (typeof orig !== 'function') continue;
    const wrapped = function hermeticFsCb(...args) {
      const v = check(name, args);
      if (v && live.enforce) throw new HermeticAccessError({ ...v, test: live.testName?.() });
      return orig.apply(this, args);
    };
    if (orig.__promisify__) wrapped.__promisify__ = orig.__promisify__;
    fs[name] = wrapped;
  }
  for (const name of FS_CALLBACK) {
    const orig = fsPromises[name];
    if (typeof orig !== 'function') continue;
    fsPromises[name] = function hermeticFsP(...args) {
      const v = check(name, args);
      if (v && live.enforce) return Promise.reject(new HermeticAccessError({ ...v, test: live.testName?.() }));
      return orig.apply(this, args);
    };
  }
  syncBuiltinESMExports();
  if (fetchHost && typeof fetchHost.fetch === 'function') {
    const origFetch = fetchHost.fetch;
    fetchHost.fetch = function hermeticFetch(input, init) {
      const url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
      const hit = live.enabled && classifyFetchUrl(url);
      if (hit) {
        const v = { kind: 'fetch', target: url };
        live.onViolation(v);
        if (live.enforce) return Promise.reject(new HermeticAccessError({ ...v, test: live.testName?.() }));
      }
      return origFetch.call(fetchHost, input, init);
    };
  }
  return live;
}
