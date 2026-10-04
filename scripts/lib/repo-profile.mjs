/**
 * @file scripts/lib/repo-profile.mjs
 * @description `repoProfile`/`gateFor` — multi-repo slice 1 (we:backlog/xjko7gy-multi-repo-slice-1-a-per-repo-
 *   profile.md, see we:reports/2026-09-23-conveyor-multi-repo-gap-map.md). Collapses the FIVE scattered per-repo
 *   vocabularies (internal key, gh slug, slug tag, backlog scope prefix, `check-standards` locus marker) each
 *   consumer re-derives today into ONE frozen profile per repo, and gives every repo ONE gate-command source.
 *
 * WHY A SEPARATE FILE FROM `./constellation-repos.mjs`, NOT ADDED THERE (this item's own scope names that file;
 * this is the deviation, and the reason). Several operations declared READ-ONLY — `gate-health-io.mjs`,
 * `operator-queue.mjs`'s `dispatch-eligibility.mjs` chain — already import `constellation-repos.mjs` for its
 * plain data table, and a STATIC import-graph guard (`scripts/operations/__tests__/{gate-health,http-adapter}
 * .test.mjs`, using `__tests__/import-graph.mjs`) asserts their whole module graph reaches ZERO `node:` built-ins.
 * `gateFor` needs real IO — `verify-lane-gate.mjs#composeGate`, `homedir()`, a checkout's `package.json` — to do
 * its job; adding it to `constellation-repos.mjs` would hand every one of those read-only consumers a transitive
 * IO capability they are asserted never to have (confirmed live: doing so tripped both guards, plus a THIRD,
 * unrelated-looking failure — `operator-queue-entry.test.mjs`'s symlink tests — because that suite stages a
 * synthetic checkout containing only the files `operator-queue.mjs` is KNOWN to need, and a new static import
 * of `verify-lane-gate.mjs` from `constellation-repos.mjs` is a file that synthetic checkout never staged, so the
 * child process crashed on a missing module). Splitting the file is a smaller, safer change than teaching three
 * unrelated tests about a dependency they exist to keep out. `CONSTELLATION_REPOS`/`repoKeyForSlug` are imported
 * FROM `constellation-repos.mjs` (still the one source of the table itself); this file is never imported BACK
 * from there — a re-export would be its own `from`-clause and the same static scanner would still follow it,
 * defeating the split.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONSTELLATION_REPOS, repoKeyForDir, repoKeyForSlug } from './constellation-repos.mjs';

// This module's OWN checkout root — the `we` entry's `path: ''` means "wherever this file is physically
// checked out" (the primary checkout or a lane clone of it), never a fixed location. Computed once from
// `import.meta.url` rather than `process.cwd()` so it is right even when this module is `import`-ed from a
// caller running elsewhere (mirrors the `REPO_ROOT` convention every `scripts/operations/*-io.mjs` shell uses).
const WE_CHECKOUT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// The backlog-scope / `check-standards` locus-marker prefixes that mean each repo (`LOCUS_MARKER_RE` and the
// `LOCI` table in we:scripts/check-standards-rules.mjs): the short tag, plus the repo's full name.
const SCOPE_PREFIXES = Object.freeze({
  we: Object.freeze(['we', 'webeverything']),
  frontierui: Object.freeze(['fui', 'frontierui']),
  'plateau-app': Object.freeze(['plateau', 'plateau-app']),
});

// The prefix each repo's own backlog cards actually write today (grepped `backlog/*.md`, 2026-09-23):
// `we:` 31513 vs `webeverything:` 5; `fui:` 4147 vs `frontierui:` 281; `plateau:` 1667 vs `plateau-app:` 1436.
const CANONICAL_PREFIX = Object.freeze({ we: 'we', frontierui: 'fui', 'plateau-app': 'plateau' });

// TODAY'S truth. `review` is true everywhere already; multi-repo slice 5 (`we:backlog/3966-*.md`) turned `fix`
// on for the couple-repos — `reconcile-fix-dispatch.mjs#runReconcileFixDispatch` dispatches a real fix agent
// for frontierui/plateau-app rather than recording `unsupported-repo`. Multi-repo slice 7 (`we:backlog/3967-
// *.md`) turns `ciHeal` on the same way, independently of `fix` — `reconcile-core.mjs#planReconcile` now plans
// a durable `kind:'ci-heal'` entry for ANY repo's red CI, capped by `countCiHealComments`, and
// `we:scripts/operations/ci-heal-pr-dispatch.mjs#runReconcileCiHealDispatch` is the capability-gated dispatcher
// that reads it — mirroring `runReconcileFixDispatch`'s own gate for `fix` exactly.
const CAPABILITIES = Object.freeze({
  we: Object.freeze({ review: true, fix: true, ciHeal: true, build: 'direct' }),
  frontierui: Object.freeze({ review: true, fix: true, ciHeal: true, build: 'couple' }),
  'plateau-app': Object.freeze({ review: true, fix: true, ciHeal: true, build: 'couple' }),
});

// A scope prefix or full name that is not already a key/slug/slugTag (those are covered by `repoKeyForSlug` /
// `slugTag` lookups below) — the remaining aliases `SCOPE_PREFIXES` introduces.
const PREFIX_ALIASES = Object.freeze({ webeverything: 'we', fui: 'frontierui', plateau: 'plateau-app' });

/**
 * Resolve ANY of the vocabularies `repoProfile`/`gateFor` accept to an internal repo KEY, or `null` for anything
 * unrecognized. Never throws. PURE.
 * @param {unknown} input
 * @returns {string|null}
 */
