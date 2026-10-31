/**
 * provider-routing.mjs — deterministic LLM dispatch-provider and supervision-level router (#3690).
 *
 * This module provides the routing intelligence for picking the optimal dispatch provider
 * ('gemini' | 'codex' | 'both' | 'claude') and model supervision level ('full' | 'spot-check').
 *
 * REACH: the mechanical dispatch path only. Mechanical provider routing binds the mechanical dispatch
 * path only (the autonomous conveyor/runner dispatch machinery). An interactive orchestrating loop
 * keeps its own inline routing verdict under [docs/agent/backlog-workflow.md#model-routing] Inline (3)
 * and [docs/agent/backlog-workflow.md#effort-routing]; the router may inform that verdict, never
 * replace it (per [docs/agent/platform-decisions.md#delegation-trial-record-graduation] "Reach", #3690).
 *
 * PURE MODULE ARCHITECTURE (per [docs/agent/platform-decisions.md#deterministic-core-thin-judgment]):
 *   • The default gate is a validated policy snapshot at module load; selectors remain pure over inputs.
 *   • Callers explicitly load and pass in scorecard records (from the shared scorecard store — `run-scorecard-store.mjs#readStore`, #4155
 *     or in-memory fixtures) and backdown thresholds.
 *   • Fully deterministic: identical arguments produce byte-identical return objects every time.
 *   • No Date.now(), Math.random(), or implicit time reads. Timestamps in scorecards are treated as
 *     deterministic ISO-8601 strings.
 *
 * `explorationHint` is an ADDITIONAL, purely advisory field sourced from caller-loaded
 * `we:scripts/lib/model-capability-ratings.mjs` data, consulted ONLY inside `selectProvider`,
 * NEVER inside `selectSupervisionLevel`. It cannot change recommendation, claudeTier, or level.
 *
 * PROGRESSIVE BACKDOWN & GRADUATION MODEL (#3690):
 *   • Unit of trust is strictly {provider, model, subjectClass, taskType}, never broader (identity never
 *     inherits trust). `taskType` carries whatever the caller's subject axis is — a work task type, a role
 *     kind, or a review lens — and `subjectClass` keeps those axes from colliding: a review-lens or role-kind
 *     subject never counts toward a work triple's streak, and a work subject never counts toward one of theirs,
 *     even where the subject strings happen to match (#3801 Fork 3).
 *   • N = 5 consecutive clean trials (verified by claude-subagent or independent-claude) required for spot-check.
 *   • 'other'-verified trials (e.g. smoke tests) neither advance nor reset the streak.
 *   • Informative-trial requirement: at least one historical trial for the triple must have caught and fixed
 *     a real finding from independent review.
 *   • Calibration-miss hard veto: any confirmed finding as the most recent trial immediately forces full
 *     supervision, resetting the streak.
 *
 * CASCADE EVALUATION ORDER (first fit wins):
 *   1. Gemini / Antigravity fitness check -> 'gemini'
 *   2. Codex fitness check -> 'codex'
 *   3. Both together (high-stakes critical or thin history without informative trials) -> 'both'
 *   4. Claude fallback by effort tier ('haiku' | 'sonnet' | 'opus') -> 'claude'
 *
 * DEFAULT AGY ALTERNATE: Claude Sonnet/Opus offers alternateBackend via gemini-direct-task.mjs and
 * Antigravity's separate quota by default for capacity relief. Three opt-outs return null: Haiku has no
 * agy equivalent; statute-tier paths, architectural-decision and triage-research require native Claude
 * session identity/tools; or the most recent Antigravity trial for this exact taskType is not clean.
 * Antigravity's sandbox is a different execution context from a native Claude Code session. This routing
 * recommendation does not change supervision or graduation. Every Claude branch appends an
 * agy-alternate-backend audit entry after claude-tier; other branches omit the alternateBackend field.
 *
 * STATUTE-TIER PATHS:
 *   Per AGENTS.md line 49 and docs/agent/ conventions: docs/agent/platform-decisions.md and any path
 *   under docs/agent/ constitute the repo's statute/governance layer. Touching ANY statute-tier path
 *   forces Claude Opus, never Gemini or Codex, regardless of track record.
 *
 * GEMINI/ANTIGRAVITY SCOPE (observational, not enforced — 2026-09-15/16 evidence): dispatch Gemini via
 * Antigravity for well-scoped EXECUTION work where another agent (Codex or Claude) has already designed
 * the solution and defined success criteria, not for open-ended design/judgment work. Its one clean,
 * independently-verified success this session was real merge-conflict resolution on PR #2291 and PR
 * #2292 (gemini-3.8-flash-low; the conflict, both sides' intent, and correctness were all already known
 * — see PR #2294's scorecard trials). By contrast its one attempt to DECIDE what to build (the
 * `stale-state` operation folded into #2292) failed immediately on an internal tool error before
 * touching a file, and was redone by Codex — there is still no clean trial of it choosing *what* to
 * build, only of it reconciling an already-known target. This is a documented judgment call for whoever
 * dispatches work, not a coded gate on `taskType`; re-derive once real build-new-feature trial data exists.
 */

import { readBuildArgonSettings, resolveBuildArgonModel } from './build-argon-settings.mjs';
const BUILD_ARGON_SETTINGS = readBuildArgonSettings();

import { DEFAULT_ROUTING_POLICY } from './dispatch-routing-policy.mjs';
import { REVIEW_SEAT_PROVIDERS } from './dispatch-routing-providers.mjs';
export { DEFAULT_ROUTING_POLICY, resolveOperationRoute } from './dispatch-routing-policy.mjs';

import { isUsableForExploration } from './model-capability-ratings.mjs';
import { isTestPath } from './dispatch-task-type.mjs';
import { CODEX_MODEL } from './codex-model-routing.mjs';

// ── EXPLORATION SIGNAL ONLY — advisory benchmarks, separate from supervision ──
// @test-only-export-ok: Shared threshold for caller-visible exploration hints
export const THIN_TRIAL_THRESHOLD = 3;

/** Pure advisory lookup used only when finalizing selectProvider's return value. */
function getExplorationHint(taskType, scorecards, context) {
  let geminiCount = 0;
  let codexCount = 0;
  for (const record of scorecards) {
    if (!record || record.taskType !== taskType) continue;
    if (['gemini', 'antigravity'].includes(record.provider)) geminiCount++;
    else if (record.provider === 'codex') codexCount++;
  }
  // Sufficient real evidence prevents even consulting the external registry.
  if (geminiCount >= THIN_TRIAL_THRESHOLD && codexCount >= THIN_TRIAL_THRESHOLD) return null;

  const registry = context?.capabilityRatings;
  const entries = Array.isArray(registry) ? registry : (Array.isArray(registry?.entries) ? registry.entries : []);
  const category = typeof context?.capabilityCategory === 'string'
    ? context.capabilityCategory
    : (['bugfix', 'build-new-feature', 'self-fix'].includes(taskType)
      ? 'autonomousAgenticWork'
      : (['conflict-resolution', 'doc-fix'].includes(taskType) ? 'cliToolUse' : 'overallCodingIndex'));

  let best = null;
  for (const entry of entries) {
    if (!['gemini', 'antigravity', 'codex'].includes(entry?.provider) || !isUsableForExploration(entry)) continue;
    const value = entry.categories?.[category]?.value;
    // Unknown values never rank; retain registry order for equal measured values.
    if (!Number.isFinite(value)) continue;
    if (best === null || value > best.categories[category].value) best = entry;
  }
  if (best === null) return null;

  const { value, unit } = best.categories[category];
  return {
    suggestedProvider: best.provider,
    suggestedModel: best.model,
    category,
    value,
    unit,
    asOf: best.asOf,
    source: best.source,
    reason: `Real trial history for taskType '${taskType}' is thin (gemini/antigravity: ${geminiCount}, codex: ${codexCount} trials, threshold ${THIN_TRIAL_THRESHOLD}); verified external rating suggests trying ${best.provider}/${best.model} (${category}=${value}) next.`,
  };
}

// ── EVIDENCE-BASED SIGNAL — existing routing and supervision policy ────────────

// @test-only-export-ok: Shared library exported for interactive Claude sessions and conveyor runners
export const RECOMMENDATIONS = Object.freeze({
  GEMINI: 'gemini',
  CODEX: 'codex',
  BOTH: 'both',
  CLAUDE: 'claude',
});

// @test-only-export-ok: Shared library exported for interactive Claude sessions and conveyor runners
export const CLAUDE_TIERS = Object.freeze({
  HAIKU: 'haiku',
  SONNET: 'sonnet',
  OPUS: 'opus',
});

// agy-launcher-probation (2026-09-27): re-checked against the live catalog, not assumed. `agy models` on agy
// 1.2.12 lists exactly two Claude backends — `claude-sonnet-4-6` ("Claude Sonnet 4.6 (Thinking)") and
// `claude-opus-4-6-thinking` ("Claude Opus 4.6 (Thinking)") — so these ARE the current Claude models
// Antigravity offers; nothing newer is available through it yet. Re-run `agy models` before changing a row.
// @test-only-export-ok: Shared library exported for interactive Claude sessions and conveyor runners
export const AGY_CLAUDE_MODEL_BY_TIER = Object.freeze({
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-6-thinking',
});

/** When and against which agy build {@link AGY_CLAUDE_MODEL_BY_TIER} was last checked against `agy models`. */
// @test-only-export-ok: a dated provenance record for the operator and the next re-check, pinned by its own test
export const AGY_MODEL_CATALOG_CHECK = Object.freeze({ agyVersion: '1.2.12', checkedOn: '2026-09-27' });

