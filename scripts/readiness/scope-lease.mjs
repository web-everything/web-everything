/**
 * @file scripts/readiness/scope-lease.mjs
 * @description Scope-lease + conflict-policy engine (WE epic #2560, slice 1 — DATA MODEL + POLICY only).
 *   The PURE model behind the scope-lease board (plateau-app `docs/backlog-console-design.md` §3i) and the
 *   ratified scope-breach recovery table (§3i-A4, WE decision #2574). No fs, no child_process, no `Date` — a
 *   later slice wires these into the live `lane-pool.mjs` acquire/release path; this slice is just the logic
 *   plus its unit proof.
 *
 * THE §3i MODEL (kept faithful):
 *   • PREDICTED scope = module/glob-level OR file-level, authored by the prepare agent at plan time (advisory —
 *     see below). Each entry is classified by GRANULARITY ({@link isSubtreeEntry}): a SUBTREE (glob, or a
 *     trailing-slash / bare directory) leases the whole tree; a FILE (an extension-bearing path) leases only
 *     that one path. See the #2679 note below.
 *   • OBSERVED scope  = file-level, the lane's live `git diff --name-only` set (the CLI supplies it).
 *   • BREACH          = observed files that fall OUTSIDE the predicted scope (a generalized set difference:
 *     "outside" is decided by pattern coverage, since predicted entries are module/globs, not exact paths).
 *   • Two conflict knobs are POLICIES, never fixed rules:
 *       overlap-at-launch  ∈ { wait (default), ask, force }         → {@link overlapAtLaunch}
 *       breach-mid-build   ∈ { pause, park, resolve-at-drain }      → {@link breachOutcome}
 *
 * FILE-LEVEL LEASE GRANULARITY (WE #2679 — a parallelism lever under the throughput program #2606):
 *   The coverage/overlap matchers are GRANULARITY-AWARE. A NARROW scope (one that names specific files) leases
 *   at FILE granularity, so two lanes touching DISJOINT files that merely share a directory no longer serialize
 *   on that shared prefix — the exact false positive #2673/#2679 hit (`we:scripts` over-serializing unrelated
 *   `we:scripts/...` work). A BROAD scope (a glob or a bare/trailing-slash directory) still leases the whole
 *   subtree, so a genuinely-spanning declaration — or a real same-file dependency like #2440↔#2669 both editing
 *   `we:scripts/lib/pr-merge-gate.mjs` — still contends, correctly. The classifier is conservative: it only
 *   calls a path a FILE when it is confidently file-shaped, and the matchers keep a directory-ancestor fallback,
 *   so finer granularity NEVER misses a real overlap (it can only ever err toward over-serializing). This
 *   REFINES the ADVISORY signal's resolution; it is NOT a per-file LOCK — reconcile with Fork 1 below.
 *   (The upstream half — authoring `scope:` as narrowly as correctness allows — is #2619, in the readiness flow.)
 *
 * §3i-A4 (RATIFIED 2026-07-20) — what this module encodes verbatim:
 *   • Fork 1: the ENFORCEMENT UNIT is the whole-clone lease (`lane-pool.mjs` acquire/release + the `.lane-lease`
 *     marker in `../lib/lane-lease.mjs`). Predicted file-scope is an ADVISORY breach signal, NOT a second lock;
 *     git is the ground-truth conflict detector at drain. So everything here is advisory scheduling data — it
 *     never gates a write on its own. Per-file leases were rejected AS A LOCK — and they remain rejected as a
 *     lock. #2679's file granularity is a finer resolution of this SAME advisory signal (which sibling to hold
 *     back at launch / which breach to flag), never a second enforcement unit; the whole-clone lease stays the
 *     one and only real lock.
 *   • Fork 2: A4's default transition is RETRY-IN-PLACE / re-plan within scope (drop the out-of-scope edit,
 *     finish the in-lease work). Its escalation ladder = widen-lease → hand-off-to-cross-lane → bounce/quarantine
 *     ({@link BREACH_ESCALATION_LADDER}). Retry bound (jury amendment): the escalation trigger is a TOTAL attempt
 *     counter, NOT "breaches the same scope twice" — a re-plan that breaches a DIFFERENT out-of-scope file each
 *     attempt must still escalate, or it livelocks. Retry-once-then-escalate, never retry-forever.
 *   • Fork 3: a hold carries an explicit `holdSource ∈ { user, policy, sibling-lane }`; unhold authority follows
 *     the source. `pause` (breach files belong to another live lease) is a `sibling-lane` hold; `park` (policy
 *     decided to surface it) is a `policy` hold that renders as an amber you-card.
 *
 * HOW THIS COMPOSES (fidelity to the existing system beats a fresh model):
 *   • Repo-qualified paths ("<repo>:<path>") are the SAME convention as `lane-partition.mjs` `filesOf` and
 *     `overlap-chain.mjs` — the same path in two repos never collides, a genuine same-repo overlap always does.
 *   • The exact-set primitive `disjoint` is REUSED from `lane-partition.mjs` (not re-implemented) for the
 *     file-level fast paths.
 *   • `lane-partition.disjoint` / `overlap-chain.intersects` operate on EXACT paths. Predicted scope is
 *     module/glob-level, so exact-set intersection UNDER-matches (a `src/foo/**` lease vs a `src/foo/bar.ts`
 *     candidate would read as disjoint). This module therefore MIRRORS the `intersects` contract with a
 *     coverage-aware matcher ({@link coversFile} / {@link scopeEntriesOverlap}) rather than reusing it — there
 *     is no glob/match helper anywhere in `scripts/` to reuse (searched: no minimatch/micromatch/picomatch).
 */