function resolveProfileKey(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  const stripped = raw.endsWith(':') ? raw.slice(0, -1) : raw;
  if (!stripped) return null;
  const bySlugOrKey = repoKeyForSlug(stripped);
  if (bySlugOrKey !== null) return bySlugOrKey;
  for (const [key, meta] of Object.entries(CONSTELLATION_REPOS)) {
    if (meta.slugTag && meta.slugTag === stripped) return key;
  }
  return Object.hasOwn(PREFIX_ALIASES, stripped) ? PREFIX_ALIASES[stripped] : null;
}

/**
 * The ONE per-repo profile — key, slug, slugTag, the expanded checkout path, what `lane-pool.mjs --repo=`
 * expects, every backlog-scope/locus prefix that means this repo, the dominant one to WRITE, and today's
 * capabilities. Accepts a repo key (`we`/`frontierui`/`plateau-app`), a gh slug (`plateauapp/plateau-app`), a
 * slug tag (`fui`/`pa`), or a scope prefix (`we`/`fui`/`frontierui`/`plateau`/`plateau-app`), with or without a
 * trailing `:`. Returns `null` for anything unrecognized — NEVER throws. Frozen. PURE given `home`.
 *
 * `lanePoolRepo` is what `lane-pool.mjs --repo=` expects — this value is interpolated straight into a brief's
 * `--repo=${laneRepo}`, so it must be a real, shell-safe token. It is ALWAYS `checkoutPath` (an absolute,
 * `$HOME`-expanded path), for `we` exactly as much as for a sibling repo.
 *
 * Landing-freeze fix (lane-leftover-reclaim) — `we` used to be the literal `'.'` here (`lane-pool.mjs`'s own
 * cwd-toplevel default), on the assumption that whatever process fills a brief with this value is running
 * FROM the WE checkout, so a relative `.` resolves to it. #4174 broke that assumption for every DISPATCHED
 * session: its cwd is a scratch directory OUTSIDE the checkout (`dispatch-lane-io.mjs#dispatchSessionCwd`),
 * chosen deliberately so a stray file the agent writes before it has a lane of its own never dirties the
 * checkout that dispatched it. A brief's ONE pre-lane command — `acquire --repo=${LANE_REPO}` — still ran with
 * `--repo=.`, which from a scratch cwd resolves to THAT scratch directory, not the checkout; live-caught
 * 2026-09-26 (ci-heal-2783's own transcript): `acquire --repo=.` failed to find the repo at all. An absolute
 * path is correct in EVERY caller: it is exactly the same location `.` would have resolved to for a caller
 * whose cwd already was the checkout (the common case before #4174, and still true for every non-brief
 * internal caller — `tick-core.mjs`/`reconcile-fix-dispatch.mjs`/`ci-heal-pr-dispatch.mjs` all still run with
 * cwd = the checkout), so this is a strictly more robust superset, never a behavior change for any caller that
 * already worked.
 * @param {unknown} keyOrSlugOrPrefix
 * @param {{home?: string}} [o] - `home` is injectable (mirrors `planReviewDispatch`'s own `home` param) so a
 *   test can resolve a sibling checkout path without touching the real `$HOME`.
 * @returns {{
 *   key: string, slug: string, slugTag: string, checkoutPath: string, lanePoolRepo: string,
 *   scopePrefixes: string[], canonicalPrefix: string,
 *   capabilities: {review: boolean, fix: boolean, ciHeal: boolean, build: 'couple'|'direct'},
 * }|null}
 */
