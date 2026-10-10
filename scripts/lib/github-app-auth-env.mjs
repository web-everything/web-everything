#!/usr/bin/env node
/**
 * @file scripts/lib/github-app-auth-env.mjs
 * @description Implements ratified #3866 Fork 1(a) (a GitHub App installation token, app-to-server, never
 *   the user-to-server "authorize as me" flow) via the simplest mechanism that actually reaches every
 *   consumer: a shared on-disk token cache, refreshed by each process at the top of each tick/pass, and
 *   exposed to `gh`/git subprocess calls through `process.env.GH_TOKEN` — which `gh` CLI already honors
 *   ahead of its own stored `gh auth login` credential, and which EVERY `execFileSync`/`spawn` call already
 *   inherits by default, whether it goes through `we:scripts/lib/gh-throttle.mjs`'s wrapper or one of the
 *   84 raw call sites #3861 tracks migrating (that migration is a SEPARATE, unrelated concern — burst
 *   throttling, not credential choice; a raw `execFileSync('gh', ...)` already inherits `process.env` today).
 *
 * WHY NOT WIRE THIS INSIDE gh-throttle.mjs (as #3881 originally sketched). That module's exec path is
 * deliberately, permanently SYNCHRONOUS (`execFileSync`-shaped — see its own header), but minting a real
 * installation token is an async network call (`we:scripts/lib/github-app-token.mjs#mintInstallationToken`
 * uses `fetch`). Forcing that call to sync would mean shelling `curl` from inside a throttled call, adding
 * real complexity to the one module everything else's rate-limit safety already depends on. Splitting
 * mint/refresh (async, at the top of each tick or pass, between the blocking sync work) from CONSUME (sync, a
 * plain env var read) sidesteps the problem entirely, and reaches the drain (`we:scripts/merge-ai-prs.mjs`)
 * too — which does not call through gh-throttle.mjs at all, so wiring the swap inside that module alone
 * would never have covered it (live-caught 2026-09-23, following a real rate-limit exhaustion incident).
 *
 * OPT-IN, NEVER A SILENT BEHAVIOR CHANGE. {@link resolveGithubAppEnvConfig} returns `null` unless all three
 * `WE_GITHUB_APP_*` env vars are set — a process that doesn't configure this keeps drawing from the
 * operator's own personal token exactly as before. No caller of this module is REQUIRED to opt in.
 *
 * PURE-CORE / IO-SHELL SPLIT, same discipline as every other daemon primitive in this epic:
 *   - {@link isCacheFresh} is pure — no fs, no network, no real clock (every input injected).
 *   - {@link ensureFreshGithubAppEnv} is the IO shell: reads/writes the cache file, calls the real minter,
 *     mutates `process.env`. Every effect is injectable for testing with no real GitHub App needed.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, accessSync, readdirSync, constants as fsConstants } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, basename, join } from 'node:path';
import { homedir } from 'node:os';
import { mintInstallationToken, getInstallationInfo } from './github-app-token.mjs';
import { readGithubAuthPolicy } from './github-auth-policy.mjs';
import { CONSTELLATION_REPOS } from './constellation-repos.mjs';
import { installationMap, installationForOwner, ownerOfSlug, remapLegacyInstallationId, installationCachePath } from './github-app-installations.mjs';

/**
 * What the fleet's `gh` calls actually need, as GitHub App permission levels. Live-caught 2026-09-23: the
 * first real installation was registered with NO repository permissions at all (`{}`) — its token still
 * minted fine and even READ the public repo, so a check at mint time is the only thing standing between a
 * misconfigured App and a fleet that silently can't label, comment or merge anything.
 *   - pull_requests / issues: write — PR reads, labels and comments (labels/comments go through the Issues API)
 *   - contents: write — the drain's merge
 *   - workflows: write — GitHub refuses an App merging a PR that touches `.github/workflows/` without it
 *   - checks / statuses / actions: read — CI state (`statusCheckRollup`, workflow runs)
 */
export const REQUIRED_APP_PERMISSIONS = Object.freeze({
  metadata: 'read',
  pull_requests: 'write',
  issues: 'write',
  contents: 'write',
  workflows: 'write',
  checks: 'read',
  statuses: 'read',
  actions: 'read',
});

/** Every constellation repo the fleet touches — a token that can't see one of them would fail every call to
 *  it with "Could not resolve to a Repository", with no fallback (live-caught 2026-09-23 on plateau-app). */
export const REQUIRED_APP_REPOS = Object.freeze(Object.values(CONSTELLATION_REPOS).map((r) => r.slug));

const LEVEL = { read: 1, write: 2, admin: 3 };

