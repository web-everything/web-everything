/**
 * critical-work.mjs — IS THIS WORK CRITICAL, AND WAS THIS MISS ON CRITICAL WORK? (#4034, epic #3383)
 *
 * Operator decision 2026-09-30 ~11:15 ET: ordinary conveyor/daemon work may use Codex probation,
 * with full review on every result. Critical scope is the gate/approval surface: review clearance,
 * landing, required checks, statute/rules, credentials, and this gate itself. High-risk/security work
 * and explicit human-required records remain critical; unknown scope still fails closed.
 *
 * Review escalation and never-spot-check have broader purposes. Their dispatch/daemon rosters must
 * NOT be imported wholesale here: requiring full review does not require a Claude-only builder.
 * Scope is file-granular: a mixed lander file remains critical because a card cannot prove which
 * function it will change. No daemon/drain name or conveyor-directory wildcard makes work critical.
 *
 * WHERE THIS IS READ. `dispatch-contracts.mjs#routeDispatch` computes {@link criticalWorkVerdict} for the task and
 * {@link criticalMissesFor} over the raw scorecards, and hands both to `provider-routing.mjs#selectProvider`, whose
 * `CRITICAL_WORK_GATE` opens a gated kind to a non-Claude worker ONLY for a non-critical task of an opened
 * taskType, and never for a {provider, model, taskType} triple with a critical miss on record (hard veto).
 *
 * WHY A SEPARATE MODULE rather than inside provider-routing.mjs (where the card first placed it): both
 * `dispatch-contracts.mjs` and `dispatch-thresholds.mjs` import provider-routing.mjs, and dispatch-thresholds reads
 * `DEFAULT_BACKDOWN_THRESHOLDS` at module top level — so provider-routing.mjs importing either would throw a TDZ
 * ReferenceError whenever provider-routing.mjs is the first module loaded. provider-routing.mjs stays pure and
 * import-cycle free; it receives the verdict as data.
 *
 * FAIL CLOSED. No declared scope → critical (`unknown-scope`). A miss row with no scope evidence → a critical miss.
 *
 * PURE: no fs, no process, no clock. Deterministic over its arguments.
 */

import { NEVER_SPOT_CHECK_PATH_PREFIXES } from './dispatch-thresholds.mjs';
import { isPrincipleSurface, TRUST_CHAIN } from './gate-config.mjs';
import { CONSTELLATION_REPOS } from './constellation-repos.mjs';

/**
 * Every policy-tier TRUST_CHAIN home (review runner, policy contracts, conformance/invariant self-tests, …) is
 * critical, DERIVED from the roster so a new policy member can never be silently left out (PR #3124 review).
 * The engine tier is deliberately NOT derived wholesale: the dispatch loop is ordinary machinery by decision.
 */
const POLICY_TIER_HOMES = Object.freeze(new Set(
  TRUST_CHAIN.filter((m) => m.tier === 'policy').flatMap((m) => m.homes ?? []),
));

// Confinement entrypoints, their direct local imports, and the AgY spawn/juror chain.
// Deeper generic infrastructure is intentionally not critical merely by transitive import.
const CONFINEMENT_MODULES = Object.freeze([
  // The repair-dispatch caller chain that applies the confinement and routes fixes (audit: its tests hold the enforcement assertions).
  'scripts/operations/fix-run.mjs', 'scripts/conveyor/reconcile-fix-dispatch.mjs', 'scripts/conveyor/fix-executor-routing.mjs',
  'scripts/lib/fix-slot-borrow.mjs', 'scripts/lib/fix-executor-chain.mjs', 'scripts/operations/dispatch-providers/fix.mjs',
  'scripts/lib/agy-confined-build.mjs',
  'scripts/lib/agy-sandbox.mjs',
  'scripts/lib/agy-fix-admission.mjs',
  'scripts/operations/agy-fix-provider.mjs',
  'scripts/gemini-direct-task.mjs',
  'scripts/lib/agy-review-juror.mjs',
  'scripts/lib/antigravity-judge-spawn.mjs',
  'scripts/lib/antigravity-model-effort.mjs',
  'scripts/lib/antigravity-run-evidence.mjs',
  'scripts/lib/judge-spawn.mjs',
  'scripts/lib/policy-cascade.mjs',
  'scripts/lib/mandate-fence.mjs',
  'scripts/lib/critical-work.mjs',
  'scripts/lib/provider-quota-hold.mjs',
  'scripts/lib/secret-scrub.mjs',
  'scripts/lib/bounded-child.mjs',
  'scripts/lib/dispatch-routing-policy.mjs',
  'scripts/lib/dispatch-routing-policy.json',
  'scripts/lib/provider-routing.mjs',
  'scripts/lib/dispatch-routing-policy-source.mjs',
]);