export function repoProfile(keyOrSlugOrPrefix, { home = homedir() } = {}) {
  const key = resolveProfileKey(keyOrSlugOrPrefix);
  if (key === null) return null;
  const meta = CONSTELLATION_REPOS[key];
  const checkoutPath = key === 'we' ? WE_CHECKOUT_ROOT : resolve(meta.path.replace(/^\$HOME(?=\/|$)/, home));
  const lanePoolRepo = checkoutPath;
  return Object.freeze({
    key,
    slug: meta.slug,
    slugTag: meta.slugTag,
    checkoutPath,
    lanePoolRepo,
    scopePrefixes: SCOPE_PREFIXES[key],
    canonicalPrefix: CANONICAL_PREFIX[key],
    capabilities: CAPABILITIES[key],
  });
}

/**
 * The gate command a dispatched fix / ci-heal agent runs in its lane (`{{GATE_COMMAND}}`) for a constellation
 * repo. xpnhz4o — it is `node <WE root>/scripts/verify-lane.mjs run --repo=.`: WE's own diff-selected gate
 * (`verify-lane-gate.mjs#resolveDefaultGate`, which already builds only the halves the target checkout's npm
 * scripts support, #3919), run against the agent's cwd, with no verification marker. Before this it was the
 * bare `npm run test:unit && npm run check:standards`, i.e. the FULL suite for every fix — observed 2026-09-25 as
 * several 10+ minute runs at once starving the host. The WE root is always this checkout's own root (the
 * dispatcher's current code), so a lane on an older base still gets today's selection policy.
 * Returns `null` when the profile is unknown OR the checkout does not exist (never throws). `readPackageJson`
 * is still accepted (and ignored) for call-site compatibility — script detection now happens inside verify-lane.
 * @param {unknown} keyOrSlugOrPrefix
 * @param {{home?: string, checkoutExists?: (p: string) => boolean, readPackageJson?: (p: string) => string, weRoot?: string}} [o]
 * @returns {string|null}
 */
export function gateFor(keyOrSlugOrPrefix, { home, checkoutExists = existsSync, weRoot = WE_CHECKOUT_ROOT } = {}) {
  const profile = repoProfile(keyOrSlugOrPrefix, { home });
  if (!profile) return null;
  if (!checkoutExists(profile.checkoutPath)) return null;
  return `node ${join(weRoot, 'scripts', 'verify-lane.mjs')} run --repo=.`;
}