import { disjoint } from './lane-partition.mjs';

// ── path / scope-pattern primitives ────────────────────────────────────────────────────────────────────────

/** Normalize a file/scope list → deduped array of non-empty repo-qualified strings. Mirrors
 *  `overlap-chain.mjs` `normFiles` (not exported there) — same contract, kept in sync by the test. */
export function normScope(list) {
  return [...new Set((Array.isArray(list) ? list : []).filter(Boolean).map((f) => String(f)).filter(Boolean))];
}

/** Split a repo-qualified path into `[repo, path]` (repo `null` when unqualified). Mirrors the first-colon
 *  split in `lane-partition.isMergeRiskFile`, so the two agree on what "<repo>:<path>" means. */
function splitRepo(s) {
  const str = String(s);
  const i = str.indexOf(':');
  return i < 0 ? [null, str] : [str.slice(0, i), str.slice(i + 1)];
}

/**
 * Classify a scope entry's GRANULARITY (WE #2679 — file-level leases for narrow scopes). A scope entry is
 * either a SUBTREE (it leases a whole directory tree — the coarse, prefix-holding form) or a FILE (it leases
 * exactly one path — the fine, narrow form that lets scope-disjoint work merely SHARING a directory run in
 * parallel instead of serializing on the shared prefix). This distinction is the crux of #2679: a narrow scope
 * must lease at file granularity, not hold the whole subtree it happens to sit under.
 *
 * An entry is a SUBTREE when it is EXPLICITLY directory- or pattern-shaped:
 *   • a trailing slash (`we:scripts/lib/`) — the explicit "this whole directory" marker; OR
 *   • a glob (`*` / `?`, e.g. `we:src/**` or `we:src/*.ts`) — a pattern spanning many files; OR
 *   • a bare last segment with NO file extension (`we:src/backlog-view`, `we:scripts`) — the module-level
 *     reading of a directory-ish entry (§3i's implicit "module-level" form, kept faithful).
 * Otherwise the entry names a FILE: its last segment carries an extension (`we:scripts/backlog.mjs`,
 * `we:src/list.ts`, or a dotfile like `we:.gitignore`) — and it leases ONLY that exact path.
 *
 * CONSERVATIVE BY CONSTRUCTION — the classifier only calls a path a FILE when it is confidently file-shaped (an
 * extension on its last segment). It CANNOT tell a dotted DIRECTORY (`.github`, `src/foo.v2`) with no trailing
 * slash from a dotfile (`.gitignore`) by name alone, so such a directory is misclassified as a FILE. Two guards
 * keep that safe:
 *   • OVERLAP detection ({@link scopeEntriesOverlap}) keeps a `segmentRelated` directory-ancestor fallback on
 *     the literal roots, so a misclassified dotted directory vs a glob/file BENEATH it still contends — overlap
 *     detection never misses a real parent↔child conflict (the "preserve correct overlap detection" invariant).
 *   • BREACH detection ({@link coversFile}) treats a FILE entry as its exact path only, so a dotted directory
 *     declared as PREDICTED scope may over-flag its own children as out-of-scope breaches. That is the SAFE
 *     direction (a false breach at worst triggers a needless retry-in-place/pause, never a missed conflict) and
 *     the price of removing the pre-#2679 file-as-prefix over-match; declare such a directory WITH a trailing
 *     slash (`.github/`) to lease it as a subtree and avoid the false breach.
 */
