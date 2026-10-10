/**
 * @file scripts/lib/pr-limit.mjs
 * @description Open-PR backpressure limit (we:xniq7xs, parent #4075, epic #3383). Too many open PRs is
 *   usually a REVIEW-SYSTEM problem (the drain/review pipeline can't keep up), not a build problem — so
 *   when a repo's open, agent-authored, not-yet-`review:accepted` PR count is already at/over its cap, a
 *   NEW pr-land open is refused (the branch stays pushed — nothing is lost) and new-PR dispatch intake is
 *   held with a named reason. Fixing/reviewing/CI-healing an EXISTING PR is never blocked by this — only
 *   opening ANOTHER new one is, because that is exactly the thing that makes the review backlog worse.
 *
 * PURE CORE (limits, exemption, the refusal decision, override-state parsing) + a thin gh/fs IO shell,
 * mirroring `scripts/readiness/dispatch-pause.mjs`'s own split — same reasoning: a single small mechanism
 * like this earns one file, not a `-io.mjs` sibling, and every fs/gh boundary is injectable for tests.
 *
 * OVERRIDE STATE lives at `~/.claude/conveyor/pr-limit.json` (env override `WE_PR_LIMIT_STATE_FILE`) —
 * a HOME-relative path, deliberately NOT this repo's usual `.conveyor/` (repo-relative, so distinct per
 * lane clone). The limit is a cross-repo, cross-lane concept — "is the review system overloaded right
 * now" — so the override that lifts it must be visible to every lane/session on this machine at once, the
 * same reason `~/.claude/github-app-token` and other machine-wide operator state live under `~/.claude`.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CONSTELLATION_REPOS, repoKeyForSlug } from './constellation-repos.mjs';
import { isAiGeneratedPr, hasLabel } from './ai-pr-authorship.mjs'; // the zero-dependency leaf (we:xniq7xs) — never merge-ai-prs.mjs directly, which would drag its whole land/merge/review import graph into this small module's consumers (operator-queue.mjs, dispatch-plan.mjs)
import { REVIEW_LABELS } from './review-escalation.mjs';
import { runGhSync } from './gh-throttle.mjs';
import { readSharedOpenPrs } from './pr-snapshot.mjs';
import { meteredPrCommits } from './gh-metered-reads.mjs';
import { readGitPrCommits } from './git-pr-commits.mjs';
import { writeAllSync } from './write-all-sync.mjs';
import { isCardOnlyDiff } from '../ci-card-only.mjs'; // THE one definition of card-only (backlog/ only, fail-closed) — never re-derived here
import { readSettings } from './settings-files.mjs';
import { platformPreference, logCascadeSources } from './policy-cascade.mjs';
import { gitRun } from './git-run.mjs';
import { classifySession } from '../operations/session-role.mjs'; // THE worker/orchestrator marker — the same one pre-pr-review's bypass gate reads
import { currentActorId } from './review-independence.mjs'; // the harness session id, recorded on every grant/refusal

// ── LIMITS (defaults + per-repo env override) ───────────────────────────────────────────────────────────

/** Today's per-repo caps (we:xniq7xs — the operator's own numbers). */
export const PR_LIMIT_DEFAULTS = Object.freeze({ we: 15, frontierui: 5, 'plateau-app': 5 });

/** The env var that overrides EACH repo's cap independently — no repo shares another's override. */
export const PR_LIMIT_ENV = Object.freeze({
  we: 'WE_PR_LIMIT_WE',
  frontierui: 'WE_PR_LIMIT_FRONTIERUI',
  'plateau-app': 'WE_PR_LIMIT_PLATEAU_APP',
});

/**
 * The effective cap for a repo key. An env override wins when it parses to a finite number ≥ 0; otherwise
 * the default; an unknown repo key has no cap (`Infinity` — never refuses, since this module has nothing
 * principled to enforce for a repo it doesn't know). PURE.
 * @param {string} repoKey
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function resolvePrLimit(repoKey, env = process.env) {
  const envName = PR_LIMIT_ENV[repoKey];
  const raw = envName ? env?.[envName] : undefined;
  const n = raw == null ? NaN : Number(raw);
  if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  return Object.hasOwn(PR_LIMIT_DEFAULTS, repoKey) ? PR_LIMIT_DEFAULTS[repoKey] : Infinity;
}

// ── SCOPE — which open PRs the cap counts (operator ruling 2026-10-09 ~17:05 ET) ────────────────────────────

/** Built-in default: a card-only PR (every changed file under `backlog/`) is NOT counted — it costs the review
 *  system almost nothing (CI light path, no code review), so letting it fill the cap blocks real work for no gain. */
export const PR_LIMIT_SCOPE_DEFAULTS = Object.freeze({ excludeCardOnly: true, excludeStackedAwaitingBase: true });

/** The env override for {@link PR_LIMIT_SCOPE_DEFAULTS}.excludeCardOnly. */
export const PR_LIMIT_EXCLUDE_CARD_ONLY_ENV = 'WE_PR_LIMIT_EXCLUDE_CARD_ONLY';
/** The env override for {@link PR_LIMIT_SCOPE_DEFAULTS}.excludeStackedAwaitingBase. */
export const PR_LIMIT_EXCLUDE_STACKED_ENV = 'WE_PR_LIMIT_EXCLUDE_STACKED_AWAITING_BASE';
/** The label the review-status tagger puts on a draft whose base is another open PR (we:scripts/conveyor/review-status-tag.mjs). */
export const AWAITING_BASE_LABEL = 'review-status:awaiting-base';