/**
 * The FIVE `{{REPO}}`/`{{LANE_REPO}}`/`{{GATE_COMMAND}}`/`{{WE_ROOT}}`/`{{ATTRIBUTION}}` conveyor-brief
 * placeholders (multi-repo slice 4, `we:backlog/3960-*.md`) computed together from ONE profile, so
 * `dispatchFix`/`dispatchCiHeal` (`we:scripts/conveyor/reconcile-fix-dispatch.mjs`,
 * `we:scripts/operations/ci-heal-pr-dispatch.mjs`) never re-derive any of them a second, possibly-diverging way.
 *
 * `WE_ROOT` is ALWAYS this checkout's own root, regardless of which repo is being profiled — the tools a
 * fix/ci-heal brief runs (`rearm-review.mjs`, `stand-down.mjs`, `ci-heal-mark.mjs`, `lane-pool.mjs`, …) live only
 * in WE, never in the target repo, so a brief needs WE's location even when repairing a sibling repo's PR.
 *
 * `ATTRIBUTION` folds in the item/PR-only distinction the gap-map's "Proposed design C"
 * (`we:reports/2026-09-23-conveyor-multi-repo-gap-map.md`) names for a future item-less fix (slice 6, not wired
 * yet): an item-carrying dispatch (today, every fix/ci-heal) is `<REPO-TAG> #<item>` — `profile.canonicalPrefix`
 * upper-cased, so for `we` this is `WE #<item>`, reproducing the commit-title prefix both briefs hardcoded
 * before this slice, byte-for-byte; a PR with no backlog item is `PR #<pr>`.
 *
 * Returns `null` when the profile is unknown OR its gate is unresolvable (mirrors {@link gateFor}'s own
 * fail-closed shape) — the caller decides what that means. As of multi-repo slice 5, `dispatchFix` reaches this
 * for frontierui/plateau-app too (their `capabilities.fix` is now true — see `runReconcileFixDispatch`'s own
 * capability check); `ci-heal` still only ever reaches this for `we` (its capability stays off elsewhere until
 * slice 7). WE's own checkout always resolves, so the `null` branch there is exercised only by tests.
 * @param {unknown} keyOrSlugOrPrefix
 * @param {{itemNum?: (string|number|null), prNum?: (string|number|null), home?: string,
 *   checkoutExists?: (p: string) => boolean, readPackageJson?: (p: string) => string}} [o] - `itemNum`/`prNum`
 *   feed `ATTRIBUTION` only; `home`/`checkoutExists`/`readPackageJson` are injectable exactly as
 *   {@link repoProfile}/{@link gateFor} take them (so a test can resolve a sibling repo's tokens without
 *   touching the real filesystem).
 * @returns {{REPO: string, LANE_REPO: string, GATE_COMMAND: string, WE_ROOT: string, ATTRIBUTION: string}|null}
 */
/**
 * xftsbsg (epic #3383) — WHICH REPO a dispatch's own repo-qualified `scope:` names, so a caller that only has
 * the scope (never a resolved lane path — this is asked BEFORE `lane-pool.mjs acquire` has run, at the exact
 * point `we:scripts/operations/dispatch-lane-io.mjs#dispatchLaneGrant` pre-grants a lane directory) can tell
 * `we` apart from `frontierui`/`plateau-app` instead of assuming `we` unconditionally.
 *
 * Accepts the same shape `we:scripts/operations/dispatch-lane-io.mjs#findItem` already hands through on the
 * payload — an array of repo-qualified scope strings (`['plateau-app:src/...', ...]`) — or a single string
 * (a caller that already joined it, or a bare one-entry scope). Reads the FIRST entry whose prefix resolves to
 * a real repo profile; a scope with no entries, or whose entries carry no `<repo>:` prefix this table
 * recognizes, returns `null` (never a guess) so the caller can fall back to its OWN existing default rather
 * than this function silently choosing one. PURE.
 * @param {string|string[]|null|undefined} scope
 * @returns {string|null}
 */
export function repoKeyForScope(scope) {
  const entries = Array.isArray(scope) ? scope : (scope == null ? [] : [scope]);
  for (const raw of entries) {
    const s = String(raw ?? '');
    const i = s.indexOf(':');
    if (i <= 0) continue;
    const key = resolveProfileKey(s.slice(0, i));
    if (key !== null) return key;
  }
  return null;
}