/** The file-level gate/approval boundary, distinct from the broader full-review roster. */
const CRITICAL_PATH_PREFIXES = Object.freeze({
  statute: NEVER_SPOT_CHECK_PATH_PREFIXES.statute,
  gateSelf: Object.freeze([
    'scripts/check-standards', 'scripts/check-review-gate', 'scripts/guard-', 'scripts/verify-lane',
    'scripts/lib/critical-work.mjs', 'scripts/lib/provider-routing.mjs', 'scripts/lib/gate-',
    'scripts/review-set-label.mjs', 'scripts/review-core-cli.mjs',
    'scripts/lib/review-core.mjs', 'scripts/lib/review-policy', 'scripts/lib/review-escalation.mjs',
    'scripts/lib/review-independence.mjs', 'scripts/lib/advisory-labels.mjs',
    'scripts/lib/verdict-ledger', 'scripts/lib/disposition-land-seam.mjs', 'scripts/lib/auto-land-seam.mjs',
    'scripts/operations/review-pr', 'scripts/conveyor/advisory-label-sweep.mjs',
    'scripts/conveyor/advisory-fix-mark.mjs',
    // The gate's own wiring and inputs: the module that computes/passes the verdict, its threshold data, and the
    // scorecard whose critical-miss vetoes feed it.
    'scripts/lib/dispatch-contracts.mjs', 'scripts/lib/dispatch-thresholds.mjs', 'scripts/lib/dispatch-routing-policy', 'scripts/conveyor/run-scorecard',
    'scripts/lib/model-capability-ratings', 'scripts/lib/poc-branches.json',
    // Review-clearance code and the harness hooks/permissions/skills.
    'scripts/review-runner', 'scripts/lib/review-runner-core.mjs', 'scripts/lib/review-label-provider.mjs',
    'scripts/lib/review-loop-policy.mjs', 'scripts/lib/review-skill-guard.mjs', '.claude/',
    // The drain's land step: builds/spawns the merge sweep and clears review; plus the resident daemons that run it.
    'scripts/lane-drain.mjs', 'scripts/converge-daemon-pass.mjs', 'scripts/converge-daemon-install.mjs',
    'plateau-app/tools/drain-daemon/',
    // Land, required-check, credential, approval-store and review-independence surface not named in any roster
    // (PR #3124 round 2): the merge gate the lander consults, the check list, app-token minting, the land advance
    // operation, authorship inputs, the human-approval store, and the main-push lock backstop.
    'scripts/lib/pr-merge-gate.mjs', 'scripts/lib/required-status-checks.mjs', 'scripts/lib/verify-lane-gate.mjs',
    'scripts/lib/github-app-', 'scripts/lib/forge-land-provider.mjs', 'scripts/operations/land-advance',
    'scripts/operations/pr-land-reasons.mjs', 'scripts/lib/ai-pr-authorship.mjs', 'scripts/lib/marker-authorship.mjs',
    'scripts/lib/verdict-totality.mjs', 'scripts/lib/trust-chain-tier.mjs', 'scripts/conveyor/hiccup-approve.mjs',
    // Enforcement dependencies and their sibling regression tests are part of the same trust boundary.
    ...CONFINEMENT_MODULES,
    ...CONFINEMENT_MODULES.filter(p => p.endsWith('.mjs')).map(p => p.replace(/([^/]+)\.mjs$/, '__tests__/$1.test.mjs')),
    // Untrusted diff producer: its confinement, admission, settings and regression harness are gate code.
    'scripts/lib/agy-confined-', 'scripts/lib/agy-sandbox.mjs', 'scripts/lib/agy-fix-admission.mjs',
    'scripts/operations/agy-fix-provider.mjs', 'scripts/settings/agy-build.json',
    'scripts/lib/__tests__/agy-confined-', 'scripts/lib/__tests__/agy-sandbox.test.mjs',
    'scripts/lib/__tests__/agy-fix-admission.test.mjs',
    '.githooks/',
  ]),
  irreversible: Object.freeze([
    '.github/workflows/', '.github/branch-protection', '.github/required-check',
    'scripts/pr-land', 'scripts/merge-ai-prs', 'scripts/operations/poc-land',
  ]),
});

