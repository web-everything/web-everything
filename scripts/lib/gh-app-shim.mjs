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
 * INTERACTIVE OPT-IN (#3866). {@link buildGhShimSettingsEnv} returns `null` — no fs
 * write, no PATH override, a dispatch byte-identical to before this file existed — unless
 * `we:scripts/lib/github-app-auth-env.mjs#resolveGithubAppEnvConfig` says the CALLING process has actually
 * opted into App auth. This is not only architectural tidiness: a process (or a test) that has not configured
 * `WE_GITHUB_APP_*` has no cache worth shadowing `gh` for, so shimming would be pure overhead for zero benefit
 * — and, live-caught the same day on this same item's own status-file follow-up, an unconditional real-fs
 * default is exactly how an unrelated test run ends up writing into a developer's actual home directory.
 * Daemon callers always need a refusal shim, including when App configuration is unavailable; inability
 * to install it throws instead of letting a dispatch omit the auth boundary.
 *
 * NEVER TOUCHES THE PRIVATE KEY. The generated shim only ever reads the shared token CACHE (a short-lived,
 * already-minted installation token). Daemon cache misses delegate minting to the bounded refresh CLI.
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
import { join, resolve, dirname, isAbsolute, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultCachePath, resolveGithubAppEnvConfig } from './github-app-auth-env.mjs';
import {
  OWNER_INSTALLATIONS, MOVED_REPO_OWNERS, canonicalOwner, installationMap, installationForOwner, ownerOfSlug, ownerFromRemoteUrl, ownerFromGhArgv, installationCachePath,
} from './github-app-installations.mjs';
import { readGhAuthPolicy } from './github-auth-policy.mjs';
import { readSettings, SETTINGS_DIR, LEGACY_SETTINGS_PATH } from './settings-files.mjs';
import { primaryCheckout } from '../bootstrap-session.mjs';
import { DEFAULT_CALLER_ROLES, roleForCaller, readDeliveryIdentity, shimRoleTable, ROLE_ENV } from './github-app-identity.mjs';
import { controlClonePath } from './automation-home.mjs';
import { stripGhDebug, rateLimitRecords, ghAuthIdentity } from './gh-throttle.mjs';
import { renderGhResourceClassifier } from './gh-argv.mjs';

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

/**
 * The personal-fallback policy written into a shim. Many processes write one shim dir (it is keyed by
 * `ghThrottleCliPath`, usually the control clone's), so the policy must not depend on the writer: both its
 * tool settings and its platform preference files come from the checkout that owns `ghThrottleCliPath`. A
 * caller's env (WE_GH_AUTH_PERSONAL_FALLBACK, WE_PLATFORM_PREFERENCES_FILE) and the writer's own checkout never
 * reach it. The shim still reads WE_GH_AUTH_PERSONAL_FALLBACK from each caller at run time.
 */
export function shimFallbackPolicy({ ghThrottleCliPath = defaultGhThrottleCliPath() } = {}) {
  const scripts = dirname(dirname(resolve(ghThrottleCliPath)));
  return readGhAuthPolicy({ daemon: true, env: {},
    read: () => readSettings({ dir: join(scripts, basename(SETTINGS_DIR)), legacyPath: join(scripts, basename(LEGACY_SETTINGS_PATH)) }),
    // The platform files are named relative to the reading module; read the owner's files of the same names.
    readFile: (path, encoding) => readFileSync(join(scripts, 'lib', basename(path)), encoding) });
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
    // A relative entry (`.`, `~/bin`) names a different gh in every caller's cwd; the shim is shared.
    if (!isAbsolute(dir)) continue;
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
 * The value-taking options of gh 2.95, read from every native command's `--help`: per command,
 * [its value shorthands, its value long names]. The host guard reads only repository selectors and
 * target positionals as hosts; an option value (`--comment <url>`, `-n <notes>`) is content. Only a
 * (command, option) pair listed here skips its value, so a switch of the same name in another command
 * (`repo edit --template <repo>`, `pr view --comments <url>`) keeps its next argument a target, and an
 * option a newer gh adds is scanned conservatively: drift can cause a refusal, never a missed host.
 * Selectors (-R/--repo, --hostname, --host) and optional-value options (browse -c/--commit) are absent.
 */
export const GH_VALUE_OPTIONS = {
  'agent-task create': ['baF', 'base custom-agent from-file'],
  'agent-task list': ['qLt', 'jq json limit template'],
  'agent-task view': ['qt', 'jq json template'],
  api: ['FHqXpft', 'cache field header input jq method preview raw-field template'],
  'attestation download': ['dLo', 'digest-alg limit owner predicate-type'],
  'attestation trusted-root': ['', 'tuf-root tuf-url'],
  'attestation verify': ['bidqLot', 'bundle cert-identity cert-identity-regex cert-oidc-issuer ' +
    'custom-trusted-root digest-alg format jq limit owner predicate-type signer-digest signer-repo ' +
    'signer-workflow source-digest source-ref template'],
  'auth login': ['phs', 'git-protocol scopes'],
  'auth logout': ['hu', 'user'],
  'auth refresh': ['hrs', 'remove-scopes scopes'],
  'auth setup-git': ['fh', 'force'],
  'auth status': ['h', 'jq json template'],
  'auth switch': ['hu', 'user'],
  'auth token': ['hu', 'user'],
  browse: ['b', 'branch'],
  'cache delete': ['r', 'ref succeed-on-no-caches'],
  'cache list': ['qkLOrSt', 'jq json key limit order ref sort template'],
  'codespace code': ['c', 'codespace repo-owner'],
  'codespace cp': ['cp', 'codespace profile repo-owner'],
  'codespace create': ['bdlm', 'branch devcontainer-path display-name idle-timeout location machine ' +
    'retention-period'],
  'codespace delete': ['cou', 'codespace days org repo-owner user'],
  'codespace edit': ['cdm', 'codespace display-name machine repo-owner'],
  'codespace jupyter': ['c', 'codespace repo-owner'],
  'codespace list': ['qLotu', 'jq json limit org template user'],
  'codespace logs': ['c', 'codespace repo-owner'],
  'codespace ports': ['cqt', 'codespace jq json repo-owner template'],
  'codespace rebuild': ['c', 'codespace repo-owner'],
  'codespace ssh': ['c', 'codespace debug-file profile repo-owner server-port'],
  'codespace stop': ['cou', 'codespace org repo-owner user'],
  'codespace view': ['cqt', 'codespace jq json repo-owner template'],
  completion: ['s', 'shell'],
  'discussion comment': ['bF', 'body body-file'],
  'discussion create': ['bFclt', 'body body-file category label title'],
  'discussion edit': ['bFct', 'add-label body body-file category remove-label title'],
  'discussion list': ['AcqlLSst', 'after author category jq json label limit order search sort state template'],
  'discussion view': ['qLt', 'after jq json limit order template'],
  'extension create': ['', 'precompiled'],
  'extension install': ['', 'pin'],
  'extension search': ['qLt', 'jq json license limit order owner sort template'],
  'gist create': ['df', 'desc filename'],
  'gist edit': ['adfr', 'add desc filename remove'],
  'gist list': ['L', 'filter limit'],
  'gist view': ['f', 'filename'],
  'gpg-key add': ['t', 'title'],
  'issue close': ['cr', 'comment duplicate-of reason'],
  'issue comment': ['bF', 'body body-file'],
  'issue create': ['abFlmpTt', 'assignee blocked-by blocking body body-file label milestone parent project ' +
    'recover template title type'],
  'issue develop': ['bn', 'base branch-repo name'],
  'issue edit': ['bFmt', 'add-assignee add-blocked-by add-blocking add-label add-project add-sub-issue body ' +
    'body-file milestone parent remove-assignee remove-blocked-by remove-blocking remove-label remove-project ' +
    'remove-sub-issue title type'],
  'issue list': ['aAqlLmSst', 'app assignee author jq json label limit mention milestone search state template ' +
    'type'],
  'issue lock': ['r', 'reason'],
  'issue reopen': ['c', 'comment'],
  'issue status': ['qt', 'jq json template'],
  'issue view': ['qt', 'jq json template'],
  'label create': ['cd', 'color description'],
  'label edit': ['cdn', 'color description name'],
  'label list': ['qLSt', 'jq json limit order search sort template'],
  'org list': ['L', 'limit'],
  'pr checkout': ['b', 'branch'],
  'pr checks': ['iqt', 'interval jq json template'],
  'pr close': ['c', 'comment'],
  'pr comment': ['bF', 'body body-file'],
  'pr create': ['aBbFHlmprTt', 'assignee base body body-file head label milestone project recover reviewer ' +
    'template title'],
  'pr diff': ['e', 'color exclude'],
  'pr edit': ['BbFmt', 'add-assignee add-label add-project add-reviewer base body body-file milestone ' +
    'remove-assignee remove-label remove-project remove-reviewer title'],
  'pr list': ['aABHqlLSst', 'app assignee author base head jq json label limit search state template'],
  'pr lock': ['r', 'reason'],
  'pr merge': ['AbFt', 'author-email body body-file match-head-commit subject'],
  'pr reopen': ['c', 'comment'],
  'pr revert': ['bFt', 'body body-file title'],
  'pr review': ['bF', 'body body-file'],
  'pr status': ['qt', 'jq json template'],
  'pr view': ['qt', 'jq json template'],
  'project close': ['qt', 'format jq owner template'],
  'project copy': ['qt', 'format jq source-owner target-owner template title'],
  'project create': ['qt', 'format jq owner template title'],
  'project delete': ['qt', 'format jq owner template'],
  'project edit': ['dqt', 'description format jq owner readme template title visibility'],
  'project field-create': ['qt', 'data-type format jq name owner single-select-options template'],
  'project field-delete': ['qt', 'format id jq template'],
  'project field-list': ['qLt', 'format jq limit owner template'],
  'project item-add': ['qt', 'format jq owner template url'],
  'project item-archive': ['qt', 'format id jq owner template'],
  'project item-create': ['qt', 'body format jq owner template title'],
  'project item-delete': ['qt', 'format id jq owner template'],
  'project item-edit': ['qt', 'body date field-id format id iteration-id jq number project-id ' +
    'single-select-option-id template text title'],
  'project item-list': ['qLt', 'format jq limit owner query template'],
  'project link': ['T', 'owner team'],
  'project list': ['qLt', 'format jq limit owner template'],
  'project mark-template': ['qt', 'format jq owner template'],
  'project unlink': ['T', 'owner team'],
  'project view': ['qt', 'format jq owner template'],
  'release create': ['nFt', 'discussion-category notes notes-file notes-start-tag target title'],
  'release download': ['ADOp', 'archive dir output pattern'],
  'release edit': ['nFt', 'discussion-category notes notes-file tag target title'],
  'release list': ['qLOt', 'jq json limit order template'],
  'release verify': ['qt', 'format jq template'],
  'release verify-asset': ['qt', 'format jq template'],
  'release view': ['qt', 'jq json template'],
  'repo autolink list': ['qt', 'jq json template'],
  'repo autolink view': ['qt', 'jq json template'],
  'repo clone': ['u', 'upstream-remote-name'],
  'repo create': ['dghlrstp', 'description gitignore homepage license remote source team template'],
  'repo deploy-key add': ['t', 'title'],
  'repo deploy-key list': ['qt', 'jq json template'],
  'repo edit': ['dh', 'add-topic default-branch description homepage remove-topic squash-merge-commit-message ' +
    'visibility'],
  'repo fork': ['', 'fork-name org remote-name'],
  'repo list': ['qlLt', 'jq json language limit template topic visibility'],
  'repo read-dir': ['qt', 'jq json ref template'],
  'repo read-file': ['qot', 'jq json output ref template'],
  'repo sync': ['bs', 'branch source'],
  'repo view': ['bqt', 'branch jq json template'],
  'ruleset list': ['Lo', 'limit org'],
  'ruleset view': ['o', 'org'],
  'run download': ['Dnp', 'dir name pattern'],
  'run list': ['bceqLstuw', 'branch commit created event jq json limit status template user workflow'],
  'run rerun': ['j', 'job'],
  'run view': ['ajqt', 'attempt job jq json template'],
  'run watch': ['i', 'interval'],
  'search code': ['qLt', 'extension filename jq json language limit match owner size template'],
  'search commits': ['qLt', 'author author-date author-email author-name committer committer-date committer-email ' +
    'committer-name hash jq json limit order owner parent sort template tree visibility'],
  'search issues': ['qLt', 'app assignee author closed commenter comments created interactions involves jq json ' +
    'label language limit match mentions milestone order owner project reactions sort state team-mentions ' +
    'template updated visibility'],
  'search prs': ['BHqLt', 'app assignee author base checks closed commenter comments created head interactions ' +
    'involves jq json label language limit match mentions merged-at milestone order owner project reactions ' +
    'review review-requested reviewed-by sort state team-mentions template updated visibility'],
  'search repos': ['qLt', 'created followers forks good-first-issues help-wanted-issues include-forks jq json ' +
    'language license limit match number-topics order owner size sort stars template topic updated visibility'],
  'secret delete': ['aeo', 'app env org'],
  'secret list': ['aeqot', 'app env jq json org template'],
  'secret set': ['abeforv', 'app body env env-file org visibility'],
  'skill install': ['', 'agent dir pin scope'],
  'skill list': ['qt', 'agent dir jq json scope template'],
  'skill publish': ['', 'tag'],
  'skill search': ['qLt', 'jq json limit owner page template'],
  'skill update': ['', 'dir'],
  'ssh-key add': ['t', 'title type'],
  status: ['eo', 'exclude org'],
  'variable delete': ['eo', 'env org'],
  'variable get': ['eqot', 'env jq json org template'],
  'variable list': ['eqot', 'env jq json org template'],
  'variable set': ['beforv', 'body env env-file org visibility'],
  'workflow list': ['qLt', 'jq json limit template'],
  'workflow run': ['Ffr', 'field raw-field ref'],
  'workflow view': ['r', 'ref'],
};

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

/** PURE, inlined into the standalone shim. */
export function isDaemonCaller(env = {}) {
  return Boolean(env.WE_GH_DAEMON_CALLER)
    || /^(com\.we\.|com\.plateau\.)/.test(String(env.XPC_SERVICE_NAME || ''));
}

/** Use the same stable checkout selection as the throttle CLI. */
export function defaultGithubAppRefreshCliPath(options) {
  return join(dirname(defaultGhThrottleCliPath(options)), 'github-app-refresh-cli.mjs');
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
 * back to whatever auth was already in effect for interactive callers. Daemons refuse this fallback unless
 * `ghAuth.personalFallback=allow` or inherited auth has matching App-token provenance. An interactive session with
 * no App auth configured keeps its existing behavior. Every other outcome (success, or a failure unrelated to the token)
 * passes the same bytes and exit code through — but BUFFERED, not streamed: on the tokened path gh sees a
 * pipe, not a TTY, so color/pager/live-progress differ from a direct call (harmless for a non-TTY dispatched
 * session; an interactive operator run is the known gap, PR #2600 review). With no cached token at all the
 * interactive inherited-auth call runs unchanged. A daemon tries the refresh CLI once before refusing.
 *
 * #4064 — BOTH real-`gh` invocations below (the tokened attempt and the inherited-auth fallback) run through
 * `we:scripts/lib/gh-throttle.mjs`'s own standalone CLI (`GH_THROTTLE_CLI`, baked in at generation time exactly
 * like `REAL_GH` — never a repo-relative `require`, same independence contract as the rest of this script)
 * rather than execing `REAL_GH` directly, so every dispatched session's `gh` call is now BOTH on the App login
 * AND paced by that module's cross-process concurrency cap + rate-limit backoff — with no per-call-site
 * migration needed, unlike that module's other adopters. `WE_GH_THROTTLE_GH_BIN` tells that CLI to exec
 * `REAL_GH` directly instead of searching `PATH` for a bare `gh` — which would otherwise resolve back through
 * THIS shim's own `PATH` override and recurse forever.
 * PER-ROLE APPS (we:scripts/lib/github-app-identity.mjs): `roleTable` ({role: {cachePath, installations}}, one entry per
 * CONFIGURED role) is baked in; each call picks its role from `WE_GITHUB_APP_ROLE`, else the caller map, else worker,
 * and tries role → worker → today's App. Any step down is written to stderr — never silent. An empty table (nothing
 * configured) leaves the shim behaving exactly as before.
 * @param {{realGhPath:string, cachePath:string, ghThrottleCliPath?:string, roleTable?:object, callerRoles?:object}} o
 * @returns {string}
 */
export function renderGhShimScript({ realGhPath, cachePath, ghThrottleCliPath = defaultGhThrottleCliPath(),
  // Like the policy, the refresh CLI belongs to the checkout that owns the shim, not the writer.
  refreshCliPath = join(dirname(ghThrottleCliPath), 'github-app-refresh-cli.mjs'), personalFallbackPolicy = shimFallbackPolicy({ ghThrottleCliPath }),
  roleTable = {}, callerRoles = DEFAULT_CALLER_ROLES }) {
  return `#!/usr/bin/env node
// AUTO-GENERATED by we:scripts/lib/gh-app-shim.mjs — regenerated on every dispatch; do not edit by hand.
// A transparent \`gh\` pass-through that reads the shared GitHub App token cache FRESH on every call (#x8mpubm),
// so a dispatched session's gh calls keep authenticating as the App installation for as long as the shared
// cache stays fresh, however long the session itself runs — never a one-time value stale after ~1h. If the
// cached token gets rejected, invalidate its cache. Daemons refuse inherited personal auth; interactive
// callers retain their existing retry behavior (#x8mpubm review-2582).
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
// Per-role Apps: {role: {cachePath, installations}} for each CONFIGURED role; empty = today's App only.
const ROLE_IDENTITIES = ${JSON.stringify(roleTable ?? {})};
const CALLER_ROLES = ${JSON.stringify(callerRoles ?? {})};
const GH_VALUE_OPTIONS = ${JSON.stringify(GH_VALUE_OPTIONS)};
${roleForCaller.toString()}
const REFRESH_BUFFER_MS = ${JSON.stringify(SHIM_REFRESH_BUFFER_MS)};
const GH_THROTTLE_CLI = ${JSON.stringify(ghThrottleCliPath)};
const APP_REFRESH_CLI = ${JSON.stringify(refreshCliPath)};
const PERSONAL_FALLBACK_POLICY = ${JSON.stringify(personalFallbackPolicy)};
${isDaemonCaller.toString()}
const DAEMON = isDaemonCaller(process.env);
const DAEMON_CALLER = process.env.WE_GH_DAEMON_CALLER || process.env.XPC_SERVICE_NAME || 'unknown';
const runtimeFallback = String(process.env.WE_GH_AUTH_PERSONAL_FALLBACK || '').trim().toLowerCase();
const fallbackOverridden = ['allow', 'refuse'].includes(runtimeFallback);
const personalFallback = fallbackOverridden ? runtimeFallback : PERSONAL_FALLBACK_POLICY.personalFallback;
const personalFallbackSource = fallbackOverridden ? 'env' : PERSONAL_FALLBACK_POLICY.source.personalFallback;
let tokenMisses = [];

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
${renderGhResourceClassifier()}
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
// One App's fresh token for \`owner\`: \`entry.installations\` null = today's App (owner map + legacy single cache).
function tokenFrom(entry, owner) {
  if (!owner) {
    const c = readFreshCache(entry.cachePath);
    return c ? { cached: c, used: entry.cachePath } : { miss: 'no fresh token cached' };
  }
  const id = entry.installations
    ? (Object.prototype.hasOwnProperty.call(entry.installations, String(owner).toLowerCase()) ? entry.installations[String(owner).toLowerCase()] : null)
    : installationForOwner(owner, process.env);
  if (!id) return { miss: 'no installation for owner ' + owner, noInstallation: true };
  const path = installationCachePath(entry.cachePath, id);
  const c = readFreshCache(path);
  if (c) return { cached: c, used: path };
  if (!entry.installations) {
    // Not minted yet for this owner: the legacy single cache still serves it when it holds THIS installation.
    const legacy = readFreshCache(CACHE_PATH);
    if (legacy && (legacy.installationId == null || String(legacy.installationId) === String(id))) return { cached: legacy, used: CACHE_PATH };
  }
  return { miss: 'no fresh token cached' };
}
function requestedRole(env) {
  const r = String(env.WE_GITHUB_APP_ROLE || '').trim().toLowerCase();
  return r || roleForCaller(CALLER, CALLER_ROLES) || 'worker';
}
function freshCachedToken() {
  const owner = targetOwner(process.argv.slice(2), process.env);
  const role = requestedRole(process.env);
  const loud = Object.keys(ROLE_IDENTITIES).length > 0;
  const chain = [];
  if (ROLE_IDENTITIES[role]) chain.push([role, ROLE_IDENTITIES[role]]);
  if (role !== 'worker' && ROLE_IDENTITIES.worker) chain.push(['worker', ROLE_IDENTITIES.worker]);
  chain.push(['legacy', { cachePath: CACHE_PATH, installations: null }]);
  const misses = loud && !ROLE_IDENTITIES[role] ? [role + ': unconfigured'] : [];
  for (const [name, entry] of chain) {
    const r = tokenFrom(entry, owner);
    if (r.cached) {
      if (loud && name !== role) {
        process.stderr.write('gh-shim: GitHub App role "' + role + '" unavailable (' + misses.join('; ') + ') - using the ' + name + ' App for this call\\n');
      }
      usedCachePath = r.used;
      cachedInstallationId = r.cached.installationId ?? null;
      return r.cached.token;
    }
    if (!DAEMON && name === 'legacy' && r.noInstallation) {
      process.stderr.write('gh-shim: no GitHub App installation is configured for owner "' + owner + '" - using personal auth for this call\\n');
    }
    misses.push(name + ': ' + r.miss);
  }
  tokenMisses = misses;
  if (!DAEMON && loud) process.stderr.write('gh-shim: no App token for role "' + role + '" (' + misses.join('; ') + ') - using personal auth for this call\\n');
  return null;
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
function runInherited(env, reason) {
  const inheritedApp = DAEMON && !unsupportedHost && env.GH_TOKEN && env.WE_GH_AUTH_TOKEN_HASH === createHash('sha256').update(env.GH_TOKEN).digest('hex');
  if (DAEMON) {
    if (!inheritedApp) {
      const detail = ' for daemon caller "' + DAEMON_CALLER + '" (role ' + requestedRole(env)
        + ', owner ' + (targetOwner(process.argv.slice(2), env) || 'unknown') + '): '
        + (reason || tokenMisses.join('; ') || 'no fresh token cached')
        + '; ghAuth.personalFallback=' + personalFallback + ' (source: ' + personalFallbackSource + ')';
      if (personalFallback === 'refuse') {
        process.stderr.write('gh-shim: REFUSING personal-auth fallback' + detail + '\\n');
        process.exitCode = 1;
        return;
      }
      process.stderr.write('gh-shim: personal-auth fallback allowed' + detail + '\\n');
    }
  }
  // #4064: was a direct \`spawnSync(REAL_GH, ..., {stdio:'inherit'})\` — now routed through the SAME throttled
  // hop as the tokened path below (stdout/stderr captured then relayed, never \`process.exit()\`'d past — see
  // the block comment above), so the concurrency cap still applies on the no-cached-token fallback too.
  const result = runThrottled(inheritedApp ? appTokenArgv(process.argv.slice(2)) : process.argv.slice(2), env);
  if (result.error) {
    process.stderr.write(String(result.error && result.error.message || result.error) + '\\n');
    process.exitCode = 1;
    return;
  }
  if (result.stdout && result.stdout.length) process.stdout.write(result.stdout);
  if (result.stderr && result.stderr.length) process.stderr.write(result.stderr);
  process.exitCode = result.status == null ? 1 : result.status;
}

// \`gh auth status\` also validates every stored account (TokenForUser) and every configured host
// unless --active and --hostname narrow it. A daemon spending App credentials checks only the active
// github.com token, which GH_TOKEN supplies. Placed after every flag (but before a \`--\`) so a user's
// --active=false cannot win.
function appTokenArgv(argv) {
  if (!DAEMON || argv[0] !== 'auth' || argv[1] !== 'status') return argv;
  const end = argv.indexOf('--') === -1 ? argv.length : argv.indexOf('--');
  return [...argv.slice(0, end), '--active', '--hostname', 'github.com', ...argv.slice(end)];
}

// These Apps and their provenance are scoped to github.com. Enterprise gh selects a different
// credential family (or a stored login), so a GH_TOKEN hash cannot authorize that execution.
// Check every host hint conservatively, including remotes and URLs, before using ANY App cache.
function unsupportedTargetHost(argv, env) {
  const publicHost = (host) => String(host).toLowerCase() === 'github.com';
  // gh expands aliases/extensions after our check. Their hidden flags cannot establish App provenance.
  const nativeCommands = ['alias', 'api', 'attestation', 'auth', 'browse', 'cache', 'codespace', 'cs', 'completion',
    'config', 'extension', 'ext', 'gist', 'gpg-key', 'help', 'issue', 'label', 'org', 'pr', 'project', 'release',
    'repo', 'ruleset', 'run', 'search', 'secret', 'ssh-key', 'status', 'variable', 'workflow'];
  if (argv[0] && !argv[0].startsWith('-') && !nativeCommands.includes(argv[0])) return 'unknown command or alias';
  // cobra finds each command level after skipping options (and the next argument of an option it does
  // not know) and empty arguments: \`repo --json name view x\` and \`'' repo view x\` both run repo view.
  // The checks below read the command from fixed positions, so only a leading command word classifies it.
  if ((argv[0] === '' || argv[0]?.startsWith('-')) && argv.length > 1) return 'ambiguous command';
  if (!['api', 'browse', 'completion', 'help', 'status'].includes(argv[0]) && argv.length > 1
    && (argv[1] === '' || argv[1].startsWith('-'))) return 'ambiguous command';
  if (['extension', 'ext'].includes(argv[0]) && argv[1] === 'exec') return 'extension execution';
  // Other auth commands read, write or validate stored per-account credentials (git-credential also
  // takes its host from stdin). \`auth status\` is pinned to the active App token by appTokenArgv.
  if (argv[0] === 'auth' && argv[1] !== undefined && !['status', 'token'].includes(argv[1])) return 'auth ' + argv[1] + ' uses stored credentials';
  // \`auth token\` prints the active (App env) token; --user and the hidden --secure-storage read the
  // keyring instead. Allow only the hostname flag, whose value the scan below checks.
  if (argv[0] === 'auth' && argv[1] === 'token') {
    for (let i = 2; i < argv.length; i++) {
      if (argv[i] === '-h' || argv[i] === '--hostname') i++;
      else if (!/^-h|^--hostname=/.test(argv[i])) return 'auth token ' + argv[i] + ' reads stored credentials';
    }
  }
  const repoHost = (value, api = false) => {
    const s = String(value || '');
    if (/^[a-z][a-z0-9+.-]*:[/][/]/i.test(s)) {
      try {
        const host = new URL(s).hostname.toLowerCase();
        // WHATWG URLs normalize Unicode/percent encodings and default ports; gh's host-keyed
        // credential lookup need not. Only a literal public authority proves the same host.
        const authority = s.slice(s.indexOf('://') + 3).split('/')[0].split('?')[0].split('#')[0].toLowerCase();
        if (authority !== host) return 'ambiguous URL host';
        return (publicHost(host) || (api && host === 'api.github.com')) ? null : host;
      } catch { return 'invalid URL'; }
    }
    const scp = /^(?:[^@/]+@)?([^/:]+):[^/]/.exec(s);
    if (scp) return publicHost(scp[1]) ? null : scp[1];
    const parts = s.split('/');
    if (parts.length >= 3) return publicHost(parts[0]) ? null : parts[0];
    return null;
  };
  if (env.GH_HOST && !publicHost(env.GH_HOST)) return String(env.GH_HOST);
  if (env.GH_REPO) { const host = repoHost(env.GH_REPO); if (host) return host; }
  // Only target-bearing positions are URLs. A comment body/title/header may contain any URL.
  // Native search and extension search positionals are query text.
  const targetCommand = argv[0] !== 'search' && !(['extension', 'ext'].includes(argv[0]) && argv[1] === 'search');
  const valueFlags = new Set();
  // Short names change arity between commands: checkout -q/-f and merge -m/-s/-a are booleans.
  // Exempt content values only where their consuming option is known; uncertain URL arguments refuse.
  // Built-in aliases have the same argument arity and target positions as their commands.
  const subcommand = ({ new: 'create', ls: 'list', co: 'checkout', uninstall: 'remove' })[argv[1]]
    || (['secret', 'variable'].includes(argv[0]) && argv[1] === 'remove' ? 'delete' : argv[1]);
  const top = ({ cs: 'codespace', ext: 'extension' })[argv[0]] || argv[0];
  const command = top + ' ' + subcommand;
  // Option values are content, never targets (--comment <url>, --notes, --description). Only this
  // command's own value options skip their value: a switch of the same name elsewhere keeps its next
  // argument a positional (repo edit --template <repo>). Three-level commands use the deepest key.
  const commandKeys = [command + ' ' + (({ ls: 'list' })[argv[2]] || argv[2]), command, top];
  const valueOptions = commandKeys.map((key) => GH_VALUE_OPTIONS[key]).find(Boolean) || ['', ''];
  for (const name of valueOptions[1].split(' ').filter(Boolean)) valueFlags.add('--' + name);
  if (argv[0] === 'api') for (const flag of ['-F', '-f', '-H', '-X', '-q', '-t']) valueFlags.add(flag);
  if (['pr create', 'pr edit', 'pr merge', 'issue create', 'issue edit'].includes(command)) {
    for (const flag of ['-b', '-F', '-t']) valueFlags.add(flag);
  }
  if (['pr comment', 'pr review', 'issue comment'].includes(command)) {
    for (const flag of ['-b', '-F']) valueFlags.add(flag);
  }
  if (['pr view', 'pr list', 'pr status', 'pr checks', 'issue view', 'issue list', 'issue status', 'repo view'].includes(command)) {
    for (const flag of ['-q', '-t']) valueFlags.add(flag);
  }
  if (command === 'workflow run') for (const flag of ['-f', '-F']) valueFlags.add(flag);
  if (['pr list', 'issue list'].includes(command)) valueFlags.add('-S');
  const repositoryContentFlags = {
    'repo clone': ['-o', '--origin', '-u', '--upstream-remote-name'],
    'repo create': ['-d', '--description', '-h', '--homepage', '-g', '--gitignore', '-l', '--license',
      '-r', '--remote', '-s', '--source', '-t', '--team'],
    'repo edit': ['--add-topic', '--default-branch', '-d', '--description', '-h', '--homepage',
      '--remove-topic', '--squash-merge-commit-message', '--visibility'],
    'repo fork': ['--fork-name', '--org', '--remote-name'],
    'repo sync': ['-b', '--branch'],
    'repo view': ['-b', '--branch'],
  }[command] || [];
  for (const flag of repositoryContentFlags) valueFlags.add(flag);
  // The positionals gh parses as [HOST/]OWNER/REPO (ghrepo.FromFullName). Every other positional is a
  // local path, branch, tag or name, so a dotted directory like build.v1/app.tar.gz selects no host.
  const repositoryPositionals = (argv[0] === 'repo' && ['archive', 'clone', 'create', 'credits', 'delete', 'edit',
    'fork', 'garden', 'rename', 'set-default', 'sync', 'unarchive', 'view'].includes(subcommand))
    || ['label clone', 'extension install', 'ext install', 'issue transfer'].includes(command);
  if (['extension install', 'ext install'].includes(command)) valueFlags.add('--pin');
  // --template is output content elsewhere, but repo create uses it as a source repository.
  const repositoryFlags = {
    'repo create': ['--template', '-p'], 'repo sync': ['--source', '-s'], 'issue develop': ['--branch-repo'],
    'secret set': ['--repos', '-r'], 'variable set': ['--repos', '-r'],
  }[command] || [];
  // --repos takes a comma-separated list; each entry may name its own host.
  const repoValueHost = (value) => String(value ?? '').split(',').map((part) => repoHost(part.trim())).find(Boolean) || null;
  // Only advance over known boolean shorthands. An unknown shorthand may consume the
  // rest of the argument as content (-fR=... is a workflow field, not a repo selector).
  const booleanShorthands = {
    'pr view': 'cw', 'issue view': 'cw', 'repo view': 'w',
    'pr list': 'dw', 'issue list': 'w', 'pr status': 'c', 'pr create': 'defw', 'issue create': 'ew', 'pr checks': 'w',
    'pr checkout': 'f', 'pr merge': 'admrs', 'pr comment': 'cew', 'issue comment': 'cew',
    'pr close': 'd', 'pr diff': 'w', 'pr ready': 'u', 'pr review': 'acr', 'pr update-branch': 'r',
    'pr revert': 'd',
    'issue delete': 'y', 'issue develop': 'cl',
    'repo create': 'ci', 'repo sync': 'f', 'repo fork': 'cr',
    'repo archive': 'y', 'repo unarchive': 'y', 'repo delete': 'y', 'repo deploy-key': 'w',
    'repo rename': 'y', 'repo autolink': 'nw',
    'release create': 'dp', 'release delete': 'cy', 'release delete-asset': 'y', 'release upload': 'c', 'release view': 'w',
    'run list': 'a', 'run view': 'evw', 'run watch': 'e', 'run rerun': 'df',
    'workflow list': 'a', 'workflow view': 'wy', 'cache delete': 'a',
    'label create': 'f', 'label clone': 'f', 'label delete': 'y', 'label list': 'w',
    'ruleset check': 'w', 'ruleset list': 'pw', 'ruleset view': 'pw',
    'codespace code': 'w', 'codespace cp': 'er', 'codespace create': 'sw',
    'codespace delete': 'f', 'codespace list': 'w', 'codespace logs': 'f', 'codespace ssh': 'd',
    'secret set': 'u', 'secret list': 'u', 'secret delete': 'u',
    'search code': 'w', 'search commits': 'w', 'search issues': 'w', 'search prs': 'w', 'search repos': 'w',
    'auth status': 'at',
  }[command] || (argv[0] === 'browse' ? 'anprsw' : '');
  // Value shorthands (GH_VALUE_OPTIONS): inside a bundle they take the rest as content
  // (-BRelease/a/b is a base branch). Any shorthand in neither table is uncertain.
  // Optional-value shorthands (browse -c, \`--commit[=last]\`) never take the rest or the
  // next argument, so they are absent from that table and scanned as uncertain.
  const valueShorthands = valueOptions[0];
  // After \`--\` gh reads -x/o/r as a repository argument, unless pflag took the \`--\` as the value of an
  // option (\`pr list --app -- -R x/o/r\` still parses -R). Check both readings: every later argument is
  // a positional here, and the option scan below still runs over all of them.
  const dashDash = argv.indexOf('--');
  if (targetCommand && dashDash !== -1) {
    for (const a of argv.slice(dashDash + 1)) {
      if (repositoryPositionals || /^[a-z][a-z0-9+.-]*:[/][/]/i.test(a)) {
        const host = repoHost(a, argv[0] === 'api');
        if (host) return host;
      }
    }
  }
  let cloneSourceSeen = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // pflag permits boolean bundles before a value flag: -cRhost/o/r, -fsHOST/o/r, -ahHOST.
    // A known content flag consumes the remainder, so -bRhost/o/r stays body text.
    // An unknown shorthand may be a boolean (-qRhost/o/r selects host) or a value option (the rest
    // is content). Check both readings: a later selector still refuses its host, but no following
    // argument is skipped as a value, so -q -R host/o/r and -qR host/o/r are both scanned.
    if (a.startsWith('-') && !a.startsWith('--')) {
      let consumed = false;
      let uncertain = false;
      for (let j = 1; j < a.length; j++) {
        const flag = '-' + a[j];
        const attached = j + 1 < a.length;
        const nextValue = () => (uncertain ? argv[i + 1] : argv[++i]);
        if (flag === '-R' || repositoryFlags.includes(flag)) {
          const value = attached ? a.slice(j + 1).replace(/^=/, '') : nextValue();
          const host = repoValueHost(value);
          if (host) return host;
          consumed = !uncertain;
          break;
        }
        // auth -h is --hostname and config -h is --host. pflag takes the next argument as its value
        // even when it starts with -.
        if ((argv[0] === 'auth' || argv[0] === 'config') && flag === '-h') {
          const host = attached ? a.slice(j + 1).replace(/^=/, '') : nextValue();
          if (!publicHost(host ?? '')) return host || 'unknown';
          consumed = !uncertain;
          break;
        }
        if (valueFlags.has(flag) || valueShorthands.includes(a[j])) {
          if (!attached && !uncertain) i++;
          consumed = !uncertain;
          break;
        }
        if (!booleanShorthands.includes(a[j])) uncertain = true;
      }
      if (consumed) continue;
    }
    const repositoryFlag = repositoryFlags.find((flag) => a === flag || a.startsWith(flag + '='));
    if (repositoryFlag) {
      const value = a === repositoryFlag ? argv[++i] : a.slice(repositoryFlag.length).replace(/^=/, '');
      const host = repoValueHost(value);
      if (host) return host;
      continue;
    }
    if (valueFlags.has(a)) { i++; continue; }
    if (a === '--hostname' || a === '--host') {
      const host = argv[++i];
      if (!publicHost(host ?? '')) return host || 'unknown';
      continue;
    }
    if (a.startsWith('--hostname=') || a.startsWith('--host=')) {
      const host = a.slice(a.indexOf('=') + 1);
      if (!publicHost(host)) return host || 'unknown';
      continue;
    }
    if (a === '--repo') { const host = repoHost(argv[++i]); if (host) return host; continue; }
    if (a.startsWith('--repo=')) { const host = repoHost(a.slice(7)); if (host) return host; continue; }
    // Repository arguments also accept single-label host/owner/repo and SCP syntax. A
    // clone's second positional is a local directory; asset paths, branch names and relative
    // API endpoints likewise do not select a host. Keep scanning URLs after unknown flags.
    const repositoryTarget = repositoryPositionals && i > 1 && !a.startsWith('-')
      && (command !== 'repo clone' || !cloneSourceSeen);
    if (repositoryTarget && command === 'repo clone') cloneSourceSeen = true;
    if (targetCommand && !a.startsWith('-') && (repositoryTarget || /^[a-z][a-z0-9+.-]*:[/][/]/i.test(a))) {
      const host = repoHost(a, argv[0] === 'api');
      if (host) return host;
    }
  }
  try {
    const remotes = spawnSync('/usr/bin/git', ['remote', '-v'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 });
    if (remotes.error) return 'unreadable git remotes';
    for (const line of String(remotes.stdout || '').split('\\n')) {
      const url = line.trim().split(/\\s+/)[1];
      if (url) { const host = repoHost(url); if (host) return host; }
    }
  } catch { return 'unreadable git remotes'; }
  // gh may use a configured enterprise host as its implicit default. Parse only the simple
  // public-host-only shape; ambiguous YAML or unreadable config cannot prove public provenance.
  if (!env.GH_HOST) {
    const configDir = env.GH_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config'), 'gh');
    try {
      const hosts = readFileSync(join(configDir, 'hosts.yml'), 'utf8');
      const keys = hosts.split('\\n').filter((line) => line.trim() && !/^\\s|^#|^---\\s*$/.test(line));
      if (!keys.length && hosts.split('\\n').some((line) => line.trim() && !/^\\s*(?:#.*|---)?$/.test(line))) return 'ambiguous gh hosts';
      if (keys.some((line) => !/^(?:github[.]com|"github[.]com"|'github[.]com'):\\s*(?:#.*)?$/.test(line))) return 'unsupported configured host';
    } catch (e) { if (e.code !== 'ENOENT') return 'unreadable gh hosts'; }
  }
  return null;
}
const unsupportedHost = DAEMON ? unsupportedTargetHost(process.argv.slice(2), process.env) : null;
let token = unsupportedHost ? null : freshCachedToken();
if (!token && DAEMON && !unsupportedHost) {
  // One bounded synchronous mint attempt, then one cache re-read. CLI output never reaches the caller.
  try {
    if (existsSync(APP_REFRESH_CLI)) {
      const refreshed = spawnSync(process.execPath, [APP_REFRESH_CLI, '--role=' + requestedRole(process.env)], {
        env: process.env, stdio: 'ignore', timeout: 90000,
      });
      if (!refreshed.error && refreshed.status === 0) token = freshCachedToken();
    }
  } catch { /* missing/broken refresh always reaches the refusal guard */ }
}
// A reader that closed early (\`gh … | head\`) must not turn a deferred write into an unhandled EPIPE stack trace.
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
if (!token) {
  runInherited(process.env, unsupportedHost ? 'unsupported GitHub host (' + unsupportedHost + ')' : undefined);
} else {
  const withToken = runThrottled(appTokenArgv(process.argv.slice(2)), Object.assign({}, process.env, { GH_TOKEN: token }));
  if (withToken.error) {
    process.stderr.write(String(withToken.error.message || withToken.error) + '\\n');
    process.exitCode = 1;
  } else {
    const stderrText = withToken.stderr ? withToken.stderr.toString('utf8') : '';
    if (withToken.status !== 0 && looksLikeAppTokenAuthFailure(stderrText)) {
      invalidateSharedCache();
      runInherited(process.env, 'App token rejected (HTTP 401 / Bad credentials)'); // guarded inherited-auth retry
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
  writeFile = writeFileSync, chmod = chmodSync, mkdir = mkdirSync, roleTable = {}, callerRoles = DEFAULT_CALLER_ROLES,
  refreshCliPath, personalFallbackPolicy,
  // #4044: the real write is ATOMIC (temp file + rename) — this one file is rewritten on every dispatch while
  // other processes exec it, and an in-place truncate-then-write could hand a concurrent `gh` a torn script.
  // An injected `writeFile` (tests) with no injected `rename` keeps the direct single write they assert on.
  rename = writeFile === writeFileSync ? renameSync : null,
} = {}) {
  if (!realGhPath) return { ok: false, reason: 'no-real-gh' };
  try {
    mkdir(dir, { recursive: true });
    const path = shimGhPath(dir);
    const src = renderGhShimScript({ realGhPath, cachePath, ghThrottleCliPath, roleTable, callerRoles, refreshCliPath, personalFallbackPolicy });
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
 * Daemon callers throw on a missing real `gh` or a failed shim write: omitting the settings would
 * lose the refusal boundary. Interactive callers retain the best-effort null result.
 * @param {{env?:NodeJS.ProcessEnv, pathEnv?:string, cachePath?:string, dir?:string, ghThrottleCliPath?:string, cwd?:string,
 *   exists?:Function, writeFile?:Function, chmod?:Function, mkdir?:Function, readFile?:Function}} [o]
 * @returns {Record<string,string>|null}
 */
export function buildGhShimSettingsEnv({
  env = process.env, pathEnv = process.env.PATH || '', cachePath = defaultCachePath(), dir: dirOpt,
  ghThrottleCliPath = defaultGhThrottleCliPath(), cwd, exists, writeFile, chmod, mkdir, readFile, identity,
} = {}) {
  // Per-role Apps: the shim bakes every configured role's cache + installations (empty when none is configured).
  let id = identity;
  if (!id) { try { id = readDeliveryIdentity({ env }); } catch { id = null; } }
  if (!resolveGithubAppEnvConfig(env) && !id?.anyConfigured && !isDaemonCaller(env)) return null;
  const roleTable = shimRoleTable({ identity: id, cachePath });
  // #4044: THIS checkout's own shim dir by default — never the one machine-wide file every dispatcher rewrote.
  const dir = dirOpt ?? checkoutShimDir({ ghThrottleCliPath });
  const realGhPath = resolveRealGhBinary({ pathEnv, shimDir: dir, exists });
  if (!realGhPath) {
    if (isDaemonCaller(env)) throw new Error('gh-shim: refusing daemon dispatch without a real gh binary');
    return null;
  }
  const written = ensureGhShim({ dir, realGhPath, cachePath, ghThrottleCliPath, writeFile, chmod, mkdir, roleTable, callerRoles: id?.callerRoles, personalFallbackPolicy: shimFallbackPolicy({ ghThrottleCliPath }) });
  if (!written.ok) {
    if (isDaemonCaller(env)) throw new Error('gh-shim: refusing daemon dispatch without the gh auth guard');
    return null;
  }
  const settingsEnv = { PATH: ghShimPathOverride({ dir, currentPath: pathEnv }) };
  // A dispatched session plays its dispatcher's role (a review session = reviewer) — only once roles are configured.
  if (Object.keys(roleTable).length && env?.[ROLE_ENV]) settingsEnv[ROLE_ENV] = String(env[ROLE_ENV]);
  if (isDaemonCaller(env)) settingsEnv.WE_GH_DAEMON_CALLER = String(env.WE_GH_DAEMON_CALLER || env.XPC_SERVICE_NAME);
  if (cwd) ensureSettingsFileEnv({ cwd, env: settingsEnv, readFile, writeFile, mkdir }); // best-effort, see above
  return settingsEnv;
}
