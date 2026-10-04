/**
 * dispatch-contracts.mjs — pure mechanical-dispatch contracts (#3383, slice G1).
 *
 * Callers supply cards, plans, provenance, scorecards and timestamps. This module owns
 * validation and composition; provider fitness and supervision remain router policy.
 * Invalid boundary inputs fail closed, including malformed or cyclic objects.
 */
import { DEFAULT_ROUTING_POLICY, resolveOperationRoute, PROBATION_WORKERS,
  PROVEN_TASK_ENVELOPES, isStatuteTierPath, isHighStakesTask, isWithinProvenEnvelope,
  selectProvider, selectSupervisionLevel, RECOMMENDATIONS, CLAUDE_TIERS, SUPERVISION_LEVELS, AGY_CLAUDE_MODEL_BY_TIER,
  workerTierFor, selectProbationWorker, CRITICAL_WORK_GATE, decideCriticalWorkGate,
} from './provider-routing.mjs';
import { scrubPublish } from './secret-scrub.mjs';
import { thresholdsForRisk, neverSpotCheck, spotCheckSample } from './dispatch-thresholds.mjs';
import { CODEX_MODEL } from './codex-model-routing.mjs';
import { taskTypeFor } from './dispatch-task-type.mjs';
// #4034 — the critical-work verdict and the critical-miss veto list the provider cascade's CRITICAL_WORK_GATE reads.
// A safe import cycle: critical-work.mjs reads deriveRisk/deriveComplexity from here, never at module top level.
import { criticalWorkVerdict, criticalMissesFor } from './critical-work.mjs';

/** Closed task vocabulary, sourced from the router's proven envelopes. */
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export const TASK_TYPES = Object.freeze([...Object.keys(PROVEN_TASK_ENVELOPES), 'triage-research', 'architectural-decision']);
/** Risk order; array index is the rank. */
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export const RISKS = Object.freeze(['low', 'medium', 'high']);
/** Derived complexity order. */
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export const COMPLEXITIES = Object.freeze(['S', 'M', 'L']);
/** Terminal task execution statuses. */
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export const TASK_STATUSES = Object.freeze(['landed', 'blocked', 'failed']);
/** Supervisor judgments. */
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export const VERDICTS = Object.freeze(['accept', 'rework', 'reject']);
/** Recorded verifier provenance. */
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export const VERIFIED_BY = Object.freeze(['independent-claude', 'claude-subagent', 'other']);
/** Verifiers that can supply graduation evidence. */
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export const GRADUATION_VERIFIERS = Object.freeze(VERIFIED_BY.slice(0, 2));
/** Concrete execution providers; a dual routing recommendation is not provenance. */
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export const PROVIDERS = Object.freeze(['claude', 'gemini', 'antigravity', 'codex']);
/** Execution mechanisms that stamp task results. */
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export const EXECUTORS = Object.freeze(['codex-direct-task', 'gemini-direct-task', 'claude-subagent', 'claude-session']);
/** Allowed provider provenance per execution mechanism. */
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export const EXECUTOR_PROVIDERS = Object.freeze({
  'codex-direct-task': Object.freeze(['codex']),
  'gemini-direct-task': Object.freeze(['gemini', 'antigravity']),
  'claude-subagent': Object.freeze(['claude']), 'claude-session': Object.freeze(['claude']),
});
/** Mirrors we:scripts/operations/dispatch-lane.mjs#LAUNCH_KINDS without its impure imports. */
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export const STORY_KINDS = Object.freeze(['build', 'prepare', 'prepare-decision', 'investigate', 'fix', 'ci-heal']);
/** Dispatcher entry stages. */
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export const ROUTE_STAGES = Object.freeze(['story', 'task']);
/** Build story planner role. */
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export const SUPERVISOR_ROLE = 'build-supervisor';
/** Router Sonnet blast-radius ceiling in changed lines. */
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export const M_COMPLEXITY_MAX_LOC = 500;
/** Router Sonnet blast-radius ceiling in files. */
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export const M_COMPLEXITY_MAX_FILES = 8;
/**
 * Auditable size-to-LOC table:
 * 1 → 30: trivial one-file edit, under every envelope.
 * 2 → 80: doc-fix envelope and observed 80-LOC conflict-resolution trial.
 * 3 → 150: observed max bugfix trial (~150 LOC / 2 files); modal size.
 * 5 → 300: top of build-new-feature / other proven envelopes.
 * 8 → 500: Sonnet blast-radius ceiling; batchable cutoff (size <= 8).
 * 13 → 900: should-split band (size > 8), beyond envelopes and Sonnet ceiling.
 * Real `size` distribution across backlog/ on 2026-09-20 (3,662 cards,
 * 2,512 sized): 1:39, 2:416, 3:1124, 5:747, 8:172, 13:14; 1,148 cards carry no size. Envelope source: PROVEN_TASK_ENVELOPES
 * (doc-fix 100, self-fix 200, conflict-resolution 200, bugfix 250, build-new-feature 300, other 300 LOC). Auditable table, not a
 * formula: change a row, not an expression.
 */
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export const SIZE_TO_ESTIMATED_LOC = Object.freeze({ 1: 30, 2: 80, 3: 150, 5: 300, 8: 500, 13: 900 });
/**
 * Prepared-card kind defaults; explicit invalid values never default. No row yields `other` or `self-fix`: nothing
 * produces those two task types (#3801 Fork 2), so a kind with no row here has NO default and the card must declare
 * its own `taskType` — see {@link CARD_KINDS_WITHOUT_TASK_TYPE}.
 */
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export const TASK_TYPE_BY_CARD_KIND = Object.freeze({ story: 'build-new-feature', feature: 'build-new-feature', investigation: 'triage-research', decision: 'architectural-decision' });
/** Real card kinds that map to no task type: `deriveDispatchProfile` refuses them (`taskType:underivable`) unless the card declares a `taskType`. */
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export const CARD_KINDS_WITHOUT_TASK_TYPE = Object.freeze(['task', 'epic']);
/**
 * Role/story kinds with a rung on the model-tier table (#3857's own `workerTierFor`, `provider-routing.mjs`) —
 * every {@link STORY_KINDS} entry except `build` (which never reaches the rung lookup: `routeDispatch` returns
 * through `selectSupervisor` before it). `review` is deliberately absent: it has no rung yet (its subject key
 * and positive control are the sibling slice), so it stays `tier: null` rather than falling to the table's
 * `sonnet` default.
 *
 * REPLACES the old standalone `STORY_KIND_RUNGS` table (#3801 Fork 3, `docs/agent/backlog-workflow.md`
 * "Model routing"), which this folds into `workerTierFor` rather than keeping beside it (#3857) — a role/story
 * kind's tier is now the SAME table a code-change dispatch's tier is, not a second one that can drift from it.
 */
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export const RUNG_KINDS = Object.freeze(STORY_KINDS.filter((k) => k !== 'build'));