/**
 * The Gemini model an Antigravity-Gemini probation worker runs (#3922: Gemini takes only SIMPLE steps, under a
 * Claude/Codex checker). Flash, not Pro: the one clean Antigravity record so far is Flash on already-understood
 * mechanical work (conflict resolution, 10 landed). `high` is the Flash tier's top reasoning setting.
 */
export const AGY_GEMINI_SIMPLE_MODEL = 'gemini-3.8-flash-high';

// @test-only-export-ok: Shared library exported for interactive Claude sessions and conveyor runners
export const SUPERVISION_LEVELS = Object.freeze({
  FULL: 'full',
  SPOT_CHECK: 'spot-check',
});

// @test-only-export-ok: Shared library exported for interactive Claude sessions and conveyor runners
export const DEFAULT_BACKDOWN_THRESHOLDS = Object.freeze({
  minCleanStreak: 5,
  requireInformativeTrial: true,
  // Post-miss bar (platform-decisions.md#delegation-trial-record-graduation, rule 5; #3889): once a
  // confirmed miss is on record for a triple, the clean-streak bar to reach spot-check becomes
  // minCleanStreak + k, strictly higher than the cold-start bar. `k`, like `minCleanStreak`, is a config
  // default proposed only by a future ordinary batched finding against real trial-count data — this is a
  // structural addition (a new config field), not a recalibration; the placeholder value below is
  // explicitly out of scope for #3889 to justify.
  k: 3,
});

/**
 * Proven trial envelopes grounded in the empirical trials recorded in
 * the shared scorecard store (`run-scorecard-store.mjs#resolveScorecardStorePath`, #4155) and documented in `backlog/3690`:
 *
 * - `doc-fix`: Observed trials were small single-file text fixes (e.g. #3539).
 *   Proven envelope: max 100 LOC, max 2 files.
 * - `bugfix`: Observed trials were targeted script/engine fixes (PR #2223 pid-forwarding,
 *   #3428 NUL-byte bug, ENOBUFS fix, and hardening rounds 1-3). Max observed was ~150 LOC
 *   across 2 files. Proven envelope: max 250 LOC, max 4 files.
 * - `conflict-resolution`: Observed trial was PR #2212 branch conflict resolution (~80 LOC).
 *   Proven envelope: max 200 LOC, max 3 files.
 * - `build-new-feature` / `self-fix` / `other`: Observed trial was gemini-direct-task.mjs
 *   (single utility script, ~180 LOC). Proven envelope: max 300 LOC, max 3 files.
 *
 * Any task exceeding 300 LOC or touching > 4 files exceeds the historical envelope
 * of session-delegated external model trials.
 */
// @test-only-export-ok: Shared library exported for interactive Claude sessions and conveyor runners
export const PROVEN_TASK_ENVELOPES = Object.freeze({
  'prepare': Object.freeze({ maxLoc: 1000, maxFiles: 1 }),
  'test-fix': Object.freeze({ maxLoc: 150, maxFiles: 3, testOnly: true }),
  'doc-fix': Object.freeze({ maxLoc: 100, maxFiles: 2 }),
  'bugfix': Object.freeze({ maxLoc: 250, maxFiles: 4 }),
  'conflict-resolution': Object.freeze({ maxLoc: 200, maxFiles: 3 }),
  'build-new-feature': Object.freeze({ maxLoc: 300, maxFiles: 3 }),
  'self-fix': Object.freeze({ maxLoc: 200, maxFiles: 2 }),
  'other': Object.freeze({ maxLoc: 300, maxFiles: 3 }),
  // agy-launcher-probation — a CI heal repairs a red/BEHIND PR; its own diff (not the PR's) is what this bounds.
  // No trial exists yet, so the bound is deliberately smaller than `bugfix`'s. The external-heal launcher checks
  // the heal diff against it after the run and refuses to push a bigger one.
  'ci-heal': Object.freeze({ maxLoc: 150, maxFiles: 3 }),
});

/**
 * Check if a repo-relative path is within the statute/governance layer.
 * Per AGENTS.md line 49 and docs/agent/ conventions:
 * `docs/agent/platform-decisions.md` and any path under `docs/agent/` constitute the repo's statute layer.
 * Touching any statute path forces human/Claude review (Claude opus), never Gemini or Codex.
 * @param {string} filePath
 * @returns {boolean}
 */
// @test-only-export-ok: Shared library exported for interactive Claude sessions and conveyor runners
export function isStatuteTierPath(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) return false;
  const normalized = filePath.trim().replace(/^\.?\//, '').toLowerCase();
  return normalized === 'docs/agent/platform-decisions.md' || normalized.startsWith('docs/agent/');
}

/**
 * WIDE-BLAST-RADIUS DISPATCH MACHINERY (#3857). Every Claude dispatch's argv passes through
 * `buildAgentArgv` (`we:scripts/operations/dispatch-lane-io.mjs`), which composes the criteria this
 * file and `we:scripts/lib/dispatch-contracts.mjs` compute — so a scope that touches any of these five
 * files or the tick core that drives them is the machinery choosing its own successor's routing, not an
 * ordinary edit. Frozen and short on purpose: a table to change a row of, not a heuristic to widen.
 */
// @test-only-export-ok: Shared library exported for the model-tier table (#3857) and its own test
export const DISPATCH_MACHINERY_PATHS = Object.freeze([
  'scripts/operations/dispatch-lane-io.mjs',
  'scripts/operations/dispatch-task.mjs',
  'scripts/lib/dispatch-contracts.mjs',
  'scripts/lib/provider-routing.mjs',
  'scripts/conveyor/tick-core.mjs',
]);

/**
 * EXTERNAL WORKER CANDIDATES (#3906) — the non-Claude models the router may route a dispatch worker to, each
 * with the Claude tier it stands in for. A row does NOT grant trust: a candidate is still chosen only when its
 * own `{provider, model, taskType}` trials earn it (`evaluateProviderFitness`), and never for a kind the
 * {@link CRITICAL_WORK_GATE} holds. What a row adds is its `tierEquivalent`, carried onto the route so a
 * reader sees which Claude tier the external worker is replacing.
 *
 * `gpt-6-astra` is listed at `opus`, not `sonnet`: it is reportedly close to Opus 5.5 (operator, 2026-09-26), so
 * it may take work the tier table puts at Opus once its evidence allows, not only Sonnet-tier work. A model
 * with no row here has `tierEquivalent: null` (unranked), and routes exactly as before this table existed.
 */
// @test-only-export-ok: Shared library exported for the mechanical dispatch path (#3906) and its own test
export const EXTERNAL_WORKER_CANDIDATES = Object.freeze([
  Object.freeze({ provider: 'codex', model: CODEX_MODEL, tierEquivalent: CLAUDE_TIERS.OPUS }),
]);

/**
 * The Claude tier an external `{provider, model}` stands in for, from {@link EXTERNAL_WORKER_CANDIDATES}, or
 * `null` when the pair has no row. Pure.
 * @param {string} provider
 * @param {string|null} model
 * @returns {string|null}
 */
// @test-only-export-ok: Shared library exported for the mechanical dispatch path (#3906) and its own test
export function externalTierEquivalent(provider, model) {
  const row = EXTERNAL_WORKER_CANDIDATES.find((c) => c.provider === provider && c.model === model);
  return row ? row.tierEquivalent : null;
}

/**
 * THE CRITICAL-WORK GATE (#3906, opened per taskType by #4034). A dispatch of one of these `kinds` builds or
 * repairs product code. For a gated kind the Gemini, Codex and dual-dispatch steps are skipped and the dispatch
 * takes the Claude tier table — UNLESS every one of these holds:
 *
 *   1. the task's `taskType` row in `openForNonCritical` is `true` (an explicit, per-taskType operator switch;
 *      `doc-fix` and `ci-heal` are open on probation since 2026-09-27, `bugfix` since 2026-09-29,
 *      and `build-new-feature` since 2026-09-30 (Argon added 2026-10-15);
 *      `prepare` and `test-fix` are also open, while `conflict-resolution` stays closed);
 *   2. the caller supplied the critical-work verdict (`context.criticalWork`, from
 *      `we:scripts/lib/critical-work.mjs#criticalWorkVerdict`) and it says NOT critical — a missing verdict
 *      fails closed;
 *   3. the caller supplied the critical-miss list (`context.criticalMisses`, from `critical-work.mjs#criticalMissesFor`)
 *      — a missing list fails closed. A {provider, model, taskType} triple on that list is HARD-VETOED: a miss on
 *      critical work is never outweighed by any clean streak.
 *
 * Even then the provider must still earn the work on its own trials (`evaluateProviderFitness`), and an opened
 * gated kind never takes the dual-dispatch (`both`) step. The exception is an opened taskType with a
 * {@link PROBATION_ROSTER} row: there the recommendation stays Claude (the fallback executor) and one roster
 * worker is offered beside it as `probationWorker` ({@link selectProbationWorker}), so the worker earns its
 * record on real, non-critical work. Supervision is unchanged: every such PR still gets the
 * full review plus the A2/A3 seats. Other kinds, and a caller with no `kind` (an interactive session asking for
 * advice), are unaffected.
 *
 * To open one taskType, flip its row to `true` — one line, reviewed like any other change.
 */