/** Operator ruling 2026-10-10 (option c): a stacked draft waiting for its base PR (base is not the default branch, it
 *  carries {@link AWAITING_BASE_LABEL}, AND its base branch is the head of another OPEN PR) is NOT counted — it cannot
 *  land before that base does, so it adds no review or merge load yet. All three signals are required (fail-closed: a
 *  stacked PR without the label, or a labelled one aimed at a branch no open PR owns — the label is hand-appliable and
 *  the tagger puts it on any non-default base — still counts). `openHeadRefs` is the Set of every open PR's
 *  `headRefName`; absent/not a Set → nothing is stacked. PURE. */
export function isStackedAwaitingBasePr(pr, openHeadRefs, defaultBranch = 'main') {
  const base = typeof pr?.baseRefName === 'string' ? pr.baseRefName : '';
  if (!base || base === defaultBranch || !(openHeadRefs instanceof Set) || !openHeadRefs.has(base)) return false;
  return hasLabel(pr, AWAITING_BASE_LABEL);
}

const parseBool = (v) => {
  if (typeof v === 'boolean') return v;
  const t = String(v ?? '').trim().toLowerCase();
  if (t === 'true' || t === '1') return true;
  if (t === 'false' || t === '0') return false;
  return null;
};

/** The policy cascade, PURE: default → platform preference (`prLimit`, we:scripts/lib/policy-cascade.mjs) → tool
 *  layer (`scripts/settings/pr-limit.json` → `prLimit`) → env. A value that is not a boolean (or a boolean-ish env
 *  string) is ignored at its layer, never coerced. */
export function resolvePrLimitScope({ platform = {}, tool = {}, env = {} } = {}) {
  const resolveKey = (key, envName) => {
    let value = PR_LIMIT_SCOPE_DEFAULTS[key];
    let source = 'default';
    if (typeof platform?.[key] === 'boolean') { value = platform[key]; source = 'platform'; }
    if (typeof tool?.[key] === 'boolean') { value = tool[key]; source = 'tool'; }
    const fromEnv = parseBool(env?.[envName]);
    if (fromEnv !== null) { value = fromEnv; source = 'env'; }
    return [value, source];
  };
  const [excludeCardOnly, cardSource] = resolveKey('excludeCardOnly', PR_LIMIT_EXCLUDE_CARD_ONLY_ENV);
  const [excludeStackedAwaitingBase, stackedSource] = resolveKey('excludeStackedAwaitingBase', PR_LIMIT_EXCLUDE_STACKED_ENV);
  return { excludeCardOnly, excludeStackedAwaitingBase, source: { excludeCardOnly: cardSource, excludeStackedAwaitingBase: stackedSource } };
}

/** Read the live scope (the settings files + env). Never throws: unreadable settings fall back to the default. */
export function readPrLimitScope({ env = process.env, read = readSettings } = {}) {
  let tool = {};
  try { tool = read()?.prLimit ?? {}; } catch { tool = {}; }
  const scope = resolvePrLimitScope({ platform: platformPreference('prLimit', { env }), tool, env });
  const std = (layer) => (layer === 'default' ? 'standard' : layer);
  logCascadeSources('prLimit', { value: scope, sources: {
    excludeCardOnly: std(scope.source.excludeCardOnly), excludeStackedAwaitingBase: std(scope.source.excludeStackedAwaitingBase),
  } }, { env });
  return scope;
}

/** Is this `gh pr list --json files` row card-only? A row with no file list is NOT (fail-closed: it counts). PURE. */
export function isCardOnlyPr(pr) {
  const files = Array.isArray(pr?.files) ? pr.files.map((f) => (typeof f === 'string' ? f : f?.path)).filter(Boolean) : null;
  return isCardOnlyDiff(files);
}

// ── EXEMPT PATHS — conveyor/daemon infrastructure always gets through, even at/over the cap ───────────────

/** A PR that fixes the review/land machinery itself must never be the thing the machinery's own backlog
 *  blocks — so a changeset entirely within these paths is exempt from the limit. ONE list, reused by both
 *  pr-land's pre-create check and the dispatcher's intake hold (never re-derived a second way). */
export const EXEMPT_PATH_PREFIXES = Object.freeze([
  'scripts/conveyor/',
  'skills-src/conveyor/',
  'scripts/lane-pool.mjs',
  'scripts/lib/lane-lease.mjs',
  'scripts/lib/lane-pool-paths.mjs',
  'scripts/lib/lane-concurrency.mjs',
  'scripts/lib/lane-litter.mjs',
  'scripts/lib/lane-verify.mjs',
  'scripts/lib/gh-throttle.mjs',
  'scripts/lib/gh-app-shim.mjs',
  'scripts/lib/pr-snapshot.mjs',
  'scripts/lib/pr-snapshot-store.mjs',
  'scripts/lib/review-escalation.mjs',
  'scripts/lib/review-core.mjs',
  'scripts/lib/review-independence.mjs',
  'scripts/lib/review-label-provider.mjs',
  'scripts/lib/review-policy.mjs',
  'scripts/lib/pr-limit.mjs',
  'scripts/pr-land.mjs',
  'scripts/merge-ai-prs.mjs',
  'scripts/lane-drain.mjs',
  'scripts/review-set-label.mjs',
  'scripts/operations/pr-limit.mjs',
  'scripts/operations/review-dispatch.mjs',
  'scripts/operations/ci-heal-pr-dispatch.mjs',
  'scripts/operations/open-pr.mjs',
  'scripts/operations/open-pr-io.mjs',
]);

/** Is `path` under one of {@link EXEMPT_PATH_PREFIXES}? A file-prefix match (a listed `.mjs` matches
 *  itself; a listed directory matches anything under it). PURE. */