/** Pure delivery capability data, shared by admission and the wrapper backstop. */
export function deliveryLocusForScope(scope) {
  const entries = String(scope ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  const keys = [...new Set(entries.map((entry) => repoKeyForScope(entry) ?? 'we'))];
  if (!keys.length) keys.push('we');
  return { multiRepo: keys.length > 1, keys };
}

/**
 * xftsbsg (epic #3383) — THE REAL PRIMARY CHECKOUT a lane clone's own absolute PATH belongs to, given nothing
 * but that path: the pool-dir basename directly above `lane-<N>` (`.lanes/<basename>/lane-<N>`) is exactly
 * what {@link ../lib/constellation-repos.mjs#repoKeyForDir} already maps to a repo key, and {@link repoProfile}
 * turns that key into the checkout the Codex sandbox deny-map needs to seal off — the repo's OWN live primary
 * checkout (which routinely holds another session's in-flight uncommitted work), not whichever repo the
 * dispatching process itself happens to be checked out from.
 *
 * Returns `null` for a path this cannot place (an unrecognized pool-dir basename, or a path with no parent
 * segment at all — e.g. a synthetic path a test hands in) — the caller decides what that means; every existing
 * caller today falls back to its own current default (this repo's own `REPO_ROOT`), so a `null` here is
 * byte-identical to before this function existed. PURE.
 * @param {string} lanePath
 * @param {{home?: string}} [o]
 * @returns {string|null}
 */
export function primaryCheckoutForLanePath(lanePath, { home } = {}) {
  return repoProfileForLanePath(lanePath, { home })?.checkoutPath ?? null;
}

/**
 * build-path-codex-isolation-locus — THE FULL PROFILE (not just the checkout path) for a lane clone's own
 * absolute PATH, given nothing else. Generalizes {@link primaryCheckoutForLanePath}'s own pool-dir-basename
 * lookup (unchanged — same `repoKeyForDir`/`repoProfile` calls) so a caller that needs the repo's `key` or
 * `canonicalPrefix` — e.g. `deliver-item-wrapper.mjs#commitBuildTurn`'s commit-subject prefix, which must say
 * `PLATEAU #<item>` for a plateau-app lane rather than an always-`WE` literal — has one shared lookup to call
 * instead of re-deriving the pool-dir-basename math a second time. Returns `null` under the exact same
 * conditions {@link primaryCheckoutForLanePath} already did (an unrecognized pool-dir basename, or no parent
 * segment at all) — never throws. PURE.
 * @param {string} lanePath
 * @param {{home?: string}} [o]
 * @returns {ReturnType<typeof repoProfile>}
 */
export function repoProfileForLanePath(lanePath, { home } = {}) {
  const poolDirBasename = basename(dirname(String(lanePath ?? '')));
  const key = repoKeyForDir(poolDirBasename);
  if (key === null) return null;
  return repoProfile(key, { home });
}

export function briefTokensForRepo(keyOrSlugOrPrefix, { itemNum = null, prNum = null, home, checkoutExists, readPackageJson } = {}) {
  const profile = repoProfile(keyOrSlugOrPrefix, { home });
  if (!profile) return null;
  const gateCommand = gateFor(keyOrSlugOrPrefix, { home, checkoutExists, readPackageJson });
  if (!gateCommand) return null;
  const item = itemNum === null || itemNum === undefined || String(itemNum).trim() === '' ? null : String(itemNum).trim();
  const attribution = item ? `${profile.canonicalPrefix.toUpperCase()} #${item}` : `PR #${prNum}`;
  return Object.freeze({
    REPO: profile.slug,
    LANE_REPO: profile.lanePoolRepo,
    GATE_COMMAND: gateCommand,
    WE_ROOT: WE_CHECKOUT_ROOT,
    ATTRIBUTION: attribution,
  });
}