export function isSubtreeEntry(entry) {
  const [, p] = splitRepo(entry);
  if (p.endsWith('/')) return true; // explicit directory marker
  if (/[*?]/.test(p)) return true; // a glob spans many files
  const seg = p.slice(p.lastIndexOf('/') + 1); // the last path segment
  return !/\.[^./]+$/.test(seg); // no extension on the last segment ⇒ a bare directory (subtree)
}

/** Coverage test for a SUBTREE entry (a glob pattern, or a bare/trailing-slash directory prefix) over a
 *  repo-relative observed path. Two shapes, per §3i "predicted scope is module/glob-level":
 *    • GLOB (contains `*`/`?`): `**` = any chars incl `/`; `*` = any chars except `/`; `?` = one non-`/`.
 *    • DIRECTORY PREFIX (no wildcard): matches the exact path OR anything UNDER it (`src/backlog-view` covers
 *      `src/backlog-view/foo.ts`). A trailing slash is just the directory marker and is stripped first. */
function subtreeTest(patternPath) {
  const p = patternPath.replace(/\/$/, ''); // a trailing slash is just a directory marker
  if (/[*?]/.test(p)) {
    const rx = '^' + p
      .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex metachars (NOT * ? — handled next)
      // convert the glob wildcards in ONE pass — alternation matches `**` before `*`, so no placeholder
      // sentinel is needed: `**` → `.*` (crosses path segments) · `*` → `[^/]*` (within a segment) ·
      // `?` → `[^/]` (one non-slash char).
      .replace(/\*\*|\*|\?/g, (m) => (m === '**' ? '.*' : m === '*' ? '[^/]*' : '[^/]')) + '$';
    const re = new RegExp(rx);
    return (f) => re.test(f);
  }
  return (f) => f === p || f.startsWith(p + '/');
}

/** Does a predicted scope entry COVER an observed file? Both repo-qualified; the repo must match first (a
 *  `we:` lease never covers a `frontierui:` file — the constellation-disjointness `filesOf` relies on).
 *  Granularity-aware (WE #2679):
 *    • a SUBTREE entry covers the exact path OR anything UNDER it (glob → its pattern; bare dir → prefix);
 *    • a FILE entry covers ONLY its exact path — it does NOT synthesize a subtree beneath a file. This removes
 *      the pre-#2679 latent over-match where a file entry `foo.mjs` wrongly "covered" a deeper `foo.mjs/x`,
 *      which mattered for breach detection ({@link scopeLease}/{@link breachOf}). */
export function coversFile(pattern, file) {
  const [pr, pp] = splitRepo(pattern);
  const [fr, fp] = splitRepo(file);
  if (pr !== fr) return false;
  if (isSubtreeEntry(pattern)) return subtreeTest(pp)(fp);
  return fp === pp; // FILE entry — exact path only, never a synthetic subtree
}

/** The literal (wildcard-free) leading path of a pattern — its "module root". Used to decide SUBTREE↔SUBTREE
 *  overlap at LAUNCH, when only predicted (glob/dir) scope exists on both sides and neither is an exact file. */
function litRoot(pattern) {
  const [r, p] = splitRepo(pattern);
  const lit = p.match(/^[^*?]*/)[0].replace(/\/$/, '');
  return [r, lit];
}