/**
 * Pure: which required permissions and repos does a minted installation NOT cover? An empty result on both
 * is the only state in which applying the App token is safe.
 *
 * `granted.repositorySelection === 'all'` short-circuits the repo check entirely, ignoring `granted.repos`
 * whatever it contains (even `[]` or `undefined`). Live-caught 2026-09-26: `GET /installation/repositories`
 * (the source of `granted.repos`) can lag the installation's own `repository_selection` field for a short
 * window right after a permission/repo-access change, and every one of `REQUIRED_APP_REPOS` was reported
 * missing during that lag even though the installation already covered all of them. `repository_selection` is
 * set synchronously on the installation resource the moment it changes on github.com, so an `'all'`
 * installation covers every repo GitHub will ever add to it, by definition — never gated on enumerating one.
 * @param {{permissions?:object, repos?:string[], repositorySelection?:string|null}} granted
 * @param {{permissions?:object, repos?:string[]}} [required]
 * @returns {{missingPermissions:string[], missingRepos:string[]}}
 */
export function findInstallationGaps(granted, { permissions = REQUIRED_APP_PERMISSIONS, repos = REQUIRED_APP_REPOS } = {}) {
  const have = granted?.permissions ?? {};
  const missingPermissions = Object.entries(permissions)
    .filter(([name, level]) => (LEVEL[have[name]] ?? 0) < LEVEL[level])
    .map(([name, level]) => `${name}:${level}`);
  if (granted?.repositorySelection === 'all') {
    return { missingPermissions, missingRepos: [] };
  }
  const haveRepos = new Set((granted?.repos ?? []).map((r) => String(r).toLowerCase()));
  const missingRepos = repos.filter((r) => !haveRepos.has(String(r).toLowerCase()));
  return { missingPermissions, missingRepos };
}

/** The repos an installation token can actually see (`GET /installation/repositories`, authenticated as the
 *  installation itself). One call per MINT, not per `gh` call — a mint happens roughly once an hour. */