/** Security-sensitive scope in any repo; security tags cover handling in otherwise ordinary files. */
const SECURITY_PATH_RE = /(^|[/_.-])(secrets?|credentials?|branch-protection|required-checks?)([/_.-]|$)|(^|\/)\.env(?:[./]|$)/i;

/** The confirmed-miss outcomes (#3949 writes `reworked` on a review:changes verdict; the red team #4195 too). */
// @test-only-export-ok: the critical-work table (#4034)
export const MISS_OUTCOMES = Object.freeze(['reworked', 'rejected']);

/** `we:scripts/x.mjs` → `scripts/x.mjs`; `plateau-app:tools/x` → `plateau-app/tools/x` (as decideDispatchRoute does). */
function normalizePath(p) {
  return String(p).trim().replace(/^we:/, '').replace(/^([A-Za-z0-9._-]+):/, '$1/').replace(/^\.\//, '');
}

/**
 * #4200 (epic #3383) — EVERY ALIAS `normalizePath` can leave as a sibling repo's own leading path segment
 * (`plateau-app/`, `plateau/`, `frontierui/`, `fui/`) — `we:`/`webeverything:` is already stripped bare by
 * `normalizePath` itself, so it needs no entry here. Sourced from `constellation-repos.mjs#CONSTELLATION_REPOS`
 * (the one table) plus the two short scope-prefix aliases `scripts/lib/repo-profile.mjs#SCOPE_PREFIXES`
 * documents (`fui`, `plateau`) — not imported from that file to keep this module's import graph exactly as
 * narrow as its own docblock already claims ("no fs, no process, no clock"; `repo-profile.mjs` reads `homedir()`
 * and `existsSync` at call time for ITS OWN callers, a capability this module has no reason to acquire).
 */
const SIBLING_REPO_PATH_ALIASES = Object.freeze(
  [...new Set([
    ...Object.entries(CONSTELLATION_REPOS).filter(([key]) => key !== 'we').flatMap(([, meta]) => meta.dirs),
    'fui', 'plateau',
  ])],
);

/**
 * #4200 — THE SAME FILE, RELATIVE TO ITS OWN REPO, given `normalizePath`'s already-normalized form. An
 * irreversible-tier pattern like `.github/workflows/` recurs IDENTICALLY in every constellation repo's own
 * layout — each has its own `.github/workflows/` at its own root — so testing only the WE-relative form (as
 * every OTHER never-spot-check group correctly does; `docs/agent/`, `scripts/check-standards` etc. are WE's
 * OWN governance/gate files with no sibling-repo equivalent) silently exempted a `plateau:`/`frontierui:`-scoped
 * deploy-workflow edit from the SAME rule a `we:`-scoped one already gets. Returns `null` when `f` carries no
 * recognized sibling-repo alias segment (already WE-relative, or an unrecognized prefix) — the caller always
 * tests the ORIGINAL string too, so this only ever ADDS a candidate, never replaces one. PURE.
 * @param {string} f - already run through {@link normalizePath}.
 * @returns {string|null}
 */
function repoRelativeForm(f) {
  for (const alias of SIBLING_REPO_PATH_ALIASES) {
    const prefix = `${alias}/`;
    if (f.startsWith(prefix)) return f.slice(prefix.length);
  }
  return null;
}

/**
 * Is this work critical? Pure.
 * @param {{taskType?: string, filesTouched?: string[], estimatedLoc?: number, acceptanceTestable?: boolean,
 *   risk?: string, humanRequired?: boolean, tags?: string[]}} work
 * @returns {{critical: boolean, reasons: Array<{proxy: string, detail: string}>}}
 */
// @test-only-export-ok: the critical-work predicate (#4034), wired through dispatch-contracts.mjs#routeDispatch
export function criticalWorkVerdict(work = {}) {
  const taskType = typeof work?.taskType === 'string' ? work.taskType : '';
  const files = Array.isArray(work?.filesTouched)
    ? [...new Set(work.filesTouched.filter((p) => typeof p === 'string' && p.trim()).map(normalizePath))]
    : [];
  const reasons = [];
  if (files.length === 0) {
    return { critical: true, reasons: [{ proxy: 'unknown-scope', detail: 'no declared scope: criticality cannot be ruled out (fail closed)' }] };
  }

  // General dispatch risk also scores ordinary implementation+test bugfixes high. That affects care,
  // not this operator's Claude-only boundary; only the declared high-risk flag is a critical override.
  if (work?.risk === 'high') {
    reasons.push({ proxy: 'dispatch-risk', detail: 'explicitly high-risk work' });
  }

  const groups = Object.entries(CRITICAL_PATH_PREFIXES)
    .filter(([name, prefixes]) => files.some((f) => {
      if (prefixes.some((prefix) => f.startsWith(prefix))) return true;
      if (name === 'gateSelf' && POLICY_TIER_HOMES.has(f)) return true;
      // #4200 — ONLY `irreversible` recurs identically per repo (`.github/workflows/`, the deploy/land
      // mechanisms this rule exists to catch); `statute`/`gateSelf` name WE's OWN governance/gate files with
      // no sibling-repo equivalent, so they deliberately stay WE-relative-only, unchanged.
      if (name !== 'irreversible') return false;
      const relative = repoRelativeForm(f);
      return relative != null && prefixes.some((prefix) => relative.startsWith(prefix));
    }))
    .map(([group]) => group);
  if (groups.length) {
    reasons.push({ proxy: 'never-spot-check', detail: groups.length ? groups.join(',') : 'statute-tier path' });
  }

  const principle = files.filter((f) => isPrincipleSurface(f, null));
  if (work?.humanRequired === true || principle.length) {
    reasons.push({ proxy: 'human-required', detail: principle.length ? principle.join(',') : 'humanRequired on record' });
  }

  const security = files.filter((f) => SECURITY_PATH_RE.test(f));
  if (taskType === 'security-fix' || work?.tags?.includes('security') || security.length) {
    reasons.push({ proxy: 'security', detail: security.length ? security.join(',') : 'security-critical task' });
  }

  return { critical: reasons.length > 0, reasons };
}

/** A confirmed miss: an explicit `reworked`/`rejected` outcome (never inferred from `findings`). Pure. */
// @test-only-export-ok: the critical-work predicate (#4034)
export function isMissRecord(record) {
  return Boolean(record) && typeof record === 'object' && MISS_OUTCOMES.includes(record.outcome);
}

/**
 * Was this trial a miss on CRITICAL work? Pure. The scope comes from the row itself (`filesTouched`,
 * `humanRequired`, `risk`) or from caller-supplied `evidence` (e.g. the PR's changed files read at the io edge).
 * A miss with no scope evidence is critical — fail closed, the same direction rule 5 fails a missing class.
 * @param {object} record - a run-scorecard row
 * @param {{filesTouched?: string[], humanRequired?: boolean, risk?: string}} [evidence]
 * @returns {boolean}
 */
// @test-only-export-ok: the critical-work predicate (#4034), wired through dispatch-contracts.mjs#routeDispatch
export function isCriticalMiss(record, evidence = {}) {
  if (!isMissRecord(record)) return false;
  return criticalWorkVerdict({
    taskType: record.taskType,
    filesTouched: Array.isArray(record.filesTouched) ? record.filesTouched : evidence?.filesTouched,
    humanRequired: record.humanRequired === true || evidence?.humanRequired === true,
    risk: record.risk ?? evidence?.risk,
    tags: record.tags ?? evidence?.tags,
  }).critical;
}

/**
 * Every {provider, model, taskType} triple with a critical miss on record — the hard-veto list
 * `selectProvider` reads. Accepts the store shape (`{records}`) or a bare array. Pure.
 * @param {Array<object>|{records?: Array<object>}} scorecards
 * @param {string} [taskType] - only rows of this taskType (omit for all)
 * @returns {Array<{provider: string, model: string, taskType: string, scoredAt: string|null}>}
 */
// @test-only-export-ok: the critical-work predicate (#4034), wired through dispatch-contracts.mjs#routeDispatch
export function criticalMissesFor(scorecards, taskType) {
  const records = Array.isArray(scorecards) ? scorecards : Array.isArray(scorecards?.records) ? scorecards.records : [];
  return records
    .filter((r) => r && typeof r === 'object' && typeof r.provider === 'string' && typeof r.model === 'string')
    .filter((r) => r.role !== 'supervise' && (taskType === undefined || r.taskType === taskType))
    .filter((r) => isCriticalMiss(r))
    .map((r) => ({ provider: r.provider, model: r.model, taskType: r.taskType, scoredAt: typeof r.scoredAt === 'string' ? r.scoredAt : null }));
}