export function isExemptPath(path) {
  const p = String(path || '').replace(/^\.\//, '');
  if (!p) return false;
  return EXEMPT_PATH_PREFIXES.some((prefix) => p === prefix || p.startsWith(prefix));
}

/** A changeset is exempt only when EVERY changed file is exempt (an infra-only PR) — a PR that mixes one
 *  exempt file with an ordinary feature file is NOT exempt, so a feature can't ride the daemon carve-out
 *  in to dodge the cap. An EMPTY changeset is never exempt (nothing to found the exemption on). PURE. */
export function isExemptChangeset(changedFiles) {
  const files = Array.isArray(changedFiles) ? changedFiles.filter(Boolean) : [];
  return files.length > 0 && files.every(isExemptPath);
}

// ── COUNTING — open, agent-authored, not-yet-review:accepted PRs per repo ──────────────────────────────────

/** Of a `gh pr list --json number,commits,labels` row set, the subset this limit counts: AI-generated
 *  (every substantive commit carries the Claude/anthropic trailer — reuses `merge-ai-prs.mjs`'s own
 *  rubric, never a second one) AND not already `review:accepted` (a PR a reviewer already cleared is past
 *  the point where opening MORE PRs makes its backlog worse — it's one `gh pr merge`/drain pass from
 *  closing). PURE. */
export function countBackpressurePrs(prs) {
  const list = Array.isArray(prs) ? prs : [];
  return list.filter((pr) => isAiGeneratedPr(pr) && !hasLabel(pr, REVIEW_LABELS.accepted));
}

/** Fetch a repo's open PRs (`number,labels,headRefName,headRefOid` — deliberately NOT `commits`, see {@link fetchPrCommits})
 *  through the shared throttle. Fail-SOFT: any gh/auth/network hiccup returns `null` (never throws), so a
 *  transient `gh` failure degrades to "unknown count", not "block everything".
 *  @param {string} repoSlug - the gh `owner/repo` slug
 *  @param {{exec?: Function}} [o] - `exec` mirrors `runGhSync`'s own signature (tests inject a fake)
 *  @returns {Array|null} */
export function fetchOpenPrs(repoSlug, { exec = runGhSync, localOnly = false, readShared } = {}) {
  try {
    // #gh-graphql-budget — the host-shared open-PR snapshot first (null = not applicable → the direct read).
    // `readShared` is the test seam for that snapshot (a fake `exec` alone never reaches it).
    if (readShared || exec === runGhSync) { const shared = (readShared ?? readSharedOpenPrs)({ repo: repoSlug, fields: 'number,labels,headRefName,headRefOid,baseRefName,files', cacheOnly: localOnly }); if (shared) return shared; }
    if (localOnly) return null;
    const out = exec(
      ['pr', 'list', '--repo', repoSlug, '--state', 'open', '--json', 'number,labels,headRefName,headRefOid,baseRefName,files', '--limit', '100'],
      { throttle: { op: 'pr list (pr-limit)' }, encoding: 'utf8' },
    );
    const rows = JSON.parse(String(out ?? '[]'));
    return Array.isArray(rows) ? rows : null;
  } catch {
    return null;
  }
}

/** Fetch ONE PR's commits, PER-PR — never bulk. LIVE-CONFIRMED (we:xniq7xs proof run against the real WE
 *  repo): `gh pr list --json commits` for even a handful of open PRs routinely blows GitHub's GraphQL
 *  node-limit ("requesting up to 1,000,000 possible nodes … exceeds the maximum limit of 500,000") — the
 *  `commits` connection has no per-PR cap in a bulk list query, so it multiplies out across every PR in the
 *  page. `scripts/merge-ai-prs.mjs`'s own drain already fetches commits this exact way (`gh pr view --json
 *  commits`, one call per PR) for the identical reason; this reuses that established shape rather than
 *  re-discovering the limit the hard way twice. Fail-SOFT: returns `null` (never `[]`, which would read as
 *  "zero commits" / mechanical-only) on any failure, so the caller can tell "unknown" apart from "empty".
 *  @returns {Array|null} */
export function fetchPrCommits(repoSlug, number, { exec = runGhSync, headRefName, headRefOid, baseRefName, cwd, git, localOnly = false, allowApi = true, onApi } = {}) {
  const local = readGitPrCommits(repoSlug, headRefName, { cwd, git, headRefOid, baseRefName, localOnly });
  if (local !== null) return local;
  // `allowApi:false` is a caller's spent GitHub budget: git was still tried, the metered read is not.
  if (localOnly || !allowApi) return null;
  onApi?.();
  try {
    const commits = meteredPrCommits(repoSlug, number, { exec });
    return Array.isArray(commits) ? commits : null;
  } catch {
    return null;
  }
}

/** The live, read-only backpressure count for one repo KEY (`we`/`frontierui`/`plateau-app`). Returns
 *  `{repoKey, slug, count, prNumbers, limit, unavailable}` — `unavailable:true` (count `null`) on any gh
 *  failure or an unknown repo key, never a thrown error. `env` feeds {@link resolvePrLimit}.
 *
 *  ONE `gh pr list` per repo, plus ONE `gh pr view --json commits` per open PR that is not ALREADY
 *  `review:accepted` (an already-accepted PR is excluded from the count regardless of authorship, so its
 *  commits are never worth fetching) — see {@link fetchPrCommits} for why a bulk commits fetch is unsafe. A
 *  PR whose commits lookup fails is DROPPED from the count (unknown authorship is never assumed AI). */
export function countOpenPrsForRepo(repoKey, { exec, env = process.env, reposTable = CONSTELLATION_REPOS, git, cwd, localOnly = false, readShared, authorshipCache = null, maxApiFetches = Infinity, now = Date.now(), scope } = {}) {
  const meta = reposTable[repoKey];
  const liveScope = scope && typeof scope.excludeCardOnly === 'boolean' ? scope : readPrLimitScope({ env });
  const { excludeCardOnly } = liveScope;
  const excludeStacked = liveScope.excludeStackedAwaitingBase ?? PR_LIMIT_SCOPE_DEFAULTS.excludeStackedAwaitingBase;
  const limit = resolvePrLimit(repoKey, env);
  if (!meta) return { repoKey, slug: null, count: null, prNumbers: [], limit, unavailable: true, unresolved: 0 };
  const prs = fetchOpenPrs(meta.slug, { exec, localOnly, readShared });
  if (prs === null) return { repoKey, slug: meta.slug, count: null, prNumbers: [], limit, unavailable: true, unresolved: 0 };
  // Excluded BEFORE any commits read: an accepted or card-only PR never costs an authorship lookup.
  const acceptedPrs = prs.filter((pr) => hasLabel(pr, REVIEW_LABELS.accepted));
  const cardOnlyPrs = excludeCardOnly ? prs.filter((pr) => !hasLabel(pr, REVIEW_LABELS.accepted) && isCardOnlyPr(pr)) : [];
  const cardOnlySet = new Set(cardOnlyPrs);
  const openHeadRefs = new Set(prs.map((pr) => pr?.headRefName).filter((h) => typeof h === 'string' && h));
  const stackedPrs = excludeStacked
    ? prs.filter((pr) => !hasLabel(pr, REVIEW_LABELS.accepted) && !cardOnlySet.has(pr) && isStackedAwaitingBasePr(pr, openHeadRefs))
    : [];
  for (const pr of stackedPrs) cardOnlySet.add(pr); // excluded from the authorship lookup and the count alike
  // GitHub-call budget for the per-PR commits reads (git is tried first and is not counted); an exhausted budget
  // leaves the PR UNRESOLVED rather than spending past it.
  let apiFetches = 0;
  const repoCwd = cwd ?? (meta.path ? meta.path.replace('$HOME', homedir()) : process.cwd());
  const liveKeys = new Set();
  const verdicts = prs
    .filter((pr) => !hasLabel(pr, REVIEW_LABELS.accepted) && !cardOnlySet.has(pr))
    .map((pr) => {
      // A verdict is immutable for a given head oid, so it is cached by (repo, PR, oid) — a head that moved is a miss.
      const key = pr.headRefOid ? `${meta.slug}#${pr.number}@${pr.headRefOid}` : null;
      if (key) liveKeys.add(key);
      const hit = key && authorshipCache ? authorshipCache.get(key) : undefined;
      if (typeof hit === 'boolean') return { pr, ai: hit };
      const coolingDown = Number.isFinite(hit?.failedAt) && now - hit.failedAt < AUTHORSHIP_FAILURE_COOLDOWN_MS;
      let spent = false;
      const commits = fetchPrCommits(meta.slug, pr.number, {
        exec, headRefName: pr.headRefName, headRefOid: pr.headRefOid, baseRefName: pr.baseRefName, git, localOnly, cwd: repoCwd,
        allowApi: !coolingDown && apiFetches < maxApiFetches, onApi: () => { apiFetches++; spent = true; },
      });
      if (!Array.isArray(commits)) {
        // Only an attempted API read earns a cooldown; budget/local-only misses must stay eligible.
        if (spent && key && authorshipCache) authorshipCache.set(key, { failedAt: now });
        return { pr, ai: null };
      }
      const ai = isAiGeneratedPr({ ...pr, commits });
      if (key && authorshipCache) authorshipCache.set(key, ai);
      return { pr, ai };
    });
  authorshipCache?.flush(liveKeys);
  // A PR whose commits could not be read (local-only mode with its head not fetched, or the budget spent) is unknown,
  // not absent: `unresolved` lets a caller tell an undercount from a true count instead of silently failing open.
  const unresolved = verdicts.filter((v) => v.ai === null).length;
  const counted = verdicts.filter((v) => v.ai === true).map((v) => v.pr);
  return {
    repoKey, slug: meta.slug, count: counted.length, prNumbers: counted.map((p) => p.number), limit, unavailable: false, unresolved, apiFetches,
    excludeCardOnly, cardOnly: cardOnlyPrs.length, cardOnlyPrNumbers: cardOnlyPrs.map((p) => p.number),
    stacked: stackedPrs.length, stackedPrNumbers: stackedPrs.map((p) => p.number), accepted: acceptedPrs.length, acceptedPrNumbers: acceptedPrs.map((p) => p.number),
  };
}

// ── THE DISPATCHER'S PER-ROUND COUNT — local first, a cached + bounded networked fallback ───────────────────

/** Most GitHub per-PR commits reads the dispatcher's fallback may spend in ONE builder round. Verdicts are cached, so
 *  a larger cold backlog converges across rounds instead of costing one call per PR every round. */
export const DISPATCH_PR_COUNT_API_CAP = 3;

/** Retry failed API reads after fifteen minutes; local git remains eligible during the cooldown. */
export const AUTHORSHIP_FAILURE_COOLDOWN_MS = 15 * 60 * 1000;

/** Where the authorship verdicts live — machine-wide like the override state, so every lane's round shares one cache. */
export function resolveAuthorshipCachePath(env = process.env) {
  return env?.WE_PR_AUTHORSHIP_CACHE_FILE || join(homedir(), '.claude', 'conveyor', 'pr-authorship-cache.json');
}

/** A tiny file-backed `{get, set, flush}` of `{[repo#number@oid]: boolean | {failedAt: number}}`. Fail-SOFT everywhere: an unreadable or
 *  corrupt file is an empty cache and a failed write is dropped — the cache only ever saves calls, it can't block. */
export function createAuthorshipCache({ path = resolveAuthorshipCachePath() } = {}) {
  let data = null;
  let dirty = false;
  const load = () => {
    if (data) return data;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch { data = {}; }
    return data;
  };
  return {
    get: (key) => load()[key],
    set(key, ai) { if (load()[key] !== ai) { data[key] = ai; dirty = true; } },
    /** Persist, dropping every entry not in `liveKeys` (a closed PR / moved head), so the file stays as small as the open set. */
    flush(liveKeys) {
      const d = load();
      for (const k of Object.keys(d)) if (!liveKeys.has(k)) { delete d[k]; dirty = true; }
      if (!dirty) return;
      try {
        mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(d));
        renameSync(tmp, path);
        dirty = false;
      } catch { /* a dropped write only costs a re-read next round */ }
    },
  };
}