async function defaultListInstallationRepos(token, fetchImpl = fetch) {
  const res = await fetchImpl('https://api.github.com/installation/repositories?per_page=100', {
    headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (!res.ok) throw new Error(`github-app-auth-env: listing installation repos failed (HTTP ${res.status})`);
  const data = await res.json();
  return (data.repositories ?? []).map((r) => r.full_name);
}

/** Refresh this long before the real 1-hour expiry — generous enough that a slow mint, a daemon restart
 *  mid-refresh, or plain clock skew never leaves a consumer holding a token GitHub has already rejected. */
export const REFRESH_BUFFER_MS = 10 * 60 * 1000;

/** One shared cache, not per-daemon — the review daemon, the fix-dispatch daemon and the drain all draw
 *  from the SAME installation, so one fresh token serves all of them; minting three independent tokens for
 *  one installation would just be three times the JWT-signing cost for zero isolation benefit (they already
 *  share the one installation's rate-limit bucket, by #3866's own ruling). */
export function defaultCachePath(home = homedir()) {
  return `${home}/.claude/github-app-token/web-everything.json`;
}

/**
 * ONE SHARED STATUS FILE, sibling of the token cache (#x8mpubm). Live-caught 2026-09-23: an installation
 * missing every required permission and repo left {@link ensureFreshGithubAppEnv} refusing to apply the App
 * token on EVERY tick, of EVERY daemon, since the App was registered — and the only trace of that was a
 * repeated line in one daemon's own log file, which is why plateau-app PR #181's review session ran a whole
 * incident on the operator's personal `gh` credential before anyone noticed. This file is the fix for
 * "noticed": every {@link ensureFreshGithubAppEnv} call, whichever process runs it, overwrites the SAME
 * status file with its own outcome, so `we:scripts/conveyor/github-app-status.mjs` (or a future monitoring
 * skill) can answer "is App auth actually applying?" with one read, no daemon log to grep.
 */
export function defaultStatusPath(home = homedir()) {
  return `${home}/.claude/github-app-token/status.json`;
}

/**
 * The three env vars that opt a process into GitHub App auth. All three or none — a partially-configured
 * process is almost certainly a typo, not an intentional two-thirds opt-in, so it refuses closed (falls back
 * to personal auth) rather than guessing which piece is missing.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{appId:string, installationId:string, privateKeyPath:string}|null}
 */
export function resolveGithubAppEnvConfig(env = process.env) {
  const appId = env.WE_GITHUB_APP_ID;
  const installationId = env.WE_GITHUB_APP_INSTALLATION_ID;
  const privateKeyPath = env.WE_GITHUB_APP_PRIVATE_KEY_PATH;
  if (!appId || !installationId || !privateKeyPath) return null;
  // The retired personal-account installation id is remapped to the web-everything org's installation, so a
  // launchd plist that still carries the old id keeps minting a token that covers the moved repos.
  return { appId, installationId: remapLegacyInstallationId(installationId, env), privateKeyPath };
}

/** The three opt-in env vars, in the order {@link diagnoseGithubAppEnvConfig} reports them. */
export const GITHUB_APP_ENV_KEYS = Object.freeze(['WE_GITHUB_APP_ID', 'WE_GITHUB_APP_INSTALLATION_ID', 'WE_GITHUB_APP_PRIVATE_KEY_PATH']);

function defaultCanReadKey(path) {
  try { accessSync(path, fsConstants.R_OK); return true; } catch { return false; }
}

/**
 * Is App auth fully configured, absent, or HALF-configured? PURE apart from the injected key-readability check.
 * Live-caught 2026-10-09: the drain's plist pinned an installation and a key path but no `WE_GITHUB_APP_ID`, so
 * {@link resolveGithubAppEnvConfig} returned `null` and the drain ran on the operator's personal login with no
 * trace anywhere — until that login's shared rate limit broke the drain's check at 13:21Z. Half-configured is never
 * an intentional opt-out, so it must be reported, never treated like "absent".
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{canReadKey?:(path:string)=>boolean}} [o]
 * @returns {{state:'complete'|'absent'|'half', missing:string[], keyUnreadable:boolean}}
 */
export function diagnoseGithubAppEnvConfig(env = process.env, { canReadKey = defaultCanReadKey } = {}) {
  const missing = GITHUB_APP_ENV_KEYS.filter((k) => !env?.[k]);
  if (missing.length === GITHUB_APP_ENV_KEYS.length) return { state: 'absent', missing, keyUnreadable: false };
  const keyPath = env?.WE_GITHUB_APP_PRIVATE_KEY_PATH;
  const keyUnreadable = !!keyPath && !canReadKey(keyPath);
  if (missing.length || keyUnreadable) return { state: 'half', missing, keyUnreadable };
  return { state: 'complete', missing: [], keyUnreadable: false };
}

/** The plain-language warning for a {@link diagnoseGithubAppEnvConfig} result that is not `complete`. PURE. */
export function formatGithubAppConfigWarning(diag, { caller = 'this process', daemon = false } = {}) {
  if (!diag || diag.state === 'complete') return null;
  if (diag.state === 'absent') {
    return daemon
      ? `github-app-auth-env: WARNING — ${caller} is a daemon and App login is the default (github.auth=app), but none of ${GITHUB_APP_ENV_KEYS.join(', ')} is set. It is running on the operator's PERSONAL gh login.`
      : null;
  }
  const parts = [];
  if (diag.missing.length) parts.push(`missing ${diag.missing.join(', ')}`);
  if (diag.keyUnreadable) parts.push('the private key file is unreadable');
  return `github-app-auth-env: WARNING — App auth is HALF-configured for ${caller} (${parts.join('; ')}). App login is SKIPPED and every gh call runs on the operator's PERSONAL login. Set the missing value(s) in the launchd plist and reload it (bootout + bootstrap).`;
}

/**
 * A stable name for the process refreshing auth, for its per-caller status file. A pass-daemon runs one pass per
 * process, so its `--pass=` value is part of the name (otherwise every pass-daemon would share one file).
 */
export function defaultAuthCaller(argv = process.argv, env = process.env) {
  if (env?.WE_GITHUB_AUTH_CALLER) return String(env.WE_GITHUB_AUTH_CALLER);
  const script = argv?.[1] ? basename(String(argv[1])) : 'unknown';
  const pass = (argv ?? []).find((a) => typeof a === 'string' && a.startsWith('--pass='));
  return pass ? `${script}:${pass.slice(7)}` : script;
}

/** One status file PER CALLER (no read-modify-write race between daemons), beside the shared status file. */
export function defaultCallerStatusDir(home = homedir()) {
  return `${home}/.claude/github-app-token/callers`;
}

function callerStatusFile(dir, caller) {
  return join(dir, `${String(caller).replace(/[^A-Za-z0-9._-]+/g, '_')}.json`);
}

/**
 * Every caller's last recorded auth outcome, newest first, dropping files older than `maxAgeMs` (a daemon that was
 * removed stops refreshing its file; a live one rewrites it every tick). Never throws.
 * @returns {{caller:string, applied:boolean, reason:string, missing?:string[], keyUnreadable?:boolean, checkedAt:string}[]}
 */
export function readGithubAppCallerStatuses({ dir = defaultCallerStatusDir(), now = Date.now(), maxAgeMs = 2 * 60 * 60 * 1000 } = {}) {
  let names = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const n of names) {
    try {
      const s = JSON.parse(readFileSync(join(dir, n), 'utf8'));
      const at = Date.parse(s?.checkedAt ?? '');
      if (!s || typeof s.caller !== 'string' || !Number.isFinite(at) || now - at > maxAgeMs) continue;
      out.push(s);
    } catch { /* torn/corrupt file: skip */ }
  }
  return out.sort((a, b) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt));
}

