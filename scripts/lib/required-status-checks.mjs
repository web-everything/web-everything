/**
 * @file scripts/lib/required-status-checks.mjs — @module required-status-checks
 *
 * THE PROBLEM THIS CLOSES (LIVE INCIDENT 2026-09-26, PR #2748, web-everything/web-everything): "CI failed" was
 * decided by an EXCLUSION list (`we:scripts/operations/pr-status.mjs#CI_TRUTH_EXCLUDED_CHECKS`) — every check
 * counted as CI truth EXCEPT the ones named on that list. A brand-new advisory workflow (the soak-replay gate,
 * PR #2775) went red on a PR whose every REQUIRED check (`test`/`smoke`/`daemon-soak`) was green, and every
 * wholesale "is anything red" reader (`we:scripts/progress-board.mjs#ciFailed`, `we:scripts/readiness/
 * conveyor-state.mjs#ciRollup`, this file's sibling `reduceCheckState`, `we:scripts/operator/dispatch.mjs
 * #healCi`) read it as a genuine CI failure anyway, because nobody had yet added its name to the exclusion
 * list — an advisory workflow's mere EXISTENCE was enough to cause a false red, and the same will be true of
 * the NEXT one someone adds, forever, unless something closes the gap structurally.
 *
 * THE FIX: invert the question. Read branch rulesets (App-token readable) AND classic branch protection, and
 * take their union — GitHub enforces both — to learn which checks are ACTUALLY required to merge. Asking "did a REQUIRED check fail"
 * cannot be fooled by a new advisory check: it only counts once explicitly required by repository policy.
 *
 * THIS FILE OWNS THE IO (`gh api …`, cached to a sidecar file — same convention as `we:scripts/progress-
 * board.mjs`'s own `reports/.progress-board-cache.json`) so every PURE reducer that wants the required set
 * (`ciFailed`/`classifyPr` in `we:scripts/progress-board.mjs`, `we:scripts/conveyor/reconcile-core.mjs
 * #planReconcile`) can accept it as plain data, with no network call of their own, matching this repo's
 * standing "the gh calls are injected, so every branch is reachable in a test with no network" convention (see
 * `we:scripts/operations/pr-status.mjs`'s own file header).
 *
 * DEGRADATION, on the same "never lose the read" principle `we:scripts/progress-board.mjs` documents: a fresh
 * live fetch wins when available; a live fetch that fails falls back to the last cache written (even stale —
 * a branch-protection change is rare, so a day-old required set is still far more accurate than guessing);
 * a protection 403/404 (never a rate-limit 403 — that is transient), or both sources read fine and requiring
 * nothing, instead selects the repo's declared
 * policy, cached for the normal TTL as `declared`, unless a live entry already exists: that is returned as
 * `stale-cache` and left untouched on disk. A rules denial is such a denial even when classic protection reads
 * fine: that classic set is partial, so it is never live, only added on top of the declared/fallback set.
 * Other failures still retry and prefer the cache, with its original age exposed to admission gates.
 * With no cache, failures return `fallback` for a declared repo; undeclared repos return [] with `fallback`
 * on 403/404 or `unavailable` otherwise. The shared check reducer then evaluates observed
 * CI checks, retaining red/pending/unchecked evidence rather than treating an empty required set as green.
 * Cache entries coexist by repo@branch; legacy single-entry sidecars are migrated on the next write.
 */
import { spawnSync } from 'node:child_process';
import { readGh } from './proc-read.mjs';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { looksLikePersonalAccessDenial, resolvePersonalRouteEnabled, runGhCliPassthrough } from './gh-throttle.mjs';
import { ghRestGetJson } from './gh-rest-read.mjs';
import { writeJsonAtomic, withFileLock } from './atomic-json-file.mjs';
import { readSettings } from './settings-files.mjs';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { REQUIRED_CHECK_IMPLIED_BY, withoutImpliedRequiredChecks } from './required-check-implication.mjs';
import { CONSTELLATION_REPOS } from './constellation-repos.mjs';

/**
 * The required set as confirmed live on 2026-10-11 via the rules API
 * (`repos/web-everything/web-everything/rules/branches/main`, ruleset 24883772).
 * Used as WE's declared policy on access denial, or as an untrusted fallback for other failures when no
 * cache exists. A successful live fetch always wins, picking up changes on the next successful read.
 */