/**
 * The backpressure count the dispatcher takes EVERY builder round. Order of cost: (1) the cache/local-only read — no
 * gh — which is the whole answer in the common case; only when that is unavailable (cold snapshot) or has unresolved
 * PRs does it (2) fall back to the networked count, and even then it is BOUNDED: one list call at most, git before
 * GitHub, verdicts cached by head oid, and no more than {@link DISPATCH_PR_COUNT_API_CAP} GraphQL commits reads.
 * Whatever the cap leaves unresolved is reported (`unresolved`) and resolved on a later round from the cache.
 */
export function countOpenPrsForDispatch(repoKey, o = {}) {
  const authorshipCache = o.authorshipCache ?? createAuthorshipCache();
  const local = countOpenPrsForRepo(repoKey, { ...o, authorshipCache, localOnly: true });
  if (!local.unavailable && local.unresolved === 0) return { ...local, fallback: false };
  return { ...countOpenPrsForRepo(repoKey, { ...o, authorshipCache, localOnly: false, maxApiFetches: DISPATCH_PR_COUNT_API_CAP }), fallback: true };
}

/** Every constellation repo's live count, in one call (the shape both the CLI `status`/`dry-run` and the
 *  operator-queue alert want). */
export function countOpenPrsAllRepos(o = {}) {
  return Object.keys(CONSTELLATION_REPOS).map((repoKey) => countOpenPrsForRepo(repoKey, o));
}