// @test-only-export-ok: Shared library exported for the mechanical dispatch path (#3906) and its own test
export const CRITICAL_WORK_GATE = DEFAULT_ROUTING_POLICY.criticalWorkGate;

/**
 * Decide the critical-work gate for one dispatch. Pure. Returns `null` when the kind is not gated (the gate does
 * not apply), else `{open, reason, vetoes}` — `vetoes` being the critical-miss triples for this taskType.
 * @param {object} gate
 * @param {string} kind
 * @param {string} taskType
 * @param {object} context
 */
export function decideCriticalWorkGate(gate, kind, taskType, context) {
  if (!gate.kinds.includes(kind)) return null;
  const rows = gate.openForNonCritical && typeof gate.openForNonCritical === 'object' ? gate.openForNonCritical : {};
  const closed = (why) => ({ open: false, reason: `kind '${kind}' is gated: ${why}`, vetoes: [] });
  if (rows[taskType] !== true) return closed(`taskType '${taskType}' is not opened in CRITICAL_WORK_GATE.openForNonCritical`);
  const verdict = context?.criticalWork;
  if (!verdict || typeof verdict.critical !== 'boolean') return closed('no critical-work verdict supplied (fail closed)');
  const misses = context?.criticalMisses;
  if (!Array.isArray(misses)) return closed('no critical-miss list supplied (fail closed)');
  if (verdict.critical) {
    const why = Array.isArray(verdict.reasons) ? verdict.reasons.map((r) => r?.proxy).filter(Boolean).join(', ') : '';
    return closed(`critical work${why ? ` (${why})` : ''} never leaves Claude`);
  }
  return {
    open: true,
    reason: `taskType '${taskType}' is opened for non-critical work, and this task is not critical`,
    vetoes: misses.filter((m) => m && m.taskType === taskType),
  };
}

/**
 * THE PROBATION WORKERS (agy-launcher-probation, operator 2026-09-27) — the non-Claude workers an OPENED,
 * non-critical {@link CRITICAL_WORK_GATE} taskType may be launched on while they build a record. Each row names
 * WHO runs the work (`provider`/`model`, the trust unit), WHAT reports it on the run record (`executor`, the
 * #2815 field), and WHICH synchronous launcher script runs it. `checker` names the second provider that must
 * pass the result before it is pushed (Gemini only: #3922 lets it take simple steps under a Claude/Codex check).
 * `simpleOnly` rows require a simple task; test-fix satisfies this through its enforced test-only envelope.
 */
// @test-only-export-ok: Shared library exported for the probation launcher (agy-launcher-probation) and its own test
export const PROBATION_WORKERS = Object.freeze({
  codex: Object.freeze({ id: 'codex', provider: 'codex', model: CODEX_MODEL, executor: 'codex', launcher: 'scripts/codex-direct-task.mjs', simpleOnly: false, checker: null }),
  'antigravity-claude': Object.freeze({ id: 'antigravity-claude', provider: 'antigravity', model: null, executor: 'antigravity', launcher: 'scripts/gemini-direct-task.mjs', simpleOnly: false, checker: null }),
  'antigravity-argon': Object.freeze({ id: 'antigravity-argon', provider: 'antigravity', model: BUILD_ARGON_SETTINGS.value.model, executor: 'antigravity', launcher: 'scripts/gemini-direct-task.mjs', simpleOnly: false, checker: 'codex' }),
  'antigravity-gemini': Object.freeze({ id: 'antigravity-gemini', provider: 'antigravity', model: AGY_GEMINI_SIMPLE_MODEL, executor: 'antigravity', launcher: 'scripts/gemini-direct-task.mjs', simpleOnly: true, checker: 'codex' }),
});

/**
 * Which probation workers each opened taskType may use, in tie-break order. A taskType with no row here gets no
 * probation worker even when its gate row is open (it then routes on earned trials alone, as before).
 */
// @test-only-export-ok: Shared library exported for the probation launcher (agy-launcher-probation) and its own test
export const PROBATION_ROSTER = Object.freeze({
  'build-new-feature': Object.freeze(['codex', 'antigravity-argon']),
  'prepare': Object.freeze(['codex', 'antigravity-gemini']),
  'test-fix': Object.freeze(['antigravity-gemini']),
  'doc-fix': Object.freeze(['antigravity-claude', 'codex']),
  'ci-heal': Object.freeze(['antigravity-claude', 'codex', 'antigravity-gemini']),
  'bugfix': Object.freeze(['codex', 'antigravity-claude', 'antigravity-gemini']),
});

/** Preserve worker authorization and checker identity across explicit policy hand-offs. */
export function probationWorkerForRoute({ provider, model, effort }, taskType) {
  const id = provider === 'codex' ? 'codex' : model.startsWith('claude-') ? 'antigravity-claude'
    : resolveBuildArgonModel(model) ? 'antigravity-argon' : 'antigravity-gemini';
  return { ...PROBATION_WORKERS[id], model, effort, taskType };
}

/**
 * PICK ONE PROBATION WORKER for an opened, non-critical task. PURE and deterministic over its arguments.
 *
 * Refuses (returns `worker: null`) for statute-tier paths, judgment taskTypes, a scope outside the proven
 * envelope (not checked for `ci-heal`: the heal's own diff is unknown up front, so the launcher bounds it after
 * the run instead), and a taskType with no roster row. Otherwise, over the roster:
 *   1. drop a `simpleOnly` worker unless `simple === true` or the taskType is `test-fix`;
 *   2. drop a worker whose exact {provider, model, taskType} triple has a critical miss (`vetoes`, #4034);
 *   3. rank a worker whose most recent JUDGED trial for this taskType was not clean after one whose was (a
 *      launch row still awaiting its review has no outcome yet and is not a failure);
 *   4. then the worker with FEWER recorded trials for this taskType, launch rows included (probation collects
 *      data evenly, and a launch moves the rotation on before its review lands);
 *   5. then roster order.
 * Every pick is supervised `full`, fully reviewed, and owes a run rating — probation never lightens either.
 *
 * @param {{taskType: string, tier?: string, simple?: boolean, filesTouched?: string[], estimatedSize?: number,
 *   scorecards?: Array<object>, vetoes?: Array<object>, availability?: object, argonSettings?: object}} o
 * @returns {{worker: object|null, auditTrail: Array<object>, reason: string}}
 */
// @test-only-export-ok: Shared library exported for the probation launcher (agy-launcher-probation) and its own test
export function selectProbationWorker({ taskType, tier = CLAUDE_TIERS.SONNET, simple = false, filesTouched = [], estimatedSize = 0, scorecards = [], vetoes = [], availability = {}, argonSettings = BUILD_ARGON_SETTINGS } = {}) {
  availability ??= {};
  argonSettings ??= BUILD_ARGON_SETTINGS;
  const auditTrail = [];
  // Settings may be JSON objects: audit malformed leaves without invoking their coercion hooks.
  const settingLabel = (value) => typeof value === 'string' ? JSON.stringify(value.slice(0, 200))
    : typeof value === 'boolean' ? String(value) : `<${typeof value}>`;
  const none = (reason) => ({ worker: null, auditTrail, reason });
  const roster = PROBATION_ROSTER[taskType];
  if (!roster) return none(`taskType '${taskType}' has no probation roster`);
  if (taskType === 'architectural-decision' || taskType === 'triage-research') return none(`taskType '${taskType}' needs Claude judgment`);
  if (filesTouched.some(isStatuteTierPath)) return none('statute-tier paths stay on Claude');
  if (taskType !== 'ci-heal' && !isWithinProvenEnvelope(taskType, estimatedSize, filesTouched.length)) {
    return none(`scope (${filesTouched.length} files, ${estimatedSize} LOC) exceeds the proven '${taskType}' envelope`);
  }
  if (taskType === 'test-fix' && (!filesTouched.length || !filesTouched.every(isTestPath))) {
    return none('test-fix requires only test paths; use the normal route for production changes');
  }
  const records = Array.isArray(scorecards) ? scorecards : [];
  const candidates = [];
  roster.forEach((id, order) => {
    const def = PROBATION_WORKERS[id];
    if (id === 'antigravity-argon') {
      const value = argonSettings.value ?? {};
      const sources = argonSettings.sources ?? {};
      auditTrail.push({ criterion: `probation-candidate:${id}`, result: value.enabled === true ? 'enabled' : 'disabled', dataConsulted: `build.argon.enabled=${settingLabel(value.enabled)} (${settingLabel(sources.enabled)}), build.argon.model=${settingLabel(value.model)} (${settingLabel(sources.model)})`, reasoning: 'build probation cascade setting' });
      if (value.enabled !== true) return;
    }
    const held = availability[id] || availability[def.provider] || (def.checker && availability[def.checker]);
    if (held) {
      auditTrail.push({ criterion: `probation-candidate:${id}`, result: 'quota-held', dataConsulted: settingLabel(held), reasoning: 'active backend or checker hold; availability otherwise unknown' });
      return;
    }
    const model = id === 'antigravity-argon'
      ? resolveBuildArgonModel(argonSettings.value?.model)
      : def.model ?? AGY_CLAUDE_MODEL_BY_TIER[tier] ?? AGY_CLAUDE_MODEL_BY_TIER.sonnet;
    if (!model) {
      auditTrail.push({ criterion: `probation-candidate:${id}`, result: 'invalid-model', dataConsulted: settingLabel(argonSettings.value?.model), reasoning: 'build.argon.model must be approved for non-simple Argon builds' });
      return;
    }
    if (def.simpleOnly && simple !== true && taskType !== 'test-fix') {
      auditTrail.push({ criterion: `probation-candidate:${id}`, result: 'skipped', dataConsulted: `simple=${simple === true}`, reasoning: 'offered only for a simple task' });
      return;
    }
    if (vetoes.some((v) => v?.provider === def.provider && v.model === model && v.taskType === taskType)) {
      auditTrail.push({ criterion: `probation-candidate:${id}`, result: 'vetoed', dataConsulted: `${def.provider}/${model}/${taskType}`, reasoning: 'a critical miss is on record for this exact triple (#4034)' });
      return;
    }
    const rows = getSortedRecordsForProviderAndTask(records, [def.provider], taskType).filter((r) => r.model === model);
    // A launch row with no outcome yet (awaiting its review) counts as a trial for the rotation, never as a failure.
    const lastJudged = rows.find((r) => r.outcome != null);
    const recentFailure = lastJudged && !isCleanRecord(lastJudged) ? 1 : 0;
    candidates.push({ def, model, order, recentFailure, trials: rows.length });
    auditTrail.push({ criterion: `probation-candidate:${id}`, result: `recentFailure=${recentFailure} trials=${rows.length}`, dataConsulted: `${def.provider}/${model}/${taskType}`, reasoning: 'eligible' });
  });
  if (!candidates.length) return none(`no probation worker is eligible for '${taskType}'`);
  candidates.sort((a, b) => a.recentFailure - b.recentFailure || a.trials - b.trials || a.order - b.order);
  const pick = candidates[0];
  const toWorker = (c) => Object.freeze({
    id: c.def.id,
    provider: c.def.provider,
    model: c.model,
    executor: c.def.executor,
    launcher: c.def.launcher,
    checker: c.def.checker,
    taskType,
    trials: c.trials,
    supervision: SUPERVISION_LEVELS.FULL,
    review: 'full',
    runRating: 'required',
  });
  // The other eligible workers, in rotation order: the launch boundary tries them when the pick's executable
  // (or its checker's) is missing, before it falls back to Claude. Pure eligibility only — no binary probe here.
  const worker = Object.freeze({ ...toWorker(pick), alternates: Object.freeze(candidates.slice(1).map(toWorker)) });
  const reason = `probation worker ${worker.id} (${worker.provider}/${worker.model}) for '${taskType}': last trial ${pick.recentFailure ? 'not clean' : 'clean or none'}, ${pick.trials} trial(s) so far; full review and a run rating are owed on the result`;
  auditTrail.push({ criterion: 'probation-worker', result: worker.id, dataConsulted: `roster=${roster.join(',')}, simple=${simple === true}`, reasoning: reason });
  return { worker, auditTrail, reason };
}