export const FALLBACK_REQUIRED_STATUS_CHECKS = Object.freeze(['test', 'smoke', 'daemon-soak', 'soak-replay-gate']);

export { REQUIRED_CHECK_IMPLIED_BY, withoutImpliedRequiredChecks };

/**
 * PR requirements when protection cannot be read. Sibling CI workflows inspected 2026-10-02:
 * Plateau runs test + e2e on every PR (e2e skips only pushes); Frontier UI runs test. Plateau's older
 * workflow commentary calls e2e advisory; the declared PR policy here intentionally requires both.
 * Deployment admission/build/deploy jobs are event/label-gated and are not PR requirements.
 */
export const DECLARED_REQUIRED_STATUS_CHECKS = Object.freeze({
  [CONSTELLATION_REPOS.we.slug]: FALLBACK_REQUIRED_STATUS_CHECKS,
  [CONSTELLATION_REPOS['plateau-app'].slug]: Object.freeze(['test', 'e2e']),
  [CONSTELLATION_REPOS.frontierui.slug]: Object.freeze(['test']),
});

const DEFAULT_CACHE_TTL_MS = 15 * 60_000;

/**
 * Is this a protection ACCESS denial (gh's `HTTP 403`/`HTTP 404` that is not a rate limit)? Delegates to the
 * shared, `isRateLimitShaped`-guarded classifier so a rate-limit/abuse 403 is a transient failure, never a
 * denial — it must not select the declared policy or overwrite a live cache entry.
 */
function protectionAccessDenied(error) {
  return looksLikePersonalAccessDenial(`${error?.message ?? ''}\n${error?.stderr ?? ''}`);
}

/**
 * The ONE cache file every daemon and lane clone shares: under the operator's coordination root, never the
 * working directory (a per-cwd file gave every clone its own cold cache — 5,470 protection reads in 12 h).
 * Entries are keyed `repo@branch`, so one file holds every repo.
 */
export function defaultCachePath({ env = process.env } = {}) {
  return join(resolveCoordinationRoot({ env }), 'required-status-checks-cache.json');
}

const TTL_SETTINGS_MEMO_MS = 60_000;
let ttlSettingsMemo = null;

/**
 * Pure: the cache TTL a settings object asks for (`requiredChecksCache.ttlMinutes`), else the 15 min default.
 * A non-positive or non-numeric value is ignored, never a zero TTL that would revalidate on every call.
 */
export function cacheTtlMsFromSettings(settings) {
  const minutes = settings?.requiredChecksCache?.ttlMinutes;
  return typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : DEFAULT_CACHE_TTL_MS;
}

/** The TTL from `scripts/settings/required-checks-cache.json`; the merged settings read is memoized for a minute. */
export function resolveCacheTtlMs({ settings, now = Date.now() } = {}) {
  if (settings !== undefined) return cacheTtlMsFromSettings(settings);
  if (!ttlSettingsMemo || now - ttlSettingsMemo.atMs >= TTL_SETTINGS_MEMO_MS || now < ttlSettingsMemo.atMs) {
    ttlSettingsMemo = { atMs: now, ttlMs: cacheTtlMsFromSettings(readSettings()) };
  }
  return ttlSettingsMemo.ttlMs;
}

/** Parse a cache file into its `entries` map. Unreadable, corrupt or foreign-shaped means "no cache" ({}), never an error. */
function readCacheEntries(cachePath) {
  try {
    const parsed = JSON.parse(readFileSync(cachePath, 'utf8'));
    if (parsed?.entries && typeof parsed.entries === 'object' && !Array.isArray(parsed.entries)) return parsed.entries;
    if (typeof parsed?.key === 'string') return { [parsed.key]: parsed }; // legacy single-entry sidecar
  } catch {
    /* no cache, or unreadable */
  }
  return {};
}

/** Pure projection of branch rules into the union of required status-check contexts. */
export function requiredChecksFromRules(rulesJson) {
  if (!Array.isArray(rulesJson)) throw new Error('required-status-checks: unexpected shape from branch rules');
  return [...new Set(rulesJson
    .filter(rule => rule?.type === 'required_status_checks')
    .flatMap(rule => rule.parameters?.required_status_checks ?? [])
    .map(check => check?.context)
    .filter(context => typeof context === 'string' && context.length > 0))];
}