// ── THE DECISION — reused verbatim by pr-land's pre-create check AND the dispatcher's intake hold ─────────

/**
 * The one refusal decision. PURE — every signal (count, limit, exemption, overrides) is passed in already
 * resolved, so this is unit-testable with no fs/gh at all, and the SAME function backs both enforcement
 * points (#4's requirement: they must never drift). Order matters: exemption and overrides are checked
 * BEFORE the limit, so an infra fix or a deliberate override always gets through regardless of count.
 * @param {{repoKey:string, limit:number, openCount:(number|null), changedFiles?:string[], branch?:(string|null),
 *   branchAllowed?:boolean, globalOff?:boolean, forceOpen?:boolean, forceReason?:(string|null)}} o
 * @returns {{allowed:boolean, reason:string, exempt:boolean, overridden:boolean}}
 */
export function decideOpenPr({
  repoKey, limit, openCount, changedFiles = [], branch = null, branchAllowed = false, globalOff = false, forceOpen = false, forceReason = null,
  cardOnlyExcluded = null, acceptedExcluded = null, stackedExcluded = null, excludeCardOnly = PR_LIMIT_SCOPE_DEFAULTS.excludeCardOnly,
} = {}) {
  const split = cardOnlyExcluded == null && acceptedExcluded == null && stackedExcluded == null ? ''
    : ` — ${openCount} counted (${cardOnlyExcluded ?? 0} card-only excluded, ${stackedExcluded ?? 0} stacked awaiting-base excluded, ${acceptedExcluded ?? 0} accepted excluded)`;
  if (isExemptChangeset(changedFiles)) {
    return { allowed: true, reason: 'exempt: conveyor/daemon infrastructure changeset (a fix to the review/land machinery itself always gets through)', exempt: true, overridden: false };
  }
  // A card-only PR is never COUNTED (#4713), so refusing to OPEN one guards a count it cannot raise (xbxahvf; live
  // 2026-10-10 the first card-batch draft was refused at 17/15). `isCardOnlyDiff` is the one definition, fail-closed.
  // Only while the count excludes them: with `excludeCardOnly` OFF a card-only PR IS counted, so it meets the cap too.
  if (excludeCardOnly !== false && isCardOnlyDiff(changedFiles)) {
    return { allowed: true, reason: 'exempt: card-only changeset (not counted toward the limit)', exempt: true, overridden: false };
  }
  if (globalOff) {
    return { allowed: true, reason: 'pr-limit is globally OFF (operator override)', exempt: false, overridden: true };
  }
  if (branchAllowed) {
    return { allowed: true, reason: `branch ${branch ?? '(unknown)'} is allow-listed (operator override)`, exempt: false, overridden: true };
  }
  if (forceOpen) {
    return { allowed: true, reason: `--force-open (${forceReason && String(forceReason).trim() ? forceReason : 'no reason given'})`, exempt: false, overridden: true };
  }
  if (openCount == null) {
    // Fail OPEN on an unavailable live count (a gh hiccup) — never let a transient read failure block a
    // land/dispatch; the count is a soft backpressure signal, not a hard safety gate.
    return { allowed: true, reason: 'open-PR count unavailable (gh read failed) — allowing (fail-open)', exempt: false, overridden: false };
  }
  if (Number.isFinite(limit) && openCount >= limit) {
    return {
      allowed: false,
      exempt: false,
      overridden: false,
      reason: `open-PR backpressure limit reached for ${repoKey}: ${openCount}/${limit} open agent-authored PRs not yet review:accepted${split} — land or review the existing ones first. An agent stops and reports here — exceptions are the operator's to grant (\`node scripts/operations/pr-limit.mjs allow --branch=<b> --reason=… --operator-quote="<verbatim>"\` from the operator's channel, never a worker or lane session; or \`pr-limit.mjs off\`)`,
    };
  }
  return { allowed: true, reason: `under limit (${openCount}/${limit})${split}`, exempt: false, overridden: false };
}

// ── OVERRIDE STATE — pure parse/serialize + a thin, injectable fs shell ────────────────────────────────────