/** Path-segment relation on two repo-relative literal paths: EQUAL, or one is a directory ANCESTOR of the
 *  other (`a/b` ↔ `a/b/c`), or either side is empty (a leading-wildcard glob root that spans everything). This
 *  is the ONLY relation that can hold between a directory and something inside it, and it is the safety net that
 *  guarantees overlap detection NEVER misses a real parent↔child conflict — whatever the granularity classifier
 *  decided about a dotted-directory name (`.github`, `src/foo.v2`). It is NEVER true for two genuinely-distinct
 *  files (a real file can never be a path-segment ancestor of another path). */
function segmentRelated(a, b) {
  const x = a.replace(/\/$/, '');
  const y = b.replace(/\/$/, '');
  return x === y || x.startsWith(y + '/') || y.startsWith(x + '/') || x === '' || y === '';
}

/** Do two scope entries overlap (their leases contend)? Same repo first, then GRANULARITY-AWARE (WE #2679):
 *    • FILE ↔ FILE       → contend ONLY if they name the same path. Disjoint files under a shared directory do
 *                          NOT contend — the parallelism this story unlocks.
 *    • FILE ↔ SUBTREE    → contend if the subtree COVERS the file ({@link coversFile}).
 *    • SUBTREE ↔ SUBTREE → contend if their module-roots are in a path-segment relation — the pre-#2679
 *                          behavior, preserved so a genuinely-spanning declaration still serializes.
 *  Implemented as coverage-in-either-direction ({@link coversFile}, at each entry's authored granularity) OR a
 *  {@link segmentRelated} fallback on the wildcard-free ROOTS. The fallback is what makes finer granularity
 *  SAFE: it catches every genuine parent↔child overlap the coverage test can't (a directory declared without a
 *  trailing slash — dotted or not — vs a glob/file beneath it), so the classifier can only ever err toward
 *  OVER-serializing, never toward a missed conflict. MIRRORS `overlap-chain.intersects` (list-membership
 *  overlap) generalized to module patterns — see the file header for why exact-set `intersects`/`disjoint`
 *  under-matches here. */
export function scopeEntriesOverlap(x, y) {
  const [rx] = splitRepo(x);
  const [ry] = splitRepo(y);
  if (rx !== ry) return false; // different repos never contend
  // Coverage handles FILE-in-SUBTREE + glob matches at the authored granularity (and same-file/exact for two
  // files); the segment-ancestor fallback on the literal roots catches directory↔child overlaps coverage misses.
  if (coversFile(x, y) || coversFile(y, x)) return true;
  const [, rootX] = litRoot(x);
  const [, rootY] = litRoot(y);
  return segmentRelated(rootX, rootY);
}

/** Do two predicted scopes (arrays of module/glob entries) overlap at all? */
export function scopesOverlap(scopeA, scopeB) {
  const a = normScope(scopeA);
  const b = normScope(scopeB);
  return a.some((x) => b.some((y) => scopeEntriesOverlap(x, y)));
}

// ── (1) the scope-lease model: predicted (plan) vs observed (lane diff) → breach ────────────────────────────

/**
 * The scope-lease of one lane's work stream.
 * @param {string[]} predictedFiles  module/glob-level, repo-qualified — the prepare-agent's planned scope.
 * @param {string[]} observedFiles   file-level, repo-qualified — the lane's live changed set (git diff).
 * @returns {{predicted:string[], observed:string[], inScope:string[], breach:string[], clean:boolean}}
 *   `breach` = observed files covered by NO predicted entry (the §3i "breach = their difference", generalized
 *   from raw set-difference to pattern coverage because predicted is module-level). `clean` ⇒ no breach.
 *   ADVISORY only (§3i-A4 Fork 1) — the whole-clone lease is the real lock; this is a scheduling signal.
 */
export function scopeLease(predictedFiles, observedFiles) {
  const predicted = normScope(predictedFiles);
  const observed = normScope(observedFiles);
  const inScope = observed.filter((f) => predicted.some((p) => coversFile(p, f)));
  const breach = observed.filter((f) => !predicted.some((p) => coversFile(p, f)));
  return { predicted, observed, inScope, breach, clean: breach.length === 0 };
}

/** Convenience: just the breach set of predicted-vs-observed (the input `breachOutcome` consumes). */
export function breachOf(predictedFiles, observedFiles) {
  return scopeLease(predictedFiles, observedFiles).breach;
}

// ── (2) overlap-at-launch policy ────────────────────────────────────────────────────────────────────────────