const warnedOnce = new Set();
/** Log `msg` once per process per key — the per-tick refresh must stay loud without flooding a daemon log. */
function warnOnce(log, key, msg) {
  if (!msg || warnedOnce.has(key)) return;
  warnedOnce.add(key);
  log?.error?.(msg);
}

/**
 * Stamped on every cache entry this module writes. Only an entry carrying the CURRENT version is trusted —
 * because a cache hit skips the access check, an entry written by an older, laxer version must never be
 * reused (live-caught 2026-09-23: a pre-check probe cached an unvalidated token, and both daemons applied it
 * on restart until it was deleted by hand). Bump this whenever what "validated" means changes.
 */
// Identity fields are additive to v2 so existing shim readers can still consume the token.
// This reader additionally requires matching App and installation IDs before reuse.
export const CACHE_VERSION = 2;

/** Pure: is a cached token still safe to use `bufferMs` before its own real expiry? No token cached at all
 *  is never "fresh" — that is a mint, not a refresh; nor is one written by a different cache version.
 *  @param {{expiresAt?:string, v?:number}|null} cached @param {number} nowMs @param {number} [bufferMs] */
export function isCacheFresh(cached, nowMs, bufferMs = REFRESH_BUFFER_MS) {
  if (!cached || cached.v !== CACHE_VERSION || typeof cached.expiresAt !== 'string') return false;
  const expiresAtMs = Date.parse(cached.expiresAt);
  return Number.isFinite(expiresAtMs) && (expiresAtMs - bufferMs) > nowMs;
}

/** Missing is distinct from corrupt — a corrupt cache (torn write, hand-edited) is treated as absent rather
 *  than thrown on, since the caller's whole job is "get me a usable token", not "diagnose the cache file". */
function readCacheFile(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/** Atomic write (write-then-rename, same directory) — two processes racing to refresh the SAME shared cache
 *  must never leave a torn/partial JSON on disk for a third reader mid-write. */
function writeCacheFile(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(data), 'utf8');
  renameSync(tmp, path);
}

/**
 * BEST-EFFORT, atomic like {@link writeCacheFile} — but a status write is diagnostic, never load-bearing, so
 * unlike every other effect in this module it swallows its OWN failure (a read-only home dir, a full disk)
 * rather than reporting one: {@link ensureFreshGithubAppEnv} must stay exactly as reliable as it was before
 * this file existed, for a caller that never reads the status back.
 */
function writeStatusFile(path, status) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(status, null, 2), 'utf8');
    renameSync(tmp, path);
  } catch { /* diagnostic only — see docblock above */ }
}

/**
 * Read the status file back, for `we:scripts/conveyor/github-app-status.mjs` and any future caller — the
 * counterpart read to {@link writeStatusFile}, exported for the same reason {@link defaultCachePath} is: so
 * a reader resolves the SAME path this module writes without duplicating the join logic.
 * @param {string} [path]
 * @returns {{applied:boolean, reason:string, missingPermissions?:string[], missingRepos?:string[], checkedAt:string}|null}
 */
export function readGithubAppStatus(path = defaultStatusPath(), { callerDir = join(dirname(path), 'callers'), now = Date.now() } = {}) {
  let status = null;
  try { status = JSON.parse(readFileSync(path, 'utf8')); } catch { status = null; }
  // Per-caller outcomes (half-configured daemons, a daemon stuck on mint-failed): the shared file above is
  // last-writer-wins, so one healthy daemon's `ok` would hide another's fallback. Attached only when present.
  const callers = readGithubAppCallerStatuses({ dir: callerDir, now });
  if (!callers.length) return status;
  return { ...(status ?? {}), callers };
}