/**
 * Pure projection of a `GET repos/{repo}/branches/{branch}` body into its classic-protection required contexts
 * (`contexts` ∪ `checks[].context`). An unprotected branch, or protection that requires no status checks, is [];
 * a protected branch whose protection the token cannot see is an unexpected shape, never "no checks".
 */
export function requiredChecksFromBranch(branchJson) {
  const shapeError = () => new Error('required-status-checks: unexpected shape from branch');
  if (!branchJson || typeof branchJson !== 'object' || Array.isArray(branchJson)) throw shapeError();
  if (branchJson.protected === false) return [];
  if (branchJson.protected !== true || !branchJson.protection || typeof branchJson.protection !== 'object') throw shapeError();
  if (branchJson.protection.enabled === false) return []; // protected by a ruleset only — no classic protection
  const status = branchJson.protection.required_status_checks;
  if (status == null) return [];
  if (typeof status !== 'object') throw shapeError();
  const contexts = Array.isArray(status.contexts) ? status.contexts : [];
  const checks = Array.isArray(status.checks) ? status.checks.map(check => check?.context) : [];
  return [...new Set([...contexts, ...checks].filter(context => typeof context === 'string' && context.length > 0))];
}

/**
 * `gh api --paginate --slurp` prints an array of PAGES; flatten it to the rule list. A bare rule list (no page
 * wrapper) passes through; a mix of pages and bare rules is an unexpected shape, never a partial read.
 */
function flattenRulePages(parsed) {
  if (!Array.isArray(parsed)) return parsed; // requiredChecksFromRules rejects the shape
  const pages = parsed.filter(Array.isArray).length;
  if (pages === 0) return parsed;
  if (pages !== parsed.length) throw new Error('required-status-checks: unexpected mix of pages and rules from branch rules');
  return parsed.flat();
}

/** Shared routing, timeout and piped IO for both GitHub sources. */
function readRequiredChecksGh(args) {
  const opts = { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] };
  if (resolvePersonalRouteEnabled()) {
    // Personal routing lives in the CLI read path, not runGhSync.
    const result = runGhCliPassthrough(args, {
      spawn: (bin, argv, spawnOpts) => spawnSync(bin, argv, { ...spawnOpts, ...opts }),
    });
    if (result.status !== 0 || result.deferred) {
      throw Object.assign(new Error('required-status-checks: read failed'), { stderr: result.stderr });
    }
    return String(result.stdout ?? '');
  }
  return readGh(args, opts); // #74d: failure/oversize throws; never parsed as empty
}

/**
 * The injected `gh` reader. Returns the repo's required status-check context names, or throws — never
 * swallows an error itself, so {@link getRequiredStatusChecks} is the one place that decides what a failure
 * degrades to.
 *
 * `repo` OMITTED (null/undefined) uses `gh api`'s own `{owner}/{repo}` template placeholders, resolved from
 * the CURRENT directory's git remote — the same "let gh infer it" convention this repo's other readers use
 * (e.g. `we:scripts/conveyor/reconcile-pass.mjs#defaultReadAheadBy`) — rather than failing a caller that never
 * had a repo slug to pass.
 * @param {{repo?: string, branch?: string, gh?: Function, restGet?: Function}} o
 * @returns {string[]}
 */
export function defaultReadRequiredStatusChecks(options = {}) {
  return readRequiredStatusChecksDetailed(options).checks;
}

const RULES_PAGE_SIZE = 100;
const RULES_MAX_PAGES = 10;

/**
 * The rules list via one conditional GET per page (an unchanged page is a free `304`). A non-array body — a blank
 * 200 included — is a failed read, never "no rules"; hitting the page cap is an error, never a partial list.
 */
function readRulesPaged(restGet, path, o) {
  const rules = [];
  for (let page = 1; page <= RULES_MAX_PAGES; page += 1) {
    const { json } = restGet(`${path}?per_page=${RULES_PAGE_SIZE}&page=${page}`, o);
    if (!Array.isArray(json)) throw new Error('required-status-checks: unexpected shape from branch rules');
    rules.push(...json);
    if (json.length < RULES_PAGE_SIZE) return rules;
  }
  throw new Error('required-status-checks: branch rules exceed the page cap');
}

