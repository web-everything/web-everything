#!/usr/bin/env node
/**
 * @file scripts/lib/gh-app-shim.mjs
 * @description #x8mpubm — GET THE APP TOKEN INTO A DISPATCHED SESSION, FOR REAL. The coordinator's live
 *   evidence (2026-09-23) overturned this same item's own first cut: `we:scripts/lib/github-app-auth-env.mjs`
 *   correctly mints/refreshes an App token and sets `process.env.GH_TOKEN` in the DAEMON's own process (review
 *   88701, fix 8004, drain 43551 all had it in `ps eww`) — but the SPAWNED review/fix sessions (pids 72738,
 *   81880) had neither `GH_TOKEN` nor any `WE_GITHUB_APP_*` var at all. `claude --bg` does not fork a simple
 *   child of the invoking process; it hands work to a separate background session mechanism that does not
 *   inherit the SPAWNER's ambient `process.env` — confirmed live here by direct experiment (a `WE_ENV_PROBE_*`
 *   var set on the spawning shell never reached a `--bg` session's own Bash tool subprocess).
 *
 * WHAT DOES REACH IT, ALSO CONFIRMED LIVE (at the time): `claude --bg --settings '{"env":{...}}'` — an EXPLICIT
 * CLI argument, not inherited env — sets exactly those vars in the started session's own Bash-tool subprocess
 * environment, including a `PATH` override (proven by shadowing `gh` with a fake executable and observing the
 * fake, not the real, `gh` respond inside the dispatched session).
 *
 * #x8mpubm FOLLOW-UP (live-caught 2026-09-24, review-2600/2599/2594, after that day's earlier laptop restart):
 * `--settings` STOPPED BEING THE WHOLE STORY. The CLI now keeps a background daemon (`CLAUDE_BG_BACKEND=daemon`)
 * with a pool of pre-warmed, generic "spare" processes it hands a `--bg` request to for low latency, INSTEAD OF
 * spawning fresh, whenever one is available — and `ps eww` on live, task-ASSIGNED review sessions proved the
 * claim never re-applies `--settings`'s env to that spare: every one carried `GH_TOKEN` baked in from whenever
 * the spare was forked (traced to ~34 min after that day's 10:21 ET reboot — long since expired by the time it
 * was used), and the shim dir was simply absent from `PATH`. A `--settings`-only dispatch is thus, empirically,
 * a COIN FLIP: it lands when the pool happens to be out of spares (a genuinely fresh spawn), and silently does
 * nothing the rest of the time. Confirmed live, the SAME day: a `.claude/settings.local.json` `env` block in
 * the checkout the session starts in reaches a dispatched session's `gh` resolution even with NO `--settings`
 * flag at all — read fresh per task rather than baked at process-fork time, so it cannot go stale the way a
 * spare's own exec-time env can. {@link buildGhShimSettingsEnv} now writes BOTH: the `--settings` env object AND
 * (given a `cwd`) this file, so the override reaches a session whichever path served it.
 *
 * WHY A PATH-SHADOWING SHIM, NOT A ONE-TIME `GH_TOKEN` VALUE. Baking the CURRENT cached token into `--settings`
 * at spawn time would suffer the exact expiry problem this item's own evidence names: an installation token
 * lives ~1h, and a dispatched review/fix session can genuinely outlive that (multi-round reviews, a fix that
 * runs tests, retries). An env var, once set on a process, never updates itself no matter how long that
 * process lives. Instead, this shadows `gh` on `PATH` with a wrapper ({@link renderGhShimScript}) that reads
 * `we:scripts/lib/github-app-auth-env.mjs`'s own shared, continuously-refreshed token cache file FRESH ON
 * EVERY `gh` INVOCATION — so a session's very first `gh` call and its five-hundredth, an hour later, each get
 * whatever the daemon fleet's own ongoing refresh has most recently written, never a stale spawn-time snapshot.
 * The wrapper needs no `WE_GITHUB_APP_*` var and never touches the private key itself — only the cache file's
 * already-minted, short-lived token, exactly the credential `GH_TOKEN` was always meant to carry.
 *
 * OPT-IN, SAME GATE AS THE REST OF THIS EPIC (#3866). {@link buildGhShimSettingsEnv} returns `null` — no fs
 * write, no PATH override, a dispatch byte-identical to before this file existed — unless
 * `we:scripts/lib/github-app-auth-env.mjs#resolveGithubAppEnvConfig` says the CALLING process has actually
 * opted into App auth. This is not only architectural tidiness: a process (or a test) that has not configured
 * `WE_GITHUB_APP_*` has no cache worth shadowing `gh` for, so shimming would be pure overhead for zero benefit
 * — and, live-caught the same day on this same item's own status-file follow-up, an unconditional real-fs
 * default is exactly how an unrelated test run ends up writing into a developer's actual home directory.
 *
 * NEVER TOUCHES THE PRIVATE KEY. The generated shim only ever reads the shared token CACHE (a short-lived,
 * already-minted installation token) — never `WE_GITHUB_APP_PRIVATE_KEY_PATH`, never signs a JWT, never mints.
 *
 * PURE CORE / IO SHELL: {@link resolveRealGhBinary}, {@link renderGhShimScript} and {@link ghShimPathOverride}
 * are pure (every input injected, including the filesystem probe). {@link ensureGhShim} is the one real write,
 * best-effort and never-throwing exactly like `github-app-auth-env.mjs#writeStatusFile`. {@link
 * buildGhShimSettingsEnv} composes the three into the one thing a dispatcher actually needs: an `env` object
 * to fold into a `claude --bg --settings` argument, or `null` when nothing should change.
 */