/**
 * The IO shell a process's own bootstrap calls: if GitHub App auth is configured, ensure the shared cache
 * holds a token fresh enough to use, minting a new one when it does not, then set `process.env.GH_TOKEN` to
 * it so every `gh` CLI call and every raw `execFileSync('gh', …)` this process (or anything it spawns)
 * makes from here on authenticates as the App installation instead of the operator's personal token.
 *
 * Never throws on a mint failure — a transient GitHub outage must not crash a daemon tick or a drain run;
 * it logs and leaves `process.env.GH_TOKEN` UNCHANGED, so a caller with no App configured (or one whose mint
 * just failed) falls straight back to whatever auth was already in effect (the operator's own `gh auth
 * login`, unchanged from today).
 *
 * FAIL-SAFE ON A MISCONFIGURED APP. A fresh mint is checked against {@link REQUIRED_APP_PERMISSIONS} and
 * {@link REQUIRED_APP_REPOS} BEFORE it is cached or applied. An installation missing any of them is refused
 * the same way a failed mint is — personal auth stays in effect, and the log names exactly what to grant — so
 * switching the App on can never leave the fleet less able to act than it was before. Only a token that
 * passed this check is ever written to the cache, so a cache hit needs no re-check.
 *
 * REPO CHECK PREFERS `repository_selection` OVER ENUMERATION (live-caught 2026-09-26). Right after minting,
 * {@link getInstallationInfo} reads the installation's own `repository_selection` via the App's JWT — a field
 * set synchronously on github.com, never subject to listing lag. `'all'` satisfies every repo requirement
 * outright, with no call to `listRepos` at all. Only when it is `'selected'` (or unreadable) does this fall
 * back to the enumeration-based check {@link listRepos} has always done. A verification failure (the info
 * fetch AND, when it was needed, the repo listing both fail) is reported as its OWN reason,
 * `access-check-failed` — distinct from `insufficient-access` — so a transient read failure is never
 * misreported as though every required permission or repo were confirmed missing.
 * RECORDS ITS OUTCOME (#x8mpubm) to {@link defaultStatusPath} by default, on every path EXCEPT
 * `not-configured` (see the inline comment on `record` below for why that one reason is deliberately never
 * written) — so a fail-closed state that would otherwise sit invisible in one daemon's own log is checkable
 * from anywhere with one file read (`we:scripts/conveyor/github-app-status.mjs`). The write is best-effort
 * ({@link writeStatusFile} never throws) and never changes what this function returns — a caller that ignores
 * `statusPath`/`writeStatus` entirely sees byte-identical behavior to before.
 * @param {{env?:NodeJS.ProcessEnv, cachePath?:string, now?:number, readCache?:Function, writeCache?:Function,
 *   mint?:typeof mintInstallationToken, listRepos?:(token:string)=>Promise<string[]>,
 *   getInstallationInfo?:typeof getInstallationInfo,
 *   required?:{permissions?:object, repos?:string[]}, setEnv?:(token:string)=>void, log?:Console,
 *   statusPath?:string, writeStatus?:(path:string, status:object)=>void}} [o]
 * @returns {Promise<{applied:boolean, reason:string, missingPermissions?:string[], missingRepos?:string[]}>}
 */