const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const nonempty = (x) => typeof x === 'string' && x.trim().length > 0;
const integer = (x, min = 1) => Number.isInteger(x) && x >= min;
const owns = (x, key) => Object.hasOwn(x, key);
const result = (errors) => ({ ok: errors.length === 0, errors });
const storyRefOK = (x) => nonempty(x) && /^[A-Za-z0-9._#]+$/.test(x);
const taskIdOK = (x) => nonempty(x) && /^[A-Za-z0-9._-]+$/.test(x);
function check(errors, condition, message) { if (!condition) errors.push(message); }
function guarded(fn) {
  try { return fn(); } catch { return result(['unreadable contract input']); }
}
function strings(x, predicate = nonempty, unique = false) {
  return Array.isArray(x) && Array.from(x).every(predicate) && (!unique || new Set(x).size === x.length);
}
function identity(x, errors) {
  check(errors, taskIdOK(x.taskId), 'taskId is invalid');
  check(errors, storyRefOK(x.storyRef), 'storyRef is invalid');
  check(errors, integer(x.round), 'round must be a positive integer');
  check(errors, integer(x.attempt), 'attempt must be a positive integer');
}

/** Whether a value belongs to the closed task vocabulary. */
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export function isTaskType(x) { return TASK_TYPES.includes(x); }
/** Require already-normalised, non-traversing repository paths. */
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export function isRepoRelativePath(p) {
  return nonempty(p) && !p.startsWith('/') && !p.startsWith('./') && !p.includes('\\') && !p.includes('\0') && !p.split('/').includes('..') && !/^[a-z][a-z0-9+.-]*:/i.test(p);
}
/** Compare path prefixes only at segment boundaries, ignoring trailing slashes. */
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export function pathsOverlap(a, b) {
  if (!nonempty(a) || !nonempty(b)) return false;
  a = a.replace(/\/+$/, ''); b = b.replace(/\/+$/, '');
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
/** Derive complexity from proven envelopes and the router's Sonnet ceiling. */
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export function deriveComplexity(taskType, estimatedLoc, filesCount) {
  return isWithinProvenEnvelope(taskType, estimatedLoc, filesCount) ? 'S'
    : estimatedLoc <= M_COMPLEXITY_MAX_LOC && filesCount <= M_COMPLEXITY_MAX_FILES ? 'M' : 'L';
}
/** Derive minimum risk from governance, correctness, complexity and acceptance. */
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export function deriveRisk(taskType, filesTouched, complexity, acceptanceTestable, { isStatutePath = isStatuteTierPath } = {}) {
  if (filesTouched.some(isStatutePath) || isHighStakesTask({ taskType }, { filesTouched })) return 'high';
  return complexity === 'L' || acceptanceTestable === false ? 'medium' : 'low';
}
/** A requested risk can raise but never lower the derived risk. */
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export function raiseRisk(derived, requested) { return RISKS.indexOf(requested) > RISKS.indexOf(derived) ? requested : derived; }

function profileInputs(p, errors) {
  check(errors, isTaskType(p.taskType), 'taskType is invalid');
  check(errors, integer(p.estimatedLoc), 'estimatedLoc must be a positive integer');
  check(errors, strings(p.filesTouched, isRepoRelativePath, true) && p.filesTouched.length > 0, 'filesTouched must contain unique repo-relative paths');
  check(errors, typeof p.acceptanceTestable === 'boolean', 'acceptanceTestable must be boolean');
  check(errors, strings(p.dependsOn, nonempty, true), 'dependsOn must contain unique non-empty strings');
}
/** Validate raw profile fields and derive complexity and minimum risk. */
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export function buildDispatchProfile(input, options = {}) {
  const checked = guarded(() => {
    if (!object(input)) return result(['profile input must be an object']);
    const errors = []; profileInputs(input, errors);
    if (owns(input, 'risk')) check(errors, RISKS.includes(input.risk), 'risk is invalid');
    if (errors.length) return result(errors);
    const { taskType, estimatedLoc, acceptanceTestable } = input;
    const filesTouched = [...input.filesTouched], dependsOn = [...input.dependsOn];
    const complexity = deriveComplexity(taskType, estimatedLoc, filesTouched.length);
    const risk = raiseRisk(deriveRisk(taskType, filesTouched, complexity, acceptanceTestable, options), input.risk);
    return { ok: true, errors: [], profile: { taskType, estimatedLoc, filesTouched, acceptanceTestable, risk, complexity, dependsOn } };
  });
  return checked.ok ? checked : { ...checked, profile: null };
}
/** Validate a profile, including derived complexity and the minimum risk floor. */
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export function validateDispatchProfile(profile, options = {}) {
  return guarded(() => {
    if (!object(profile)) return result(['profile must be an object']);
    const errors = []; profileInputs(profile, errors);
    check(errors, COMPLEXITIES.includes(profile.complexity), 'complexity is invalid');
    check(errors, RISKS.includes(profile.risk), 'risk is invalid');
    if (!errors.length) {
      const complexity = deriveComplexity(profile.taskType, profile.estimatedLoc, profile.filesTouched.length);
      check(errors, profile.complexity === complexity, `complexity must equal derived ${complexity}`);
      const risk = deriveRisk(profile.taskType, profile.filesTouched, complexity, profile.acceptanceTestable, options);
      check(errors, RISKS.indexOf(profile.risk) >= RISKS.indexOf(risk), `risk must be at least derived ${risk}`);
    }
    return result(errors);
  });
}
/** Validate a standalone task; dependency existence belongs to the enclosing plan. */
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export function validateTaskShape(task, options = {}) {
  return guarded(() => {
    if (!object(task)) return result(['task must be an object']);
    const errors = [];
    check(errors, taskIdOK(task.id), 'id is invalid');
    check(errors, TASK_LIFECYCLE.includes(task.status), 'status is invalid');
    checkAgent(task.agent, { ...options, taskId: task.id }, errors);
    check(errors, !owns(task, 'complexity') && !owns(task, 'risk'), 'complexity and risk belong in profile');
    check(errors, nonempty(task.title) && task.title.length <= 200, 'title must be non-empty and at most 200 characters');
    const depsOK = strings(task.dependsOn, taskIdOK, true);
    check(errors, depsOK, 'dependsOn must contain unique task ids');
    if (depsOK) check(errors, !task.dependsOn.includes(task.id), 'self dependency');
    const profile = validateDispatchProfile(task.profile, options);
    errors.push(...profile.errors.map((e) => `profile: ${e}`));
    if (depsOK && profile.ok) check(errors, task.dependsOn.length === task.profile.dependsOn.length && task.dependsOn.every((d) => task.profile.dependsOn.includes(d)), 'dependsOn and profile.dependsOn must equal as sets');
    return result(errors);
  });
}

// Iterative reachability avoids recursion limits, even for long supervisor plans.
function closures(tasks) {
  const edges = new Map(tasks.map((t) => [t.id, t.dependsOn]));
  const out = new Map();
  for (const task of tasks) {
    const seen = new Set(), pending = [...task.dependsOn];
    while (pending.length) {
      const id = pending.pop();
      if (seen.has(id)) continue;
      seen.add(id); pending.push(...(edges.get(id) || []));
    }
    out.set(task.id, seen);
  }
  return out;
}
/** Validate a plan and report cyclic components deterministically in plan order. */
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export function validatePlan(plan, options = {}) {
  return guarded(() => {
    if (!object(plan)) return result(['plan must be an object']);
    const errors = [];
    check(errors, storyRefOK(plan.storyRef), 'storyRef is invalid');
    checkSupervisor(plan.supervisor, errors);
    check(errors, integer(plan.round), 'round must be a positive integer');
    if (!Array.isArray(plan.tasks) || !plan.tasks.length) return result([...errors, 'tasks must be a non-empty array']);
    const ids = new Set(); let shapesOK = true;
    for (const [index, task] of plan.tasks.entries()) {
      const shape = validateTaskShape(task, { ...options, storyRef: plan.storyRef, round: plan.round });
      errors.push(...shape.errors.map((e) => `tasks[${index}]: ${e}`));
      shapesOK &&= shape.ok;
      if (object(task) && taskIdOK(task.id)) {
        if (ids.has(task.id)) errors.push(`duplicate task id: ${task.id}`);
        ids.add(task.id);
      }
    }
    for (const task of plan.tasks) if (object(task) && strings(task.dependsOn, taskIdOK)) {
      for (const dep of task.dependsOn) if (!ids.has(dep)) errors.push(`unknown dependency: ${dep}`);
    }
    if (shapesOK && ids.size === plan.tasks.length) {
      const reach = closures(plan.tasks), reported = new Set();
      for (const task of plan.tasks) if (reach.get(task.id).has(task.id) && !reported.has(task.id)) {
        const members = plan.tasks.filter((t) => reach.get(task.id).has(t.id) && reach.get(t.id).has(task.id)).map((t) => t.id);
        members.forEach((id) => reported.add(id));
        errors.push(`dependency cycle: ${[...members, members[0]].join(' -> ')}`);
      }
    }
    return result(errors);
  });
}
/** Enumerate disjoint task pairs without a dependency path in either direction. */
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export function computeParallelEligible(plan, options = {}) {
  return guarded(() => {
    const valid = validatePlan(plan, options); if (!valid.ok) return valid;
    const reach = closures(plan.tasks), pairs = [];
    for (let i = 0; i < plan.tasks.length; i++) for (let j = i + 1; j < plan.tasks.length; j++) {
      const a = plan.tasks[i], b = plan.tasks[j];
      if (!reach.get(a.id).has(b.id) && !reach.get(b.id).has(a.id)
        && !a.profile.filesTouched.some((p) => b.profile.filesTouched.some((q) => pathsOverlap(p, q)))) pairs.push([a.id, b.id]);
    }
    return { ok: true, pairs };
  });
}
/** Validate stamped execution provenance and evidence supporting the terminal status. */
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export function validateTaskResult(value) {
  return guarded(() => {
    if (!object(value)) return result(['result must be an object']);
    const errors = []; identity(value, errors);
    check(errors, isTaskType(value.taskType), 'taskType is invalid');
    check(errors, nonempty(value.authorRef), 'authorRef is required');
    check(errors, Object.values(SUPERVISION_LEVELS).includes(value.supervisionLevel), 'supervisionLevel is invalid');
    checkSupervisor(value.supervisor, errors);
    checkSession(value.sessionName, value, errors);
    check(errors, TASK_STATUSES.includes(value.status), 'status is invalid');
    check(errors, PROVIDERS.includes(value.provider), 'provider is invalid');
    check(errors, nonempty(value.model), 'model is required');
    check(errors, EXECUTORS.includes(value.executor), 'executor is invalid');
    if (EXECUTORS.includes(value.executor)) check(errors, EXECUTOR_PROVIDERS[value.executor].includes(value.provider), 'executor/provider mismatch');
    check(errors, strings(value.findings, (s) => nonempty(s) && s.length <= 2000), 'findings must contain non-empty strings of at most 2000 characters');
    if (!object(value.evidence)) return result([...errors, 'evidence must be an object']);
    const e = value.evidence;
    if (owns(e, 'sha')) check(errors, typeof e.sha === 'string' && /^[a-f0-9]{7,40}$/.test(e.sha), 'evidence.sha is invalid');
    if (owns(e, 'pr')) check(errors, integer(e.pr), 'evidence.pr must be a positive integer');
    if (owns(e, 'tests')) {
      check(errors, object(e.tests), 'evidence.tests must be an object');
      if (object(e.tests)) {
        check(errors, nonempty(e.tests.command), 'evidence.tests.command is required');
        check(errors, integer(e.tests.passed, 0), 'evidence.tests.passed must be a non-negative integer');
        check(errors, integer(e.tests.failed, 0), 'evidence.tests.failed must be a non-negative integer');
      }
    }
    if (value.status === 'landed') {
      check(errors, owns(e, 'sha') || owns(e, 'pr'), 'landed requires sha or pr');
      check(errors, object(e.tests), 'landed requires tests');
      if (object(e.tests)) check(errors, e.tests.failed === 0, 'landed requires zero failed tests');
    }
    return result(errors);
  });
}
/** Validate supervisor judgment, identity and permitted round-control actions. */
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export function validateSupervisorVerdict(value, options = {}) {
  return guarded(() => {
    if (!object(value)) return result(['verdict must be an object']);
    const errors = []; identity(value, errors);
    check(errors, VERDICTS.includes(value.verdict), 'verdict is invalid');
    check(errors, VERDICT_MODES.includes(value.mode), 'mode is invalid');
    checkSupervisor(value.supervisor, errors);
    check(errors, !owns(value, 'supervisorRef'), 'supervisorRef is not permitted');
    check(errors, isTaskType(value.storyTaskType), 'storyTaskType is invalid');
    if (value.mode === 'shadow') check(errors, !owns(value, 'newTasks') && !owns(value, 'complete'), 'shadow verdicts cannot act');
    check(errors, VERIFIED_BY.includes(value.verifiedBy), 'verifiedBy is invalid');
    check(errors, strings(value.findings), 'findings must contain non-empty strings');
    if (value.verdict === 'rework' || value.verdict === 'reject') check(errors, Array.isArray(value.findings) && value.findings.length > 0, 'rework/reject requires findings');
    if (owns(value, 'complete')) check(errors, typeof value.complete === 'boolean', 'complete must be boolean');
    if (value.complete === true) check(errors, value.verdict === 'accept', 'complete requires accept');
    if (owns(value, 'newTasks')) {
      check(errors, Array.isArray(value.newTasks), 'newTasks must be an array');
      check(errors, value.verdict === 'accept' || value.verdict === 'reject', 'newTasks requires accept or reject');
      check(errors, value.complete !== true, 'newTasks and complete are mutually exclusive');
      if (Array.isArray(value.newTasks)) for (const [i, task] of value.newTasks.entries()) errors.push(...validateTaskShape(task, { ...options, storyRef: value.storyRef, round: value.round }).errors.map((e) => `newTasks[${i}]: ${e}`));
    }
    if (value.verdict === 'rework') check(errors, !owns(value, 'complete'), 'rework carries neither complete nor newTasks');
    return result(errors);
  });
}
/** Match the exact task attempt the supervisor judged. */
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export function verdictMatchesResult(taskResult, verdict) {
  try {
    return object(taskResult) && object(verdict) && taskIdOK(taskResult.taskId) && storyRefOK(taskResult.storyRef)
      && integer(taskResult.round) && integer(taskResult.attempt)
      && ['taskId', 'storyRef', 'round', 'attempt'].every((k) => taskResult[k] === verdict[k]);
  } catch { return false; }
}
/** Report every failed graduation condition in fixed rule order. */
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export function gradeGraduation(taskResult, verdict, groundTruth) {
  try {
    const reasons = [...validateTaskResult(taskResult).errors.map(e => `result: ${e}`),
      ...validateSupervisorVerdict(verdict).errors.map(e => `verdict: ${e}`),
      ...validateGroundTruth(groundTruth).errors.map(e => `groundTruth: ${e}`)];
    if (!verdictMatchesResult(taskResult, verdict)) reasons.push('verdict does not match result identity');
    if (!groundTruthMatches(taskResult, groundTruth)) reasons.push('ground truth does not match result identity');
    if (verdict?.mode !== 'acting') reasons.push('graduation requires acting verdict');
    // One trial from the final accepted attempt. Outright failures without independent
    // review are a known gap; the router ignores non-independently-verified rows anyway.
    if (verdict?.verdict !== 'accept') reasons.push('graduation requires accept');
    if (taskResult?.status !== 'landed') reasons.push('graduation requires landed status');
    if (!verifiedByFromGroundTruth(groundTruth)) reasons.push('ground truth requires independent-pr-review graduation verifier');
    // The verdict's own verifiedBy is deliberately NOT consulted for graduation.
    const session = verdict?.supervisor?.sessionId;
    if (!nonempty(session) || !nonempty(taskResult?.authorRef) || session === taskResult?.authorRef
      || !Array.isArray(groundTruth?.sources) || groundTruth.sources.some(s => s?.actorRef === taskResult?.authorRef || s?.actorRef === session))
      reasons.push('author, supervisor and ground truth actors must be independent');
    return { ok: reasons.length === 0, reasons };
  } catch { return { ok: false, reasons: ['unreadable graduation input'] }; }
}
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export function isGraduationGrade(taskResult, verdict, groundTruth) { return gradeGraduation(taskResult, verdict, groundTruth).ok; }

/** Derive a dispatch-ready profile from a prepared backlog card, failing closed. */
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export function deriveDispatchProfile(card, options = {}) {
  try {
    if (!object(card)) return { ready: false, missing: ['preparedDate', 'scope', 'size'] };
    const missing = [];
    if (typeof card.preparedDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(card.preparedDate)) missing.push('preparedDate');
    const scope = typeof card.scope === 'string' ? [card.scope] : card.scope;
    const filesTouched = []; let scopeOK = Array.isArray(scope);
    if (scopeOK) for (const entry of scope) {
      if (typeof entry !== 'string') { scopeOK = false; continue; }
      let path = entry.trim().replace(/^we:/, '').replace(/^([A-Za-z0-9._-]+):/, '$1/').replace(/^\.\//, '');
      if (!path) continue;
      if (!isRepoRelativePath(path)) scopeOK = false;
      if (!filesTouched.includes(path)) filesTouched.push(path);
    }
    if (!scopeOK || !filesTouched.length) missing.push('scope');
    // `estimatedLoc` (#3839, Fork 4 field of #3801) is the task-only dispatch estimate — estimated changed
    // lines, distinct from `size` points. Only a `task` card may declare it; when it validly does, it
    // stands in for `size` (a task carries no `size:` — the no-double-count rule). Declaring it on any
    // other kind is refused, never silently accepted alongside a `size`.
    const hasEstimatedLoc = owns(card, 'estimatedLoc');
    const validTaskEstimate = card.kind === 'task' && hasEstimatedLoc && Number.isInteger(card.estimatedLoc) && card.estimatedLoc > 0;
    if (hasEstimatedLoc && card.kind !== 'task') missing.push('estimatedLoc:task-only');
    else if (hasEstimatedLoc && !validTaskEstimate) missing.push('estimatedLoc:invalid');
    const size = typeof card.size === 'string' && /^\d+$/.test(card.size) ? Number(card.size) : card.size;
    if (!validTaskEstimate && (typeof size !== 'number' || !owns(SIZE_TO_ESTIMATED_LOC, size))) missing.push('size');
    if (owns(card, 'taskType') && !isTaskType(card.taskType)) missing.push('taskType:invalid');
    if (owns(card, 'risk') && !RISKS.includes(card.risk)) missing.push('risk:invalid');
    if (owns(card, 'acceptanceTestable') && typeof card.acceptanceTestable !== 'boolean') missing.push('acceptanceTestable:invalid');
    if (owns(card, 'kind') && (typeof card.kind !== 'string' || !(owns(TASK_TYPE_BY_CARD_KIND, card.kind) || CARD_KINDS_WITHOUT_TASK_TYPE.includes(card.kind)))) missing.push('kind:invalid');
    // No default task type: a card with neither a declared `taskType` nor a kind that maps to one is refused, never labelled `other`.
    if (!missing.some((m) => m === 'taskType:invalid' || m === 'kind:invalid') && !(owns(card, 'taskType') ? card.taskType : owns(card, 'kind') && owns(TASK_TYPE_BY_CARD_KIND, card.kind))) missing.push('taskType:underivable');
    if (missing.length) return { ready: false, missing };
    const blocked = Array.isArray(card.blockedBy) ? card.blockedBy : [card.blockedBy];
    const dependsOn = [...new Set(blocked.filter((x) => typeof x === 'string' || typeof x === 'number').map((x) => String(x).trim()).filter(Boolean))];
    const estimatedLoc = validTaskEstimate ? card.estimatedLoc : SIZE_TO_ESTIMATED_LOC[size];
    const input = { taskType: card.taskType ?? TASK_TYPE_BY_CARD_KIND[card.kind], estimatedLoc, filesTouched, acceptanceTestable: card.acceptanceTestable ?? true, dependsOn };
    if (owns(card, 'risk')) input.risk = card.risk;
    const built = buildDispatchProfile(input, options);
    // `sized` is always true here: unlike `estimatedLocForSize`'s dispatch-time fallback (the largest band
    // for a card with no declared size), this function fails closed on `missing` above rather than assuming
    // one — a ready profile's estimate always came from the card itself, `estimatedLoc` or `size` alike.
    return built.ok ? { ready: true, profile: built.profile, sized: true } : { ready: false, missing: built.errors };
  } catch { return { ready: false, missing: ['unreadable card'] }; }
}

function audit(criterion, resultValue, dataConsulted, reasoning) { return { criterion, result: resultValue, dataConsulted, reasoning }; }
function refused(errors) {
  return { mode: null, shadow: null, backend: null, spotCheck: null, role: 'refused', provider: null, model: null, tier: null, supervision: SUPERVISION_LEVELS.FULL, alternateBackend: null,
    auditTrail: errors.map((e) => audit('invalid-dispatch', 'refused', 'dispatch input', e)) };
}
// A stable projection ignores input key order and irrelevant/cyclic metadata. Equal-date
// records get a canonical tie-break before the router's stable descending timestamp sort.
function routingRecords(scorecards) {
  const records = Array.isArray(scorecards) ? scorecards : Array.isArray(scorecards?.records) ? scorecards.records : [];
  // 'informative' (#3888, rule 4) and 'rootCause' (#3889, rule 5) must survive this projection too —
  // selectSupervisionLevel reads both directly off the row, never inferred from outcome/findings, and a
  // row missing them here can never graduate to spot-check through this call path no matter what the
  // scorecard actually records.
  const keys = ['role', 'subjectClass', 'provider', 'model', 'taskType', 'scoredAt', 'outcome', 'verifiedBy', 'findings', 'handle', 'pr', 'item', 'taskDescription', 'informative', 'rootCause'];
  return records.filter(object).map((r) => Object.fromEntries(keys.map((k) => [k, ['string', 'number', 'boolean'].includes(typeof r[k]) ? r[k] : null])))
    .sort((a, b) => compare(b.scoredAt || '', a.scoredAt || '') || compare(JSON.stringify(a), JSON.stringify(b)));
}
function compare(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
/** Route a validated profile through story policy or the existing provider cascade. */
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export function routeDispatch(profile, options = {}) {
  try {
    const errors = [...validateDispatchProfile(profile).errors];
    const { stage, kind, scorecards = [], taskKey, tags = [], criticalWorkGate, simple = false } = options;
    if (!ROUTE_STAGES.includes(stage)) errors.push('stage is invalid');
    if (stage === 'story' && !STORY_KINDS.includes(kind)) errors.push('kind is invalid');
    if (errors.length) return refused(errors);
    if (stage === 'story' && kind === 'build') return { ...selectSupervisor(profile, { scorecards }), spotCheck: null };
    // The router does not filter roles: work and supervisor evidence must never mix.
    const records = routingRecords(scorecards).filter(r => r.role !== 'supervise'), ownAudit = [], routerAudit = [];
    const high = profile.risk === 'high' || profile.filesTouched.some(isStatuteTierPath);
    const out = { mode: 'acting', shadow: null, backend: null, spotCheck: null, role: stage === 'story' ? kind === 'build' ? SUPERVISOR_ROLE : 'lane-agent' : 'task-agent', provider: null, model: null, tier: null, supervision: SUPERVISION_LEVELS.FULL, alternateBackend: null, probationWorker: null, auditTrail: [] };
    if (stage === 'story') {
      out.provider = RECOMMENDATIONS.CLAUDE;
      // #3857 — the same model-tier table a code-change dispatch uses, RUNG_KINDS-gated (every STORY_KINDS
      // entry reaching here except `build`, which already returned above) so `review` (no rung yet) never
      // reaches this call from elsewhere and a kind outside the table's rungs cannot silently fall to `sonnet`.
      const tableTier = workerTierFor({ kind, taskType: profile.taskType, scopePaths: profile.filesTouched, tags });
      out.tier = high ? CLAUDE_TIERS.OPUS : tableTier.tier;
      out.model = CLAUDE_NATIVE_MODEL_BY_TIER[out.tier];
      ownAudit.push(audit(kind === 'build' ? 'build-supervisor-tier' : 'story-kind-tier', out.tier, `kind=${kind}, risk=${profile.risk}, statute=${profile.filesTouched.some(isStatuteTierPath)}`, high ? 'Story rung is raise-only for high-risk or statute work.' : tableTier.reason));
    } else {
      const task = { taskType: profile.taskType };
      // Operator decision 2026-09-30: critical uses gate/approval scope and declared risk, not the broader
      // correctness-risk heuristic. Direct profile callers retain their explicit risk. Miss vetoes come from
      // the RAW scorecards, because `routingRecords` projects away the scope evidence a miss row may carry.
      const criticalWork = criticalWorkVerdict({ taskType: profile.taskType, filesTouched: profile.filesTouched, estimatedLoc: profile.estimatedLoc, acceptanceTestable: profile.acceptanceTestable, risk: options.criticalRisk ?? profile.risk, tags });
      const criticalMisses = criticalMissesFor(scorecards, profile.taskType);
      const context = { risk: profile.risk, filesTouched: [...profile.filesTouched], estimatedSize: profile.estimatedLoc, acceptanceTestable: profile.acceptanceTestable, scorecards: records, kind, tags, criticalWork, criticalMisses, simple: simple === true, ...(criticalWorkGate ? { criticalWorkGate } : {}) };
      const selected = selectProvider(task, context);
      routerAudit.push(...selected.auditTrail);
      out.provider = selected.recommendation;
      if (selected.recommendation === RECOMMENDATIONS.CLAUDE) {
        out.tier = selected.claudeTier; out.model = CLAUDE_NATIVE_MODEL_BY_TIER[out.tier]; out.alternateBackend = selected.alternateBackend ?? null;
        // agy-launcher-probation — the roster pick for an opened, non-critical taskType (Claude stays the fallback).
        out.probationWorker = selected.probationWorker ?? null;
      } else if (selected.recommendation === RECOMMENDATIONS.BOTH) {
        ownAudit.push(audit('both-supervision', SUPERVISION_LEVELS.FULL, 'dual-provider route', 'No single provider/model/taskType triple can graduate dual dispatch.'));
      } else {
        const group = selected.recommendation === RECOMMENDATIONS.GEMINI ? EXECUTOR_PROVIDERS['gemini-direct-task'] : EXECUTOR_PROVIDERS['codex-direct-task'];
        const candidates = records.filter((r) => r.taskType === profile.taskType && group.includes(r.provider) && nonempty(r.model));
        const model = [...new Set(candidates.map((r) => r.model))].find((m) => selectProvider(task, { ...context, model: m }).recommendation === selected.recommendation);
        if (!model) return refused(['no candidate model reproduces the provider recommendation']);
        out.model = model; out.provider = candidates.find((r) => r.model === model).provider;
        ownAudit.push(audit('task-model-recovery', model, `provider=${out.provider}, taskType=${profile.taskType}`, 'Model reproduces the router recommendation under its own fitness policy.'));
      }
    }
    if (!(stage === 'story' && kind === 'build') && out.provider !== RECOMMENDATIONS.BOTH) {
      const supervision = selectSupervisionLevel(out.provider, out.model, profile.taskType, records, thresholdsForRisk(profile.risk));
      out.supervision = supervision.level; routerAudit.push(...supervision.auditTrail);
    }
    if (neverSpotCheck(profile) && out.supervision === SUPERVISION_LEVELS.SPOT_CHECK) {
      out.supervision = SUPERVISION_LEVELS.FULL;
      ownAudit.push(audit('never-spot-check', out.supervision, 'risk and filesTouched', 'Statute, gate-self, irreversible and high-risk tasks require full supervision.'));
    }
    out.backend = out.provider === 'claude' ? 'claude-native' : out.provider === 'codex' ? 'codex' : ['gemini', 'antigravity'].includes(out.provider) ? 'agy' : null;
    if (out.supervision === 'spot-check' && taskSessionName(taskKey)) {
      out.spotCheck = spotCheckSample(taskKey, profile.risk);
      ownAudit.push(audit('spot-check-sample', out.spotCheck.sampled, JSON.stringify(taskKey), JSON.stringify(out.spotCheck)));
    }
    out.auditTrail = [...ownAudit, ...routerAudit]; return out;
  } catch { return refused(['unreadable dispatch input']); }
}

// Validate Gregorian dates and explicit ISO time zones without consulting a clock.
function validTimestamp(value) {
  if (typeof value !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!m) return false;
  const [, year, month, day, hour, minute, second, zone] = m;
  const y = Number(year), mo = Number(month), d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= days[mo - 1] && Number(hour) < 24 && Number(minute) < 60 && Number(second) < 60
    && (zone === 'Z' || (Number(zone.slice(1, 3)) <= 23 && Number(zone.slice(4)) < 60));
}
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export const CLAUDE_NATIVE_MODEL_BY_TIER = Object.freeze({ haiku: 'claude-haiku-4-5-20251001', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5' });
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export const TASK_LIFECYCLE = Object.freeze(['planned', 'dispatched', 'landed', 'blocked', 'failed', 'validated', 'reworked']);
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export const VERDICT_MODES = Object.freeze(['acting', 'shadow']);
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export const GROUND_TRUTH_KINDS = Object.freeze(['ci', 'independent-pr-review', 'rework-rounds', 'revert']);

function checkSupervisor(s, errors) {
  check(errors, object(s) && PROVIDERS.includes(s.provider) && nonempty(s.model)
    && (s.sessionId === null || nonempty(s.sessionId)), 'supervisor must have provider, model and sessionId (string or null)');
}
function checkSession(name, key, errors) {
  check(errors, name === null || (typeof name === 'string' && name === taskSessionName(key)), 'sessionName must match task identity or be null');
}
function checkAgent(agent, key, errors) {
  if (agent === null) return;
  if (!object(agent)) { errors.push('agent must be an object or null'); return; }
  check(errors, PROVIDERS.includes(agent.provider) || agent.provider === 'both', 'agent.provider is invalid');
  check(errors, nonempty(agent.model) || (agent.provider === 'both' && agent.model === null), 'agent.model is invalid');
  check(errors, agent.executor === null || EXECUTORS.includes(agent.executor), 'agent.executor is invalid');
  check(errors, Object.values(SUPERVISION_LEVELS).includes(agent.supervisionLevel), 'agent.supervisionLevel is invalid');
  if (key.storyRef !== undefined && key.round !== undefined) checkSession(agent.sessionName, key, errors);
  else check(errors, agent.sessionName === null || parseTaskSessionName(agent.sessionName)?.taskId === key.taskId, 'agent.sessionName is invalid');
}
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export function taskSessionName(key) {
  try { return object(key) && storyRefOK(key.storyRef) && Number.isSafeInteger(key.round) && key.round >= 1 && taskIdOK(key.taskId)
    ? `t-${key.storyRef}-r${key.round}-${key.taskId}` : null; } catch { return null; }
}
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export function parseTaskSessionName(name) {
  if (typeof name !== 'string') return null;
  const m = /^t-([A-Za-z0-9._#]+)-r(\d+)-([A-Za-z0-9._-]+)$/.exec(name);
  if (!m || m[2].startsWith('0')) return null;
  const key = { storyRef: m[1], round: Number(m[2]), taskId: m[3] };
  return taskSessionName(key) === name ? key : null;
}
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export function verdictEffects(verdict) {
  const inert = { acted: false, newTasks: [], complete: false };
  try { return validateSupervisorVerdict(verdict).ok && verdict.mode === 'acting'
    ? { acted: true, newTasks: verdict.newTasks ?? [], complete: verdict.complete === true } : inert; } catch { return inert; }
}
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export function validateGroundTruth(gt) {
  return guarded(() => {
    if (!object(gt)) return result(['ground truth must be an object']);
    const errors = [];
    check(errors, taskIdOK(gt.taskId), 'taskId is invalid');
    check(errors, storyRefOK(gt.storyRef), 'storyRef is invalid');
    check(errors, integer(gt.round), 'round must be a positive integer');
    check(errors, gt.recordedBy === 'orchestrator', 'recordedBy must be orchestrator');
    if (!Array.isArray(gt.sources) || !gt.sources.length) return result([...errors, 'sources must be non-empty']);
    for (const [i, source] of gt.sources.entries()) {
      const e = [];
      if (!object(source)) { errors.push(`sources[${i}] must be an object`); continue; }
      check(e, GROUND_TRUTH_KINDS.includes(source.kind), 'kind is invalid');
      check(e, ['clean', 'unclean'].includes(source.outcome), 'outcome is invalid');
      check(e, nonempty(source.actorRef), 'actorRef is required');
      if (source.kind === 'independent-pr-review' || owns(source, 'verifiedBy')) check(e, VERIFIED_BY.includes(source.verifiedBy), 'verifiedBy is invalid');
      if (source.kind === 'rework-rounds' || owns(source, 'reworkRounds')) check(e, integer(source.reworkRounds, 0), 'reworkRounds is invalid');
      if (source.kind === 'rework-rounds') check(e, (source.reworkRounds > 0) === (source.outcome === 'unclean'), 'rework outcome contradicts rounds');
      if (owns(source, 'findings')) check(e, strings(source.findings, s => nonempty(s) && s.length <= 2000), 'findings are invalid');
      errors.push(...e.map(message => `sources[${i}]: ${message}`));
    }
    return result(errors);
  });
}
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export function groundTruthOutcome(gt) {
  return !validateGroundTruth(gt).ok || gt.sources.some(s => s.outcome === 'unclean') ? 'unclean' : 'clean';
}
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export function groundTruthMatches(r, gt) {
  try { return object(r) && object(gt) && taskSessionName(r) !== null && ['taskId', 'storyRef', 'round'].every(k => r[k] === gt[k]); } catch { return false; }
}
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export function outcomeFromGroundTruth(gt) {
  if (!validateGroundTruth(gt).ok) return 'rejected';
  if (groundTruthOutcome(gt) === 'clean') return 'landed';
  return gt.sources.filter(s => s.outcome === 'unclean').every(s => s.kind === 'rework-rounds') ? 'reworked' : 'rejected';
}
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export function verifiedByFromGroundTruth(gt) {
  if (!validateGroundTruth(gt).ok) return null;
  return gt.sources.find(s => s.kind === 'independent-pr-review' && GRADUATION_VERIFIERS.includes(s.verifiedBy))?.verifiedBy ?? null;
}

// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export const SUPERVISOR_CANDIDATES = Object.freeze([
  { id: 'agy-sonnet-4-6', backend: 'agy', provider: 'antigravity', model: AGY_CLAUDE_MODEL_BY_TIER.sonnet, tier: 'sonnet' },
  { id: 'codex-astra', backend: 'codex', provider: 'codex', model: CODEX_MODEL, tier: null },
  { id: 'claude-sonnet-5-5', backend: 'claude-native', provider: 'claude', model: CLAUDE_NATIVE_MODEL_BY_TIER.sonnet, tier: 'sonnet' },
  { id: 'agy-opus-4-6', backend: 'agy', provider: 'antigravity', model: AGY_CLAUDE_MODEL_BY_TIER.opus, tier: 'opus' },
  { id: 'claude-opus-5', backend: 'claude-native', provider: 'claude', model: CLAUDE_NATIVE_MODEL_BY_TIER.opus, tier: 'opus' },
].map(Object.freeze));
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export const SUPERVISOR_LADDERS = Object.freeze(Object.fromEntries(Object.entries({
  'low/S': 0, 'low/M': 1, 'low/L': 2, 'medium/S': 1, 'medium/M': 2, 'medium/L': 3, 'high/S': 3, 'high/M': 3, 'high/L': 3,
}).map(([key, start]) => [key, Object.freeze(SUPERVISOR_CANDIDATES.slice(start).map(c => c.id))])));
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export function selectSupervisor(profile, options = {}) {
  try {
    const valid = validateDispatchProfile(profile); if (!valid.ok) return refused(valid.errors);
    // selectSupervisionLevel has no role filter (role sits outside its {provider, model, subjectClass,
    // taskType} trust key, #3801 Fork 3), so a 'supervise' role dispatch is still partitioned here; the
    // subjectClass:'driver' argument below is the callee's own enforcement of the subject-class boundary.
    const records = routingRecords(options.scorecards).filter(r => r.role === 'supervise');
    const hard = profile.filesTouched.some(isStatuteTierPath) || ['architectural-decision', 'triage-research'].includes(profile.taskType);
    const ids = hard ? ['claude-opus-5'] : SUPERVISOR_LADDERS[`${profile.risk}/${profile.complexity}`];
    const auditTrail = []; let chosen;
    for (const id of ids) {
      const candidate = SUPERVISOR_CANDIDATES.find(c => c.id === id);
      const assessment = selectSupervisionLevel(candidate.provider, candidate.model, profile.taskType, records, thresholdsForRisk(profile.risk), 'driver');
      const fallback = id === ids.at(-1);
      auditTrail.push(audit('supervisor-candidate', id, assessment.auditTrail, fallback ? 'fallback' : assessment.reasoning));
      if (fallback || assessment.level === 'spot-check') { chosen = candidate; break; }
    }
    const { provider, model, tier, backend } = chosen;
    const cheaper = !hard && ids[0] !== chosen.id ? SUPERVISOR_CANDIDATES.find(c => c.id === ids[0]) : null;
    const shadow = cheaper ? { provider: cheaper.provider, model: cheaper.model, tier: cheaper.tier, backend: cheaper.backend, mode: 'shadow' } : null;
    auditTrail.push(audit('supervisor-selected', chosen.id, ids, chosen.id === ids.at(-1) ? 'fallback' : 'first eligible rung'));
    return { role: SUPERVISOR_ROLE, provider, model, tier, backend, mode: 'acting', shadow, supervision: 'full', alternateBackend: null, auditTrail };
  } catch { return refused(['unreadable supervisor input']); }
}

/**
 * #3887 — RULE 7 of #3690 at `spot-check` (`#delegation-trial-record-graduation`): the independent-pass DEPTH
 * a computed supervision level owns. Full COVERAGE at every level, moving only in DEPTH — `full` keeps the
 * existing mandatory panel unchanged (already ratified and built by #3850; this contract changes nothing
 * about it), `spot-check` owns the `#every-pr-gets-a-look-advisory-floor` shape (#3313): one tool-free juror,
 * one round, capped findings, structurally non-blocking. FAILS LOUD on any other value — a route that
 * resolved to neither depth would resolve to NO independent seat, which is the exact failure rule 7 forbids.
 *
 * @param {string} supervision - one of {@link SUPERVISION_LEVELS}'s values.
 * @returns {{supervision:string, depth:'full-panel'|'floor', toolFree:boolean, rounds:number, blocking:boolean}}
 */
// @wired-by-3887: has a runtime caller — scripts/operations/review-dispatch.mjs#reviewSeatRoutes
export function independentReviewDepthFor(supervision) {
  if (supervision === SUPERVISION_LEVELS.FULL) {
    return Object.freeze({ supervision, depth: 'full-panel', toolFree: false, rounds: 1, blocking: true });
  }
  if (supervision === SUPERVISION_LEVELS.SPOT_CHECK) {
    return Object.freeze({ supervision, depth: 'floor', toolFree: true, rounds: 1, blocking: false });
  }
  throw new Error(
    `independentReviewDepthFor: unknown supervision level ${JSON.stringify(supervision)} — must be one of `
    + `${Object.values(SUPERVISION_LEVELS).join(', ')}. A route with neither depth would resolve to NO `
    + 'independent seat, which rule 7 (#delegation-trial-record-graduation) forbids.',
  );
}

// One idempotent row per task, from its final accepted attempt.
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export function trialIdempotencyKey(storyRef, round, taskId) { return `mech-trial:${storyRef}:r${round}:${taskId}`; }
function makeTrial(r, v, options, role, shadow = null) {
  try {
    const gt = options?.groundTruth, reasons = [];
    if (!validTimestamp(options?.now)) reasons.push('now must be a valid ISO-8601 timestamp');
    reasons.push(...gradeGraduation(r, v, gt).reasons);
    for (const field of ['provider', 'model', 'executor', 'authorRef']) if (!nonempty(r?.[field])) reasons.push(`missing provenance: ${field}`);
    const verifiedBy = verifiedByFromGroundTruth(gt);
    if (!verifiedBy) reasons.push('missing provenance: verifiedBy from ground truth');
    if (shadow) {
      reasons.push(...validateSupervisorVerdict(shadow).errors);
      if (shadow.mode !== 'shadow' || !verdictMatchesResult(r, shadow)) reasons.push('shadow identity or mode is invalid');
      if (shadow.supervisor?.provider === v?.supervisor?.provider && shadow.supervisor?.model === v?.supervisor?.model) reasons.push('shadow and acting supervisor must differ');
      // The shadow session must be an identifiable process independent of the author, the acting supervisor and every ground-truth actor.
      const shadowSession = shadow.supervisor?.sessionId;
      if (!nonempty(shadowSession) || shadowSession === r?.authorRef || shadowSession === v?.supervisor?.sessionId
        || (Array.isArray(gt?.sources) && gt.sources.some(s => s?.actorRef === shadowSession))) reasons.push('shadow session must be independent of author, acting supervisor and ground truth');
    }
    if (reasons.length) return { ok: false, reason: reasons.join('; ') };
    const subject = shadow ?? v;
    const { provider, model } = role === 'work' ? r : subject.supervisor;
    const findings = [...new Set([...gt.sources.flatMap(s => s.findings ?? []), ...v.findings, ...r.findings, ...(shadow?.findings ?? [])])].join('; ') || null;
    for (const [field, value] of [['provider', provider], ['model', model], ['findings', findings ?? ''], ['work model', r.model], ['acting model', v.supervisor.model]])
      if (scrubPublish(value).length) reasons.push(`${field} failed publish scrub`);
    if (reasons.length) return { ok: false, reason: reasons.join('; ') };
    const { storyRef, round, taskId } = r, handle = `${storyRef}/r${round}/${taskId}`;
    const idempotencyKey = role === 'work' ? trialIdempotencyKey(storyRef, round, taskId)
      : shadow ? `mech-sup-shadow-trial:${storyRef}:r${round}:${taskId}:${provider}:${model}` : `mech-sup-trial:${storyRef}:r${round}:${taskId}`;
    const correct = shadow && ((shadow.verdict === 'accept') === (groundTruthOutcome(gt) === 'clean'));
    const row = { v: 1, outcome: shadow ? correct ? 'landed' : 'rejected' : outcomeFromGroundTruth(gt), scoredAt: options.now,
      rubricVersion: role === 'work' ? 'mechanical-dispatch.1' : 'mechanical-supervise.1', provider, model,
      subjectClass: role === 'work' ? 'work-agent' : 'driver', role,
      dispatchKind: role === 'work' ? 'mechanical-task' : shadow ? 'mechanical-supervise-shadow' : 'mechanical-supervise',
      criteriaEvaluated: 0, score: null, deductions: [],
      item: /^\d+$/.test(storyRef) && Number.isSafeInteger(Number(storyRef)) && Number(storyRef) > 0 ? Number(storyRef) : null,
      pr: r.evidence.pr ?? null, handle, taskDescription: `mechanical task ${handle}`, taskType: role === 'work' ? r.taskType : subject.storyTaskType,
      verifiedBy, findings, retroactive: false, idempotencyKey };
    if (shadow) row.agreedWithActing = shadow.verdict === v.verdict;
    return { ok: true, row, idempotencyKey };
  } catch { return { ok: false, reason: 'unreadable trial input' }; }
}
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export function trialFromVerdict(r, v, options = {}) { return makeTrial(r, v, options, 'work'); }
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export function supervisorTrialFromVerdict(r, v, options = {}) { return makeTrial(r, v, options, 'supervise'); }
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export function shadowTrialFromVerdict(r, shadow, acting, options = {}) {
  if (!shadow) return { ok: false, reason: 'shadow verdict is required' };
  return makeTrial(r, acting, options, 'supervise', shadow);
}

// ── #3717 — THE DISPATCH PATH'S ONE ROUTING ENTRY POINT ───────────────────────────────────────────────────
//
// `routeDispatch` above (slice G1) already composes BOTH halves of the router
// (`provider-routing.mjs#selectProvider` and `#selectSupervisionLevel`) and returns the provider, the model,
// the supervision level and an audit trail. #3717's wiring therefore adds NO second router: it adds the one
// thing `routeDispatch` was missing to be callable from a real dispatch — the `taskType`, DERIVED from the
// dispatch itself (`./dispatch-task-type.mjs`) rather than read off a card, a brief or a model's guess.
//
// `decideDispatchRoute` is that composition and nothing more. It is PURE: the scorecards arrive as data, read
// at the io edge by `we:scripts/operations/dispatch-lane-io.mjs`.

/** The env var that turns supervision ENFORCEMENT on. Off by default — see {@link supervisionEnforcementFrom}. */
// @wired-by-3717: has a runtime caller — the G2 dispatcher wiring (see `decideDispatchRoute`)
export const SUPERVISION_ENFORCEMENT_ENV = 'WE_DISPATCH_SUPERVISION_ENFORCE';

/**
 * WHETHER SUPERVISION IS ENFORCED AS A GATE, or only RECORDED. **Off by default, deliberately.**
 *
 * The supervision level `selectSupervisionLevel` computes implements #3690's progressive-backdown graduation
 * model, and **#3690 is an OPEN, unratified decision** (worker `prepare-3690` is preparing it). Turning a
 * computed level into a dispatch gate would put that model into force ahead of the ruling, which #3717's own
 * card flags for the operator. So the level is computed and written into the run record on every dispatch —
 * the data the eventual ruling needs — and the gate stays behind this switch until #3690 is ratified.
 *
 * An unrecognised value THROWS rather than picking a side, for the same reason
 * `dispatch-provider-registry.mjs#dispatchModeFor` does: a typo'd `WE_DISPATCH_SUPERVISION_ENFORCE=ture`
 * silently disabling a gate is the failure this shape exists to remove.
 *
 * @param {Record<string, string|undefined>} [env] - data; this module never reads the ambient environment.
 * @returns {boolean}
 */
// @wired-by-3717: has a runtime caller — the G2 dispatcher wiring (see `decideDispatchRoute`)
export function supervisionEnforcementFrom(env = {}) {
  const raw = String(env?.[SUPERVISION_ENFORCEMENT_ENV] ?? '').trim().toLowerCase();
  if (!raw) return false;
  if (['1', 'true', 'on'].includes(raw)) return true;
  if (['0', 'false', 'off'].includes(raw)) return false;
  throw new TypeError(
    `dispatch-contracts: ${SUPERVISION_ENFORCEMENT_ENV} must be 1/true/on or 0/false/off (the default — `
    + `#3690 is not ratified, so supervision is RECORDED, not enforced), got ${JSON.stringify(raw)}`,
  );
}

/**
 * THE SUPERVISION GATE, once #3690 ratifies. `null` means "nothing holds this dispatch".
 *
 * With `enforce` off (the default) it ALWAYS returns `null`: byte-identical dispatch behaviour, the level
 * recorded either way. With it on, a dispatch whose computed level is `full` and which names no supervisor is
 * held — a `full`-supervision route with nobody supervising it is the exact case the level exists to name.
 *
 * @param {{supervision?: string, supervisor?: unknown}} routing
 * @param {{enforce?: boolean}} [o]
 * @returns {string|null} the hold reason, or `null`.
 */
// @wired-by-3717: has a runtime caller — the G2 dispatcher wiring (see `decideDispatchRoute`)
export function supervisionHold(routing, { enforce = false } = {}) {
  if (!enforce) return null;
  if (routing?.supervision !== SUPERVISION_LEVELS.FULL) return null;
  if (routing?.supervisor) return null;
  return `computed supervision level is \`${SUPERVISION_LEVELS.FULL}\` and this dispatch names no supervisor — `
    + `held because ${SUPERVISION_ENFORCEMENT_ENV} is on. Unset it to record the level without gating on it `
    + '(#3690 is not ratified).';
}

/**
 * #3801 Fork 4 (b) — the `unsizedCardPolicy` vocabulary: `block` (default) leaves an unsized card for the
 * admission gate to hold (a sibling slice; not built here); `default-size` reads {@link DEFAULT_SIZE_POLICY}'s
 * `defaultSize` instead.
 */
// @wired-by-3717: has a runtime caller — the G2 dispatcher wiring (see `decideDispatchRoute`)
export const UNSIZED_CARD_POLICIES = Object.freeze(['block', 'default-size']);

/**
 * #3801 Fork 4 (b) — the `fixSizeSource` chain vocabulary for `fix`/`ci-heal` dispatches, executed by
 * {@link resolveFixSize} (#3844, Fork 4 "fix path" of #3801). `policy` defers to `unsizedCardPolicy` and is
 * valid only when that policy is `default-size`: under `block` it would silently stop a conflict fix.
 */
// @wired-by-3717: has a runtime caller — the G2 dispatcher wiring (see `decideDispatchRoute`)
export const FIX_SIZE_SOURCES = Object.freeze(['card-size', 'measured-diff', 'assumed', 'policy']);

/**
 * #3784's constraint, carried here per #3801 Fork 4 (b): a `defaultSize` below this makes unsized cards
 * eligible for delegation on an unmeasured number, and must not be enabled before #3784's rule-3 and rule-6
 * fixes land. #3784 removes this floor.
 */
// @wired-by-3717: has a runtime caller — the G2 dispatcher wiring (see `decideDispatchRoute`)
export const MIN_DEFAULT_SIZE = 13;

/**
 * #3801 Fork 4 (b) — the ruled setting, checked in at `we:scripts/lib/dispatch-size-policy.json` and the
 * default {@link decideDispatchRoute} uses when no `sizePolicy` is supplied: `block`, `defaultSize: 13` (read
 * only under `default-size`), `fixSizeSource` the ordered chain `card-size`, then `measured-diff`, then
 * `assumed`. This default keeps an unsized card's route byte-identical to before #3843: `block` does not gate
 * admission (that is the sibling slice), so {@link decideDispatchRoute} still falls back to the largest band.
 */
// @wired-by-3717: has a runtime caller — the G2 dispatcher wiring (see `decideDispatchRoute`)
export const DEFAULT_SIZE_POLICY = Object.freeze({
  unsizedCardPolicy: 'block', defaultSize: 13, fixSizeSource: Object.freeze(['card-size', 'measured-diff', 'assumed']),
});

/**
 * VALIDATE THE CHECKED-IN SIZE-POLICY SETTING (#3801 Fork 4 (b)). Pure: takes whatever
 * `we:scripts/lib/dispatch-size-policy.json` parsed to (or any candidate override), returns a normalized,
 * frozen policy or the reasons it fails closed. A missing field reads as {@link DEFAULT_SIZE_POLICY}'s own
 * value for it, so a partial override still validates. Refuses a `defaultSize` below {@link MIN_DEFAULT_SIZE},
 * naming #3784; refuses `policy` in `fixSizeSource` unless `unsizedCardPolicy` is `default-size`.
 *
 * @param {unknown} raw
 * @returns {{ok: true, policy: {unsizedCardPolicy: string, defaultSize: number, fixSizeSource: string[]}} | {ok: false, errors: string[]}}
 */
// @wired-by-3717: has a runtime caller — the G2 dispatcher wiring (see `decideDispatchRoute`)
export function validateSizePolicy(raw) {
  const errors = [];
  const p = object(raw) ? raw : {};

  const unsizedCardPolicy = owns(p, 'unsizedCardPolicy') ? p.unsizedCardPolicy : DEFAULT_SIZE_POLICY.unsizedCardPolicy;
  if (!UNSIZED_CARD_POLICIES.includes(unsizedCardPolicy)) {
    errors.push(`unsizedCardPolicy must be one of ${UNSIZED_CARD_POLICIES.join(', ')}, got ${JSON.stringify(unsizedCardPolicy)}`);
  }

  const defaultSize = owns(p, 'defaultSize') ? p.defaultSize : DEFAULT_SIZE_POLICY.defaultSize;
  if (typeof defaultSize !== 'number' || !owns(SIZE_TO_ESTIMATED_LOC, defaultSize)) {
    errors.push(`defaultSize must be one of ${Object.keys(SIZE_TO_ESTIMATED_LOC).join(', ')}, got ${JSON.stringify(defaultSize)}`);
  } else if (defaultSize < MIN_DEFAULT_SIZE) {
    errors.push(
      `defaultSize ${defaultSize} is below ${MIN_DEFAULT_SIZE} — #3784's rule-3 and rule-6 fixes must land `
      + 'before an unsized card can be admitted on an unmeasured number this small',
    );
  }

  const fixSizeSourceRaw = owns(p, 'fixSizeSource') ? p.fixSizeSource : DEFAULT_SIZE_POLICY.fixSizeSource;
  if (!Array.isArray(fixSizeSourceRaw) || fixSizeSourceRaw.length === 0) {
    errors.push(`fixSizeSource must be a non-empty array, got ${JSON.stringify(fixSizeSourceRaw)}`);
  } else {
    const seen = new Set();
    for (const source of fixSizeSourceRaw) {
      if (!FIX_SIZE_SOURCES.includes(source)) errors.push(`fixSizeSource entry ${JSON.stringify(source)} is not one of ${FIX_SIZE_SOURCES.join(', ')}`);
      if (seen.has(source)) errors.push(`fixSizeSource repeats ${JSON.stringify(source)}`);
      seen.add(source);
    }
    if (fixSizeSourceRaw.includes('policy') && unsizedCardPolicy !== 'default-size') {
      errors.push('fixSizeSource cannot include `policy` unless unsizedCardPolicy is `default-size` — under `block` it would silently stop a conflict fix');
    }
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    policy: Object.freeze({ unsizedCardPolicy, defaultSize, fixSizeSource: Object.freeze([...fixSizeSourceRaw]) }),
  };
}

/**
 * #3784 — RULE 6 of #3690 (`#delegation-trial-record-graduation`): THE PROMOTION RECORD. A ratified decision
 * card is the ACT; this checked-in file (`we:scripts/lib/dispatch-supervision-promotions.json`) is its
 * machine-readable transcript. Ships empty — no triple is promoted.
 *
 * #3906 carries the record and the clamp below ONLY. Supervision ENFORCEMENT stays off by default here
 * ({@link supervisionEnforcementFrom}); turning it on is #4180. So on main the clamp changes the RECORDED level
 * of a route, never whether it dispatches.
 */
// @wired-by-3717: has a runtime caller — the G2 dispatcher wiring (see `decideDispatchRoute`)
export const DEFAULT_PROMOTIONS = Object.freeze({ promotions: Object.freeze([]) });

/**
 * VALIDATE A CANDIDATE PROMOTION RECORD (#3784, rule 6 of #3690). Pure: takes whatever
 * `we:scripts/lib/dispatch-supervision-promotions.json` parsed to (or any candidate override). Each row is
 * `{provider, model, taskType, level, ratifiedOn, ratifiedBy, anchor}` — the citation to the ratified act that
 * authorized it (`ratifiedBy: "#NNNN"`, `anchor: "we:docs/agent/platform-decisions.md#…"`). A row missing
 * `ratifiedBy` or `anchor` (or carrying any other invalid field) is refused BY NAME.
 *
 * **Unlike {@link validateSizePolicy}, an invalid candidate here is never handed to a caller as "every field
 * defaults" — see {@link decideDispatchRoute}'s own use of this function, which fails CLOSED on any error: a
 * missing, unparseable or invalid promotions file promotes NOTHING; it does not refuse the dispatch (that
 * would hold every route, not just an unproven one), it simply grants no promotion, so every computed
 * `spot-check` stays gated to `full`. That is rule 6's own stated default: "With no such act, a triple stays
 * at `full`."
 *
 * The citation itself (does `anchor` resolve to a real heading? is the `ratifiedBy` card `status: resolved`?)
 * is NOT checked here — that is script-decidable against the live repo, so it belongs to `check:standards`
 * (the prototype's `findInvalidPromotionCitations`, graduating with #4180), not this pure, io-free function.
 *
 * @param {unknown} raw
 * @returns {{ok: true, promotions: Array<{provider:string, model:string, taskType:string, level:string, ratifiedOn:string, ratifiedBy:string, anchor:string}>} | {ok: false, errors: string[]}}
 */
// @wired-by-3717: has a runtime caller — the G2 dispatcher wiring (see `decideDispatchRoute`)
export function validatePromotions(raw) {
  const errors = [];
  const p = object(raw) ? raw : Array.isArray(raw) ? { promotions: raw } : {};
  // #3906 — main's shared registry shape (`{version, entries: [...]}`, read by
  // `we:scripts/operations/graduation-progress-report-io.mjs` from this SAME file) is accepted beside the
  // prototype's `{promotions: [...]}`, so the one checked-in file has one shape both readers agree on. A row
  // in that shape may omit `level`: a promotion is always TO `spot-check` (the only level above `full`).
  const fromEntries = !owns(p, 'promotions') && owns(p, 'entries');
  const list = fromEntries ? p.entries : owns(p, 'promotions') ? p.promotions : undefined;
  if (!Array.isArray(list)) {
    return { ok: false, errors: [`promotions must be an array, got ${JSON.stringify(list ?? raw)}`] };
  }
  const rows = [];
  list.forEach((rawRow, i) => {
    const e = [];
    if (!object(rawRow)) { errors.push(`promotions[${i}] must be an object`); return; }
    const row = fromEntries && !owns(rawRow, 'level') ? { ...rawRow, level: SUPERVISION_LEVELS.SPOT_CHECK } : rawRow;
    check(e, PROVIDERS.includes(row.provider), 'provider is invalid');
    check(e, nonempty(row.model), 'model is required');
    check(e, isTaskType(row.taskType), 'taskType is invalid');
    check(e, Object.values(SUPERVISION_LEVELS).includes(row.level), 'level is invalid');
    check(e, nonempty(row.ratifiedOn) && /^\d{4}-\d{2}-\d{2}$/.test(row.ratifiedOn), 'ratifiedOn must be an ISO date (YYYY-MM-DD)');
    check(e, nonempty(row.ratifiedBy) && /^#\d+$/.test(row.ratifiedBy), 'ratifiedBy is required and must be `#NNN`');
    check(e, nonempty(row.anchor) && row.anchor.startsWith('we:docs/agent/platform-decisions.md#'), 'anchor is required and must cite we:docs/agent/platform-decisions.md#…');
    if (e.length) { errors.push(...e.map((m) => `promotions[${i}]: ${m}`)); return; }
    rows.push(Object.freeze({
      provider: row.provider, model: row.model, taskType: row.taskType, level: row.level,
      ratifiedOn: row.ratifiedOn, ratifiedBy: row.ratifiedBy, anchor: row.anchor,
    }));
  });
  if (errors.length) return { ok: false, errors };
  return { ok: true, promotions: Object.freeze(rows) };
}

/**
 * THE `size:` → estimated-LOC read, with the ONE safe answer for a card that declares no size.
 *
 * 1,148 of the backlog's cards carry no `size:` (see {@link SIZE_TO_ESTIMATED_LOC}'s own table), so refusing
 * an unsized dispatch would stop a third of the conveyor. Understating the size would be the dangerous
 * direction — it is what puts a task INSIDE a proven envelope and hands it to a non-Claude provider. So an
 * unknown size reads as the LARGEST band (`13` → 900 LOC), which sits outside every entry of
 * `provider-routing.mjs#PROVEN_TASK_ENVELOPES` and therefore forces the Claude/both side of the cascade.
 * Overstating is recorded, not hidden: the returned `sized` flag says whether the number came from the card.
 *
 * @param {unknown} size
 * @returns {{estimatedLoc: number, sized: boolean}}
 */
// @wired-by-3717: has a runtime caller — the G2 dispatcher wiring (see `decideDispatchRoute`)
export function estimatedLocForSize(size) {
  const n = typeof size === 'string' && /^\d+$/.test(size) ? Number(size) : size;
  if (typeof n === 'number' && owns(SIZE_TO_ESTIMATED_LOC, n)) return { estimatedLoc: SIZE_TO_ESTIMATED_LOC[n], sized: true };
  const bands = Object.keys(SIZE_TO_ESTIMATED_LOC).map(Number);
  return { estimatedLoc: SIZE_TO_ESTIMATED_LOC[Math.max(...bands)], sized: false };
}

/**
 * #3844 (Fork 4 "fix path" of #3801) — THE REPAIR KINDS: the only two whose size, absent a card size, walks
 * {@link FIX_SIZE_SOURCES} instead of falling straight to the generic `unsizedCardPolicy` fallback every other
 * kind (`build` included) uses. The card's own reasoning: `we:scripts/conveyor/reconcile-fix-dispatch.mjs`
 * passes no size for a bounced PR's repair, so `block` alone — the checked-in default — would silently stop
 * every conflict-caused fix. The chain gives it two real numbers to try FIRST.
 */
// @wired-by-3717: has a runtime caller — the G2 dispatcher wiring (see `decideDispatchRoute`)
export const REPAIR_KINDS = Object.freeze(['fix', 'ci-heal']);

/**
 * #3844 — WALK {@link FIX_SIZE_SOURCES} for one `fix`/`ci-heal` dispatch, in the order `sizePolicy.fixSizeSource`
 * names. Pure: `measuredDiffLoc` (the changed-line count of the PR being repaired) arrives as data, read at the
 * io edge exactly like `scorecards`/`sizePolicy` themselves — this function never touches `gh`/`git`. Stops at
 * the first step that resolves a number; `assumed` always does, so the chain never falls through unanswered.
 *
 * @param {{size?: unknown, estimatedLoc?: number, measuredDiffLoc?: number}} dispatch
 * @param {{unsizedCardPolicy: string, defaultSize: number, fixSizeSource: string[]}} sizePolicy - already
 *   validated by {@link validateSizePolicy}.
 * @returns {{estimatedLoc: number, sized: boolean, sizeSource: string}}
 */
function resolveFixSize(dispatch, sizePolicy) {
  for (const step of sizePolicy.fixSizeSource) {
    if (step === 'card-size') {
      if (dispatch?.estimatedLoc != null) return { estimatedLoc: dispatch.estimatedLoc, sized: true, sizeSource: 'card-size' };
      const bySize = estimatedLocForSize(dispatch?.size);
      if (bySize.sized) return { estimatedLoc: bySize.estimatedLoc, sized: true, sizeSource: 'card-size' };
    } else if (step === 'measured-diff') {
      const measured = dispatch?.measuredDiffLoc;
      if (typeof measured === 'number' && Number.isFinite(measured) && measured > 0) {
        return { estimatedLoc: measured, sized: true, sizeSource: 'measured-diff' };
      }
    } else if (step === 'assumed') {
      return { estimatedLoc: SIZE_TO_ESTIMATED_LOC[sizePolicy.defaultSize], sized: false, sizeSource: 'assumed' };
    } else if (step === 'policy') {
      // `validateSizePolicy` only allows `policy` here when `unsizedCardPolicy` is `default-size` — under
      // `block` it would silently stop a conflict fix, exactly the failure #3844 exists to prevent.
      return { estimatedLoc: SIZE_TO_ESTIMATED_LOC[sizePolicy.defaultSize], sized: false, sizeSource: `defaultSize=${sizePolicy.defaultSize}` };
    }
  }
  // Unreachable while `fixSizeSource` validates non-empty and every member above is handled; kept fail-closed
  // rather than returning `undefined` if a future vocabulary entry is added without a handler here.
  return { estimatedLoc: SIZE_TO_ESTIMATED_LOC[MIN_DEFAULT_SIZE], sized: false, sizeSource: 'assumed' };
}

/**
 * THE MARKER'S VOCABULARY (#3840, Fork 5 of #3801): the registered delivery vendors an item's `deliveryAgent:`
 * marker may name, each with the routing provider (a member of {@link PROVIDERS}) whose trial history its runs
 * accrue to. Antigravity is absent until #3658 gives it a descriptor. It is a copy of
 * `deliver-item-wrapper.mjs#DELIVERY_AGENT_PROVIDER_NAMES` because this pure library may not import the wrapper
 * (its graph reaches the filesystem and the spawn code); `dispatch-lane-routing-record.test.mjs` pins the two
 * key lists equal so they cannot drift.
 */
// @wired-by-3717: has a runtime caller — the G2 dispatcher wiring (see `decideDispatchRoute`)
export const DELIVERY_VENDOR_PROVIDERS = Object.freeze({ 'claude-restricted': 'claude', codex: 'codex' });

/** The launch kinds whose dispatch honours the marker (`build`, `fix`, `ci-heal` — the three provider modules that
 *  read it). A marker on an item the tick launches as a `prepare`/`investigate` is not read: it is not an override
 *  of anything there, so it is neither recorded nor refused. */
const MARKER_KINDS = Object.freeze(['build', 'fix', 'ci-heal']);

/**
 * WHICH VENDOR ACTUALLY EXECUTES A DISPATCH, given what the criteria `routed` and what #3840's `deliveryAgent:`
 * override (if any) says.
 *
 * `we:scripts/operations/dispatch-lane-io.mjs`'s `provider` port (#3579) has exactly one implementation that
 * starts a worker with no override — `defaultClaudeProvider`, Claude — and every mechanical per-kind provider
 * in `dispatch-provider-registry.mjs` wraps that same spawn UNLESS the item's own `deliveryAgent:` marker
 * names a different registered vendor (#3840), in which case `we:scripts/operations/dispatch-providers/
 * build.mjs` (and its `fix`/`ci-heal` siblings) pass `--provider=<vendor>` and the delivery wrapper actually
 * spawns it. So `executed` is the override's `executedVendor` when there is one, else plain `claude` — never
 * the ROUTED vendor, which is the criteria's recommendation, not a fact about what ran. A routed non-Claude
 * pick with no override still lands as `routed: <p>, executed: claude` rather than quietly becoming a Claude
 * decision — the delegation gap stays MEASURABLE instead of invisible (#3717 step 6, #3848).
 *
 * @param {{value: {executedVendor: string}|null}} override — {@link normalizeOverride}'s return.
 * @returns {string}
 */
function executedVendorFor(override) {
  return override.value ? override.value.executedVendor : 'claude';
}

/**
 * DECIDE A DISPATCH'S ROUTE — the one call a dispatch path makes before a spawn.
 *
 * Composes, in order: the `taskType` derivation → the profile → `routeDispatch` (which is itself
 * `selectProvider` + `selectSupervisionLevel`). Returns a RECORD, never a side effect, and never consults a
 * brief, a prompt or a model.
 *
 * FAILS CLOSED three ways, each with a named reason on `refusal`:
 *   - the dispatch has no derivable `taskType` (#3717's own rule: never guessed, never defaulted to `bugfix`);
 *   - the profile does not validate (an un-normalised scope path, a non-boolean `acceptanceTestable`, …);
 *   - `routeDispatch` itself refuses (`role: 'refused'`), e.g. no candidate model reproduces its own
 *     recommendation.
 *
 * THE ROLE PATH takes none of that: a `prepare`/`prepare-decision`/`investigate`/`review` dispatch has no
 * router `taskType` by nature, so the provider cascade is NEVER consulted for it and the record says `role`
 * with `routed: null`. That is the honest answer, and it is still mechanical — the kind decided it.
 * INTERIM (#3801 Fork 3): `prepare`, `prepare-decision` and `investigate` still keep their Claude spawn and
 * `routed: null`, but `tier` now names the model-tier table's ({@link ./provider-routing.mjs#workerTierFor},
 * #3857) rung for the role instead of staying `null` — the authoring role's own trust record, not a routing
 * decision. `review` has no {@link RUNG_KINDS} rung yet (its subject key and positive control are the sibling
 * slice), so it keeps `tier: null` until that slice lands.
 *
 * @param {object} dispatch
 *   - `kind`, `cause`, `scopePaths` — handed to {@link ./dispatch-task-type.mjs#taskTypeFor}.
 *   - `size` the card's `size:` frontmatter (see {@link estimatedLocForSize}); `estimatedLoc` overrides it.
 *   - `acceptanceTestable` (default `true`), `dependsOn` (default `[]`), `risk` (optional raise-only floor).
 *   - `tags` (default `[]`) — the item's own frontmatter tags, consulted only by {@link workerTierFor}'s
 *     `security` row (#3857); every other tier row reads `kind`/`taskType`/`scopePaths`.
 *   - `taskKey` `{storyRef, round, taskId}` — spot-check sampling only; omitted means no sample.
 *   - `deliveryAgent` / `deliveryAgentReason` — the item's own frontmatter marker and its required reason: the
 *     ONE provider override (#3840, Fork 5 of #3801; the process-wide environment variables are retired). A
 *     marker with no reason, a reason with no marker, or a vendor outside {@link DELIVERY_VENDOR_PROVIDERS} is
 *     REFUSED: an unexplained override is indistinguishable from the brief-sentence delegation #3717 abolishes.
 *     `routed` stays the CRITERIA's choice; the override is recorded BESIDE it as `override`
 *     (`{requestedVendor, executedVendor, reason}` — the `#agent-vendor-registry` rule-4 field names, referenced
 *     here, not a second vocabulary), and its supervision is the level of the OVERRIDE's own
 *     `{provider, model, taskType}` triple (an override to a triple with no trials starts at `full`), never the
 *     level the routed triple earned. It does not touch admission: an unsized card is still held for prepare.
 * @param {{scorecards?: unknown, enforceSupervision?: boolean, sizePolicy?: unknown, promotions?: unknown}} [deps]
 *   - `sizePolicy` — the checked-in `we:scripts/lib/dispatch-size-policy.json` setting (#3801 Fork 4 (b)), read
 *     at the io edge and handed across as data exactly like `scorecards`. Defaults to
 *     {@link DEFAULT_SIZE_POLICY} and is validated by {@link validateSizePolicy}; an invalid policy refuses the
 *     whole route rather than routing on a setting nobody checked.
 *   - `promotions` — the checked-in `we:scripts/lib/dispatch-supervision-promotions.json` promotion record
 *     (#3784, rule 6 of #3690), read at the io edge and handed across as data. Defaults to
 *     {@link DEFAULT_PROMOTIONS} and is validated by {@link validatePromotions}; UNLIKE `sizePolicy`, an
 *     invalid/missing candidate fails CLOSED to no promotions (every computed `spot-check` gates to `full`)
 *     rather than refusing the route.
 *   - `criticalWorkGate` (#3906/#4034) — which kinds are gated and which taskTypes are opened for non-critical
 *     work. Omitted means `provider-routing.mjs#CRITICAL_WORK_GATE` (build, fix and ci-heal gated; every
 *     `openForNonCritical` row off); a caller passes its own only to state a different gate explicitly (a test,
 *     or the read-only dry-run of an opened row).
 *   - `dispatch.measuredDiffLoc` (#3844) — the changed-line count of the PR being repaired, read at the io edge
 *     (e.g. `reconcile-fix-dispatch.mjs`'s own `gh` read) and handed in as data; consulted only for a
 *     {@link REPAIR_KINDS} dispatch, and only when `card-size` (the dispatch's own `size`/`estimatedLoc`)
 *     did not already answer it.
 * @returns {object} the routing record — see the file's own test for the exact shape.
 */
// @wired-by-3717: has a runtime caller — the G2 dispatcher wiring (see `decideDispatchRoute`)
function decideDispatchRouteLegacy(dispatch = {}, { scorecards = [], enforceSupervision = false, sizePolicy: rawSizePolicy = DEFAULT_SIZE_POLICY, promotions: rawPromotions = DEFAULT_PROMOTIONS, criticalWorkGate } = {}) {
  try {
    const kind = String(dispatch?.kind ?? '').trim();
    const scopePaths = Array.isArray(dispatch?.scopePaths) ? dispatch.scopePaths.map(String) : [];
    const tags = Array.isArray(dispatch?.tags) ? dispatch.tags.map(String) : [];
    const derivation = taskTypeFor({ kind, cause: dispatch?.cause ?? null, scopePaths });

    const override = normalizeOverride(dispatch, kind);
    if (override.refusal) return routeRefused(kind, derivation, override.refusal);

    if (derivation.outcome === 'refused') return routeRefused(kind, derivation, derivation.reason);

    if (derivation.outcome === 'role') {
      const record = {
        kind,
        outcome: 'role',
        role: derivation.role,
        taskType: null,
        routed: null,
        executed: null,
        model: null,
        tier: RUNG_KINDS.includes(derivation.role) ? workerTierFor({ kind: derivation.role, taskType: null, scopePaths, tags }).tier : null,
        supervision: SUPERVISION_LEVELS.FULL,
        spotCheck: null,
        sized: null,
        sizeSource: null,
        override: override.value,
        refusal: null,
        supervisionEnforced: enforceSupervision,
        supervisionHold: null,
        auditTrail: [audit('role-path', derivation.role, `kind=${kind}`, derivation.reason)],
      };
      // Preparation edits the card, not its eventual implementation scope. The launcher enforces that
      // single-card envelope; judgment roles (especially prepare-decision) never enter this roster.
      if (kind === 'prepare-item' && (criticalWorkGate ?? CRITICAL_WORK_GATE).openForNonCritical?.prepare) {
        const picked = selectProbationWorker({ taskType: 'prepare', filesTouched: [], estimatedSize: 0, simple: dispatch.simple === true, scorecards: routingRecords(scorecards), vetoes: criticalMissesFor(scorecards, 'prepare') });
        record.probationWorker = picked.worker;
        record.tier = CLAUDE_TIERS.SONNET;
        record.auditTrail.push(...picked.auditTrail);
      }
      // A role dispatch has no provider decision to override, and the marker is not read for these kinds (see
      // `MARKER_KINDS`), so `override` is `null` here: minting a route for it would be the guess this card removes.
      return record;
    }

    const sizePolicyResult = validateSizePolicy(rawSizePolicy);
    if (!sizePolicyResult.ok) {
      return routeRefused(kind, derivation, `the size policy does not validate: ${sizePolicyResult.errors.join('; ')}`);
    }
    const sizePolicy = sizePolicyResult.policy;

    // #3784 — RULE 6 of #3690: THE PROMOTION RECORD, resolved once per route. UNLIKE `sizePolicy` above, an
    // invalid/missing/unparseable candidate never refuses the route — it fails CLOSED to an empty list, so
    // every computed `spot-check` below is gated to `full` rather than the whole dispatch being held. See
    // {@link validatePromotions}'s own docblock for why this departs from the size-policy precedent.
    const promotionsResult = validatePromotions(rawPromotions);
    const promotedRows = promotionsResult.ok ? promotionsResult.promotions : [];

    // #3801 Fork 4 (b) — WHERE THE SIZE CAME FROM, recorded beside the number itself. An explicit override or
    // the card's own `size:` is `sized: true`, source `card`. Otherwise (`sized: false`) `unsizedCardPolicy`
    // decides the FALLBACK NUMBER: `default-size` reads `sizePolicy.defaultSize` (the setting's name and
    // value ARE the source); `block` does not gate admission here (that is the sibling slice), so the number
    // stays the pre-#3843 largest-band answer, unchanged.
    //
    // #3844 (Fork 4 "fix path") — a {@link REPAIR_KINDS} dispatch (`fix`/`ci-heal`) never reaches this generic
    // fallback: it walks {@link resolveFixSize}'s `fixSizeSource` chain instead, because `block` alone would
    // silently stop a conflict-caused fix (this card's own reasoning, on the checked-in default policy).
    let estimatedLoc; let sized; let sizeSource;
    if (dispatch?.sizeSource === 'plan') {
      // The planner only emits planned `build` tasks. `sizeSource` is caller-supplied, so a repair (or any other
      // cause) naming it would skip `resolveFixSize` / the card size policy and pick a smaller, more autonomous envelope.
      if (kind !== 'build' || dispatch.cause !== 'planned') return routeRefused(kind, derivation, 'plan size is only valid for a planned build');
      const bySize = estimatedLocForSize(dispatch.size);
      estimatedLoc = dispatch.estimatedLoc ?? (bySize.sized ? bySize.estimatedLoc : null);
      if (!integer(estimatedLoc)) return routeRefused(kind, derivation, 'plan size requires a positive estimatedLoc or a supported size');
      sized = true; sizeSource = 'plan';
    } else if (REPAIR_KINDS.includes(kind)) {
      ({ estimatedLoc, sized, sizeSource } = resolveFixSize(dispatch, sizePolicy));
    } else if (dispatch?.estimatedLoc != null) {
      estimatedLoc = dispatch.estimatedLoc; sized = true; sizeSource = 'card';
    } else {
      const bySize = estimatedLocForSize(dispatch?.size);
      sized = bySize.sized;
      if (sized) {
        estimatedLoc = bySize.estimatedLoc; sizeSource = 'card';
      } else if (sizePolicy.unsizedCardPolicy === 'default-size') {
        estimatedLoc = SIZE_TO_ESTIMATED_LOC[sizePolicy.defaultSize]; sizeSource = `defaultSize=${sizePolicy.defaultSize}`;
      } else {
        estimatedLoc = bySize.estimatedLoc; sizeSource = 'largest-band';
      }
    }
    const filesTouched = [...new Set(scopePaths.map((p) => p.replace(/^we:/, '').replace(/^([A-Za-z0-9._-]+):/, '$1/').replace(/^\.\//, '')).filter(Boolean))];
    const input = {
      taskType: derivation.taskType,
      estimatedLoc,
      filesTouched,
      acceptanceTestable: dispatch?.acceptanceTestable !== false,
      dependsOn: Array.isArray(dispatch?.dependsOn) ? [...new Set(dispatch.dependsOn.map(String))] : [],
    };
    if (owns(dispatch ?? {}, 'risk') && dispatch.risk != null) input.risk = dispatch.risk;
    const built = buildDispatchProfile(input);
    if (!built.ok) {
      return routeRefused(kind, derivation, `the dispatch profile does not validate: ${built.errors.join('; ')}`);
    }

    // agy-launcher-probation — a `behind` CI heal (a rebase, no failing test to diagnose) is the one SIMPLE task
    // today; only a simple task may go to the Antigravity-Gemini probation worker (#3922).
    const simple = kind === 'ci-heal' && String(dispatch?.reason ?? '').trim() === 'behind';
    const out = routeDispatch(built.profile, { stage: 'task', scorecards, taskKey: dispatch?.taskKey, kind, tags, criticalWorkGate, simple, criticalRisk: dispatch?.risk ?? 'low' });
    if (out.role === 'refused') {
      return routeRefused(kind, derivation, `the router refused this dispatch: ${out.auditTrail.map((a) => a.reasoning).join('; ')}`);
    }

    // #3840 — `routed` is ALWAYS the criteria's choice. The override sits beside it, and it is supervised as the
    // triple it actually is: `selectSupervisionLevel` over the OVERRIDE's own `{provider, model, taskType}`, so a
    // vendor the criteria did not pick cannot inherit the `spot-check` the routed triple earned. The model is the
    // routed one only when the override lands on the same provider; otherwise it is unknown here (the wrapper
    // picks it) and matches no trial, so the triple starts at `full`.
    let supervision = out.supervision;
    let spotCheck = out.spotCheck;
    let supervisionProvider = out.provider;
    let supervisionModel = out.model;
    const overrideAudit = [];
    if (override.value) {
      const provider = DELIVERY_VENDOR_PROVIDERS[override.value.requestedVendor];
      const model = provider === out.provider ? out.model : null;
      const own = selectSupervisionLevel(
        provider, model, derivation.taskType, routingRecords(scorecards).filter((r) => r.role !== 'supervise'), thresholdsForRisk(built.profile.risk),
      );
      supervision = own.level;
      if (neverSpotCheck(built.profile) && supervision === SUPERVISION_LEVELS.SPOT_CHECK) supervision = SUPERVISION_LEVELS.FULL;
      spotCheck = supervision === SUPERVISION_LEVELS.SPOT_CHECK && taskSessionName(dispatch?.taskKey)
        ? spotCheckSample(dispatch.taskKey, built.profile.risk)
        : null;
      supervisionProvider = provider;
      supervisionModel = model;
      overrideAudit.push(
        audit('provider-override', override.value.requestedVendor, `criteria routed ${out.provider}`, override.value.reason),
        audit('override-supervision', supervision, `triple=${provider}/${model ?? 'unknown-model'}/${derivation.taskType}; routed triple was ${out.supervision}`, 'An override is a trial of its own triple, supervised at that triple\'s level, never at the routed one\'s.'),
        ...own.auditTrail,
      );
    }

    // #3784 — RULE 6 of #3690: a computed `spot-check` survives ONLY when its own `{provider, model, taskType}`
    // triple is named (at that level) in the ratified promotion record; otherwise it is gated to `full`, with a
    // reason naming the missing act. A computed `full` is NEVER lifted by a promotion row — demotion stays
    // automatic (the data demotes), promotion never happens without a named, cited act (the operator promotes).
    // `selectSupervisionLevel` (provider-routing.mjs) is NOT touched by this — the clamp lives here, one layer up.
    if (supervision === SUPERVISION_LEVELS.SPOT_CHECK) {
      const named = promotedRows.some((p) => p.level === SUPERVISION_LEVELS.SPOT_CHECK
        && p.provider === supervisionProvider && p.model === supervisionModel && p.taskType === derivation.taskType);
      if (!named) {
        supervision = SUPERVISION_LEVELS.FULL;
        spotCheck = null;
        overrideAudit.push(audit(
          'promotion-required', SUPERVISION_LEVELS.FULL,
          `triple=${supervisionProvider ?? 'unknown-provider'}/${supervisionModel ?? 'unknown-model'}/${derivation.taskType}`,
          'Rule 6 of #delegation-trial-record-graduation: no ratified promotion act '
            + '(we:scripts/lib/dispatch-supervision-promotions.json) names this {provider, model, taskType} '
            + 'triple at spot-check, so the computed level is held at full until one does.',
        ));
      }
    }

    const routed = out.provider;
    const record = {
      kind,
      outcome: 'routed',
      role: out.role,
      taskType: derivation.taskType,
      routed,
      // WHAT ACTUALLY RUNS IT (#3848) — see {@link executedVendorFor}. `routed !== executed` is the delegation
      // gap, recorded rather than silently collapsed; an override closes the gap for THIS dispatch only.
      executed: executedVendorFor(override),
      model: out.model,
      tier: out.tier,
      supervision,
      spotCheck,
      risk: built.profile.risk,
      complexity: built.profile.complexity,
      estimatedLoc,
      sized,
      sizeSource,
      override: override.value,
      // agy-launcher-probation — the probation worker a launcher may run this dispatch on (see
      // `provider-routing.mjs#selectProbationWorker`), or null. An item's own `deliveryAgent:` override wins.
      probationWorker: override.value ? null : (out.probationWorker ?? null),
      refusal: null,
      supervisionEnforced: enforceSupervision,
      supervisionHold: null,
      auditTrail: [
        audit('task-type-derivation', derivation.taskType, `kind=${kind}, cause=${dispatch?.cause ?? 'none'}, scope=${scopePaths.length} path(s)`, derivation.reason),
        audit(
          'estimated-loc', String(estimatedLoc), `size=${JSON.stringify(dispatch?.size ?? null)}`,
          sized
            ? (sizeSource === 'plan' ? 'from the planner estimate' : 'from the card\'s own `size:`')
            : sizeSource === 'largest-band'
              ? 'the card declares no `size:` — read as the largest band, which sits outside every proven envelope'
              : `the card declares no \`size:\` — unsizedCardPolicy is \`default-size\`, read as ${sizeSource}`,
        ),
        ...overrideAudit,
        ...out.auditTrail,
      ],
    };
    record.supervisionHold = supervisionHold(record, { enforce: enforceSupervision });
    return record;
  } catch (e) {
    return routeRefused('', { reason: String((e && e.message) || e) }, `unreadable dispatch input: ${String((e && e.message) || e)}`);
  }
}

function routeRefused(kind, derivation, reason) {
  return {
    kind, outcome: 'refused', role: null, taskType: null, routed: null, executed: null, model: null, tier: null,
    supervision: SUPERVISION_LEVELS.FULL, spotCheck: null, sized: null, sizeSource: null, override: null,
    refusal: reason, supervisionEnforced: false, supervisionHold: null,
    auditTrail: [audit('dispatch-task-type', 'refused', `kind=${kind}`, derivation?.reason ?? reason)],
  };
}

function normalizeOverride(dispatch, kind) {
  if (!MARKER_KINDS.includes(kind)) return { value: null, refusal: null };
  const vendor = dispatch?.deliveryAgent == null ? '' : String(dispatch.deliveryAgent).trim();
  const reason = dispatch?.deliveryAgentReason == null ? '' : String(dispatch.deliveryAgentReason).trim();
  if (!vendor) {
    if (reason) {
      return { value: null, refusal: 'a `deliveryAgentReason:` is set with no `deliveryAgent:` marker — a reason for nothing is a sentence in a brief, which is what #3717 abolishes' };
    }
    return { value: null, refusal: null };
  }
  if (!Object.hasOwn(DELIVERY_VENDOR_PROVIDERS, vendor)) {
    return { value: null, refusal: `\`deliveryAgent: ${vendor}\` is not one of ${Object.keys(DELIVERY_VENDOR_PROVIDERS).join(', ')}` };
  }
  if (!reason) {
    return { value: null, refusal: `\`deliveryAgent: ${vendor}\` has no \`deliveryAgentReason:\` — an unexplained override is indistinguishable from the brief-sentence delegation #3717 abolishes, so it is refused` };
  }
  // The rule-4 field names (`#agent-vendor-registry`). The marker's vendor is honoured verbatim by the build / fix /
  // ci-heal providers, so requested and executed are the same vendor; a fallback for a kind a vendor cannot run is
  // #3658's and is not built yet.
  return { value: { requestedVendor: vendor, executedVendor: vendor, reason }, refusal: null };
}

/** Resolve once before dispatch; preserve the existing risk, supervision and override calculations. */
// @wired-by-3717: has a runtime caller — the G2 dispatcher wiring (see `decideDispatchRoute`)
export function decideDispatchRoute(dispatch = {}, options = {}) {
  const policy = options.routingPolicy ?? DEFAULT_ROUTING_POLICY;
  const criticalWorkGate = options.criticalWorkGate ?? policy.criticalWorkGate;
  const record = decideDispatchRouteLegacy(dispatch, { ...options, criticalWorkGate });
  if (record.outcome === 'refused' || record.refusal || record.override) return record;
  // PR #3311 split: repair dispatch retains the main evidence/tier path.
  if (dispatch.kind === 'ci-heal' && options.ciHealAvailability && record.probationWorker) {
    const picked = selectProbationWorker({ taskType: record.taskType, tier: record.tier,
      simple: dispatch.reason === 'behind', filesTouched: dispatch.scopePaths ?? [],
      scorecards: routingRecords(options.scorecards), vetoes: criticalMissesFor(options.scorecards ?? [], record.taskType),
      availability: options.ciHealAvailability });
    record.auditTrail.push(...picked.auditTrail);
    if (!picked.worker) return { ...record, probationWorker: null, outcome: 'refused', refusal: picked.reason };
    record.probationWorker = picked.worker;
  }
  if (['fix', 'ci-heal'].includes(dispatch.kind)) return record;
  // Every policy-routed kind needs a verdict, including roles and future operation names.
  // Keep the inherited evidence router unchanged when no explicit policy route exists.
  const roleGate = decideCriticalWorkGate({ ...criticalWorkGate, kinds: [...new Set([...criticalWorkGate.kinds, dispatch.kind])] }, dispatch.kind, record.taskType ?? (dispatch.kind === 'prepare-item' ? 'prepare' : dispatch.kind), {
    criticalWork: criticalWorkVerdict({ filesTouched: dispatch.cardPath ? [dispatch.cardPath] : dispatch.scopePaths, risk: dispatch.risk, tags: dispatch.tags }),
    criticalMisses: criticalMissesFor(options.scorecards ?? [], dispatch.kind === 'prepare-item' ? 'prepare' : dispatch.kind),
  });
  const gateClosed = (roleGate && !roleGate.open) || record.auditTrail?.some(row => row.criterion === 'critical-work-gate' && row.result === 'claude-only');
  try {
    // Critical-miss vetoes are scored per taskType and apply to EVERY routed operation, gated or not
    // (prepare-item is role-path: no record.taskType, scored as 'prepare').
    const vetoTaskType = record.taskType ?? (dispatch.kind === 'prepare-item' ? 'prepare' : dispatch.kind);
    const route = resolveOperationRoute({ operation: dispatch.kind, size: dispatch.size, designQuestion: dispatch.designQuestion, wellScoped: dispatch.wellScoped, taskType: record.taskType ?? (dispatch.kind === 'prepare-item' ? 'prepare' : null), gateClosed, policy, vetoes: criticalMissesFor(options.scorecards ?? [], vetoTaskType) });
    if (!route) {
      if (roleGate && !roleGate.open) record.probationWorker = null;
      return record;
    }
    const tier = Object.entries(CLAUDE_NATIVE_MODEL_BY_TIER).find(([, model]) => model === route.model)?.[0];
    record.policyRoute = route;
    record.model = route.model;
    record.effort = route.effort;
    record.routed = route.provider;
    record.executed = route.provider;
    record.supervision = SUPERVISION_LEVELS.FULL;
    record.spotCheck = null;
    record.probationWorker = null;
    if (tier) record.tier = tier;
    if (route.provider !== 'claude' && (dispatch.kind === 'prepare-item' || (dispatch.kind === 'build' && ['doc-fix', 'test-fix'].includes(record.taskType)))) {
      const id = route.provider === 'codex' ? 'codex' : route.model.startsWith('claude-') ? 'antigravity-claude' : 'antigravity-gemini';
      record.probationWorker = { ...PROBATION_WORKERS[id], model: route.model, effort: route.effort, taskType: dispatch.kind === 'prepare-item' ? 'prepare' : record.taskType };
    }
    record.auditTrail.push(audit('routing-policy', `${route.provider}/${route.model}`, 'we:scripts/lib/dispatch-routing-policy.json', gateClosed ? 'Critical-work gate requires the Claude fallback.' : 'Operator policy selects this explicit provider/model; supervision remains full.'));
    return record;
  } catch (error) {
    return { ...record, outcome: 'refused', refusal: error.message };
  }
}