import { existsSync, writeFileSync, chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultCachePath, resolveGithubAppEnvConfig } from './github-app-auth-env.mjs';

/** Where the generated shim lives — a sibling of the token cache, under the same shared `.claude` tree so a
 *  single daemon's own refresh already covers every dispatcher on the machine. */
export function defaultShimDir(home = homedir()) {
  return `${home}/.claude/github-app-token/gh-shim`;
}

/** The shim's own file path — always named literally `gh`, since PATH resolution for a bare `gh` command is
 *  the entire mechanism this shadows. */
export function shimGhPath(dir = defaultShimDir()) {
  return join(dir, 'gh');
}

/**
 * PURE (given `exists`): find the first REAL `gh` executable on `pathEnv`, skipping `shimDir` itself so the
 * shim never resolves to its own generated file (which would recurse forever the moment it ran). Returns
 * `null` when nothing is found — the caller's signal to skip shimming entirely rather than write a wrapper
 * with no real binary to call.
 * @param {{pathEnv?:string, shimDir?:string, exists?:(p:string)=>boolean}} [o]
 * @returns {string|null}
 */
export function resolveRealGhBinary({ pathEnv = process.env.PATH || '', shimDir = defaultShimDir(), exists = existsSync } = {}) {
  const resolvedShimDir = resolve(shimDir);
  for (const dir of pathEnv.split(':').filter(Boolean)) {
    if (resolve(dir) === resolvedShimDir) continue; // never resolve to ourselves
    const candidate = join(dir, 'gh');
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** The shared cache's own freshness contract, INLINED rather than imported (#x8mpubm) — the rendered shim is a
 *  standalone script that must run correctly from ANY cwd, under ANY lane a dispatched session happens to
 *  acquire, with no dependency on this repo's own module resolution being reachable from wherever `gh` was
 *  invoked. Duplicating these two small constants is the honest cost of that independence; a drift between
 *  this and `github-app-auth-env.mjs#CACHE_VERSION`/`REFRESH_BUFFER_MS` would only ever make the shim MISS a
 *  token it could have used (never apply a wrong one — the check is a pure subset of the real one), so the
 *  failure direction of a drift is the safe one. */
const SHIM_CACHE_VERSION = 2;
const SHIM_REFRESH_BUFFER_MS = 10 * 60 * 1000;
/** The captured App-token call's per-stream buffer cap — far above any real gh output (see the shim script). */
const SHIM_CAPTURE_MAX_BUFFER = 1024 * 1024 * 1024;

/**
 * PURE: the pattern the shim script tests a FAILED App-token `gh` call's stderr against to tell "this token
 * itself was rejected" apart from every other reason `gh` can fail (a bad flag, a genuinely missing PR, a
 * network hiccup) — never retry-and-mask those, only a credential GitHub itself refused. Exported so the
 * detection is under test at this file's own level, not only inside the generated script's opaque template.
 * @param {string} stderrText
 * @returns {boolean}
 */
export function looksLikeAppTokenAuthFailure(stderrText) {
  const s = String(stderrText || '');
  return /HTTP 401/.test(s) || /Bad credentials/i.test(s);
}

/**
 * PURE: the shim script's own source text — a standalone, dependency-free CommonJS Node script (no repo
 * import reaches it; see the module header for why). Reads `cachePath` fresh on every invocation, applies
 * `GH_TOKEN` only when the cached token is not within `SHIM_REFRESH_BUFFER_MS` of its own expiry, then execs
 * the REAL `gh` (`realGhPath`, baked in at generation time so the shim can never resolve back to itself) with
 * the original argv and the real exit code — a transparent pass-through in every other way.
 *
 * #x8mpubm follow-up (live-caught 2026-09-24, review-2582): "fresh by `expiresAt`" is NOT the same guarantee
 * as "GitHub still honors it" — an installation token can be invalidated (revoked, clock-skewed at mint time,
 * an installation change) before its own recorded expiry. Applying such a token used to fail the WHOLE
 * dispatched session outright on the very first `gh` call, with no recovery until the shared cache next
 * happened to look stale. Now: a `gh` call made WITH the cached App token is run once with its output
 * captured (not inherited) so it can be inspected; only if it fails AND {@link looksLikeAppTokenAuthFailure}
 * recognizes the failure as the token itself being rejected does the shim (a) best-effort delete the shared
 * cache, so the fleet's next refresh mints a replacement instead of every other dispatched session hitting
 * the same bad token for up to an hour, and (b) retry the SAME call once more with no token override — falling
 * back to whatever auth was already in effect (the operator's own `gh auth login`), exactly as a session with
 * no App auth configured at all would run. Every other outcome (success, or a failure unrelated to the token)
 * passes the same bytes and exit code through — but BUFFERED, not streamed: on the tokened path gh sees a
 * pipe, not a TTY, so color/pager/live-progress differ from a direct call (harmless for a non-TTY dispatched
 * session; an interactive operator run is the known gap, PR #2600 review). With no cached token at all the
 * original inherited-stdio call runs unchanged — a host with nothing cached sees zero change from before.
 * @param {{realGhPath:string, cachePath:string}} o
 * @returns {string}
 */
export function renderGhShimScript({ realGhPath, cachePath }) {
  return `#!/usr/bin/env node
// AUTO-GENERATED by we:scripts/lib/gh-app-shim.mjs — regenerated on every dispatch; do not edit by hand.
// A transparent \`gh\` pass-through that reads the shared GitHub App token cache FRESH on every call (#x8mpubm),
// so a dispatched session's gh calls keep authenticating as the App installation for as long as the shared
// cache stays fresh, however long the session itself runs — never a one-time value stale after ~1h. If the
// cached token itself gets rejected (looks fresh, GitHub disagrees), falls back to personal auth for THIS
// call and invalidates the cache so the fleet stops handing out the same bad token (#x8mpubm review-2582).
'use strict';
const { spawnSync } = require('node:child_process');
const { readFileSync, unlinkSync } = require('node:fs');

const REAL_GH = ${JSON.stringify(realGhPath)};
const CACHE_PATH = ${JSON.stringify(cachePath)};
const CACHE_VERSION = ${JSON.stringify(SHIM_CACHE_VERSION)};
const REFRESH_BUFFER_MS = ${JSON.stringify(SHIM_REFRESH_BUFFER_MS)};

function freshCachedToken() {
  let cached;
  try { cached = JSON.parse(readFileSync(CACHE_PATH, 'utf8')); } catch { return null; }
  if (!cached || cached.v !== CACHE_VERSION || typeof cached.expiresAt !== 'string' || typeof cached.token !== 'string') return null;
  const expiresAtMs = Date.parse(cached.expiresAt);
  if (!Number.isFinite(expiresAtMs) || (expiresAtMs - REFRESH_BUFFER_MS) <= Date.now()) return null;
  return cached.token;
}

function looksLikeAppTokenAuthFailure(stderrText) {
  const s = String(stderrText || '');
  return /HTTP 401/.test(s) || /Bad credentials/i.test(s);
}

function invalidateSharedCache() {
  try { unlinkSync(CACHE_PATH); } catch { /* best-effort — a missing/already-gone cache is fine */ }
}

// #x8mpubm follow-up (live-caught 2026-09-24, review-2578/2601 — \`Unterminated string in JSON\`, a >64KB
// \`gh pr view\` payload truncated mid-string). NO PATH BELOW EVER CALLS \`process.exit()\` RIGHT AFTER A WRITE —
// same rule and same reason as \`we:scripts/conveyor/__tests__/helpers/fake-gh.mjs\` (x3xz8qp/#3988): a captured
// (\`stdio: ['inherit','pipe','pipe']\`) child's stdout/stderr is written back out through NODE's own stream, and
// for a payload over the ~64KB pipe-buffer size that write is ASYNCHRONOUS — \`process.exit()\` tears the
// process down before it drains, silently truncating whatever \`gh\` printed. Setting \`exitCode\` and letting the
// script fall off the end instead keeps the event loop alive until every queued write really lands.
function runInherited(env) {
  const result = spawnSync(REAL_GH, process.argv.slice(2), { stdio: 'inherit', env });
  if (result.error) {
    process.stderr.write(String(result.error && result.error.message || result.error) + '\\n');
    process.exitCode = 1;
    return;
  }
  process.exitCode = result.status == null ? 1 : result.status;
}

const token = freshCachedToken();
// A reader that closed early (\`gh … | head\`) must not turn a deferred write into an unhandled EPIPE stack trace.
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
if (!token) {
  runInherited(process.env); // no cached App token — unchanged, byte-identical to before this existed
} else {
  const withToken = spawnSync(REAL_GH, process.argv.slice(2), {
    stdio: ['inherit', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, { GH_TOKEN: token }),
    // Captured output must never be capped below what a real gh call can emit (a big diff, a CI log): Node's
    // 1MB default fails a call that SUCCEEDED with ENOBUFS (PR #2600 review).
    maxBuffer: ${JSON.stringify(SHIM_CAPTURE_MAX_BUFFER)},
  });
  if (withToken.error) {
    process.stderr.write(String(withToken.error.message || withToken.error) + '\\n');
    process.exitCode = 1;
  } else {
    const stderrText = withToken.stderr ? withToken.stderr.toString('utf8') : '';
    if (withToken.status !== 0 && looksLikeAppTokenAuthFailure(stderrText)) {
      invalidateSharedCache();
      runInherited(process.env); // retry once on whatever auth is already in effect — falls back safely
    } else {
      if (withToken.stdout && withToken.stdout.length) process.stdout.write(withToken.stdout);
      if (withToken.stderr && withToken.stderr.length) process.stderr.write(withToken.stderr);
      process.exitCode = withToken.status == null ? 1 : withToken.status;
    }
  }
}
`;
}

/**
 * THE ONE REAL WRITE — best-effort and NEVER throws, mirroring `github-app-auth-env.mjs#writeStatusFile`'s
 * own discipline: a dispatch must never fail because a diagnostic/convenience write couldn't land (a
 * read-only shim dir, a full disk). A failure here means the caller falls back to `null` — no shim, no
 * `--settings` override, the dispatch proceeds exactly as it would have before this file existed.
 * @param {{dir?:string, realGhPath:string, cachePath?:string, writeFile?:Function, chmod?:Function, mkdir?:Function}} o
 * @returns {{ok:boolean, path?:string, reason?:string}}
 */
export function ensureGhShim({
  dir = defaultShimDir(), realGhPath, cachePath = defaultCachePath(),
  writeFile = writeFileSync, chmod = chmodSync, mkdir = mkdirSync,
} = {}) {
  if (!realGhPath) return { ok: false, reason: 'no-real-gh' };
  try {
    mkdir(dir, { recursive: true });
    const path = shimGhPath(dir);
    writeFile(path, renderGhShimScript({ realGhPath, cachePath }), 'utf8');
    chmod(path, 0o755);
    return { ok: true, path };
  } catch (e) {
    return { ok: false, reason: 'write-failed', error: String((e && e.message) || e) };
  }
}

/** PURE: the new `PATH` value — the shim dir prepended, so a bare `gh` command resolves to it first. */
export function ghShimPathOverride({ dir = defaultShimDir(), currentPath = process.env.PATH || '' } = {}) {
  return `${dir}:${currentPath}`;
}

/**
 * THE SECOND, DURABLE DELIVERY PATH (#x8mpubm follow-up — see the module header for why `--settings` alone is
 * no longer enough). Merges `env` into `<cwd>/.claude/settings.local.json`'s own `env` block, creating the
 * file (and the `.claude` dir) if neither exists yet. ADDITIVE, never clobbering: an existing file's other
 * top-level keys and other `env` entries survive untouched; only the keys THIS call names are set/overwritten.
 *
 * BEST-EFFORT, NEVER THROWS — same discipline as {@link ensureGhShim}: a read-only checkout, a corrupt
 * existing settings file (treated as empty rather than fatal), or a full disk all resolve to `{ok:false}`,
 * never an exception, so a dispatch that would otherwise have gone out fine is never blocked by this.
 * @param {{cwd:string, env:Record<string,string>, readFile?:Function, writeFile?:Function, mkdir?:Function}} o
 * @returns {{ok:boolean, path?:string, reason?:string}}
 */
export function ensureSettingsFileEnv({
  cwd, env, readFile = readFileSync, writeFile = writeFileSync, mkdir = mkdirSync,
}) {
  if (!cwd) return { ok: false, reason: 'no-cwd' };
  const dir = join(cwd, '.claude');
  const path = join(dir, 'settings.local.json');
  try {
    mkdir(dir, { recursive: true });
    let existing;
    try { existing = JSON.parse(readFile(path, 'utf8')); } catch { existing = null; }
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) existing = {};
    const merged = { ...existing, env: { ...(existing.env && typeof existing.env === 'object' ? existing.env : {}), ...env } };
    writeFile(path, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    return { ok: true, path };
  } catch (e) {
    return { ok: false, reason: 'write-failed', error: String((e && e.message) || e) };
  }
}

/**
 * PURE: a shallow copy of `env` with `GH_TOKEN`/`GITHUB_TOKEN` REMOVED (not merely set to `''` — `gh` honors
 * either name, and a present-but-empty value is not guaranteed to be treated the same as absent).
 *
 * #x8mpubm follow-up (live-caught 2026-09-24): `github-app-auth-env.mjs#ensureFreshGithubAppEnv` sets
 * `process.env.GH_TOKEN` in a LONG-RUNNING daemon's own process so ITS OWN `gh`/git calls authenticate as the
 * App — necessary and correct for the daemon itself. But that daemon is also what invokes `claude` to start a
 * dispatched session, and `execFileSync`/`spawn` inherit the CALLER's `process.env` whenever no explicit `env`
 * is given — so the CLI-front-end invocation (and anything the CLI's own background-daemon infra bootstraps
 * from it, including a pre-warmed spare pool that then outlives any single dispatch) silently picks up a
 * snapshot of the daemon's own token. That snapshot never refreshes and eventually expires — the opposite of
 * what the shim exists to prevent. The spawn call this guards should carry NEITHER token: an App-authenticated
 * `gh` call only ever belongs behind the shim (which reads the shared cache fresh, every time); everything
 * else should fall through to the operator's own personal auth, exactly as if App auth were never configured.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {NodeJS.ProcessEnv}
 */
export function sanitizeSpawnEnv(env = process.env) {
  const out = { ...env };
  delete out.GH_TOKEN;
  delete out.GITHUB_TOKEN;
  return out;
}

/**
 * THE ONE THING A DISPATCHER ACTUALLY CALLS: an `env` object to fold into a `claude --bg --settings
 * '{"env":...}'` argument (via `we:scripts/operations/dispatch-lane-io.mjs#buildAgentArgv`'s `settingsEnv`
 * param), or `null` when nothing should change — the caller then omits `--settings` entirely, a dispatch
 * byte-identical to before this file existed. When `cwd` is given (the checkout the session will start in),
 * ALSO best-effort writes the same override into that checkout's `.claude/settings.local.json` via
 * {@link ensureSettingsFileEnv} — the durable delivery path a `--settings`-ignoring spare-pool claim cannot
 * skip (see the module header). That second write's own success/failure never changes this function's return
 * value; it is purely additional insurance.
 *
 * NEVER THROWS. Every real effect below it is wrapped or already non-throwing; this function additionally
 * treats a MISSING real `gh` binary or a failed shim write as "skip it", never as a reason to fail a dispatch
 * that would otherwise have gone out fine on personal auth, exactly as it always has.
 * @param {{env?:NodeJS.ProcessEnv, pathEnv?:string, cachePath?:string, dir?:string, cwd?:string,
 *   exists?:Function, writeFile?:Function, chmod?:Function, mkdir?:Function, readFile?:Function}} [o]
 * @returns {Record<string,string>|null}
 */
export function buildGhShimSettingsEnv({
  env = process.env, pathEnv = process.env.PATH || '', cachePath = defaultCachePath(), dir = defaultShimDir(),
  cwd, exists, writeFile, chmod, mkdir, readFile,
} = {}) {
  if (!resolveGithubAppEnvConfig(env)) return null; // opt-in — see the module header
  const realGhPath = resolveRealGhBinary({ pathEnv, shimDir: dir, exists });
  if (!realGhPath) return null;
  const written = ensureGhShim({ dir, realGhPath, cachePath, writeFile, chmod, mkdir });
  if (!written.ok) return null;
  const settingsEnv = { PATH: ghShimPathOverride({ dir, currentPath: pathEnv }) };
  if (cwd) ensureSettingsFileEnv({ cwd, env: settingsEnv, readFile, writeFile, mkdir }); // best-effort, see above
  return settingsEnv;
}