export async function ensureFreshGithubAppEnv({
  env = process.env,
  cachePath = defaultCachePath(),
  now = Date.now(),
  readCache = readCacheFile,
  writeCache = writeCacheFile,
  mint = mintInstallationToken,
  listRepos = defaultListInstallationRepos,
  getInstallationInfo: getInstallationInfoFn = getInstallationInfo,
  required,
  setEnv = (token) => { env.GH_TOKEN = token; },
  log = console,
  statusPath = defaultStatusPath(),
  writeStatus = writeStatusFile,
  extraInstallations = true,
  perOwner = false,
  installShim = defaultInstallOwnerShim,
  daemon = false,
  caller = defaultAuthCaller(process.argv, env),
  policy,
  canReadKey = mint === mintInstallationToken ? defaultCanReadKey : () => true,
  callerStatusDir = join(dirname(statusPath), 'callers'),
  // A test that injected `writeStatus` never wrote the real home dir; keep it that way for the per-caller file.
  writeCallerStatus = writeStatus === writeStatusFile ? writeStatusFile : () => {},
} = {}) {
  const recordCaller = (result, extra = {}) => {
    writeCallerStatus(callerStatusFile(callerStatusDir, caller), { caller, daemon, ...result, ...extra, checkedAt: new Date(now).toISOString() });
  };
  const record = (result, { shared = true } = {}) => {
    if (result.reason !== 'not-configured') recordCaller(result);
    if (!shared) return result;
    // `not-configured` is skipped, deliberately (#x8mpubm follow-up): this shared file reports the FLEET's
    // installation state, and `not-configured` means only "THIS caller never opted in" — a fact about the
    // caller, not the installation. Recording it would let any incidental, unconfigured caller (a stray local
    // script, a test that forgot to inject `statusPath`/`writeStatus` — live-caught the same day this was
    // added) stomp a real `insufficient-access`/`ok` a properly-configured daemon just wrote. A reader with no
    // file at all already gets its own honest, distinct message (`readGithubAppStatus` returning `null`), so
    // nothing is lost by skipping this one reason.
    if (result.reason !== 'not-configured') {
      writeStatus(statusPath, { ...result, checkedAt: new Date(now).toISOString() });
    }
    return result;
  };

  // `github.auth: personal` is an explicit, host-wide choice — honoured, recorded, never a silent fallback.
  const authPolicy = policy ?? readGithubAuthPolicy({ env });
  if (authPolicy.auth === 'personal') {
    warnOnce(log, `policy-personal:${caller}`, `github-app-auth-env: github.auth=personal (${authPolicy.source?.auth ?? '?'}) — ${caller} uses the operator's personal gh login by policy.`);
    return record({ applied: false, reason: 'policy-personal' }, { shared: false });
  }

  // A HALF-configured App (some of the three vars set, or the key unreadable) is a misconfiguration, not an
  // opt-out: warn loudly and record it, so the health smell names the daemon. Still falls back (fail-safe).
  // Missing vars are checked every call; key readability only when a mint actually needs the key (below) — a
  // cache hit never reads it.
  const diag = diagnoseGithubAppEnvConfig(env, { canReadKey: () => true });
  if (diag.state === 'half') {
    warnOnce(log, `half:${caller}:${diag.missing.join(',')}:${diag.keyUnreadable}`, formatGithubAppConfigWarning(diag, { caller, daemon }));
    // Caller file only: the shared status file reports the INSTALLATION (bad-credentials reads `applied:false`
    // there), and this is a fact about one process's env, not about the installation.
    return record({ applied: false, reason: 'half-configured', missing: diag.missing, keyUnreadable: diag.keyUnreadable }, { shared: false });
  }

  const config = resolveGithubAppEnvConfig(env);
  if (!config) {
    // App is the default for DAEMONS: one with no App config at all is reported too (shared file untouched —
    // see `record` — but its own caller file says so, and the smell reads that).
    if (daemon) {
      warnOnce(log, `absent:${caller}`, formatGithubAppConfigWarning(diag, { caller, daemon }));
      recordCaller({ applied: false, reason: 'not-configured' });
      return { applied: false, reason: 'not-configured' };
    }
    return record({ applied: false, reason: 'not-configured' });
  }

  let cached = readCache(cachePath);
  let source = 'cache';
  if (!isCacheFresh(cached, now) || typeof cached.token !== 'string' || !cached.token || cached.installationId !== config.installationId || cached.appId !== config.appId) {
    source = 'mint';
    if (!canReadKey(config.privateKeyPath)) {
      const keyDiag = { state: 'half', missing: [], keyUnreadable: true };
      warnOnce(log, `half:${caller}::true`, formatGithubAppConfigWarning(keyDiag, { caller, daemon }));
      return record({ applied: false, reason: 'half-configured', missing: [], keyUnreadable: true }, { shared: false });
    }
    let minted;
    try {
      minted = await mint({ appId: config.appId, installationId: config.installationId, privateKeyPath: config.privateKeyPath, now });
    } catch (e) {
      // Never echo a partial token or the private key path's contents — only the API's own error message,
      // already scrubbed of secrets by github-app-token.mjs's own mint failure path.
      log.error?.(`github-app-auth-env: mint failed (falling back to personal auth): ${String((e && e.message) || e)}`);
      return record({ applied: false, reason: 'mint-failed' });
    }

    // Read `repository_selection` off the installation resource itself FIRST (never subject to the listing
    // endpoint's own lag — see this function's own docblock). A failure here is not fatal by itself: it just
    // means we don't yet know whether this is an 'all' installation, so we fall through to the enumeration
    // check exactly as before.
    let repositorySelection = null;
    try {
      ({ repositorySelection } = await getInstallationInfoFn({ appId: config.appId, installationId: config.installationId, privateKeyPath: config.privateKeyPath, now }));
    } catch (e) {
      log.error?.(`github-app-auth-env: could not read the installation's repository_selection (falling back to enumeration): ${String((e && e.message) || e)}`);
    }

    // `repositorySelection === 'all'` needs no enumeration at all — every repo is covered by definition, and
    // `listRepos` is never even called (never subject to its own lag). Anything else falls back to the
    // enumeration this function has always done.
    let repos = [];
    let listFailed = false;
    if (repositorySelection !== 'all') {
      try {
        repos = await listRepos(minted.token);
      } catch (e) {
        listFailed = true;
        log.error?.(`github-app-auth-env: could not list the installation's repositories: ${String((e && e.message) || e)}`);
      }
    }

    // A verification failure is never reported as "every repo is missing" — that would mislead an operator
    // into granting access that was never actually absent. It is its own, distinct outcome (live-caught
    // 2026-09-26): we know the mint itself succeeded (this token IS good), we simply could not confirm repo
    // access one way or the other this tick — `repositorySelection` came back unknown/not-'all', AND the one
    // remaining source of truth (enumeration) also failed — so the next tick tries again rather than trusting
    // an empty `repos` list as a confirmed gap.
    if (repositorySelection !== 'all' && listFailed) {
      log.error?.('github-app-auth-env: could not verify the App installation\'s repository access this tick — NOT applying it, staying on personal auth. Retrying next tick.');
      return record({ applied: false, reason: 'access-check-failed' });
    }

    // An installation covers ONE owner, so it is only required to cover the constellation repos that owner holds.
    const ownRepos = REQUIRED_APP_REPOS.filter((r) => installationForOwner(ownerOfSlug(r), env) === String(config.installationId));
    const requiredForThis = required?.repos ? required : { ...(required ?? {}), repos: ownRepos.length ? ownRepos : REQUIRED_APP_REPOS };
    const { missingPermissions, missingRepos } = findInstallationGaps({ permissions: minted.permissions, repos, repositorySelection }, requiredForThis);
    if (missingPermissions.length || missingRepos.length) {
      log.error?.(
        'github-app-auth-env: App installation is missing access the fleet needs — NOT applying it, staying on personal auth. '
        + (missingPermissions.length ? `Grant repository permissions: ${missingPermissions.join(', ')}. ` : '')
        + (missingRepos.length ? `Add repositories to the installation: ${missingRepos.join(', ')}.` : ''),
      );
      return record({ applied: false, reason: 'insufficient-access', missingPermissions, missingRepos });
    }
    cached = { v: CACHE_VERSION, appId: config.appId, installationId: config.installationId, token: minted.token, expiresAt: minted.expiresAt };
    writeCache(cachePath, cached);
  }

  // Per-installation caches: the daemon's own GH_TOKEN covers ONE owner, so also keep a fresh token for EVERY
  // mapped installation in its own cache file, which the gh shim picks by the target repo's owner.
  // Best-effort: a failure here never affects the primary token applied below.
  if (extraInstallations && !perOwner && Object.values(installationMap(env)).includes(String(config.installationId))) {
    await ensurePerInstallationCaches({ config, primary: cached, env, cachePath, now, readCache, writeCache, mint, log });
  }

  // MULTI-REPO CALLERS (the drain sweeps web-everything + frontier-ui + plateauapp in one process): one pinned
  // `GH_TOKEN` belongs to ONE org's installation, so every `--repo` outside that org failed with "Could not
  // resolve to a Repository" and the whole pass died (live 2026-10-03 23:17Z). With `perOwner`, GH_TOKEN is NOT
  // set; every owner's token is kept fresh in its own cache (above) and `gh` is routed through the shim, which
  // picks the token by each call's target repo owner and falls back to personal auth, with a warning, for an
  // owner that has no installation.
  if (perOwner) {
    if (!Object.values(installationMap(env)).includes(String(config.installationId))) {
      log.error?.('github-app-auth-env: this installation is not in the owner map - per-owner routing needs it; staying on personal auth.');
      return record({ applied: false, reason: 'owner-map-missing' });
    }
    // The per-owner caches must be fresh for EVERY owner even when the primary came from the cache.
    await ensurePerInstallationCaches({ config, primary: cached, env, cachePath, now, readCache, writeCache, mint, log });
    let shim;
    try { shim = await installShim(env, { cachePath }); } catch (e) { shim = { ok: false, reason: String((e && e.message) || e) }; }
    if (!shim || !shim.ok) {
      log.error?.(`github-app-auth-env: could not install the per-owner gh shim (${shim && shim.reason}) - staying on personal auth.`);
      return record({ applied: false, reason: 'shim-failed' });
    }
    return record({ applied: true, reason: 'ok', perOwner: true });
  }

  setEnv(cached.token);
  // Bind provenance to the credential actually applied; inherited metadata cannot label a fallback token.
  env.WE_GH_AUTH_SOURCE = source;
  env.WE_GH_AUTH_INSTALLATION = String(cached.installationId);
  env.WE_GH_AUTH_TOKEN_HASH = createHash('sha256').update(cached.token).digest('hex');
  return record({ applied: true, reason: 'ok' });
}