/** Valid overlap-at-launch policy tokens (§3i). */
export const OVERLAP_POLICIES = Object.freeze(['wait', 'ask', 'force']);

/**
 * Decide whether work may launch given the scopes it would touch vs the active leases (§3i launch rule: "work
 * starts only where its scope doesn't intersect an active lease"). Composes with the overlap machinery by
 * MIRRORING `overlap-chain.intersects` at module-pattern granularity ({@link scopesOverlap}).
 *
 * @param {string[]} candidateScope  predicted scope (module/glob) of the work about to launch.
 * @param {Array<{id?:string, laneId?:string, scope:string[]}>} activeLeases  currently-held leases + scope.
 * @param {'wait'|'ask'|'force'} policy  the overlap-at-launch knob (default 'wait').
 * @returns {{outcome:string, policy:string, overlaps:Array<{leaseId:(string|null), scope:string[]}>,
 *   waitOn:string[], resolveAtDrain:boolean}}
 *   No overlap ⇒ `outcome:'launch'` regardless of policy. Otherwise per policy:
 *     wait  → 'wait'  (block until every overlapping lease frees; `waitOn` = their ids)
 *     ask   → 'ask'   (park for the human — present the overlap; no auto-launch)
 *     force → 'force' (launch now; `resolveAtDrain:true` schedules the agent conflict-resolution step at drain,
 *                      which parks for the human if resolution fails — the §3i "force + resolve" route).
 */
export function overlapAtLaunch(candidateScope, activeLeases, policy = 'wait') {
  if (!OVERLAP_POLICIES.includes(policy)) {
    throw new Error(`overlapAtLaunch: unknown policy "${policy}" (expected ${OVERLAP_POLICIES.join('|')})`);
  }
  const cand = normScope(candidateScope);
  const overlaps = (Array.isArray(activeLeases) ? activeLeases : [])
    .filter((l) => l && scopesOverlap(cand, l.scope))
    .map((l) => ({ leaseId: l.id ?? l.laneId ?? null, scope: normScope(l.scope) }));

  if (overlaps.length === 0) {
    return { outcome: 'launch', policy, overlaps: [], waitOn: [], resolveAtDrain: false };
  }
  const waitOn = overlaps.map((o) => o.leaseId);
  switch (policy) {
    case 'wait':
      return { outcome: 'wait', policy, overlaps, waitOn, resolveAtDrain: false };
    case 'ask':
      return { outcome: 'ask', policy, overlaps, waitOn, resolveAtDrain: false };
    case 'force':
      return { outcome: 'force', policy, overlaps, waitOn, resolveAtDrain: true };
    default: /* unreachable — guarded above */
      throw new Error(`overlapAtLaunch: unhandled policy "${policy}"`);
  }
}

// ── (3) breach-mid-build policy + the §3i-A4 escalation ladder ───────────────────────────────────────────────

/** Valid breach-mid-build policy tokens (§3i). */
export const BREACH_POLICIES = Object.freeze(['pause', 'park', 'resolve-at-drain']);

/**
 * §3i-A4 Fork 2 — retry-once-then-escalate. The TOTAL-attempt bound (jury amendment): escalate once the running
 * count of breach attempts EXCEEDS this, regardless of whether each attempt breached the same or a different
 * out-of-scope file. 1 ⇒ retry in place once, then escalate.
 */
export const RETRY_BOUND = 1;

/**
 * §3i-A4 Fork 2's escalation ladder, as DATA. `order:0` (retry-in-place) is A4's DEFAULT transition; rungs 1–3
 * are the escalation routes offered once the retry bound is exhausted. `condition` names the breach shape that
 * selects a rung when a program later auto-classifies (a `park` you-card offers rungs 1–3 as the route menu).
 */
export const BREACH_ESCALATION_LADDER = Object.freeze([
  Object.freeze({ rung: 'retry-in-place', order: 0, condition: 'default',
    desc: 'drop the out-of-scope edit, re-plan within the lease (A4 default transition)' }),
  Object.freeze({ rung: 'widen-lease', order: 1, condition: 'free-scope',
    desc: 'lock-escalation into currently-free scope ONLY' }),
  Object.freeze({ rung: 'handoff-cross-lane', order: 2, condition: 'foreign-lease',
    desc: 'hand off to the cross-lane family (B2/B3/B8) — the wanted files belong to another live lease' }),
  Object.freeze({ rung: 'bounce-quarantine', order: 3, condition: 'uncontainable',
    desc: 'the slice was never containable in one lease — bounce/quarantine, re-file as a new item' }),
]);

