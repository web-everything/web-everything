/** Shadow-only decision contract. No detector evaluators or external IO belong here. */
import { createHash } from 'node:crypto';

export const ACTION_ALLOWLIST = Object.freeze({
  promote: 'runReconcilePromoteDraftDispatch',
  'restore-hold': 'restore-hold',
  review: 'dispatchReviewByMode',
  'review-status': 'applyReviewStatus',
  'rearm-review': 'rearm-review',
  'ci-heal': 'runReconcileCiHealDispatch',
  'ci-recovered-main': 'sweepCiRedRecovery',
  'ci-hung': 'sweepHungCiRecovery',
  'ci-missing': 'sweepMissingRunRecovery',
  'stand-down': 'stand-down',
  'release-claim': 'orphan-claim-release',
  'release-lane': 'lease-reaper',
});
// Code-reviewed catalogue, never extended by settings or episode prose.
export const OBSERVATION_ONLY = Object.freeze({
  "bad-credentials": "Authentication must be repaired by its owner; never rotate a secret or switch credentials.",
  "bg-isolation-stall": "Permission/isolation grants change authority; owning dispatcher/operator must repair them.",
  "claude-auth-expired": "Interactive login is owed; never synthesize credentials or resume another owner\u2019s worker.",
  "clone-stale": "Existing gated self-sync owns clone repair; never clean/reset/rebase a daemon clone.",
  "clone-behind-main": "A clone that trails main is repaired by its owning daemon refresh path; never clean/reset/rebase a daemon clone.",
  "credential-inventory-stale": "Secret age is a review heuristic, not expiry proof; no automatic rotation.",
  "daemon-held-on-last-good": "Last-good is an intentional safety hold; no forced adoption or smoke bypass.",
  "daemon-owed-no-dispatch": "Aggregate refusal is not a uniquely actionable PR; use linked specific episodes only.",
  "daemon-silent": "Dead/hung/not-ticking are distinct; supervisor owns lifecycle. No kill/restart/lease theft.",
  "dispatch-permission-stall": "No unattended permission grants; name the blocked dispatcher/session.",
  "dispatch-refused-stale-clone": "Rebuild/overlay owner must fix the named refusal; no manual clone writes.",
  "dispatch-trust-refused": "A trust refusal never grants permission to rewrite trust settings. Existing spawn retry remains the owner.",
  "drain-failing-repeatedly": "Do not run an extra drain/merge pass; report the failing operation.",
  "drain-merge-rate-drop": "Throughput is aggregate, not authority to bypass a merge gate.",
  "drain-pass-over-budget": "Do not kill or lengthen a running drain budget; report the slow step.",
  "duplicate-live-sessions": "Do not stop either live worker; the dispatcher owns the duplicate claim.",
  "fix-claim-held-no-progress": "A slow fix claim is not proof of a stuck holder; report only, never release the claim or push to the branch.",
  "fixer-stuck": "Never kill the fixer or release its claim from the responder; the session watchdog and reaper own the stuck-session path.",
  "fixer-verify-never-settles": "Never reset/re-request a marker or kill a waiter; fix the verify-daemon pass that is not dispatching.",
  "gh-call-failures": "Inhibit responder GitHub actions, honor existing throttle; do not amplify failed writes.",
  "gh-graphql-budget": "Inhibit GitHub actions until the existing budget read permits them; no new poll/retry loop.",
  "build-session-idle": "Silence does not prove death; detection only. The owning watchdog/reaper alone acts on the worker, never the responder.",
  "build-session-looping": "A repeating command is a warning, not proof of death; read the transcript, never kill from the responder.",
  "build-session-overrun": "Running long is not proof of failure; detection only, never stop a build/prepare session from the responder.",
  "external-run-stalled": "An external run's silence is a warning; read its output log, never kill or relaunch from the responder.",
  "gh-shim-lane-path": "Repair the shim producer via normal delivery, never patch a generated shim in place.",
  "ghost-session-listed": "The session watchdog owns the ghost-session clear; no responder-driven clear-stuck-session.",
  "ghost-sessions-inflate-cap": "Session reaper owns cleanup; no autonomous clear-stuck-session human confirm.",
  "github-app-token": "Inhibit GitHub actions; existing auth refresh/operator owns recovery, no credential mutation.",
  "health-tick-overrun": "Hold actions if watch freshness is inadequate; watchdog/owner diagnoses the probe.",
  "heavy-queue-wait": "Honor heavy admission; do not raise the cap or kill a holder.",
  "heavy-run-ungated": "Route the named program's runs through heavy admission; never kill the run or raise the cap.",
  "lane-destructive-unpushed": "Possible loss needs recovery judgment; preserve reflogs and do not clean anything.",
  "lane-pool-growth": "Dirty/unleased is not proof of abandoned work; no trim/reset/provision.",
  "lane-worker-without-lease": "A live worker needs ownership investigation, never release or fabricated adoption.",
  "live-process-stale-transcript": "Silence does not prove death; owning job watchdog/reaper alone handles the worker.",
  "machine-overload": "Inhibit new responder jobs; no process kill, cap increase or automatic global pause overwrite.",
  "open-prs-over-limit": "Preserve existing backpressure; never raise/disable the PR limit.",
  "pr-events-stale": "Existing polling fallback owns availability; no webhook/token/deployment edits.",
  "pr-stage-stall": "Cluster is not a per-PR action authorization; reuse inspections and specific episodes.",
  "pre-existing-red-on-main": "A failing test on main is fixed on main via the filed card; the responder never edits tests or the gate.",
  "review-label-missing": "A missing label is reported only; restoring review goes through the guarded re-arm command, never a responder label write.",
  "review-same-head-unposted": "Alert only; inspect failed posting effects and the review caps, never re-arm or post a review from the responder.",
  "review-seat-cap-near-limit":"Low severity; report only, no provider/cap changes and no operator ping.",
  "ruling-needed-waiting": "A ruling is the operator's judgment; never record, infer or auto-answer one.",
  "self-sync-conflict": "Never force or hand-merge a clone/overlay from the responder.",
  "session-stuck": "Silence or repetition is a warning, not proof of death; the session watchdog and reaper alone act on the worker.",
  "stood-down-prs": "Terminal questions need explicit operator answers; never auto-call stand-down-answer.",
  "untracked-backlog-card": "Do not adopt/commit unknown daemon-clone files; normal owner/file-item delivery is owed."
});
export const CATALOGUE = Object.freeze({ ...OBSERVATION_ONLY,
  'draft-not-promoted': ['promote'],
  'pr-no-owner': ['restore-hold', 'review', 'ci-heal', 'ci-recovered-main', 'ci-hung', 'ci-missing'],
  'review-label-conflict': ['review-status', 'rearm-review'],
  'red-pr-unattended': ['ci-heal', 'ci-recovered-main', 'ci-hung', 'ci-missing'],
  'repeated-pr-attempts': ['stand-down', 'review'],
  'stale-claim': ['release-claim'],
  'lane-starvation': ['release-lane'],
  'stranded-lane': ['release-lane'],
});
for (const row of Object.values(CATALOGUE)) if (Array.isArray(row)) Object.freeze(row);
export const DEFAULT_CONFIG = Object.freeze({ version: 1, enabled: false, mode: 'shadow', smells: Object.freeze({}) });
export const RECEIPT_STATES = Object.freeze(['prepared', 'submitted', 'confirmed', 'refused', 'unknown']);
export const WATCH_MAX_AGE_MS = 15 * 60_000;
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj ?? {}, key);
export function validConfig(c) {
  return c && Number.isInteger(c.version) && c.version > 0 && typeof c.enabled === 'boolean'
    && c.mode === 'shadow' && c.smells && typeof c.smells === 'object' && !Array.isArray(c.smells)
    && Object.entries(c.smells).every(([k, v]) => own(CATALOGUE, k) && typeof v === 'boolean');
}
export function episodeIdentity(e) {
  return { id: e.id ?? null, key: e.key ?? null, openedAt: e.openedAt ?? null,
    firstBreachAt: e.firstBreachAt ?? null, smell: e.smell ?? null, subject: e.subject ?? null };
}
export function subjectIdentity(f) {
  if (f?.kind === 'pr' && /^[^/\s]+\/[^/\s]+$/.test(f.repo) && Number.isInteger(f.pr) && f.pr > 0 && /^[a-f0-9]{40}$/.test(f.head))
    return { repo: f.repo, pr: f.pr, head: f.head };
  if (f?.kind === 'lane' && f.pool && Number.isInteger(f.lane) && f.holder && f.generation)
    return { pool: f.pool, lane: f.lane, holder: f.holder, generation: f.generation };
  if (f?.kind === 'claim' && f.item && f.holder && f.generation)
    return { item: f.item, holder: f.holder, generation: f.generation };
  return null;
}
export function familyKey(identity, family) { return JSON.stringify([identity, family]); }
const ci = (a) => typeof a === 'string' && a.startsWith('ci-');
const jobs = new Set(['review', 'ci-heal', 'release-claim']);
function predicate(e, f, a) {
  if (a === 'promote') return f.draft === true && f.checks === 'green' && f.checksHead === f.head && f.intentionalWithdrawal === false;
  if (a === 'restore-hold') return e.measure?.reason === 'missing-review-route' && e.samples >= 4
    && f.automationOwned === true && f.healHead === f.head && f.diffComplete === true
    && ['human', 'pending'].includes(f.reviewTier) && f.labels?.length === 0;
  if (a === 'review-status') return f.conflict === 'obsolete-status' && f.labelsComplete === true;
  if (a === 'rearm-review') return f.repaired === true && f.diffComplete === true && f.rearmPermitted === true;
  if (a === 'review') return f.advisoryMissing === true && f.advisoryCoverageComplete === true && f.completedSameHeadAttempts < 5;
  if (a === 'stand-down') return f.exhausted === true && f.attemptEvidenceComplete === true;
  if (ci(a)) return f.classification === ({ 'ci-heal': 'own-failure', 'ci-recovered-main': 'recovered-main', 'ci-hung': 'hung', 'ci-missing': 'missing' })[a]
    && f.classifierComplete === true;
  if (a === 'release-lane') return f.terminal === true && f.workerDead === true && f.clean === true
    && f.reachable === true && f.reserved === false && f.reaperPermitted === true;
  if (a === 'release-claim') return e.subject?.startsWith('abandoned:') && f.active === true && f.epic === false
    && f.signalsComplete === true && f.hasLease === false && f.openPr === false && f.liveSession === false && f.mergedDelivery === false;
  return false;
}
/**
 * A journal row names the ledger it was decided against by count and content hash, never by value: the row is
 * written per open episode every tick, so embedding the whole receipt/budget history grew every row with it.
 * `read` (filled in `decide` once the rule has actually consulted entries) holds only the entries it read.
 */