/**
 * THE MODEL-TIER TABLE (#3857) — the ONE checked-in table deciding a dispatch worker's Claude tier, by
 * dispatch fact, replacing both the old size/file-count/testability Opus criteria this function's Step 4
 * used to compute inline and the standalone `STORY_KIND_RUNGS` table (`dispatch-contracts.mjs`), which
 * this folds in rather than keeping beside. Updated by the operator's 2026-09-29 risk-based ruling
 * (`docs/agent/platform-decisions.md#daemon-claude-worker-risk`); originally the 2026-09-22 routing rule
 * (narrower and later than `docs/agent/backlog-workflow.md#model-routing`, which governs the INTERACTIVE
 * orchestrating loop's own sub-agent spawns and is untouched by this table — see
 * [delegation-trial-record-graduation](/docs/agent/platform-decisions.md#delegation-trial-record-graduation),
 * "Reach": mechanical routing binds the mechanical dispatch path only).
 *
 * RAISE-ONLY: every row below can only move a dispatch from `sonnet` up to `opus`, never down — the
 * function returns as soon as one row matches, and the fallback (no row matches) is always `sonnet`.
 * `haiku` is never a table output.
 *
 * @param {{kind?: string, taskType?: string, scopePaths?: string[], tags?: string[], risk?: string}} [o]
 * @returns {{tier: 'sonnet'|'opus', reason: string}}
 */
// @test-only-export-ok: Shared library exported for the mechanical dispatch spawn path (#3857) and its own test
export function workerTierFor({ kind, taskType, scopePaths, tags, risk } = {}) {
  const k = typeof kind === 'string' ? kind.trim() : '';
  const t = typeof taskType === 'string' ? taskType.trim() : '';
  const paths = Array.isArray(scopePaths) ? scopePaths.map(String) : [];
  const tagList = Array.isArray(tags) ? tags.map(String) : [];

  if (k === 'prepare-decision' || t === 'architectural-decision') {
    return { tier: CLAUDE_TIERS.OPUS, reason: "preparing a decision's forks is judgment" };
  }
  if (paths.some(isStatuteTierPath) || k === 'statute-wording') {
    return { tier: CLAUDE_TIERS.OPUS, reason: 'rewording statute or rule text' };
  }
  if (k === 'security-fix' || tagList.includes('security')) {
    return { tier: CLAUDE_TIERS.OPUS, reason: 'a security-critical fix' };
  }
  if (risk === 'high') {
    return { tier: CLAUDE_TIERS.OPUS, reason: 'high-risk work' };
  }
  return { tier: CLAUDE_TIERS.SONNET, reason: "the standard's default" };
}

/**
 * Check if a task scope fits within the proven historical envelope for that taskType.
 * Grounded in the real trial observations in the shared scorecard store (`run-scorecard-store.mjs`).
 * Unit for estimatedSize: net changed lines of code (LOC).
 * @param {string} taskType
 * @param {number} estimatedSize
 * @param {number} filesTouchedCount
 * @returns {boolean}
 */
// @test-only-export-ok: Shared library exported for interactive Claude sessions and conveyor runners
export function isWithinProvenEnvelope(taskType, estimatedSize, filesTouchedCount) {
  const envelope = PROVEN_TASK_ENVELOPES[taskType] || { maxLoc: 200, maxFiles: 3 };
  if (typeof estimatedSize === 'number' && estimatedSize > envelope.maxLoc) return false;
  if (typeof filesTouchedCount === 'number' && filesTouchedCount > envelope.maxFiles) return false;
  return true;
}

/**
 * Check if a task is high-stakes / correctness-critical (#3690).
 * Touching test files alone (`/\.test\.|__tests__/`) is NOT sufficient alone per the brief.
 * A task is high-stakes iff:
 * 1. taskType is 'bugfix' or 'conflict-resolution', AND
 * 2. It touches at least one test file (matching /\.test\.|__tests__|\.spec\./), AND
 * 3. It ALSO touches critical infrastructure/runtime paths:
 *    - `scripts/conveyor/`, `scripts/lib/`, `scripts/operations/` (the conveyor harness and review gate engine), OR
 *    - `blocks/`, `plugs/`, `src/_data/` (core standards contracts and runtime protocols), OR
 *    - touches 3 or more implementation files alongside the test files.
 * @param {{ taskType?: string }} task
 * @param {{ filesTouched?: string[] }} context
 * @returns {boolean}
 */