/**
 * Default per-owner routing: write this checkout's `gh` shim and prepend its dir to `env.PATH` (idempotent).
 * Dynamic import: `gh-app-shim.mjs` imports this module.
 */
async function defaultInstallOwnerShim(env, { cachePath }) {
  const { buildGhShimSettingsEnv } = await import('./gh-app-shim.mjs');
  const settings = buildGhShimSettingsEnv({ env, pathEnv: env.PATH || '', cachePath });
  if (!settings || !settings.PATH) return { ok: false, reason: 'no-real-gh-or-write-failed' };
  const dir = settings.PATH.split(':')[0];
  if (!(env.PATH || '').split(':').includes(dir)) env.PATH = settings.PATH;
  return { ok: true, dir };
}

/**
 * For a LONG-RUNNING daemon: wrap its `runDaemonLoop` effects so every tick first awaits
 * {@link ensureFreshGithubAppEnv}, then runs the real tick. A cache read on almost every tick; a mint only
 * once the token nears expiry.
 *
 * WHY PER-TICK AND NEVER A TIMER (live-caught 2026-09-23). A daemon tick is a long run of synchronous
 * `execFileSync` calls (`gh`, `claude`) that BLOCKS the event loop. A background `setInterval` refresh
 * therefore could not progress while a tick ran — and a mint caught mid-connection by a long tick timed out
 * ("fetch failed"), falling back to personal auth. It also meant a fresh daemon's FIRST tick always started
 * before its token was in place. The gap between ticks is the one moment the loop is guaranteed free; awaiting
 * there also means every tick, including the first, starts with the token already set.
 * @param {{tickOnce:()=>any}} effects - a daemon's `runDaemonLoop` effects object
 * @param {Parameters<typeof ensureFreshGithubAppEnv>[0]} [opts] - forwarded to every refresh
 * @returns {typeof effects} the same effects, `tickOnce` wrapped
 */