/** A fresh, all-clear state — no global off, no branch allows, no history. */
export function emptyLimitState() {
  return { global: { off: false, reason: null, by: null, at: null, until: null }, branches: {}, history: [] };
}

/** Tolerant parse of the state-file text → a normalized state. NEVER throws — any unparseable/malformed
 *  content fails OPEN to {@link emptyLimitState} (enforcement stays ON), never the reverse. PURE. */
export function parseLimitState(text) {
  if (!text || !String(text).trim()) return emptyLimitState();
  let raw;
  try { raw = JSON.parse(text); } catch { return emptyLimitState(); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyLimitState();
  const g = raw.global && typeof raw.global === 'object' ? raw.global : {};
  const branchesRaw = raw.branches && typeof raw.branches === 'object' && !Array.isArray(raw.branches) ? raw.branches : {};
  const branches = {};
  for (const [name, v] of Object.entries(branchesRaw)) {
    if (!v || typeof v !== 'object') continue;
    branches[name] = {
      reason: v.reason != null ? String(v.reason) : null,
      by: v.by != null ? String(v.by) : null,
      at: v.at != null ? String(v.at) : null,
      until: v.until != null ? String(v.until) : null,
      // xfaz7ho's grant record — kept when present so a later write never strips an earlier grant's quote.
      ...(v.operatorQuote != null ? { operatorQuote: String(v.operatorQuote) } : {}),
      ...(v.channel != null ? { channel: String(v.channel) } : {}),
      ...(v.session != null ? { session: String(v.session) } : {}),
    };
  }
  return {
    global: {
      off: g.off === true,
      reason: g.reason != null ? String(g.reason) : null,
      by: g.by != null ? String(g.by) : null,
      at: g.at != null ? String(g.at) : null,
      until: g.until != null ? String(g.until) : null,
    },
    branches,
    history: Array.isArray(raw.history) ? raw.history.slice(-500) : [],
  };
}

/** Serialize a state object back to the store's JSON text (newline-terminated). PURE. */
export function serializeLimitState(state) {
  const s = state && typeof state === 'object' ? state : emptyLimitState();
  return JSON.stringify(s, null, 2) + '\n';
}

/** Parse a `--for=<duration>` value (`30m`, `2h`, `1d`) into milliseconds, or `null` for no expiry /
 *  unparseable input. PURE. */
export function parseDurationMs(text) {
  if (text == null) return null;
  const m = String(text).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const perUnit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return Math.round(n * perUnit[unit]);
}

/** Append one entry to the state's override history (capped at 500 — an advisory audit trail, not a
 *  ledger of record). Every override this module writes is logged with actor + reason, per #4075's
 *  requirement. PURE (the timestamp is injected, so this stays directly unit-testable). */
export function appendHistory(state, entry, now = Date.now()) {
  const s = state && typeof state === 'object' ? state : emptyLimitState();
  const rec = { at: new Date(now).toISOString(), actor: entry?.actor ?? null, reason: entry?.reason ?? null, action: entry?.action ?? 'unknown', target: entry?.target ?? null };
  return { ...s, history: [...(Array.isArray(s.history) ? s.history : []), rec].slice(-500) };
}

/** Set (or re-set) the global off-switch. `untilMs` (from {@link parseDurationMs}) becomes an absolute
 *  `until` timestamp; omitted/`null` means "off until explicitly cleared". PURE. */
export function setGlobalOff(state, { reason = null, by = null, untilMs = null } = {}, now = Date.now()) {
  const s = state && typeof state === 'object' ? state : emptyLimitState();
  const global = {
    off: true,
    reason: reason != null && String(reason).trim() ? String(reason).trim() : 'operator override',
    by: by != null && String(by).trim() ? String(by).trim() : null,
    at: new Date(now).toISOString(),
    until: untilMs != null ? new Date(now + untilMs).toISOString() : null,
  };
  return appendHistory({ ...s, global }, { actor: global.by, reason: global.reason, action: 'off', target: global.until ? `until ${global.until}` : 'indefinite' }, now);
}

/** Clear the global off-switch — back to enforced. PURE. */
export function clearGlobalOff(state, { by = null, reason = null } = {}, now = Date.now()) {
  const s = state && typeof state === 'object' ? state : emptyLimitState();
  const next = { ...s, global: { off: false, reason: null, by: null, at: null, until: null } };
  return appendHistory(next, { actor: by, reason: reason || 'operator re-armed the limit', action: 'on', target: null }, now);
}

/** Allow-list one branch (indefinitely, or until `untilMs` from now). PURE. `operatorQuote`/`channel`/`session`
 *  (xfaz7ho) are recorded on the entry when given; entries written without them (before xfaz7ho) stay valid —
 *  {@link isBranchAllowedNow} never reads them, the gate is at WRITE time ({@link authoriseAllow}). */
export function allowBranch(state, branch, { reason = null, by = null, untilMs = null, operatorQuote = null, channel = null, session = null } = {}, now = Date.now()) {
  const s = state && typeof state === 'object' ? state : emptyLimitState();
  const name = String(branch || '').trim();
  if (!name) return s;
  const entry = { reason: reason != null && String(reason).trim() ? String(reason).trim() : 'operator override', by: by || null, at: new Date(now).toISOString(), until: untilMs != null ? new Date(now + untilMs).toISOString() : null };
  if (operatorQuote) entry.operatorQuote = String(operatorQuote);
  if (channel) entry.channel = String(channel);
  if (session) entry.session = String(session);
  const next = { ...s, branches: { ...s.branches, [name]: entry } };
  return appendHistory(next, { actor: entry.by, reason: entry.reason, action: 'allow-branch', target: name }, now);
}

/** Normalize a branch/ref for allow-list comparison — a stored `--branch=4080-foo` matches a lane ref
 *  `lane/4080-foo` and vice versa (the leading `lane/` is a transport detail, not part of the identity a
 *  human names at the CLI). PURE. */
export function normalizeBranchName(b) {
  return String(b || '').trim().replace(/^lane\//, '');
}

/** Is the global off-switch CURRENTLY in effect (honouring `until` expiry — an expired off auto-re-arms
 *  enforcement, never needs a human to remember to run `on`)? PURE given `nowMs`. */
export function isGlobalOffNow(state, nowMs = Date.now()) {
  const g = state?.global;
  if (!g?.off) return false;
  if (!g.until) return true;
  const untilMs = Date.parse(g.until);
  return !Number.isFinite(untilMs) || nowMs < untilMs;
}

/** Is `branch` CURRENTLY allow-listed (honouring per-entry expiry)? PURE given `nowMs`. */
export function isBranchAllowedNow(state, branch, nowMs = Date.now()) {
  const name = normalizeBranchName(branch);
  if (!name) return false;
  const branches = state?.branches || {};
  const entry = branches[name] || Object.entries(branches).find(([k]) => normalizeBranchName(k) === name)?.[1];
  if (!entry) return false;
  if (!entry.until) return true;
  const untilMs = Date.parse(entry.until);
  return !Number.isFinite(untilMs) || nowMs < untilMs;
}

// ── WHO MAY GRANT AN EXCEPTION (xfaz7ho) ──────────────────────────────────────────────────────────────────

/** Max length of a recorded operator quote — it is stored verbatim, so it is bounded, not truncated silently. */
export const OPERATOR_QUOTE_MAX = 1000;

/**
 * May THIS caller allow-list `branch`? PURE given its inputs. Exceptions are the operator's to grant: twice on
 * 2026-10-10 a worker ran `pr-limit.mjs allow --branch=<its own branch>` and opened its PR past the limit
 * (#4786, #4779 — both ratified after the fact). The channel is DERIVED from what the harness and our own spawn
 * sites put in the environment and from where the command runs — never from an argv flag the caller sets:
 *   • `worker`  — `WE_CONVEYOR_WORKER=1` (every dispatch spawn site sets it, we:scripts/operations/session-role.mjs) → refused;
 *   • `unknown` — an unrecognised marker value → refused (fail closed, same as pre-pr-review's bypass gate);
 *   • `lane`    — run from inside a lane clone (`/.lanes/`), where every worker works → refused;
 *   • own branch — the target is the branch the calling checkout itself tracks → refused;
 *   • otherwise `operator-session` (a Claude session outside any lane) or `terminal` (no Claude env) — accepted
 *     only with a verbatim `--operator-quote`, recorded on the entry (the #2895 honesty tax).
 * Like review-independence (#2895), this is NOT unforgeable — an agent with a shell can `cd` out and unset vars.
 * What it buys: a self-grant now takes a deliberate evasion, and every grant and refusal is logged with its channel.
 * @returns {{ok:boolean, channel:string, refusal:string}}
 */
export function authoriseAllow({ branch, operatorQuote, env = {}, cwdReal = '', ownBranch = '' } = {}) {
  const STOP = 'An agent refused by the limit must stop and report; the operator grants exceptions.';
  const { role, reason } = classifySession(env);
  if (role === 'worker') return { ok: false, channel: 'worker', refusal: `pr-limit allow refused: this is a dispatched worker session (${reason}). ${STOP}` };
  if (role !== 'orchestrator') return { ok: false, channel: 'unknown', refusal: `pr-limit allow refused: the session role is unknown (${reason}), so the grant fails closed. ${STOP}` };
  if (String(cwdReal || '').includes('/.lanes/')) return { ok: false, channel: 'lane', refusal: `pr-limit allow refused: run from inside a lane clone (${cwdReal}) — that is where workers run; the operator grants from the primary checkout or a terminal. ${STOP}` };
  const target = normalizeBranchName(branch);
  const own = normalizeBranchName(String(ownBranch || '').replace(/^(refs\/remotes\/)?origin\//, ''));
  if (own && own === target) return { ok: false, channel: 'own-branch', refusal: `pr-limit allow refused: ${target} is this checkout's own branch — a session never allow-lists its own branch. ${STOP}` };
  const channel = env && env.CLAUDECODE ? 'operator-session' : 'terminal';
  const quote = typeof operatorQuote === 'string' ? operatorQuote.trim() : '';
  if (!quote) return { ok: false, channel, refusal: `pr-limit allow refused: --operator-quote="<the operator's instruction, verbatim>" is required — exceptions are the operator's to grant, and the grant records their words. ${STOP}` };
  if (quote.length > OPERATOR_QUOTE_MAX) return { ok: false, channel, refusal: `pr-limit allow refused: --operator-quote is over ${OPERATOR_QUOTE_MAX} characters — quote the instruction itself.` };
  return { ok: true, channel, refusal: '' };
}

/** The branch the checkout at `cwd` tracks (its upstream, else its current branch), or '' — fails soft. */
export function readOwnBranch(cwd) {
  for (const args of [['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], ['rev-parse', '--abbrev-ref', 'HEAD']]) {
    const r = gitRun('git', args, { cwd });
    const out = r.status === 0 ? String(r.stdout).trim() : ''; // not a git checkout, or no upstream — try the next read
    if (out && out !== 'HEAD' && out !== 'main' && out !== 'origin/main') return out;
  }
  return '';
}

function realpathSafe(p) { try { return realpathSync(p); } catch { return resolve(String(p || '.')); } }

// ── THIN FS SHELL (the boundary) ────────────────────────────────────────────────────────────────────────

/** The canonical store path: `WE_PR_LIMIT_STATE_FILE` override wins, else `~/.claude/conveyor/pr-limit.json`. */
export function resolveLimitStatePath(env = process.env, home = homedir()) {
  const override = env?.WE_PR_LIMIT_STATE_FILE;
  return override && String(override).trim() ? String(override).trim() : join(home, '.claude', 'conveyor', 'pr-limit.json');
}

/** Read + parse the store. FAILS OPEN: a missing/corrupt file reads as {@link emptyLimitState}
 *  (enforcement stays on) — never throws. */
export function readLimitState(path = resolveLimitStatePath()) {
  try {
    if (!existsSync(path)) return emptyLimitState();
    return parseLimitState(readFileSync(path, 'utf8'));
  } catch {
    return emptyLimitState();
  }
}

/** Write the store, ATOMICALLY (temp + rename) — a mid-write reader never observes partial JSON. */
export function writeLimitState(state, path = resolveLimitStatePath()) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, serializeLimitState(state));
  renameSync(tmp, path);
}

/** Is the global off-switch in effect RIGHT NOW, reading the live store — the one predicate `pr-land.mjs`
 *  and the dispatcher's intake hold consult. A bare `WE_PR_LIMIT_OFF=1` env var is an unconditional
 *  belt-and-braces global off too (no state-file write needed, e.g. for a CI run) — checked FIRST since it
 *  needs no fs read at all. */
export function isGlobalOffLive({ env = process.env, path = resolveLimitStatePath(env) } = {}) {
  if (String(env?.WE_PR_LIMIT_OFF || '') === '1') return true;
  return isGlobalOffNow(readLimitState(path));
}

/** Is `branch` allow-listed RIGHT NOW, reading the live store. */
export function isBranchAllowedLive(branch, { path = resolveLimitStatePath() } = {}) {
  return isBranchAllowedNow(readLimitState(path), branch);
}

// ── CLI — `node scripts/operations/pr-limit.mjs off|on|status|allow` (declared here, run from there too) ──

function parseFlags(argv) {
  const flags = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq === -1) flags[a.slice(2)] = true;
    else flags[a.slice(2, eq)] = a.slice(eq + 1);
  }
  return flags;
}

/** The CLI body, exported so `scripts/operations/pr-limit.mjs` can be a thin re-export (mirrors
 *  `dispatch-pause.mjs`'s own inline CLI, kept here since this module already owns every piece of state
 *  the CLI touches). */
export function runPrLimitCli(argv, { env = process.env, cwd = process.cwd(), path = resolveLimitStatePath(env), ownBranch, stderr = process.stderr, stdout = null } = {}) {
  const cmd = argv[0];
  const flags = parseFlags(argv.slice(1));
  const by = flags.by || env.USER || null;
  const out = (text) => (stdout ? stdout.write(text) : writeAllSync(1, text));
  if (cmd === 'allow') {
    if (!flags.branch || flags.branch === true) { stderr.write('usage: pr-limit.mjs allow --branch=<b> --reason=<why> --operator-quote="<operator instruction, verbatim>" [--for=<duration>] [--by=<actor>]\n'); return 2; }
    const session = currentActorId(env) || null;
    const decision = authoriseAllow({ branch: flags.branch, operatorQuote: flags['operator-quote'], env, cwdReal: realpathSafe(cwd), ownBranch: ownBranch ?? readOwnBranch(cwd) });
    if (!decision.ok) {
      // LOGGED: the refusal lands in the same override history every grant does, naming channel + session.
      writeLimitState(appendHistory(readLimitState(path), { actor: by, reason: `${decision.refusal} [channel=${decision.channel}${session ? ` session=${session}` : ''}]`, action: 'allow-refused', target: normalizeBranchName(flags.branch) }), path);
      stderr.write(`✗ ${decision.refusal}\n`);
      return 3;
    }
    const untilMs = parseDurationMs(flags.for);
    const state = allowBranch(readLimitState(path), flags.branch, { reason: flags.reason, by, untilMs, operatorQuote: String(flags['operator-quote']).trim(), channel: decision.channel, session });
    writeLimitState(state, path);
    stderr.write(`✓ branch ${normalizeBranchName(flags.branch)} allow-listed — ${state.branches[String(flags.branch).trim()]?.reason}${by ? ` (by ${by})` : ''} via ${decision.channel}; operator quote recorded\n`);
    out(JSON.stringify(state, null, 2) + '\n');
    return 0;
  }

  if (cmd === 'off') {
    const untilMs = parseDurationMs(flags.for);
    const state = setGlobalOff(readLimitState(path), { reason: flags.reason, by, untilMs });
    writeLimitState(state, path);
    process.stderr.write(`⏸ pr-limit OFF — ${state.global.reason}${state.global.until ? ` (until ${state.global.until})` : ''}${by ? ` (by ${by})` : ''}\n`);
    writeAllSync(1, JSON.stringify(state, null, 2) + '\n');
    return 0;
  }
  if (cmd === 'on') {
    const state = clearGlobalOff(readLimitState(path), { by, reason: flags.reason });
    writeLimitState(state, path);
    process.stderr.write(`▶ pr-limit ON — enforcement re-armed${by ? ` (by ${by})` : ''}\n`);
    writeAllSync(1, JSON.stringify(state, null, 2) + '\n');
    return 0;
  }
  if (cmd === 'status') {
    const state = readLimitState(path);
    const nowMs = Date.now();
    const counts = countOpenPrsAllRepos();
    const out = {
      globalOff: isGlobalOffNow(state, nowMs),
      global: state.global,
      branches: state.branches,
      counts,
      historyTail: state.history.slice(-10),
    };
    writeAllSync(1, JSON.stringify(out, null, 2) + '\n');
    return 0;
  }
  stderr.write('usage: pr-limit.mjs <off|on|status|allow> [--reason=<text>] [--for=<duration>] [--branch=<b>] [--operator-quote=<verbatim>] [--by=<who>]\n');
  return 2;
}

const IS_CLI = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (IS_CLI) process.exitCode = runPrLimitCli(process.argv.slice(2));