// @test-only-export-ok: Shared library exported for interactive Claude sessions and conveyor runners
export function isHighStakesTask(task, context) {
  const taskType = task?.taskType;
  if (taskType !== 'bugfix' && taskType !== 'conflict-resolution') return false;
  const files = Array.isArray(context?.filesTouched) ? context.filesTouched : [];
  const touchesTests = files.some((p) => typeof p === 'string' && /(\.test\.|__tests__|\.spec\.)/.test(p));
  if (!touchesTests) return false;

  const CRITICAL_PREFIXES = [
    'scripts/conveyor/',
    'scripts/lib/',
    'scripts/operations/',
    'blocks/',
    'plugs/',
    'src/_data/',
  ];
  const touchesCritical = files.some((p) => {
    if (typeof p !== 'string') return false;
    const clean = p.replace(/^\.?\//, '');
    return CRITICAL_PREFIXES.some((prefix) => clean.startsWith(prefix));
  });
  if (touchesCritical) return true;

  const implFiles = files.filter((p) => typeof p === 'string' && !/(\.test\.|__tests__|\.spec\.)/.test(p));
  return implFiles.length >= 3;
}

/** Check if a scorecard record is clean (explicit landed outcome; fail-closed otherwise). Pure. */
function isCleanRecord(record) {
  if (!record || typeof record !== 'object') return false;
  return record.outcome === 'landed';
}

/**
 * Check if a scorecard record was informative (independent review found a real problem that was
 * then fixed). Pure. Reads ONLY the explicit `informative` field the logging CLI writes — never
 * inferred from `outcome` or `findings` (platform-decisions.md#delegation-trial-record-graduation,
 * rule 4; #3888).
 */
function isInformativeRecord(record) {
  if (!record || typeof record !== 'object') return false;
  const isVerified = record.verifiedBy === 'claude-subagent' || record.verifiedBy === 'independent-claude';
  if (!isVerified) return false;
  return record.informative === true;
}

/**
 * Check if a scorecard record carries a root-cause note in its own recorded field — never inferred
 * from `findings` or any other free-text field (platform-decisions.md#delegation-trial-record-graduation,
 * rule 5; #3889). Pure.
 */
function hasRootCauseNote(record) {
  if (!record || typeof record !== 'object') return false;
  return typeof record.rootCause === 'string' && record.rootCause.trim() !== '';
}

/**
 * Filter and sort scorecards for a specific provider and taskType.
 * Pure and deterministic.
 */
function getSortedRecordsForProviderAndTask(scorecards, providers, taskType) {
  const matching = scorecards.filter((r) =>
    r && typeof r === 'object' &&
    providers.includes(r.provider) &&
    r.taskType === taskType
  );
  return [...matching].sort((a, b) => {
    const tA = typeof a.scoredAt === 'string' ? a.scoredAt : '';
    const tB = typeof b.scoredAt === 'string' ? b.scoredAt : '';
    return tB.localeCompare(tA);
  });
}

/**
 * Evaluate single-provider fitness (Gemini or Codex) according to the 5 brief criteria.
 * @param {string[]} providerNames
 * @param {string} taskType
 * @param {string[]} filesTouched
 * @param {number} estimatedSize
 * @param {Array<object>} scorecards
 * @param {string|undefined} [preferredModel]
 * @returns {{ fit: boolean, fitModel: string|null, reason: string }}
 */
function evaluateProviderFitness(providerNames, taskType, filesTouched, estimatedSize, scorecards, preferredModel, vetoes = []) {
  const providerLabel = providerNames[0];

  // Criterion 5: architectural-decision or triage-research always require human/Claude judgment
  if (taskType === 'architectural-decision' || taskType === 'triage-research') {
    return {
      fit: false,
      fitModel: null,
      reason: `Task type '${taskType}' requires deep repo judgment; external models are excluded by policy.`,
    };
  }

  // Criterion 3: statute-tier paths force Claude, never external models
  const touchesStatute = filesTouched.some(isStatuteTierPath);
  if (touchesStatute) {
    return {
      fit: false,
      fitModel: null,
      reason: 'Touched files contain statute-tier paths (docs/agent/); forces Claude.',
    };
  }

  // Criterion 4: estimatedSize and filesTouched count within proven envelope
  if (!isWithinProvenEnvelope(taskType, estimatedSize, filesTouched.length)) {
    return {
      fit: false,
      fitModel: null,
      reason: `Scope (${filesTouched.length} files, ${estimatedSize} LOC) exceeds ${providerLabel}'s proven envelope for '${taskType}'.`,
    };
  }

  // Group candidate trials by model
  const records = getSortedRecordsForProviderAndTask(scorecards, providerNames, taskType);
  const models = preferredModel
    ? [preferredModel]
    : [...new Set(records.map((r) => r.model).filter((m) => typeof m === 'string' && m.trim().length > 0))];

  if (models.length === 0) {
    return {
      fit: false,
      fitModel: null,
      reason: `No recorded trials found for ${providerLabel} on taskType '${taskType}'.`,
    };
  }

  let vetoed = 0;
  for (const model of models) {
    const modelRecords = records.filter((r) => r.model === model);
    if (modelRecords.length === 0) continue;

    // #4034 — HARD VETO: a critical miss on record for this {provider, model, taskType} triple.
    if (vetoes.some((v) => providerNames.includes(v?.provider) && v.model === model && v.taskType === taskType)) {
      vetoed += 1;
      continue;
    }

    // Criterion 1: at least one clean trial with verifiedBy in ('claude-subagent', 'independent-claude')
    const verifiedCleanTrials = modelRecords.filter((r) =>
      (r.verifiedBy === 'claude-subagent' || r.verifiedBy === 'independent-claude') &&
      isCleanRecord(r)
    );
    if (verifiedCleanTrials.length === 0) {
      continue;
    }

    // Criterion 2: no trial for this triple has an unresolved finding as its MOST RECENT record
    const mostRecentTrial = modelRecords[0];
    if (!isCleanRecord(mostRecentTrial)) {
      continue;
    }

    // All criteria satisfied for this model
    return {
      fit: true,
      fitModel: model,
      reason: `At least one clean verified trial exists for model '${model}', most recent trial is clean, and scope is within proven envelope.`,
    };
  }

  return {
    fit: false,
    fitModel: null,
    reason: vetoed > 0
      ? `Hard veto: ${vetoed} ${providerLabel} model(s) have a critical miss on record for '${taskType}' (#4034); no other model qualifies.`
      : `No model under ${providerLabel} has a qualifying clean track record without unresolved findings for '${taskType}'.`,
  };
}

/**
 * @typedef {Object} AuditTrailEntry
 * @property {string} criterion - The name of the criterion evaluated.
 * @property {string} result - The outcome or decision token for this step.
 * @property {string} dataConsulted - Summary of inputs and scorecards consulted.
 * @property {string} reasoning - Detailed rationale for this evaluation step.
 */

/**
 * @typedef {Object} ProviderRecommendation
 * @property {'gemini'|'codex'|'both'|'claude'} recommendation - The selected provider.
 * @property {'haiku'|'sonnet'|'opus'|null} claudeTier - Claude tier when recommendation is 'claude', otherwise null.
 * @property {{ tool: string, cliModel: string, reason: string }|null} [alternateBackend] - Default capacity-relief agy route on the Claude branch only; null for Haiku, forced-native identity, or an unclean latest Antigravity trial for this taskType.
 * @property {AuditTrailEntry[]} auditTrail - Sequence of criteria evaluated in cascade order.
 * @property {string} reasoning - Human-readable summary paragraph explaining the recommendation.
 * @property {{ suggestedProvider: string, suggestedModel: string, category: string, value: number, unit: string, asOf: string, source: string, reason: string }|null} explorationHint - Advisory verified external rating when either provider group's trial history is thin.
 */

/**
 * SELECT DISPATCH PROVIDER (`selectProvider`).
 *
 * Deterministic cascade:
 *   1. Gemini / Antigravity fitness check -> 'gemini'
 *   2. Codex fitness check -> 'codex'
 *   3. Both together (high-stakes correctness or thin history without informative trials) -> 'both'
 *   4. Claude fallback by effort tier ('haiku' | 'sonnet' | 'opus') -> 'claude'
 *
 * PURE: No filesystem or process reads. Deterministic over its arguments.
 *
 * @param {{ description?: string, taskType: 'bugfix'|'doc-fix'|'conflict-resolution'|'triage-research'|'build-new-feature'|'architectural-decision' }} task
 * @param {{ filesTouched?: string[], estimatedSize?: number, scorecards?: Array<object>|{records: Array<object>}, acceptanceTestable?: boolean, model?: string, capabilityRatings?: Array<object>|{version: number, entries: Array<object>, dropped: Array<object>}, capabilityCategory?: string }} context - All data is caller-loaded; capabilityCategory overrides the task's default exploration category. Scorecards also inform the default agy alternate's taskType-specific reliability veto.
 * @returns {ProviderRecommendation} Includes optional alternateBackend on the Claude branch only (null when not applicable).
 */
// @test-only-export-ok: Shared library exported for interactive Claude sessions and conveyor runners
export function selectProvider(task, context) {
  const taskType = task?.taskType || 'bugfix';
  const description = typeof task?.description === 'string' ? task.description : '';
  const filesTouched = Array.isArray(context?.filesTouched) ? context.filesTouched : [];
  const rawSize = context?.estimatedSize;
  const estimatedSize = typeof rawSize === 'number' && Number.isFinite(rawSize)
    ? rawSize
    : (filesTouched.length > 0 ? filesTouched.length * 50 : 0);
  const rawScorecards = context?.scorecards;
  const scorecards = Array.isArray(rawScorecards)
    ? rawScorecards
    : (Array.isArray(rawScorecards?.records) ? rawScorecards.records : []);
  const preferredModel = typeof context?.model === 'string' ? context.model : undefined;
  const acceptanceTestable = context?.acceptanceTestable;
  const kind = typeof context?.kind === 'string' ? context.kind : '';
  const tags = Array.isArray(context?.tags) ? context.tags : [];

  const auditTrail = [];
  const statuteFiles = filesTouched.filter(isStatuteTierPath);
  const hasStatuteFile = statuteFiles.length > 0;

  // #3906 — the critical-work gate: a gated kind never reaches an external provider (steps 1-3 are skipped).
  // `context.criticalWorkGate` replaces the default only when a caller states a different gate on purpose.
  // #4034 — a gated kind opens only per taskType, only for non-critical work, and never for a vetoed triple.
  const gate = context?.criticalWorkGate && Array.isArray(context.criticalWorkGate.kinds) ? context.criticalWorkGate : CRITICAL_WORK_GATE;
  const gateDecision = decideCriticalWorkGate(gate, kind, taskType, context);
  const gated = gateDecision !== null && !gateDecision.open;
  const gatedKindOpen = gateDecision !== null && gateDecision.open;
  const vetoes = gatedKindOpen ? gateDecision.vetoes : [];
  const gatedFit = { fit: false, fitModel: null, reason: gated ? `${gateDecision.reason}.` : '' };
  // agy-launcher-probation — an opened taskType with a probation roster never switches the recommendation to an
  // external provider: Claude stays the recommended (fallback) executor, and the roster's pick rides beside it as
  // `probationWorker` for a launcher to run. Earned-fitness checks below still run, for the audit trail.
  const probationTask = gatedKindOpen && Object.hasOwn(PROBATION_ROSTER, taskType);
  if (gateDecision) {
    auditTrail.push({
      criterion: 'critical-work-gate',
      result: gatedKindOpen ? 'open-non-critical' : 'claude-only',
      dataConsulted: `kind='${kind}', taskType='${taskType}', gated kinds=${gate.kinds.join(',')}, critical=${context?.criticalWork?.critical ?? 'unknown'}, criticalMissVetoes=${vetoes.length}`,
      reasoning: gateDecision.reason,
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 1: Gemini / Antigravity Fitness Check
  // ──────────────────────────────────────────────────────────────────────────
  const geminiCheck = gated ? gatedFit : evaluateProviderFitness(
    ['gemini', 'antigravity'],
    taskType,
    filesTouched,
    estimatedSize,
    scorecards,
    preferredModel,
    vetoes
  );
  auditTrail.push({
    criterion: 'gemini-fitness',
    result: geminiCheck.fit ? 'fit' : 'unfit',
    dataConsulted: `providers=['gemini','antigravity'], taskType='${taskType}', files=${filesTouched.length}, size=${estimatedSize} LOC, statute=${hasStatuteFile}`,
    reasoning: geminiCheck.reason,
  });

  if (geminiCheck.fit && !probationTask) {
    const reasoning = `Gemini is fit for task '${taskType}' (${description || 'unnamed'}): model '${geminiCheck.fitModel}' has a clean verified track record without unresolved findings, scope (${filesTouched.length} files, ${estimatedSize} LOC) is within proven envelope, and no statute-tier paths are touched.`;
    return {
      recommendation: RECOMMENDATIONS.GEMINI,
      claudeTier: null,
      auditTrail,
      reasoning,
      explorationHint: getExplorationHint(taskType, scorecards, context),
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 2: Codex Fitness Check
  // ──────────────────────────────────────────────────────────────────────────
  const codexCheck = gated ? gatedFit : evaluateProviderFitness(
    ['codex'],
    taskType,
    filesTouched,
    estimatedSize,
    scorecards,
    preferredModel,
    vetoes
  );
  auditTrail.push({
    criterion: 'codex-fitness',
    result: codexCheck.fit ? 'fit' : 'unfit',
    dataConsulted: `provider='codex', taskType='${taskType}', files=${filesTouched.length}, size=${estimatedSize} LOC, statute=${hasStatuteFile}`,
    reasoning: codexCheck.reason,
  });

  if (codexCheck.fit && !probationTask) {
    const reasoning = `Codex is fit for task '${taskType}' (${description || 'unnamed'}): model '${codexCheck.fitModel}' has a clean verified track record without unresolved findings, scope (${filesTouched.length} files, ${estimatedSize} LOC) is within proven envelope, and no statute-tier paths are touched.`;
    return {
      recommendation: RECOMMENDATIONS.CODEX,
      claudeTier: null,
      // #3906 — the Claude tier this external model stands in for (`EXTERNAL_WORKER_CANDIDATES`), or null.
      tierEquivalent: externalTierEquivalent('codex', codexCheck.fitModel),
      auditTrail,
      reasoning,
      explorationHint: getExplorationHint(taskType, scorecards, context),
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 3: Both Together
  // ──────────────────────────────────────────────────────────────────────────
  let bothFit = false;
  let bothReason = '';

  if (gated) {
    bothFit = false;
    bothReason = gatedFit.reason;
  } else if (gatedKindOpen) {
    bothFit = false;
    bothReason = `kind '${kind}' is opened for a single earned provider only; a gated kind never takes dual dispatch (#4034).`;
  } else if (hasStatuteFile) {
    bothFit = false;
    bothReason = 'Statute-tier paths touched; policy requires Claude Opus, not external dual dispatch.';
  } else if (taskType === 'architectural-decision' || taskType === 'triage-research') {
    bothFit = false;
    bothReason = `Task type '${taskType}' requires deep architectural or triage judgment; requires Claude.`;
  } else {
    // Condition 3A: High-stakes / correctness-critical
    const isHighStakes = isHighStakesTask(task, context);
    if (isHighStakes) {
      bothFit = true;
      bothReason = `Task '${taskType}' is high-stakes/correctness-critical touching test files alongside critical infrastructure; dispatching both Gemini and Codex mitigates single-model regression risk.`;
    } else {
      // Condition 3B: Thin history on record for this taskType
      const candidateRecords = scorecards.filter((r) =>
        r && typeof r === 'object' &&
        r.taskType === taskType &&
        ['gemini', 'antigravity', 'codex'].includes(r.provider)
      );
      const hasAnyGeminiInformative = scorecards.some((r) =>
        r && typeof r === 'object' &&
        ['gemini', 'antigravity'].includes(r.provider) &&
        r.taskType === taskType &&
        isInformativeRecord(r)
      );
      const hasAnyCodexInformative = scorecards.some((r) =>
        r && typeof r === 'object' &&
        r.provider === 'codex' &&
        r.taskType === taskType &&
        isInformativeRecord(r)
      );

      // Thin history applies when trials exist on record but neither has earned an informative trial,
      // or when dispatching both is warranted to build empirical data rather than picking blind.
      if (candidateRecords.length > 0 && !hasAnyGeminiInformative && !hasAnyCodexInformative) {
        bothFit = true;
        bothReason = `Trial history for '${taskType}' is too thin to trust either model alone (neither Gemini nor Codex has an informative trial with confirmed findings on record); dispatching both to compare rather than picking blind.`;
      }
    }
  }

  auditTrail.push({
    criterion: 'both-together',
    result: bothFit ? 'fit' : 'skipped',
    dataConsulted: `highStakes=${isHighStakesTask(task, context)}, taskType='${taskType}', statute=${hasStatuteFile}`,
    reasoning: bothFit ? bothReason : (bothReason || 'Neither high-stakes criteria nor thin-history dual dispatch condition was met.'),
  });

  if (bothFit) {
    const reasoning = `Both Gemini and Codex are recommended for task '${taskType}' (${description || 'unnamed'}): ${bothReason}`;
    return {
      recommendation: RECOMMENDATIONS.BOTH,
      claudeTier: null,
      auditTrail,
      reasoning,
      explorationHint: getExplorationHint(taskType, scorecards, context),
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 4: Claude Fallback by Effort Tier — the ONE checked-in table (#3857), never inline criteria.
  // ──────────────────────────────────────────────────────────────────────────
  const tierDecision = workerTierFor({ kind, taskType, scopePaths: filesTouched, tags, risk: context?.risk });
  const claudeTier = tierDecision.tier;
  const claudeReason = tierDecision.reason;

  auditTrail.push({
    criterion: 'claude-tier',
    result: claudeTier,
    dataConsulted: `taskType='${taskType}', files=${filesTouched.length}, size=${estimatedSize} LOC, statute=${hasStatuteFile}, risk=${context?.risk ?? 'unspecified'}, testable=${acceptanceTestable !== false}`,
    reasoning: claudeReason,
  });

  const cliModel = AGY_CLAUDE_MODEL_BY_TIER[claudeTier];
  const forcedNativeIdentity = hasStatuteFile || taskType === 'architectural-decision' || taskType === 'triage-research';
  const latestAntigravityTrial = getSortedRecordsForProviderAndTask(scorecards, ['antigravity'], taskType)[0];
  const agyAlternateResult = !cliModel ? 'not-applicable'
    : forcedNativeIdentity ? 'forced-native'
      : latestAntigravityTrial && !isCleanRecord(latestAntigravityTrial) ? 'recent-failure'
        : 'offered';
  const alternateBackend = agyAlternateResult === 'offered' ? {
    tool: 'scripts/gemini-direct-task.mjs',
    cliModel,
    reason: `Default capacity-relief recommendation: run this ${claudeTier}-tier dispatch via \`node scripts/gemini-direct-task.mjs --model=${cliModel}\`, using Antigravity's separate quota for the same model family.`,
  } : null;

  auditTrail.push({
    criterion: 'agy-alternate-backend',
    result: agyAlternateResult,
    dataConsulted: `claudeTier='${claudeTier}', taskType='${taskType}', statute=${hasStatuteFile}, latestAntigravityTrial=${latestAntigravityTrial ? (latestAntigravityTrial.scoredAt || 'unscored') : 'none'}`,
    reasoning: agyAlternateResult === 'not-applicable'
      ? 'Haiku has no agy-hosted equivalent, so no alternate backend applies.'
      : agyAlternateResult === 'forced-native'
        ? 'Statute-tier paths, architectural decisions and triage research require native Claude session identity and tool access.'
        : agyAlternateResult === 'recent-failure'
          ? `The most recent Antigravity trial for taskType '${taskType}' is not clean; native Claude is required until a later clean trial supersedes it.`
          : `Offered agy model '${cliModel}' by default for capacity relief on the same Claude tier.`,
  });

  let probationWorker = null;
  if (probationTask) {
    const picked = selectProbationWorker({
      taskType, tier: claudeTier, simple: context?.simple === true, filesTouched, estimatedSize, scorecards, vetoes,
      availability: context?.availability ?? {}, argonSettings: context?.argonSettings ?? BUILD_ARGON_SETTINGS,
    });
    auditTrail.push(...picked.auditTrail);
    if (!picked.worker) auditTrail.push({ criterion: 'probation-worker', result: 'none', dataConsulted: `taskType='${taskType}'`, reasoning: picked.reason });
    probationWorker = picked.worker;
  }

  const reasoning = probationWorker
    ? `Claude (${claudeTier}) stays the fallback for '${taskType}' (${description || 'unnamed'}); the gate is open for this non-critical task, so probation worker ${probationWorker.id} is offered to run it. Effort tier '${claudeTier}' assigned because: ${claudeReason}`
    : `Claude (${claudeTier}) is recommended for task '${taskType}' (${description || 'unnamed'}): external models (Gemini/Codex) were not fit or lacked clean track record. Effort tier '${claudeTier}' assigned because: ${claudeReason}`;

  return {
    recommendation: RECOMMENDATIONS.CLAUDE,
    claudeTier,
    alternateBackend,
    // agy-launcher-probation — the roster pick for an opened, non-critical taskType, or null. See PROBATION_ROSTER.
    probationWorker,
    auditTrail,
    reasoning,
    explorationHint: getExplorationHint(taskType, scorecards, context),
  };
}

/**
 * @typedef {Object} SupervisionAuditTrail
 * @property {string} criterion
 * @property {string} result
 * @property {string} dataConsulted
 * @property {string} reasoning
 */

/**
 * @typedef {Object} SupervisionRecommendation
 * @property {'full'|'spot-check'} level
 * @property {SupervisionAuditTrail[]} auditTrail
 * @property {string} reasoning
 */

/**
 * SELECT SUPERVISION LEVEL (`selectSupervisionLevel`).
 *
 * Implements the progressive backdown plan from backlog item #3690:
 *   - Unit of trust: exact `{provider, model, subjectClass, taskType}` tuple. `taskType` is whatever the
 *     caller's subject is (a work task type, a role kind, or a review lens); `subjectClass` keeps those
 *     subject classes from mixing evidence even when the subject strings coincide (#3801 Fork 3).
 *   - Counts TRAILING consecutive clean streak (most recent first; verified by
 *     'claude-subagent' or 'independent-claude'; 'other'-verified records are skipped).
 *   - Clean record: outcome === 'landed' (fail-closed; missing/rejected/reworked all count unclean).
 *   - Informative trial: at least one verified trial EVER recorded had outcome 'rejected' or
 *     'reworked' with confirmed findings (a 'landed' record's findings text alone never counts).
 *   - Hard veto: any unclean/unresolved record as the MOST RECENT verified trial immediately
 *     forces 'full' supervision, resetting the streak.
 *   - Post-miss bar (platform-decisions.md#delegation-trial-record-graduation, rule 5; #3889): once ANY
 *     verified record for the triple was ever unclean (a confirmed miss, anywhere in its recorded
 *     history — not only as the current most-recent trial), post-miss trials count toward restoration
 *     only once a `rootCause` note is on record in its own field for that triple (never inferred from a
 *     later row's `findings`); the clean-streak bar to clear then becomes `minCleanStreak + k`, strictly
 *     higher than the cold-start bar. A cold-start triple with no miss ever recorded is unaffected and
 *     still graduates at exactly `minCleanStreak`.
 *   - Returns 'spot-check' iff cleanStreak >= the applicable bar (cold-start `minCleanStreak`, or
 *     post-miss `minCleanStreak + k` once a rootCause is on record) AND (requireInformativeTrial === false
 *     OR hasInformativeTrial === true).
 *
 * PURE: No filesystem or process reads. Deterministic over its arguments.
 *
 * @param {string} provider
 * @param {string} model
 * @param {string} taskType - the caller's subject: a work task type, a role kind, or a review lens.
 * @param {Array<object>} scorecards
 * @param {{ minCleanStreak?: number, requireInformativeTrial?: boolean, k?: number }} [backdownThresholds={}]
 * @param {string} [subjectClass='work-agent'] - which subject class `taskType` belongs to; only records with
 *   the same `subjectClass` count toward this triple (#3801 Fork 3).
 * @returns {SupervisionRecommendation}
 */
// @test-only-export-ok: Shared library exported for interactive Claude sessions and conveyor runners
export function selectSupervisionLevel(provider, model, taskType, scorecards, backdownThresholds = {}, subjectClass = 'work-agent') {
  const minCleanStreak = typeof backdownThresholds?.minCleanStreak === 'number'
    ? backdownThresholds.minCleanStreak
    : DEFAULT_BACKDOWN_THRESHOLDS.minCleanStreak;
  const requireInformativeTrial = typeof backdownThresholds?.requireInformativeTrial === 'boolean'
    ? backdownThresholds.requireInformativeTrial
    : DEFAULT_BACKDOWN_THRESHOLDS.requireInformativeTrial;
  const k = typeof backdownThresholds?.k === 'number'
    ? backdownThresholds.k
    : DEFAULT_BACKDOWN_THRESHOLDS.k;

  const records = Array.isArray(scorecards)
    ? scorecards
    : (Array.isArray(scorecards?.records) ? scorecards.records : []);

  // Filter to exact {provider, model, subjectClass, taskType} tuple — subjectClass keeps a review-lens or
  // role-kind subject from ever counting toward a work triple's streak, or vice versa (#3801 Fork 3).
  const matching = records.filter((r) =>
    r && typeof r === 'object' &&
    r.provider === provider &&
    r.model === model &&
    r.taskType === taskType &&
    r.subjectClass === subjectClass
  );

  // Walk in scoredAt order, most recent first (deterministic ISO-8601 string sort)
  const sorted = [...matching].sort((a, b) => {
    const tA = typeof a.scoredAt === 'string' ? a.scoredAt : '';
    const tB = typeof b.scoredAt === 'string' ? b.scoredAt : '';
    return tB.localeCompare(tA);
  });

  const consulted = sorted.map((r) => ({
    handle: r.handle || (r.pr ? `PR #${r.pr}` : (r.item ? `#${r.item}` : (r.taskDescription || 'trial'))),
    scoredAt: r.scoredAt || 'unscored',
    outcome: r.outcome,
    verifiedBy: r.verifiedBy,
    findings: r.findings,
  }));

  // Find most recent verified trial ('claude-subagent' or 'independent-claude')
  const mostRecentVerified = sorted.find((r) =>
    r.verifiedBy === 'claude-subagent' || r.verifiedBy === 'independent-claude'
  );
  const mostRecentHasFinding = mostRecentVerified ? !isCleanRecord(mostRecentVerified) : false;

  // Compute trailing clean streak:
  // Walk records from newest to oldest. Skip 'other'-verified records.
  // Count consecutive clean records until the first finding or rejection.
  let cleanStreak = 0;
  for (const r of sorted) {
    if (r.verifiedBy !== 'claude-subagent' && r.verifiedBy !== 'independent-claude') {
      // 'other'-verified record: does not count toward or break the streak
      continue;
    }
    if (isCleanRecord(r)) {
      cleanStreak++;
    } else {
      // Confirmed finding or rejection caps the trailing streak
      break;
    }
  }

  // Check if at least one record EVER for this triple was informative (confirmed finding from independent review)
  const hasInformativeTrial = sorted.some(isInformativeRecord);

  // Post-miss bar (platform-decisions.md#delegation-trial-record-graduation, rule 5; #3889).
  // A confirmed miss is any verified record for this triple that was NOT clean, anywhere in its recorded
  // history — not only as the current most-recent trial (that narrower case is the hard veto above; this
  // is broader, since a triple can have re-accumulated a clean trailing streak since an earlier miss).
  // Fail-closed, matching the hard veto's own `!isCleanRecord` test: a missing/undefined outcome counts
  // as a miss here too.
  const hasConfirmedMiss = sorted.some((r) =>
    (r.verifiedBy === 'claude-subagent' || r.verifiedBy === 'independent-claude') && !isCleanRecord(r)
  );
  // A root-cause note in its own recorded field — never inferred from `findings` or any other row.
  const hasRootCause = sorted.some(hasRootCauseNote);
  // Once a miss is on record, the bar to clear is strictly higher than the cold-start bar.
  const requiredCleanStreak = hasConfirmedMiss ? minCleanStreak + k : minCleanStreak;

  // Decision logic
  let level;
  let summaryReason;

  if (mostRecentHasFinding) {
    level = SUPERVISION_LEVELS.FULL;
    summaryReason = `Calibration-miss hard veto: the most recent verified trial for {"${provider}", "${model}", "${taskType}"} (${mostRecentVerified.scoredAt}) had an unresolved finding. Streak counter reset to 0.`;
  } else if (hasConfirmedMiss && !hasRootCause) {
    level = SUPERVISION_LEVELS.FULL;
    summaryReason = `A confirmed miss is on record for {"${provider}", "${model}", "${taskType}"}, but no root-cause note has been recorded in its own field — no number of post-miss clean trials counts toward restoration until one is.`;
  } else if (cleanStreak < requiredCleanStreak) {
    level = SUPERVISION_LEVELS.FULL;
    summaryReason = hasConfirmedMiss
      ? `Trailing clean streak of ${cleanStreak} is below the post-miss threshold ${requiredCleanStreak} (minCleanStreak ${minCleanStreak} + k ${k}) for {"${provider}", "${model}", "${taskType}"}.`
      : `Trailing clean streak of ${cleanStreak} is below required threshold ${requiredCleanStreak} for {"${provider}", "${model}", "${taskType}"}.`;
  } else if (requireInformativeTrial && !hasInformativeTrial) {
    level = SUPERVISION_LEVELS.FULL;
    summaryReason = `Trailing clean streak of ${cleanStreak} reaches ${requiredCleanStreak}, but no informative trial with confirmed findings has ever been recorded for {"${provider}", "${model}", "${taskType}"}.`;
  } else {
    level = SUPERVISION_LEVELS.SPOT_CHECK;
    summaryReason = `Spot-check supervision approved: trailing clean streak of ${cleanStreak} meets threshold ${requiredCleanStreak}${hasConfirmedMiss ? ' (post-miss bar, root-cause note on record)' : ''}, informative trial requirement is satisfied, and the most recent trial was clean.`;
  }

  const recordsSummary = consulted.length > 0
    ? consulted.map((c) => `${c.handle}@${c.scoredAt}`).join(', ')
    : 'none';

  const auditTrail = [
    {
      criterion: 'most-recent-trial-veto',
      result: mostRecentHasFinding ? 'veto-fired' : 'clean',
      dataConsulted: mostRecentVerified ? `${mostRecentVerified.handle || mostRecentVerified.pr || mostRecentVerified.taskDescription || 'trial'} (${mostRecentVerified.scoredAt})` : 'none',
      reasoning: mostRecentHasFinding
        ? 'Most recent verified trial had a finding; hard veto resets streak to 0.'
        : 'Most recent verified trial has no unresolved findings.',
    },
    {
      // States which bar applied (cold-start vs post-miss) and why, per rule 5 (#3889).
      criterion: 'post-miss-bar-selection',
      result: hasConfirmedMiss ? 'post-miss' : 'cold-start',
      dataConsulted: `hasConfirmedMiss=${hasConfirmedMiss}, requiredCleanStreak=${requiredCleanStreak} (minCleanStreak=${minCleanStreak}${hasConfirmedMiss ? ` + k=${k}` : ''})`,
      reasoning: hasConfirmedMiss
        ? `A confirmed miss is on record for {"${provider}", "${model}", "${taskType}"}; the post-miss bar (minCleanStreak ${minCleanStreak} + k ${k} = ${requiredCleanStreak}) applies instead of the cold-start bar.`
        : `No confirmed miss is on record for {"${provider}", "${model}", "${taskType}"}; the cold-start bar (minCleanStreak = ${minCleanStreak}) applies.`,
    },
    {
      criterion: 'post-miss-root-cause-requirement',
      result: (!hasConfirmedMiss || hasRootCause) ? 'pass' : 'fail',
      dataConsulted: `hasConfirmedMiss=${hasConfirmedMiss}, hasRootCause=${hasRootCause}`,
      reasoning: !hasConfirmedMiss
        ? 'No confirmed miss is on record for this triple, so no root-cause note is required.'
        : (hasRootCause
          ? 'A root-cause note is on record in its own field for this triple.'
          : 'No root-cause note has been recorded in its own field for this triple — findings text alone never counts.'),
    },
    {
      criterion: 'trailing-clean-streak',
      result: cleanStreak >= requiredCleanStreak ? 'pass' : 'fail',
      dataConsulted: `streak=${cleanStreak}, threshold=${requiredCleanStreak}, consulted=[${recordsSummary}]`,
      reasoning: `Computed trailing consecutive clean streak is ${cleanStreak} (required: ${requiredCleanStreak}).`,
    },
    {
      criterion: 'informative-trial-requirement',
      result: (!requireInformativeTrial || hasInformativeTrial) ? 'pass' : 'fail',
      dataConsulted: `hasInformativeTrial=${hasInformativeTrial}, required=${requireInformativeTrial}`,
      reasoning: hasInformativeTrial
        ? 'At least one verified trial with confirmed findings exists in historical records.'
        : 'No verified trial with confirmed findings on record for this triple.',
    },
  ];

  return {
    level,
    auditTrail,
    reasoning: summaryReason,
    // Structured predicates alongside the audit trail's prose, so a caller (graduation-progress-report,
    // #xtw2rap) never re-derives them from parsing `auditTrail[].dataConsulted` text. Rule 1 of
    // #delegation-trial-record-graduation: every reader of this record uses the SAME predicates this
    // function already computed — never a second, parallel implementation.
    cleanStreak,
    // The actual bar `cleanStreak` was just checked against (cold-start `minCleanStreak`, or the higher
    // post-miss `minCleanStreak + k` once a confirmed miss is on record; #3889 rule 5) — a caller that needs
    // to know "how far from graduating" (e.g. graduation-progress-report's `owed` text) reads this field
    // instead of re-deriving hasConfirmedMiss/k itself (rule 1, same reasoning as above).
    requiredCleanStreak,
    hasInformativeTrial,
    mostRecentVetoed: mostRecentHasFinding,
  };
}

// ── REVIEW-SEAT ROUTING (#4194) — which non-Claude provider backs one ADDED review seat ─────────────────
//
// An added review seat (an ADVISORY lens, or the one extra juror seat) sits BESIDE Claude's mandatory seats and
// can only ADD findings — its failure or silence never blocks or accepts a PR (`review-extra-seats.mjs`). So,
// unlike `selectProvider`'s work cascade, a seat needs NO graduated track record before it may run: a miss is
// still covered by Claude's mandatory seats. What the record DOES decide is WHICH provider backs each seat:
//   1. a provider the caller reports unavailable (CLI missing, quota exhausted, daily cap) is never picked;
//   2. a provider whose MOST RECENT seat row for this lens failed (error / timeout / unparseable / quota) is
//      ranked after one whose last row was clean — the same "most recent trial must be clean" test
//      `evaluateProviderFitness` applies (criterion 2), fail-closed on an unknown status;
//   3. then the provider carrying less of THIS review's planned load (spread seats across providers);
//   4. then the provider with FEWER recorded rows for this lens (explore evenly, so both earn a record);
//   5. then a stable per-lens tie-break (never a clock, never random).
// The rows read are the `review-seat` rows `review-extra-seats.mjs` appends to the shared scorecard store, keyed
// by `taskType: reviewSeatTaskType(lens)` — a prefixed subject that can never collide with a work taskType, so a
// review seat's history never counts toward a work triple's graduation streak (#3801 Fork 3).

/** The non-Claude providers an added review seat can be routed to, in tie-break order. Card xn2wf9t (#3383
 *  follow-up) split the old single `gemini` (always the `agy` CLI's Gemini-backed model) into its two REAL,
 *  separately-metered allowances: `agy-claude` (the `agy` CLI running a Claude-family model) and `agy-gemini`
 *  (the same CLI running its native Gemini model) — the operator confirmed live both are separate, generous
 *  quotas, while `codex`'s own weekly allowance is comparatively tight. Splitting the identity (not just the
 *  cap) lets a seat fall back from one antigravity backend to the other without touching Codex at all. */
export { REVIEW_SEAT_PROVIDERS };

/** The `dispatchKind` every added-review-seat evidence row carries. */
export const REVIEW_SEAT_DISPATCH_KIND = 'review-seat';

/** The prefixed `taskType` subject of one lens's seat rows — never a work taskType. PURE. */
export function reviewSeatTaskType(lens) {
  return `review-lens:${String(lens ?? '').trim()}`;
}

function stableLensHash(text) {
  let h = 0;
  for (const ch of String(text)) h = (h * 31 + ch.codePointAt(0)) % 1_000_003;
  return h;
}

/**
 * SELECT THE PROVIDER FOR ONE ADDED REVIEW SEAT (#4194). PURE and deterministic over its arguments.
 * @param {object} o
 * @param {string} o.lens - the seat's lens (an advisory lens, or the extra juror's lens).
 * @param {string[]} [o.available] - providers the caller found usable right now (subset of REVIEW_SEAT_PROVIDERS).
 * @param {Array<object>|{records:Array<object>}} [o.scorecards] - the shared store's rows (caller-loaded).
 * @param {Record<string, number>} [o.plannedLoad] - seats already assigned per provider in THIS review.
 * @returns {{provider: (string|null), auditTrail: Array<{criterion:string,result:string,reasoning:string}>, reasoning: string}}
 */
export function selectReviewSeatProvider({ lens, available = REVIEW_SEAT_PROVIDERS, scorecards = [], plannedLoad = {} } = {}) {
  const records = Array.isArray(scorecards) ? scorecards : (Array.isArray(scorecards?.records) ? scorecards.records : []);
  const taskType = reviewSeatTaskType(lens);
  const auditTrail = [];
  const candidates = REVIEW_SEAT_PROVIDERS.filter((p) => Array.isArray(available) && available.includes(p));
  auditTrail.push({
    criterion: 'available',
    result: candidates.join(',') || 'none',
    reasoning: candidates.length ? `usable now: ${candidates.join(', ')}` : 'no non-Claude provider is usable right now',
  });
  if (!candidates.length) {
    return { provider: null, auditTrail, reasoning: `no provider for the "${lens}" seat: none available` };
  }
  const rowsFor = (p) => records
    .filter((r) => r && r.dispatchKind === REVIEW_SEAT_DISPATCH_KIND && r.provider === p && r.taskType === taskType)
    .sort((a, b) => String(b.scoredAt ?? '').localeCompare(String(a.scoredAt ?? '')));
  const base = stableLensHash(taskType);
  const ranked = candidates.map((p, i) => {
    const rows = rowsFor(p);
    return {
      provider: p,
      recentFailure: rows.length > 0 && rows[0].status !== 'ok' ? 1 : 0,
      load: Number(plannedLoad?.[p]) || 0,
      history: rows.length,
      tie: (base + i) % candidates.length,
    };
  }).sort((a, b) => a.recentFailure - b.recentFailure || a.load - b.load || a.history - b.history || a.tie - b.tie);
  for (const r of ranked) {
    auditTrail.push({
      criterion: `rank:${r.provider}`,
      result: `recentFailure=${r.recentFailure} load=${r.load} history=${r.history} tie=${r.tie}`,
      reasoning: r.recentFailure ? 'most recent seat row for this lens was not clean — ranked after a clean one' : 'last seat row clean (or none yet)',
    });
  }
  const pick = ranked[0].provider;
  return {
    provider: pick,
    auditTrail,
    reasoning: `"${lens}" seat → ${pick} (recent-failure, then planned load, then fewest recorded ${taskType} rows, then a stable tie-break)`,
  };
}