function ledgerSummary(ledger) {
  let sha256 = null;
  try { sha256 = createHash('sha256').update(JSON.stringify(ledger) ?? 'undefined').digest('hex'); } catch { /* unhashable input: count stays null */ }
  return { count: Array.isArray(ledger) ? ledger.length : null, sha256 };
}
/** Every episode gets one record, even on invalid input. Facts are structured owner results, never prose. */
export function decide({ episodes = [], watchGeneration, subjectFacts = {}, actionReceipts = [], budgets = [], config = DEFAULT_CONFIG, now } = {}) {
  let admitted = false;
  const receiptsSummary = ledgerSummary(actionReceipts), budgetsSummary = ledgerSummary(budgets);
  const list = Array.isArray(episodes) && episodes.length ? episodes : [{ smell: null, subject: 'watch' }];
  return list.map((raw) => {
    const e = raw ?? {}, f = subjectFacts?.[e.key], identity = subjectIdentity(f);
    const record = { mode: 'shadow', at: now, configVersion: config?.version ?? null,
      episodeIdentity: episodeIdentity(e), episodeId: e.id ?? null, smell: e.smell ?? null, subject: e.subject ?? 'watch',
      expectedHeadOrLease: identity, actionFamily: null, actuator: null,
      inputs: { watchGeneration, episode: e, facts: f ?? null, config,
        actionReceipts: { ...receiptsSummary, read: [] }, budgets: { ...budgetsSummary, read: [] } },
      evidenceRefs: f?.evidenceRefs ?? [], result: 'not-submitted', applied: false };
    const out = (decision, rule, reason) => ({ ...record, decision, rule, reason,
      escalationIntent: ['escalate', 'cap-reached'].includes(decision)
        ? { queueOnly: true, severity: e.severity ?? 'unknown', notificationOwner: 'health-watch', delivered: false } : null });
    if (!Number.isFinite(now) || watchGeneration?.valid !== true || !Number.isFinite(watchGeneration.completedAt)
      || now < watchGeneration.completedAt || now - watchGeneration.completedAt > WATCH_MAX_AGE_MS)
      return out('hold', 'watch-invalid', watchGeneration?.reason ?? 'Missing, mixed or stale completed watch generation');
    if (!e.id || !Number.isFinite(e.openedAt) || e.openedAt <= 0 || e.key !== `${e.smell}::${e.subject}` || !['open', 'flapping'].includes(e.status))
      return out('hold', 'episode-inactive', 'Pending, closed or malformed episode is not authority');
    if (!validConfig(config)) return out('hold', 'config-invalid', 'Unreadable or unsupported configuration; live mode is unavailable');
    if (!own(CATALOGUE, e.smell)) return out('hold', 'unknown-smell', 'Unknown smell has no authority');
    if (!config.enabled || config.smells[e.smell] !== true) return out('hold', 'disabled', 'Responder or smell disabled');
    if (e.tracked || e.status === 'flapping') return out('hold', 'tracked-or-flapping', 'Tracked/flapping episode requires inspection');
    if (own(OBSERVATION_ONLY, e.smell)) return out('noop', 'observation-only', OBSERVATION_ONLY[e.smell]);
    const expectedKind = ['lane-starvation', 'stranded-lane'].includes(e.smell) ? 'lane' : e.smell === 'stale-claim' ? 'claim' : 'pr';
    if (f?.kind !== expectedKind || f?.complete !== true || !identity || f.episodeKey !== e.key || f.episodeId !== e.id
      || (identity?.repo && e.subject !== `${identity.repo}#${identity.pr}`)
      || !Number.isFinite(f.observedAt) || now < f.observedAt || now - f.observedAt > 60_000)
      return out('hold', 'facts-unknown', 'Fresh complete subject identity and owner facts are required; adapter absent');
    if (f.paused !== false || f.kill !== false) return out('hold', 'pause-or-kill', 'Pause/kill state is active or unknown');
    const a = f.plan?.family;
    const inhibitors = list.filter((x) => ['open', 'flapping'].includes(x?.status) && x.severity === 'high').map((x) => x.smell);
    if ((identity.repo && inhibitors.some((s) => ['bad-credentials', 'github-app-token', 'gh-call-failures', 'gh-graphql-budget'].includes(s)))
      || (jobs.has(a) && inhibitors.some((s) => ['machine-overload', 'claude-auth-expired'].includes(s))))
      return out('hold', 'host-inhibitor', 'Existing auth, rate or host owner must recover first');
    if (e.smell !== 'repeated-pr-attempts' && list.some((x) => x?.smell === 'repeated-pr-attempts'
      && x.subject === e.subject && ['open', 'flapping'].includes(x.status)))
      return out('hold', 'repeated-attempt-inhibitor', 'An active repeated-attempt episode inhibits further responder retries; its owner must resolve the loop');
    if (f.terminalHold !== false || f.liveOwner !== false || f.fixClaim !== false || f.changedIdentity !== false)
      return out('hold', 'owner-or-terminal-hold', 'Terminal hold, live owner, fix claim or changed identity; preserve all holds');
    if (f.postcondition === true) return out('noop', 'postcondition-satisfied', 'Independently observed owner postcondition already satisfied');
    if (f.plan?.kind !== 'permitted' || !own(ACTION_ALLOWLIST, a) || !CATALOGUE[e.smell].includes(a))
      return out('escalate', 'owner-refused', f.plan?.reason ?? 'Unknown/refused owner result or unsupported route');
    record.actionFamily = a; record.actuator = ACTION_ALLOWLIST[a];
    const key = familyKey(identity, a);
    if (!Array.isArray(actionReceipts) || !Array.isArray(budgets)
      || actionReceipts.some((r) => !r || !RECEIPT_STATES.includes(r.state) || !['live', 'shadow'].includes(r.mode) || typeof r.familyKey !== 'string')
      || budgets.some((r) => !r || !Number.isFinite(r.at) || r.at > now || !['live', 'shadow'].includes(r.mode) || !own(ACTION_ALLOWLIST, r.family) || !r.identity))
      return out('hold', 'ledger-invalid', 'Malformed receipt/budget data cannot authorize a proposal');
    record.inputs.actionReceipts.read = actionReceipts.filter((r) => r.familyKey === key)
      .map(({ familyKey: k, state, mode }) => ({ familyKey: k, state, mode }));
    if (actionReceipts.some((r) => r.familyKey === key && r.mode === 'live' && ['submitted', 'unknown'].includes(r.state)))
      return out('escalate', 'ambiguous-receipt', 'Reconcile durable owner receipt and postcondition; never retry an ambiguous write');
    if (actionReceipts.some((r) => r.familyKey === key)) return out('hold', 'family-receipt', 'Family already proposed/attempted for this head or lease; no repeat');
    const live = budgets.filter((r) => r.mode === 'live' && Number.isFinite(r.at) && now >= r.at && now - r.at < 86_400_000);
    const same = live.filter((r) => identity.repo ? r.identity?.repo === identity.repo && r.identity?.pr === identity.pr
      : identity.item ? r.identity?.item === identity.item : r.identity?.pool === identity.pool && r.identity?.lane === identity.lane);
    record.inputs.budgets.read = same.map(({ family, at, mode }) => ({ family, at, mode }));
    const hour = (r) => now - r.at < 3_600_000;
    if (f.durableCapReached === true || f.plan.capRemaining <= 0 || live.filter(hour).length >= 12
      || (identity.pr && (same.filter(hour).length >= 2 || same.length >= 4 || (ci(a) && same.filter((r) => ci(r.family)).length >= 2)))
      || (a === 'release-lane' && live.filter((r) => r.family === a && hour(r)).length >= 4)
      || (a === 'release-claim' && (same.length >= 1 || live.filter((r) => r.family === a && hour(r)).length >= 2)))
      return out('cap-reached', 'durable-cap', 'Existing owner or rolling responder cap exhausted; no reset or substitute route');
    if (f.durableCapReached !== false || !Number.isFinite(f.plan.capRemaining) || f.postcondition !== false || !predicate(e, f, a))
      return out('hold', 'preconditions-unproved', 'Catalogue preconditions are false, incomplete or unknown');
    // New detector variants cannot be activated with a runtime setting. Their evidence adapters ship later.
    if (['restore-hold', 'release-lane', 'release-claim', 'review', 'stand-down', 'review-status', 'rearm-review'].includes(a))
      return out('hold', 'adapter-unavailable', 'Scoped action slice must supply the matching evidence adapter and guarded owner boundary');
    if (admitted) return out('hold', 'tick-cap', 'One newly admitted candidate per tick');
    admitted = true;
    return { ...out('act-would-have', 'owner-plan', `Would call ${ACTION_ALLOWLIST[a]} for this exact identity`), result: 'would-have', familyKey: key };
  });
}
/** All external capabilities are structurally absent in this slice. */
export function forbiddenActuator(action) { throw new Error(`Shadow responder forbids external effect: ${action}`); }
export const SHADOW_ACTUATORS = Object.freeze(Object.fromEntries(Object.keys(ACTION_ALLOWLIST).map((a) => [a, () => forbiddenActuator(a)])));