/**
 * Same read as {@link defaultReadRequiredStatusChecks}, returning `{checks, classic}`: `checks` is the rules ∪
 * classic union every caller needs, `classic` the classic-branch-protection contexts alone (the main-red
 * missing-run pass must not see ruleset-only checks such as `merge-gate`, #5060).
 *
 * Reads go through `restGet` (default `ghRestGetJson`, ETag-conditional: after the cache TTL an unchanged answer is
 * a free 304). An injected `gh` text reader, or the personal-routed CLI path, keeps the plain `gh api` calls.
 * @param {{repo?: string, branch?: string, gh?: Function, restGet?: Function}} o
 * @returns {{checks: string[], classic: string[]}}
 */
export function readRequiredStatusChecksDetailed({ repo, branch = 'main', gh, restGet = ghRestGetJson } = {}) {
  const base = `repos/${repo || '{owner}/{repo}'}`;
  const useRest = !gh && !resolvePersonalRouteEnabled();
  const text = gh ?? readRequiredChecksGh;
  // `{owner}/{repo}` placeholders resolve from the cwd's remote, so the ETag cache key must carry the cwd.
  const restOpts = { op: 'required-checks', context: repo ? '' : process.cwd() };
  let rulesChecks = [];
  let rulesError;
  let rulesFailed = false; // a flag, not `rulesError`'s truthiness: a `throw undefined` is still a failed read
  try {
    // The rules endpoint pages at 30: read every page so a required check on a later page is never dropped.
    // A blank body is a failed read, not "no rules" (JSON.parse('') throws; a non-array body throws).
    const rules = useRest
      ? readRulesPaged(restGet, `${base}/rules/branches/${branch}`, restOpts)
      : flattenRulePages(JSON.parse(text(['api', '--paginate', '--slurp', `${base}/rules/branches/${branch}?per_page=100`]).trim()));
    rulesChecks = requiredChecksFromRules(rules);
  } catch (error) {
    rulesError = error;
    rulesFailed = true;
  }

  // GitHub enforces rulesets AND classic protection together, so classic protection is always read too and the
  // required set is their UNION — a check only classic protection requires must never be dropped (PR #4924).
  // Read it off the BRANCH (`protection.required_status_checks`), not `…/protection`: an App token gets a 403 on
  // the latter (live 2026-10-11) but can read the former. Any classic failure throws — never a ruleset-only set.
  let checks;
  try {
    const branchJson = useRest
      ? restGet(`${base}/branches/${branch}`, restOpts).json // a blank body parses to null → shape error below
      : JSON.parse(text(['api', `${base}/branches/${branch}`]).trim()); // blank body = failed read, same as the rules read
    checks = requiredChecksFromBranch(branchJson);
  } catch (error) {
    // The ruleset read fine: its set is partial, never live, but stays required on whatever the caller falls back to.
    if (!rulesFailed) throw withPartialChecks(error, rulesChecks);
    // A transient rules failure must not become a denial just because protection is inaccessible.
    throw !protectionAccessDenied(rulesError) ? rulesError : error;
  }
  if (!rulesFailed) {
    const union = [...new Set([...rulesChecks, ...checks])];
    // Both sources read fine and neither requires a check: an authoritative "nothing required", which selects the
    // repo's declared policy exactly as a protection denial does — never the untrusted `fallback`.
    if (!union.length) throw Object.assign(new Error('required-status-checks: no required checks in rules or branch protection'), { noRequiredChecks: true });
    return { checks: union, classic: checks };
  }
  // Rulesets can require checks classic protection lacks, and an unreadable ruleset does not mean its requirements
  // disappeared — so after ANY rules failure the classic set is partial and never returned as live: throw the rules
  // error (its denial/transient classification intact) so the caller keeps a live cache or the declared policy. It
  // carries the classic set as `partialChecks`, a floor the caller still requires (PR #4924 red team).
  throw withPartialChecks(rulesError, checks);
}

/** A usable cache entry holds real branch-protection data: source `live`, or a legacy source-less entry. */
function isLiveCacheEntry(entry) {
  return entry.source !== 'declared' && entry.source !== 'unavailable';
}

