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
 * #4064 — EVERY BOT gh CALL IS NOW BOTH ON THE APP LOGIN AND THROTTLED. `we:scripts/lib/gh-throttle.mjs` built
 * a cross-process concurrency cap + rate-limit backoff for `gh` calls (a real 2026-09-08 incident: many
 * concurrent dispatched agents tripped GitHub's secondary rate limit) but, as of that module's own PR, needed
 * each call SITE to opt in — 79 of 84 grepped `gh`-calling files still called `gh` directly. This shim is the
 * one place EVERY dispatched session's `gh` calls already funnel through (a bare `gh` resolves here via the
 * `PATH` override), so {@link renderGhShimScript}'s generated script now routes its own real-`gh` invocations
 * through `gh-throttle.mjs`'s standalone CLI (`GH_THROTTLE_CLI`, baked in exactly like `REAL_GH`) instead of
 * execing `REAL_GH` directly — no per-call-site migration needed, unlike that module's other three adopters.
 *
 * #4200-ish — GH_THROTTLE_CLI MUST NEVER DEPEND ON A LANE. Live fragility: a shim was found with
 * `GH_THROTTLE_CLI` hard-coded to `.../.lanes/web-everything/lane-22/scripts/lib/gh-throttle.mjs` — a checkout
 * the lane pool resets/recycles/deletes the moment its own PR lands, at which point every `gh` call routed
 * through that shim broke at once. The old `import.meta.url`-sibling resolution baked in whatever checkout
 * happened to be running the WRITING process's own copy of this file; if that process's own code lived in a
 * lane (a dispatched fix/review session doing its own edit work there, per lane-clone doctrine), the baked path
 * was the lane's, not a stable one. {@link defaultGhThrottleCliPath} now resolves it through
 * `bootstrap-session.mjs#primaryCheckout` instead — the SAME derivation that module already uses for its own
 * git-dir grant, specifically because a lane silently stops resolving once recycled. Belt-and-suspenders: the
 * generated shim ALSO fails open (see {@link renderGhShimScript}'s own `#4200-ish` note) with a stderr warning
 * whenever GH_THROTTLE_CLI (or one of ITS OWN sibling imports) is unavailable, so a still-stale shim, or one a
 * not-yet-upgraded checkout keeps writing, degrades to a direct unthrottled `gh` call instead of breaking.
 *
 * PURE CORE / IO SHELL: {@link resolveRealGhBinary}, {@link renderGhShimScript} and {@link ghShimPathOverride}
 * are pure (every input injected, including the filesystem probe). {@link ensureGhShim} is the one real write,
 * best-effort and never-throwing exactly like `github-app-auth-env.mjs#writeStatusFile`. {@link
 * buildGhShimSettingsEnv} composes the three into the one thing a dispatcher actually needs: an `env` object
 * to fold into a `claude --bg --settings` argument, or `null` when nothing should change.
 */

import { existsSync, writeFileSync, chmodSync, mkdirSync, readFileSync, renameSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultCachePath, resolveGithubAppEnvConfig } from './github-app-auth-env.mjs';
import {
  OWNER_INSTALLATIONS, MOVED_REPO_OWNERS, canonicalOwner, installationMap, installationForOwner, ownerOfSlug, ownerFromRemoteUrl, ownerFromGhArgv, installationCachePath,
} from './github-app-installations.mjs';
import { primaryCheckout } from '../bootstrap-session.mjs';
import { controlClonePath } from './automation-home.mjs';
import { stripGhDebug, rateLimitRecords, ghAuthIdentity, classifyGhResource } from './gh-throttle.mjs';

/**
 * #4200-ish (gh-shim-stable-path) — the absolute path to `we:scripts/lib/gh-throttle.mjs`, resolved through
 * {@link primaryCheckout} — NEVER from wherever THIS module happens to be executing. The old `import.meta.url`
 * sibling resolution baked in whatever checkout was running the CALLING process's own copy of this file — a
 * lane clone, a scratch clone, a daemon clone mid-rebuild — and a lane is reset/recycled/deleted by the pool
 * the instant its own PR lands (#104/lane-pool doctrine), which then silently breaks every `gh` call routed
 * through a shim baked with that lane's path (live: a shim found hard-coding
 * `.lanes/web-everything/lane-22/scripts/lib/gh-throttle.mjs`). `primaryCheckout` already solves exactly this
 * class of problem for `bootstrap-session.mjs`'s own git-dir grant (see its own doc: "a lane is reset and
 * recycled, so anything registered from inside one silently stops resolving") — reused here rather than
 * re-derived. Falls back to the old sibling-of-this-file resolution only when the primary checkout can't be
 * found on disk (an ephemeral host with no constellation layout at all), so this never returns a path that
 * doesn't exist when a perfectly good one is available.
 *
 * REALPATH'D, NOT JUST RESOLVED — caught live running this exact fix's own test suite: the laptop's primary
 * checkout is reachable through TWO names (`webeverything`, the real directory, and `web-everything`, a
 * symlink alias `CONSTELLATION_REPOS` also lists), and `primaryCheckout` can hand back either one depending on
 * probe order. `gh-throttle.mjs`'s own CLI entry point checks `import.meta.url === pathToFileURL(process.argv[1])`
 * to decide whether it was invoked directly — but Node's ESM loader resolves `import.meta.url` through any
 * symlink to the REAL path, while `process.argv[1]` (what {@link renderGhShimScript}'s generated script passes
 * as `GH_THROTTLE_CLI`) is whatever string this function returns verbatim. Baking the symlink alias in made
 * that comparison silently false: `main()` never ran, the CLI exited 0 with nothing printed, and every `gh`
 * call through it looked like a no-op success. Resolving through {@link realpathSync} first means the baked
 * path is always the same one Node's loader will report back, whichever alias `primaryCheckout` happened to
 * probe.
 *
 * DECOUPLE-PRIMARY-CHECKOUT (epic #4075) — THE CONTROL CLONE COMES FIRST. The primary checkout is the operator's
 * own working copy: routinely a detached HEAD hundreds of commits behind `main` (live 2026-09-27: 449 behind), so
 * a shim baked with ITS throttle CLI ran months-old pacing code for every bot `gh` call on the machine. The
 * throttle CLI now resolves, in order: (1) the automation's control clone (`automation-home.mjs#controlClonePath`
 * — `<workspace>/wev-control`, kept on `origin/main` by the daemon rebuild machinery); (2) the primary checkout,
 * for ONE release, while the control clone is not yet provisioned; (3) this file's own sibling.
 * @param {{root?:string, exists?:(p:string)=>boolean, realpath?:(p:string)=>string, env?:NodeJS.ProcessEnv,
 *   home?:string}} [o] — overridable per call (tests only; production callers accept the defaults, which read
 *   the real filesystem).
 */
export function defaultGhThrottleCliPath({ root, exists = existsSync, realpath = realpathSync, env = process.env, home } = {}) {
  const real = (p) => { try { return realpath(p); } catch { return p; } }; // best-effort — a fake `exists` in
  // tests with no matching real file on disk falls back to the candidate string itself, never throws.
  const control = join(controlClonePath({ env, ...(home ? { home } : {}) }), 'scripts', 'lib', 'gh-throttle.mjs');
  if (exists(control)) return real(control);
  const primary = primaryCheckout(root, exists);
  const candidate = join(primary, 'scripts', 'lib', 'gh-throttle.mjs');
  if (exists(candidate)) return real(candidate);
  return join(dirname(fileURLToPath(import.meta.url)), 'gh-throttle.mjs');
}

/** Where the generated shim lives — a sibling of the token cache, under the same shared `.claude` tree so a
 *  single daemon's own refresh already covers every dispatcher on the machine. */
export function defaultShimDir(home = homedir()) {
  return `${home}/.claude/github-app-token/gh-shim`;
}

/**
 * #4044 — the shim dir a dispatcher from THIS checkout writes and points its sessions at: one per checkout
 * (keyed by the throttle CLI path it bakes in), under `gh-shim.d/`. The old single shared `gh-shim/gh` was
 * rewritten by EVERY dispatcher on the machine, each baking in its own checkout's gh-throttle.mjs path — a lane
 * clone, a scratch clone, a daemon clone mid-rebuild — so any writer's tree vanishing broke gh for everyone
 * (live 2026-09-25 08:14 + 09:30 ET: the daemon rebuild's smoke rejected main on `cjs/loader:1227`). Per-checkout,
 * no other writer (including one still on older code, which only ever writes the legacy path) can clobber it.
 * @param {{ghThrottleCliPath?:string, home?:string}} [o]
 */
export function checkoutShimDir({ ghThrottleCliPath = defaultGhThrottleCliPath(), home = homedir() } = {}) {
  const key = createHash('sha256').update(resolve(ghThrottleCliPath)).digest('hex').slice(0, 16);
  return join(home, '.claude', 'github-app-token', 'gh-shim.d', key);
}

/** The root every generated shim dir lives under — never a real `gh` (see {@link resolveRealGhBinary}). */
function shimRootFor(home = homedir()) {
  return join(home, '.claude', 'github-app-token');
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
export function resolveRealGhBinary({
  pathEnv = process.env.PATH || '', shimDir = defaultShimDir(), exists = existsSync, shimRoot = shimRootFor(),
} = {}) {
  const resolvedShimDir = resolve(shimDir);
  const resolvedRoot = resolve(shimRoot);
  for (const dir of pathEnv.split(':').filter(Boolean)) {
    if (resolve(dir) === resolvedShimDir) continue; // never resolve to ourselves
    // #4044: nor to ANY generated shim (another checkout's per-checkout dir, or the legacy shared one) — a
    // dispatcher running under a session's shim PATH would otherwise bake that shim in as its "real" gh.
    if (resolve(dir).startsWith(`${resolvedRoot}/`)) continue;
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
 * PURE (#4309): the calling SCRIPT's basename from a `ps -o command=` line — `node /x/ci-heal-mark.mjs 2821` →
 * `ci-heal-mark.mjs`; a directly-run script (`/x/tool.py …`) → `tool.py`. `null` for anything that is not an
 * interpreter running a script file: a shell's `-c` command line (an agent session's Bash tool runs
 * `zsh -c source …snapshot.sh && eval '…'` — that `.sh` is NOT the caller), `node -e`, or a bare binary.
 * Inlined into the rendered shim via `Function#toString`, so it must stay self-contained (no outer references).
 * @param {string} command
 * @returns {string|null}
 */
export function shimCallerScriptFromCommand(command) {
  const toks = String(command || '').trim().split(/\s+/).filter(Boolean);
  if (!toks.length) return null;
  const base = (p) => p.slice(p.lastIndexOf('/') + 1);
  const isScript = (name) => /\.(m?[jt]s|cjs|py|sh|rb|pl)$/.test(name);
  const exe = base(toks[0]);
  if (!/^(node|nodejs|bun|deno|tsx|python[0-9.]*|ruby|perl|bash|sh|zsh)$/.test(exe)) return isScript(exe) ? exe : null;
  for (let i = 1; i < toks.length; i++) {
    const t = toks[i];
    if (t === '-c' || t === '-e' || t === '--eval' || t === '-p' || t === '--print') return null;
    if (/^(--import|--require|-r|--loader|--experimental-loader)$/.test(t)) { i += 1; continue; }
    if (t.startsWith('-') || t === 'run') continue;
    return isScript(base(t)) ? base(t) : null;
  }
  return null;
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
 *
 * #4064 — BOTH real-`gh` invocations below (the tokened attempt and the inherited-auth fallback) run through
 * `we:scripts/lib/gh-throttle.mjs`'s own standalone CLI (`GH_THROTTLE_CLI`, baked in at generation time exactly
 * like `REAL_GH` — never a repo-relative `require`, same independence contract as the rest of this script)
 * rather than execing `REAL_GH` directly, so every dispatched session's `gh` call is now BOTH on the App login
 * AND paced by that module's cross-process concurrency cap + rate-limit backoff — with no per-call-site
 * migration needed, unlike that module's other adopters. `WE_GH_THROTTLE_GH_BIN` tells that CLI to exec
 * `REAL_GH` directly instead of searching `PATH` for a bare `gh` — which would otherwise resolve back through
 * THIS shim's own `PATH` override and recurse forever.
 * @param {{realGhPath:string, cachePath:string, ghThrottleCliPath?:string}} o
 * @returns {string}
 */
export function renderGhShimScript({ realGhPath, cachePath, ghThrottleCliPath = defaultGhThrottleCliPath() }) {
  return `#!/usr/bin/env node
// AUTO-GENERATED by we:scripts/lib/gh-app-shim.mjs — regenerated on every dispatch; do not edit by hand.
// A transparent \`gh\` pass-through that reads the shared GitHub App token cache FRESH on every call (#x8mpubm),
// so a dispatched session's gh calls keep authenticating as the App installation for as long as the shared
// cache stays fresh, however long the session itself runs — never a one-time value stale after ~1h. If the
// cached token itself gets rejected (looks fresh, GitHub disagrees), falls back to personal auth for THIS
// call and invalidates the cache so the fleet stops handing out the same bad token (#x8mpubm review-2582).
// #4064: every real \`gh\` invocation below is routed through gh-throttle.mjs's own CLI (GH_THROTTLE_CLI) so
// it is paced by that module's shared cross-process concurrency cap, not execed directly.
'use strict';
const { spawnSync } = require('node:child_process');
const { readFileSync, unlinkSync, existsSync, mkdirSync, appendFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { homedir } = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');

const REAL_GH = ${JSON.stringify(realGhPath)};
const CACHE_PATH = ${JSON.stringify(cachePath)};
const CACHE_VERSION = ${JSON.stringify(SHIM_CACHE_VERSION)};
// Per-owner App installations (we:scripts/lib/github-app-installations.mjs): the token is chosen by the target
// repo's OWNER, since one installation covers one account. An unknown owner falls back to personal auth.
const OWNER_INSTALLATIONS = ${JSON.stringify(OWNER_INSTALLATIONS)};
const MOVED_REPO_OWNERS = ${JSON.stringify(MOVED_REPO_OWNERS)};
${canonicalOwner.toString()}
${installationMap.toString()}
${installationForOwner.toString()}
${ownerOfSlug.toString()}
${ownerFromRemoteUrl.toString()}
${ownerFromGhArgv.toString()}
${installationCachePath.toString()}
const REFRESH_BUFFER_MS = ${JSON.stringify(SHIM_REFRESH_BUFFER_MS)};
const GH_THROTTLE_CLI = ${JSON.stringify(ghThrottleCliPath)};

// #4064: run \`gh\` (as REAL_GH) through gh-throttle.mjs's CLI instead of execing it directly — same captured
// shape (\`stdio: ['inherit','pipe','pipe']\`, a big maxBuffer) either way, so every call site below stays a
// one-line swap. \`WE_GH_THROTTLE_GH_BIN\` pins the CLI's own inner spawn to REAL_GH's exact absolute path —
// never a bare \`gh\` PATH search, which would resolve back through this shim and recurse.
//
// #4044 (live 2026-09-25 08:14 ET): this ONE shared file is rewritten by every dispatcher on the machine, each
// baking in ITS OWN checkout's gh-throttle.mjs path — a lane clone, a scratch clone, a daemon clone. When the
// checkout that wrote it last is gone or mid-reset, GH_THROTTLE_CLI no longer exists and every gh call on the
// machine died with \`node:internal/modules/cjs/loader:1227\` (Cannot find module) — the daemon rebuild's live
// smoke rejected main on it and froze the daemon clone. A missing throttle CLI now degrades to a direct,
// unthrottled REAL_GH call (same captured shape), never a crash: the throttle is pacing, not correctness.
//
// #4200-ish (gh-shim-stable-path): GH_THROTTLE_CLI itself is now baked in via \`primaryCheckout\` (see
// \`defaultGhThrottleCliPath\`), so it should no longer point INTO a lane at generation time — but a shim
// generated before this fix, or one a still-unpatched checkout keeps writing, can still bake a lane path; and
// even a stable GH_THROTTLE_CLI has its OWN sibling imports (heavy-admission.mjs, file-locks.mjs, ...) that a
// lane reset elsewhere could still break. Both degrade the SAME way: never a crash, always a stderr warning so
// the fallback is visible rather than silently swallowed.
function warnFallback(reason) {
  try { process.stderr.write('gh-shim: ' + reason + ' — falling back to direct, unthrottled gh\\n'); } catch { /* best-effort */ }
}
// Embed the pure parsers at generation time: fallback has no checkout imports at runtime.
const GH_DEBUG_GIT_LINE = /^\\[(\\S*\\/)?git( [^\\n]*)?\\]$/;
${stripGhDebug.toString()}
${rateLimitRecords.toString()}
${ghAuthIdentity.toString()}
${classifyGhResource.toString()}
function runDirect(argv, env, fallbackReason) {
  const capture = !env.GH_DEBUG && env.WE_GH_THROTTLE_COST_HEADERS !== '0';
  const result = spawnSync(REAL_GH, argv, {
    stdio: ['inherit', 'pipe', 'pipe'],
    env: capture ? Object.assign({}, env, { GH_DEBUG: 'api' }) : env,
    maxBuffer: ${JSON.stringify(SHIM_CAPTURE_MAX_BUFFER)},
  });
  const parsed = stripGhDebug(result.stderr ? result.stderr.toString('utf8') : '');
  if (capture) result.stderr = Buffer.from(parsed.stderr);
  // Only numeric rate observations and a query hash survive; never argv, bodies or raw headers.
  const rl = rateLimitRecords(parsed.responses).map((r) => ({
    ...r, res: ['graphql', 'core', 'search', 'integration_manifest'].includes(r.res) ? r.res : null,
  }));
  const costs = parsed.responses.map((r) => r.cost);
  const cost = costs.length && costs.every((c) => Number.isInteger(c) && c >= 0)
    ? costs.reduce((sum, c) => sum + c, 0) : null;
  const clean = (value) => {
    let text = String(value || 'unknown');
    for (const secret of [env.GH_TOKEN, env.GITHUB_TOKEN]) if (secret) text = text.split(secret).join('[redacted]');
    return text.replace(/(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '[redacted]').slice(0, 160);
  };
  const id = ghAuthIdentity(env);
  const cachedAuth = token && env.GH_TOKEN === token;
  const installation = cachedAuth ? cachedInstallationId : (id === 'app' ? env.WE_GITHUB_APP_INSTALLATION_ID : null);
  const entry = {
    ts: new Date().toISOString(), op: ['api', 'pr', 'issue', 'repo', 'auth', 'run', 'workflow'].includes(argv[0]) ? argv[0] : 'other',
    attempt: 1, outcome: 'call', ok: !result.error && result.status === 0,
    caller: clean(CALLER), id, inv: randomUUID(), resource: classifyGhResource(argv),
    ...(env.WE_GH_THROTTLE_OUTER_INV ? { outer: clean(env.WE_GH_THROTTLE_OUTER_INV) } : {}),
    transport: 'shim-fallback', fallbackReason, cost, costSource: cost === null ? 'unknown' : 'response', rl,
    installationId: /^\\d+$/.test(String(installation || '')) ? String(installation) : null,
    authSource: cachedAuth ? 'app-cache' : 'inherited',
  };
  try {
    const home = env.HOME || homedir();
    const expand = (p) => p.startsWith('~') ? join(home, p.slice(1)) : p;
    const override = String(env.WE_GH_THROTTLE_LOCK_ROOT || '').trim();
    const root = override ? resolve(expand(override))
      : join(env.LANE_POOL_ROOT ? resolve(expand(env.LANE_POOL_ROOT)) : join(home, 'workspace', '.lanes'), '.admission', 'gh');
    mkdirSync(root, { recursive: true });
    appendFileSync(join(root, 'calls.jsonl'), JSON.stringify(entry) + '\\n', 'utf8');
  } catch {
    process.stderr.write('gh-shim: fallback ledger unavailable\\n');
  }
  return result;
}
// Does GH_THROTTLE_CLI's own module graph fail to load? Preloaded via \`--import\` in a fresh process with an
// empty \`-e\` program — never run as the entry point, so its own \`import.meta.url === argv[1]\` guard keeps
// main() from firing and this never invokes gh. ESM links the WHOLE static graph before evaluating any of it,
// so a stranded entry file or a stranded sibling import (heavy-admission.mjs, file-locks.mjs, ...) at any depth
// fails here with ERR_MODULE_NOT_FOUND; any other probe outcome is NOT proof, so it never triggers a replay.
function throttleCliFailsToLoad(env) {
  const probe = spawnSync(process.execPath, ['--import', pathToFileURL(GH_THROTTLE_CLI).href, '-e', ''], {
    stdio: ['ignore', 'ignore', 'pipe'], env,
    timeout: 10000, // a hung probe (status null) is never proof — it returns the original result, no replay
  });
  return probe.status !== 0 && /ERR_MODULE_NOT_FOUND/.test(probe.stderr ? probe.stderr.toString('utf8') : '');
}
function throttleCliMissing(result, env) {
  if (!result || result.error || result.status === 0) return false;
  const err = result.stderr ? result.stderr.toString('utf8') : '';
  if (!/Cannot find module/.test(err)) return false;
  // PR #2772 review: the stderr text ALONE is never proof. gh-throttle.mjs relays the REAL gh's stderr
  // byte-for-byte, so a genuine gh failure (a Node-based extension, a broken Node git hook) can print the same
  // "Cannot find module" text AFTER gh already ran — and replaying it via runDirect would duplicate a mutating
  // call. Nor is \`err.includes(GH_THROTTLE_CLI)\` enough: a stranded SIBLING import names the sibling's path,
  // not the entry file's. So the text only triggers a side-effect-free re-check of the throttle CLI's own
  // module graph; the fallback fires only when THAT fails to load too — i.e. gh was never reached.
  return throttleCliFailsToLoad(env);
}
// #4309: name the caller on every throttled call (WE_GH_THROTTLE_CALLER), so calls.jsonl stops reading "unknown"
// for every agent-session gh call. Precedence: GH_CALLER; else the parent process's script (local \`ps\`, no API);
// else the Claude session id; else the parent's command name. Best-effort — never fails the gh call.
${shimCallerScriptFromCommand.toString()}
function deriveCaller(env) {
  if (env.GH_CALLER) return String(env.GH_CALLER);
  let command = '';
  try {
    // Absolute, never a PATH lookup: a writable earlier PATH entry must not run inside the shim (PR #2851 review).
    const ps = spawnSync('/bin/ps', ['-o', 'command=', '-p', String(process.ppid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 });
    if (ps.status === 0) command = String(ps.stdout || '').trim();
  } catch { /* best-effort */ }
  const script = shimCallerScriptFromCommand(command);
  if (script) return script;
  if (env.CLAUDE_CODE_SESSION_ID) return 'session:' + String(env.CLAUDE_CODE_SESSION_ID).slice(0, 8);
  const first = command.split(' ')[0] || '';
  return first.slice(first.lastIndexOf('/') + 1) || null;
}
const CALLER = deriveCaller(process.env);

function runThrottled(argv, env) {
  if (!existsSync(GH_THROTTLE_CLI)) {
    warnFallback('throttle CLI not found at ' + GH_THROTTLE_CLI);
    return runDirect(argv, env, 'missing-entry');
  }
  const result = spawnSync(process.execPath, [GH_THROTTLE_CLI, ...argv], {
    stdio: ['inherit', 'pipe', 'pipe'],
    env: Object.assign({}, env, { WE_GH_THROTTLE_GH_BIN: REAL_GH }, CALLER ? { WE_GH_THROTTLE_CALLER: CALLER } : {}),
    // Same "never truncate a real gh payload" contract as the direct-exec path this replaces (PR #2600 review)
    // — gh-throttle.mjs's own internal capture is ALSO sized to this same cap (#4064), so neither hop clips it.
    maxBuffer: ${JSON.stringify(SHIM_CAPTURE_MAX_BUFFER)},
  });
  // The checkout vanished between the existsSync above and node resolving the entry (or one of its OWN
  // imports did) — same degrade.
  if (throttleCliMissing(result, env)) {
    warnFallback('throttle CLI at ' + GH_THROTTLE_CLI + ' failed to load (its checkout or one of its own imports is unavailable)');
    return runDirect(argv, env, 'missing-import');
  }
  return result;
}

let cachedInstallationId = null;
let usedCachePath = CACHE_PATH;
function readFreshCache(path) {
  let cached;
  try { cached = JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
  if (!cached || cached.v !== CACHE_VERSION || typeof cached.expiresAt !== 'string' || typeof cached.token !== 'string') return null;
  const expiresAtMs = Date.parse(cached.expiresAt);
  if (!Number.isFinite(expiresAtMs) || (expiresAtMs - REFRESH_BUFFER_MS) <= Date.now()) return null;
  return cached;
}
// The owner this call targets: the argv's own repo, else the current checkout's origin remote, else null.
function targetOwner(argv, env) {
  const fromArgv = ownerFromGhArgv(argv);
  if (fromArgv) return fromArgv;
  if (env.GH_REPO) { const o = ownerOfSlug(String(env.GH_REPO).split('/').slice(-2).join('/')); if (o) return o; }
  try {
    if (!existsSync('/usr/bin/git')) return null;
    const r = spawnSync('/usr/bin/git', ['remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 });
    return r.status === 0 ? ownerFromRemoteUrl(String(r.stdout || '').trim()) : null;
  } catch { return null; }
}
function freshCachedToken() {
  const owner = targetOwner(process.argv.slice(2), process.env);
  let cached = null;
  if (owner) {
    const id = installationForOwner(owner, process.env);
    if (!id) {
      process.stderr.write('gh-shim: no GitHub App installation is configured for owner "' + owner + '" - using personal auth for this call\\n');
      return null;
    }
    usedCachePath = installationCachePath(CACHE_PATH, id);
    cached = readFreshCache(usedCachePath);
    if (!cached) {
      // Not minted yet for this owner: the legacy single cache still serves it when it holds THIS installation.
      const legacy = readFreshCache(CACHE_PATH);
      if (legacy && (legacy.installationId == null || String(legacy.installationId) === String(id))) { cached = legacy; usedCachePath = CACHE_PATH; }
    }
  } else {
    usedCachePath = CACHE_PATH;
    cached = readFreshCache(CACHE_PATH);
  }
  if (!cached) return null;
  cachedInstallationId = cached.installationId ?? null;
  return cached.token;
}

function looksLikeAppTokenAuthFailure(stderrText) {
  const s = String(stderrText || '');
  return /HTTP 401/.test(s) || /Bad credentials/i.test(s);
}

function invalidateSharedCache() {
  try { unlinkSync(usedCachePath); } catch { /* best-effort — a missing/already-gone cache is fine */ }
}

// #x8mpubm follow-up (live-caught 2026-09-24, review-2578/2601 — \`Unterminated string in JSON\`, a >64KB
// \`gh pr view\` payload truncated mid-string). NO PATH BELOW EVER CALLS \`process.exit()\` RIGHT AFTER A WRITE —
// same rule and same reason as \`we:scripts/conveyor/__tests__/helpers/fake-gh.mjs\` (x3xz8qp/#3988): a captured
// (\`stdio: ['inherit','pipe','pipe']\`) child's stdout/stderr is written back out through NODE's own stream, and
// for a payload over the ~64KB pipe-buffer size that write is ASYNCHRONOUS — \`process.exit()\` tears the
// process down before it drains, silently truncating whatever \`gh\` printed. Setting \`exitCode\` and letting the
// script fall off the end instead keeps the event loop alive until every queued write really lands.
function runInherited(env) {
  // #4064: was a direct \`spawnSync(REAL_GH, ..., {stdio:'inherit'})\` — now routed through the SAME throttled
  // hop as the tokened path below (stdout/stderr captured then relayed, never \`process.exit()\`'d past — see
  // the block comment above), so the concurrency cap still applies on the no-cached-token fallback too.
  const result = runThrottled(process.argv.slice(2), env);
  if (result.error) {
    process.stderr.write(String(result.error && result.error.message || result.error) + '\\n');
    process.exitCode = 1;
    return;
  }
  if (result.stdout && result.stdout.length) process.stdout.write(result.stdout);
  if (result.stderr && result.stderr.length) process.stderr.write(result.stderr);
  process.exitCode = result.status == null ? 1 : result.status;
}

const token = freshCachedToken();
// A reader that closed early (\`gh … | head\`) must not turn a deferred write into an unhandled EPIPE stack trace.
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
if (!token) {
  runInherited(process.env); // no cached App token — same bytes/exit code as before (#4064: now also throttled)
} else {
  const withToken = runThrottled(process.argv.slice(2), Object.assign({}, process.env, { GH_TOKEN: token }));
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
 * @param {{dir?:string, realGhPath:string, cachePath?:string, ghThrottleCliPath?:string, writeFile?:Function, chmod?:Function, mkdir?:Function}} o
 * @returns {{ok:boolean, path?:string, reason?:string}}
 */
export function ensureGhShim({
  dir = defaultShimDir(), realGhPath, cachePath = defaultCachePath(), ghThrottleCliPath = defaultGhThrottleCliPath(),
  writeFile = writeFileSync, chmod = chmodSync, mkdir = mkdirSync,
  // #4044: the real write is ATOMIC (temp file + rename) — this one file is rewritten on every dispatch while
  // other processes exec it, and an in-place truncate-then-write could hand a concurrent `gh` a torn script.
  // An injected `writeFile` (tests) with no injected `rename` keeps the direct single write they assert on.
  rename = writeFile === writeFileSync ? renameSync : null,
} = {}) {
  if (!realGhPath) return { ok: false, reason: 'no-real-gh' };
  try {
    mkdir(dir, { recursive: true });
    const path = shimGhPath(dir);
    const src = renderGhShimScript({ realGhPath, cachePath, ghThrottleCliPath });
    if (rename) {
      const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
      writeFile(tmp, src, 'utf8');
      chmod(tmp, 0o755);
      rename(tmp, path);
    } else {
      writeFile(path, src, 'utf8');
      chmod(path, 0o755);
    }
    return { ok: true, path };
  } catch (e) {
    return { ok: false, reason: 'write-failed', error: String((e && e.message) || e) };
  }
}

/**
 * xpd70wx — is the generated shim at `dir` ORG-AWARE (it picks the App installation by the target repo's owner)?
 * The legacy shared `gh-shim/gh` (written before the 2026-10-03 org move) has no owner map, so it mints for one
 * account only and cannot see the plateauapp org. A marker-substring check on the file; unreadable = not aware.
 * @param {string} dir @param {{read?:(p:string)=>string}} [o]
 */
export function isOrgAwareShimDir(dir, { read = (p) => readFileSync(p, 'utf8') } = {}) {
  try { return read(shimGhPath(dir)).includes('OWNER_INSTALLATIONS'); } catch { return false; }
}

/**
 * xpd70wx — the shim dir `open-pr` / `pr-land` use for ANY target repo's org: the SAME per-checkout dir the
 * daemons resolve ({@link checkoutShimDir}, keyed by the control clone's throttle CLI), when it exists and is
 * org-aware; else `null`. Reuses the daemons' resolver and their already-minted tokens: no token is minted,
 * read into argv, printed or logged here.
 * @param {{dir?:string, exists?:(p:string)=>boolean, read?:(p:string)=>string}} [o]
 * @returns {string|null}
 */
export function resolveOrgAwareShimDir({ dir = checkoutShimDir(), exists = existsSync, read } = {}) {
  return exists(shimGhPath(dir)) && isOrgAwareShimDir(dir, read ? { read } : undefined) ? dir : null;
}

/**
 * xpd70wx — PURE: `PATH` with the org-aware shim first and the stale legacy shared shim dir (no owner map) dropped.
 * `null` when there is no org-aware shim, or `PATH` already resolves `gh` to it first (nothing to change).
 * @param {{pathEnv?:string, orgDir:string|null, legacyDir?:string}} o
 */
export function pathWithOrgAwareShim({ pathEnv = process.env.PATH || '', orgDir, legacyDir = defaultShimDir() } = {}) {
  if (!orgDir) return null;
  const parts = pathEnv.split(':').filter(Boolean);
  if (parts[0] === orgDir) return null;
  return [orgDir, ...parts.filter((d) => d !== orgDir && d !== legacyDir)].join(':');
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
 * THE PERMISSION COUNTERPART to {@link ensureSettingsFileEnv} — merges `permissions.additionalDirectories`
 * and `permissions.allow` into `<cwd>/.claude/settings.local.json`, ADDITIVE and NEVER-THROWING in exactly
 * the same shape (dedup by value, never removes an existing entry, a corrupt/missing file is treated as
 * empty rather than fatal).
 *
 * #xrv69j6 (epic #4075) — WHY THIS EXISTS. Since #4174/#2701 a dispatched session's cwd
 * (`we:scripts/operations/dispatch-lane-io.mjs#dispatchSessionCwd`) is a scratch directory OUTSIDE every
 * checkout, and its brief's very first real step (`lane-pool.mjs acquire`, then an Edit/Write into the lane
 * it just leased) targets a directory the CLI has never granted. An unattended `--bg` session that hits
 * Claude Code's own outside-cwd Edit/Write permission gate there has nobody to answer it and sits blocked
 * forever — live case: `fix-2735` (session `61d6f087…`) sat blocked 36+ minutes on 2026-09-26, stalling PR
 * #2735 (`review-status:fix-stalled`). `we:scripts/operations/dispatch-lane-io.mjs#createDispatchSinks`
 * calls this at the SAME moment, into the SAME durable per-cwd file, that {@link ensureSettingsFileEnv}
 * already writes the gh-shim env into — proven (see this module's own header) to reach a dispatched session
 * even when the CLI's background-daemon spare pool serves the dispatch from an already-running process and
 * silently drops a fresh `--settings` CLI argument. Writing directly into the file the session's own cwd
 * will read from means its FIRST Edit lands inside an already-approved directory rather than a prompt.
 *
 * WHY NOT A SECOND WRITE INTO `permissions.allow` ALONE. `additionalDirectories` is the CLI's own directory
 * grant (the same key `we:scripts/bootstrap-session.mjs#withPrimaryGitDir` writes at machine-bootstrap time
 * for a lane's `--reference`d primary `.git`); `allow` rules (`Edit(<dir>/**)`, `Write(<dir>/**)`) additionally
 * pre-approve the TOOL itself for that path. Both are written together so a directory is granted the same way
 * whichever of the two the running CLI version actually consults for a background dispatch — untested in
 * isolation here (the live proof is the dispatched session's own transcript, not a unit assertion about which
 * key wins), so this errs toward carrying both rather than picking one.
 * @param {{cwd:string, additionalDirectories?:string[], allow?:string[], readFile?:Function, writeFile?:Function, mkdir?:Function}} o
 * @returns {{ok:boolean, path?:string, reason?:string, changed?:boolean}}
 */
export function ensureSettingsFilePermissions({
  cwd, additionalDirectories = [], allow = [], readFile = readFileSync, writeFile = writeFileSync, mkdir = mkdirSync,
}) {
  if (!cwd) return { ok: false, reason: 'no-cwd' };
  const dirs = additionalDirectories.filter(Boolean);
  const rules = allow.filter(Boolean);
  if (!dirs.length && !rules.length) return { ok: true, changed: false }; // nothing to grant — no-op, no write
  const dir = join(cwd, '.claude');
  const path = join(dir, 'settings.local.json');
  try {
    mkdir(dir, { recursive: true });
    let existing;
    try { existing = JSON.parse(readFile(path, 'utf8')); } catch { existing = null; }
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) existing = {};
    const prevPerms = existing.permissions && typeof existing.permissions === 'object' ? existing.permissions : {};
    const prevDirs = Array.isArray(prevPerms.additionalDirectories) ? prevPerms.additionalDirectories : [];
    const prevAllow = Array.isArray(prevPerms.allow) ? prevPerms.allow : [];
    const merged = {
      ...existing,
      permissions: {
        ...prevPerms,
        additionalDirectories: [...new Set([...prevDirs, ...dirs])],
        allow: [...new Set([...prevAllow, ...rules])],
      },
    };
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
 * @param {{env?:NodeJS.ProcessEnv, pathEnv?:string, cachePath?:string, dir?:string, ghThrottleCliPath?:string, cwd?:string,
 *   exists?:Function, writeFile?:Function, chmod?:Function, mkdir?:Function, readFile?:Function}} [o]
 * @returns {Record<string,string>|null}
 */
export function buildGhShimSettingsEnv({
  env = process.env, pathEnv = process.env.PATH || '', cachePath = defaultCachePath(), dir: dirOpt,
  ghThrottleCliPath = defaultGhThrottleCliPath(), cwd, exists, writeFile, chmod, mkdir, readFile,
} = {}) {
  if (!resolveGithubAppEnvConfig(env)) return null; // opt-in — see the module header
  // #4044: THIS checkout's own shim dir by default — never the one machine-wide file every dispatcher rewrote.
  const dir = dirOpt ?? checkoutShimDir({ ghThrottleCliPath });
  const realGhPath = resolveRealGhBinary({ pathEnv, shimDir: dir, exists });
  if (!realGhPath) return null;
  const written = ensureGhShim({ dir, realGhPath, cachePath, ghThrottleCliPath, writeFile, chmod, mkdir });
  if (!written.ok) return null;
  const settingsEnv = { PATH: ghShimPathOverride({ dir, currentPath: pathEnv }) };
  if (cwd) ensureSettingsFileEnv({ cwd, env: settingsEnv, readFile, writeFile, mkdir }); // best-effort, see above
  return settingsEnv;
}
