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
 * a protection 403/404 (never a rate-limit 403 — that is transient) instead selects the repo's declared
 * policy, cached for the normal TTL as `declared`, unless a live entry already exists: that is returned as
 * `stale-cache` and left untouched on disk.
 * Other failures still retry and prefer the cache, with its original age exposed to admission gates.
 * With no cache, failures return `fallback` for a declared repo; undeclared repos return [] with `fallback`
 * on 403/404 or `unavailable` otherwise. The shared check reducer then evaluates observed
 * CI checks, retaining red/pending/unchecked evidence rather than treating an empty required set as green.
 * Cache entries coexist by repo@branch; legacy single-entry sidecars are migrated on the next write.
 */
import { spawnSync } from 'node:child_process';
import { readGh } from './proc-read.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { looksLikePersonalAccessDenial, resolvePersonalRouteEnabled, runGhCliPassthrough } from './gh-throttle.mjs';
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

/** Where the cache sidecar lives — mirrors `we:scripts/progress-board.mjs#cachePathFor`'s own convention. */
export function defaultCachePath() {
  return join(process.cwd(), 'reports', '.required-status-checks-cache.json');
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
 * @param {{repo?: string, branch?: string, gh?: Function}} o
 * @returns {string[]}
 */
export function defaultReadRequiredStatusChecks({ repo, branch = 'main', gh = readRequiredChecksGh } = {}) {
  const base = `repos/${repo || '{owner}/{repo}'}`;
  let rulesChecks = [];
  let rulesError;
  try {
    // The rules endpoint pages at 30: read every page (`--slurp` → one array of pages) so a required check on a
    // later page is never dropped. A blank body is a failed read, not "no rules" (JSON.parse('') throws).
    const out = gh(['api', '--paginate', '--slurp', `${base}/rules/branches/${branch}?per_page=100`]);
    rulesChecks = requiredChecksFromRules(flattenRulePages(JSON.parse(out.trim())));
  } catch (error) {
    rulesError = error;
  }

  // GitHub enforces rulesets AND classic protection together, so classic protection is always read too and the
  // required set is their UNION — a check only classic protection requires must never be dropped (PR #4924).
  let checks;
  try {
    const out = gh(['api', `${base}/branches/${branch}/protection`, '--jq', '.required_status_checks.contexts']);
    const parsed = JSON.parse(out.trim()); // blank body = failed read, same as the rules read above
    if (!Array.isArray(parsed)) throw new Error('required-status-checks: unexpected shape from branch protection');
    checks = parsed.map(String);
  } catch (error) {
    // Rules read fine: a protection DENIAL (no classic protection on the branch — 404 — or a token that cannot
    // read it — 403) leaves the ruleset set as the whole answer. Any other protection failure throws, so a
    // ruleset-only partial set is never reported live; the caller's stale-cache handling keeps the last real set.
    if (!rulesError && rulesChecks.length && protectionAccessDenied(error)) return rulesChecks;
    // A transient rules failure must not become a denial just because protection is inaccessible.
    throw rulesError && !protectionAccessDenied(rulesError) ? rulesError : error;
  }
  if (!rulesError) return [...new Set([...rulesChecks, ...checks])];
  // Rulesets can require checks classic protection lacks, so a partial classic set after a TRANSIENT rules
  // failure must not be returned as live: throw so the caller's stale-cache handling keeps the last real set.
  // Only a rules ACCESS denial lets a non-empty classic set stand (the rules API is simply unreadable here).
  if (rulesError && (!checks.length || !protectionAccessDenied(rulesError))) throw rulesError;
  return checks;
}

/**
 * The required set for `repo`'s `branch`, cached — see this file's header for the full fallback chain. PURE
 * apart from the injected `readChecks` and the cache file IO, both of which a test can stub/redirect.
 *
 * @param {object} o
 * @param {string} o.repo - `owner/name` slug (branch protection is repo-scoped).
 * @param {string} [o.branch] - defaults to `'main'`.
 * @param {string} [o.cachePath] - defaults to {@link defaultCachePath}.
 * @param {number} [o.now] - epoch ms; defaults to `Date.now()`.
 * @param {number} [o.ttlMs] - how long a cached read is trusted before a fresh live fetch is attempted again;
 *   defaults to 15 minutes. A stale-but-only-option cache is still preferred over the hardcoded fallback (see
 *   header), so this bounds re-FETCH frequency, not cache USABILITY.
 * @param {Function} [o.readChecks] - defaults to {@link defaultReadRequiredStatusChecks}.
 * @returns {{checks: string[], source: 'live'|'cache'|'stale-cache'|'fallback'|'declared'|'unavailable', cacheAgeMs?: number}}
 */
export function getRequiredStatusChecks({
  repo,
  branch = 'main',
  cachePath = defaultCachePath(),
  now = Date.now(),
  ttlMs = DEFAULT_CACHE_TTL_MS,
  readChecks = defaultReadRequiredStatusChecks,
} = {}) {
  const key = `${repo || ''}@${branch}`;
  const declared = DECLARED_REQUIRED_STATUS_CHECKS[repo];
  let entries = {};
  let cache = null;
  try {
    const parsed = JSON.parse(readFileSync(cachePath, 'utf8'));
    if (parsed?.entries && typeof parsed.entries === 'object' && !Array.isArray(parsed.entries)) {
      entries = parsed.entries;
    } else if (typeof parsed?.key === 'string') {
      entries = { [parsed.key]: parsed };
    }
    // A cwd-inferred slug is unknown here: never share an anonymous cache across repositories.
    const candidate = repo ? entries[key] : null;
    if (candidate && Array.isArray(candidate.checks) && Number.isFinite(candidate.fetchedAtMs)) {
      cache = candidate;
    }
  } catch {
    /* no cache, or unreadable — a fresh live fetch (or the hardcoded fallback) is next */
  }

  if (cache && (now - cache.fetchedAtMs) < ttlMs) {
    return { checks: cache.checks, source: cache.source === 'declared' || cache.source === 'unavailable'
      ? cache.source : 'cache' };
  }

  const save = (checks, source) => {
    if (repo) {
      try {
        mkdirSync(dirname(cachePath), { recursive: true });
        entries[key] = { checks, source, fetchedAtMs: now };
        writeFileSync(cachePath, JSON.stringify({ entries }, null, 2) + '\n');
      } catch {
        /* the cache is an optimisation — never fail a read over a write */
      }
    }
    return { checks, source };
  };

  try {
    const checks = readChecks({ repo, branch });
    if (Array.isArray(checks) && checks.length) {
      return save(checks, 'live');
    }
  } catch (error) {
    if (protectionAccessDenied(error)) {
      // An existing live entry (source `live`, or a legacy source-less one) is real branch-protection data: a
      // denial must never clobber it with the declared policy. Fall through to the stale-cache tail instead —
      // the file is untouched, so the next call re-reads live once more.
      const hasLiveCache = cache && cache.source !== 'declared' && cache.source !== 'unavailable';
      if (!hasLiveCache) {
        if (declared) return save([...declared], 'declared');
        if (!cache) return { checks: [], source: 'fallback' };
      }
    }
    /* gh missing, unauthenticated, offline, rate-limited, or an unexpected response shape — degrade below */
  }

  if (cache) return { checks: cache.checks, source: cache.source === 'unavailable' ? 'unavailable' : 'stale-cache',
    cacheAgeMs: now - cache.fetchedAtMs };
  return declared ? { checks: [...declared], source: 'fallback' } : { checks: [], source: 'unavailable' };
}