/**
 * Does the cache's CURRENT entry for a key outrank a write about to replace it? Readers overlap, so the entry
 * can be one another reader saved after this read began (PR #5404 red team). A live entry outranks a declared or
 * unavailable write at any age — the same rule as a denial never clobbering a live cache. Otherwise, of two
 * entries of the same kind, the newer `fetchedAtMs` wins, so a slower reader never moves the entry backwards.
 * A live write always replaces a non-live entry. An invalid or missing entry never outranks anything.
 */
function cacheEntryOutranks(current, incoming) {
  if (!current || !Array.isArray(current.checks) || !Number.isFinite(current.fetchedAtMs)) return false;
  const currentLive = isLiveCacheEntry(current);
  const incomingLive = isLiveCacheEntry(incoming);
  if (currentLive !== incomingLive) return currentLive;
  return current.fetchedAtMs > incoming.fetchedAtMs;
}

/**
 * One source read fine while the other failed: attach the readable source's checks to the failure as
 * `partialChecks` — never a live set, but a floor {@link getRequiredStatusChecks} adds to every degraded result.
 * A non-object throw cannot carry it and passes through unchanged (its classification must not change either).
 */
function withPartialChecks(error, partialChecks) {
  if (error && typeof error === 'object') { // always set: a reused error never keeps an earlier call's floor
    try { error.partialChecks = partialChecks; } catch { /* a frozen error degrades without the floor */ }
  }
  return error;
}

/**
 * The required set for `repo`'s `branch`, cached — see this file's header for the full fallback chain. PURE
 * apart from the injected `readChecks` and the cache file IO, both of which a test can stub/redirect.
 *
 * @param {object} o
 * @param {string} o.repo - `owner/name` slug (branch protection is repo-scoped).
 * @param {string} [o.branch] - defaults to `'main'`.
 * @param {boolean} [o.readOnly] - skip cache persistence (diagnostic planner).
 * @param {string} [o.cachePath] - defaults to {@link defaultCachePath}.
 * @param {number} [o.now] - epoch ms; defaults to `Date.now()`.
 * @param {number} [o.ttlMs] - how long a cached read is trusted before a fresh live fetch is attempted again;
 *   defaults to the `requiredChecksCache.ttlMinutes` setting (15 minutes). A stale-but-only-option cache is still preferred over the hardcoded fallback (see
 *   header), so this bounds re-FETCH frequency, not cache USABILITY.
 * @param {Function} [o.readChecks] - defaults to {@link readRequiredStatusChecksDetailed}.
 * @returns {{checks: string[], classic?: string[], source: 'live'|'cache'|'stale-cache'|'fallback'|'declared'|'unavailable', cacheAgeMs?: number}}
 *   `classic` (live/cache/stale-cache only) is the classic-protection subset of `checks`.
 */