/** The escalation routes (rungs 1–3) a `park` you-card surfaces — everything past the retry-in-place default. */
export const ESCALATION_ROUTES = Object.freeze(BREACH_ESCALATION_LADDER.filter((r) => r.order >= 1));

/** Coerce a breach input (a raw file array, or a `scopeLease(...)` result) → the breach file array. */
function breachFiles(breach) {
  if (Array.isArray(breach)) return normScope(breach);
  if (breach && Array.isArray(breach.breach)) return normScope(breach.breach);
  return [];
}

/**
 * Decide the response to a mid-build scope breach (§3i-A4). Advisory scheduling data (Fork 1) — never a lock.
 *
 * @param {string[]|{breach:string[]}} breach  the breach set (from {@link scopeLease}) or a raw file array.
 * @param {'pause'|'park'|'resolve-at-drain'} policy  the breach-mid-build knob.
 * @param {{attempt?:number, retryBound?:number}} [opts]  `attempt` = the TOTAL breach-attempt count so far
 *   (1-based, Fork 2's total counter — NOT same-scope-twice); `retryBound` defaults to {@link RETRY_BOUND}.
 * @returns {{breached:boolean, action:string, rung:(string|null), escalated:boolean, policy:string,
 *   attempt:number, retryBound:number, holdSource:(string|null), resolveAtDrain:boolean, routes:object[]}}
 *   No breach                      → `action:'continue'`.
 *   Within the retry budget        → `action:'retry-in-place'` (A4 default; `escalated:false`), for ANY policy.
 *   Budget exhausted, per policy   → 'pause' (holdSource 'sibling-lane' — wait for the owning lease to free),
 *                                    'park'  (holdSource 'policy' — amber you-card; `routes` = the ladder menu),
 *                                    'resolve-at-drain' (continue building; `resolveAtDrain:true`).
 */
export function breachOutcome(breach, policy, { attempt = 1, retryBound = RETRY_BOUND } = {}) {
  if (!BREACH_POLICIES.includes(policy)) {
    throw new Error(`breachOutcome: unknown policy "${policy}" (expected ${BREACH_POLICIES.join('|')})`);
  }
  const files = breachFiles(breach);
  const base = { policy, attempt, retryBound, resolveAtDrain: false, routes: [] };

  if (files.length === 0) {
    return { ...base, breached: false, action: 'continue', rung: null, escalated: false, holdSource: null };
  }
  // A4 default transition: retry in place / re-plan within scope — until the TOTAL attempt count exceeds the
  // bound (Fork 2's livelock guard: a different out-of-scope file each attempt still counts toward the bound).
  if (attempt <= retryBound) {
    return { ...base, breached: true, action: 'retry-in-place', rung: 'retry-in-place', escalated: false, holdSource: null };
  }
  // Bound exhausted → escalate per the breach knob.
  switch (policy) {
    case 'resolve-at-drain':
      return { ...base, breached: true, action: 'resolve-at-drain', rung: null, escalated: true,
        holdSource: null, resolveAtDrain: true };
    case 'pause':
      // The breached files belong to another live lease — hold until it frees (Fork 3: sibling-lane source).
      return { ...base, breached: true, action: 'pause', rung: 'handoff-cross-lane', escalated: true,
        holdSource: 'sibling-lane' };
    case 'park':
      // Promote to an amber you-card offering the route menu (Fork 2's `ask`/`park` promotion). holdSource
      // 'policy' — the policy decided to surface it; unhold authority is the human (Fork 3).
      return { ...base, breached: true, action: 'park', rung: null, escalated: true,
        holdSource: 'policy', routes: ESCALATION_ROUTES };
    default: /* unreachable — guarded above */
      throw new Error(`breachOutcome: unhandled policy "${policy}"`);
  }
}

// Re-export the reused exact-set primitive so callers/tests can see the composition boundary explicitly.
export { disjoint };