/**
 * Keep one fresh token cache per mapped installation (`web-everything.<installationId>.json` beside the legacy
 * cache). The primary installation's already-fresh token is reused, not re-minted. Never throws.
 */
export async function ensurePerInstallationCaches({ config, primary, env, cachePath, now, readCache, writeCache, mint, log }) {
  const done = {};
  const entries = Object.entries(installationMap(env));
  for (const [owner, installationId] of entries) {
    if (done[installationId]) continue;
    done[installationId] = true;
    const path = installationCachePath(cachePath, installationId);
    try {
      if (String(installationId) === String(config.installationId) && primary?.token) {
        writeCache(path, primary);
        continue;
      }
      const have = readCache(path);
      if (isCacheFresh(have, now) && have.token && String(have.installationId) === String(installationId) && have.appId === config.appId) continue;
      const minted = await mint({ appId: config.appId, installationId, privateKeyPath: config.privateKeyPath, now });
      writeCache(path, { v: CACHE_VERSION, appId: config.appId, installationId: String(installationId), token: minted.token, expiresAt: minted.expiresAt });
    } catch (e) {
      log.error?.(`github-app-auth-env: could not refresh the token cache for owner ${owner} (installation ${installationId}); that owner falls back to personal auth: ${String((e && e.message) || e)}`);
    }
  }
}

/**
 * The App-auth options for every FLEET daemon. Each daemon touches more than one org (web-everything,
 * frontier-ui, plateauapp), and each org has its own installation, so the token is chosen per call by the target
 * repo's owner (see `perOwner` in {@link ensureFreshGithubAppEnv}). Pinning one org's token as GH_TOKEN made
 * every call to another org fail with "Could not resolve to a Repository" (drain 2026-10-03; review daemon and
 * fix-dispatch daemon on plateauapp/plateau-app 2026-10-04). Daemons import this; none spell their own.
 */
export const FLEET_APP_AUTH_OPTS = Object.freeze({ log: console, perOwner: true, daemon: true });

/**
 * The START-UP check a daemon runs once, before its first tick: a half-configured App (or, for a daemon, no App
 * config at all) is logged at once, so it is the first thing in the daemon's log — never discovered later from a
 * personal rate-limit incident. Returns the diagnosis. Never throws.
 */
export function warnGithubAppConfigAtStart({ env = process.env, log = console, daemon = true, caller = defaultAuthCaller(process.argv, env), canReadKey = defaultCanReadKey, policy } = {}) {
  let diag;
  try {
    const authPolicy = policy ?? readGithubAuthPolicy({ env });
    if (authPolicy.auth === 'personal') return { state: 'policy-personal', missing: [], keyUnreadable: false };
    diag = diagnoseGithubAppEnvConfig(env, { canReadKey });
    const msg = formatGithubAppConfigWarning(diag, { caller, daemon });
    if (msg) log?.error?.(msg);
  } catch { /* diagnostic only */ }
  return diag;
}

export function withGithubAppAuth(effects, opts = { log: console }) {
  warnGithubAppConfigAtStart({ log: opts.log ?? console, daemon: opts.daemon ?? true, ...(opts.env ? { env: opts.env } : {}) });
  const tick = effects.tickOnce;
  return {
    ...effects,
    // See daemon-self-sync.mjs#withSelfSync's own note: forwards whatever arguments the wrapped tickOnce
    // takes (e.g. runner.mjs's per-tick bookkeeping payload) straight through — this wrapper never needs to
    // see them itself.
    tickOnce: async (...args) => {
      await ensureFreshGithubAppEnv(opts); // never throws — a failure logs and leaves personal auth in place
      return tick(...args);
    },
  };
}