export function getRequiredStatusChecks({
  repo,
  readOnly = false,
  branch = 'main',
  cachePath = defaultCachePath(),
  now = Date.now(),
  ttlMs = resolveCacheTtlMs({ now }),
  readChecks = readRequiredStatusChecksDetailed,
} = {}) {
  const key = `${repo || ''}@${branch}`;
  const declared = DECLARED_REQUIRED_STATUS_CHECKS[repo];
  // A cwd-inferred slug is unknown here: never share an anonymous cache across repositories.
  const validEntry = entry => (entry && Array.isArray(entry.checks) && Number.isFinite(entry.fetchedAtMs) ? entry : null);
  // The file's entry for this key NOW: another reader may have saved since `cache` was read. Writes rename
  // atomically, so an unlocked read sees a whole entry.
  const reread = () => (repo ? validEntry(readCacheEntries(cachePath)[key]) : null);
  const cache = reread();
  // The classic-protection contexts ride along only on a live entry (a declared/unavailable entry never read them).
  const withClassic = (result, entry) => (Array.isArray(entry?.classic) ? { ...result, classic: entry.classic } : result);

  if (cache && (now - cache.fetchedAtMs) < ttlMs) {
    return withClassic({ checks: cache.checks, source: cache.source === 'declared' || cache.source === 'unavailable'
      ? cache.source : 'cache' }, cache);
  }

  const save = (checks, source, classic) => {
    let winner = null;
    if (repo && !readOnly) {
      try {
        mkdirSync(dirname(cachePath), { recursive: true });
        // Many daemons share this file: re-read inside the lock and merge, so two repos' writes never clobber each
        // other. A lock timeout throws and skips the write — the read itself never fails over it.
        withFileLock(`${cachePath}.lock`, () => {
          const entries = readCacheEntries(cachePath);
          // The same key may have changed since this read began (`cache` is a pre-read snapshot): keep the
          // current entry if it outranks this write — see cacheEntryOutranks.
          if (cacheEntryOutranks(entries[key], { source, fetchedAtMs: now })) {
            winner = entries[key];
            return;
          }
          entries[key] = { checks, source, fetchedAtMs: now, ...(Array.isArray(classic) ? { classic } : {}) };
          writeJsonAtomic(cachePath, { entries });
        }, { timeoutMs: 2_000 });
      } catch {
        // The cache is an optimisation — never fail a read over a write. A lock timeout skipped the merge above, so
        // re-read without the lock: an entry another reader saved that outranks this write still wins the answer.
        const current = reread();
        if (cacheEntryOutranks(current, { source, fetchedAtMs: now })) winner = current;
      }
    }
    // The entry that outranked this write is what the cache now holds: answer with it, so this call never returns a
    // policy (e.g. the declared defaults) the file already superseded. Every branch adds this read's partial floor,
    // which is never cached: a winner may predate a check this read just saw required.
    if (winner) {
      const checks = withPartial(winner.checks);
      if (!isLiveCacheEntry(winner)) return withClassic({ checks, source: winner.source }, winner);
      return (now - winner.fetchedAtMs) < ttlMs
        ? withClassic({ checks, source: 'cache' }, winner)
        : withClassic({ checks, source: 'stale-cache', cacheAgeMs: now - winner.fetchedAtMs }, winner);
    }
    return withClassic({ checks, source }, { classic });
  };

  // Checks a source that DID read still requires (the other source failed): never live, but added to every degraded
  // result below — the declared policy, the stale cache or the fallback — so a degraded read never drops them. Only
  // on top of a non-empty base: an empty set means "count every observed check", and a partial set would narrow it.
  let partial = [];
  const withPartial = checks => (checks.length ? [...new Set([...checks, ...partial])] : checks);
  try {
    // A reader returns the union array, or `{checks, classic}` when it also knows the classic-protection subset.
    const read = readChecks({ repo, branch });
    const checks = Array.isArray(read) ? read : read?.checks;
    if (Array.isArray(checks) && checks.length) {
      return save(checks, 'live', Array.isArray(read) ? undefined : read.classic);
    }
  } catch (error) {
    if (Array.isArray(error?.partialChecks)) partial = error.partialChecks;
    if (protectionAccessDenied(error) || error?.noRequiredChecks === true) {
      // An existing live entry (source `live`, or a legacy source-less one) is real branch-protection data: a
      // denial must never clobber it with the declared policy. Fall through to the stale-cache tail instead —
      // the file is untouched, so the next call re-reads live once more.
      const hasLiveCache = cache && isLiveCacheEntry(cache);
      if (!hasLiveCache) {
        if (declared) return save(withPartial(declared), 'declared');
        if (!cache && !reread()) return { checks: [], source: 'fallback' };
      }
    }
    /* gh missing, unauthenticated, offline, rate-limited, or an unexpected response shape — degrade below */
  }

  // Answer from the file's current entry, never the pre-read snapshot another reader has since superseded.
  const latest = reread();
  const current = latest && !cacheEntryOutranks(cache, latest) ? latest : cache;
  if (current && (now - current.fetchedAtMs) < ttlMs) {
    return withClassic({ checks: withPartial(current.checks), source: isLiveCacheEntry(current) ? 'cache' : current.source }, current);
  }
  if (current) return withClassic({ checks: withPartial(current.checks), source: current.source === 'unavailable' ? 'unavailable' : 'stale-cache',
    cacheAgeMs: now - current.fetchedAtMs }, current);
  return declared ? { checks: withPartial(declared), source: 'fallback' } : { checks: [], source: 'unavailable' };
}
