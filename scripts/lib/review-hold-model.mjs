/**
 * @file scripts/lib/review-hold-model.mjs
 * @description The ONE place that answers "is this review verdict publishable?" (design:
 *   review-hold-model, slice S1). Pure: no I/O. Imports only the gate inventory and the STRICT merge-gate
 *   verdict parser. Every gate row is classified once from the full 24-gate table; publication, candidacy and
 *   the stored annotation all derive from that single result. Carried annotations never authorize anything.
 *
 *   Classes: R review (the review removes it) · A review-arc (produced after the verdict) · H human (enforced
 *   at merge, publication does not wait) · S stale manual freeze (proven) · X real · U unreadable.
 *   Orchestrator rulings: ledger without a `labels:` reason = X; review-acceptance `human-only:` = H; the stale
 *   manual-freeze proof is kept as S unchanged.
 */
import { DRAIN_GATES, GATE_IDS } from './merge-gate-inventory.mjs';
import { parsePrResultTable } from './merge-gate-verdict.mjs';

export const HOLD_CLASSES = Object.freeze(['R', 'A', 'H', 'S', 'X', 'U']);
/** Exact red-team reasons (red-team-check-run.mjs): only plain absence or the review's own in-flight round. */
export const RED_TEAM_MISSING = 'no red-team check run on head';
export const RED_TEAM_PENDING = 'red-team check run in progress or incomplete';
export const MERGE_GATE_FOOTER = 'merge-gate: HOLD — held';
/** Mirrors REVIEW_HOLD_LABELS (review-escalation.mjs); a test pins the two equal. */
export const REVIEW_HOLD_LABEL_NAMES = Object.freeze(['review:pending', 'review:changes', 'review:human', 'review:held-mechanical']);
/** Steps of review-gate.yml that compute the verdict (the others are infrastructure). */
export const REVIEW_GATE_VERDICT_STEPS = Object.freeze(['Fast verdict for a non-review label event', 'Check for an un-cleared review hold']);
/** Provisional log marker (emitted by slice S2): `review-gate-hold: {"holds":[..],"headSha":..,"runId":..}`. */
export const REVIEW_GATE_MARKER = 'review-gate-hold:';

const MANUAL_FREEZE = /^main is RED \(freeze: manual freeze: .+\)$/;

const always = (cls) => () => cls;
/** Each gate maps (row, ctx) to a class. Keys must equal GATE_IDS (tested). */
export const GATE_HOLD_CLASS = Object.freeze({
  'required-check-read': always('X'),
  'candidate-label': always('R'),
  'producer-certified': always('R'),
  'default-base': always('X'),
  'required-check-green': always('X'),
  codeql: always('X'),
  mergeable: always('X'),
  'landable-state': always('X'),
  'non-empty-body': always('X'),
  'red-team': (row) => (row.reason === RED_TEAM_MISSING || row.reason === RED_TEAM_PENDING ? 'A' : 'X'),
  'review-hold-labels': always('R'),
  'review-acceptance': (row) => (String(row.reason ?? '').startsWith('human-only:') ? 'H' : 'R'),
  'manifest-baseline': always('X'),
  'test-gaming': always('H'),
  'head-pin': always('X'),
  freshness: always('X'),
  'red-main-freeze': (row, ctx) => (isStaleManualFreeze(row, ctx) ? 'S' : 'X'),
  'duplicate-id-on-main': always('X'),
  'couple-whole': always('X'),
  'blocked-by': always('X'),
  'overlap-yield': always('X'),
  'card-group': always('X'),
  'pass-cap': always('X'),
  ledger: (row) => (String(row.reason ?? '').startsWith('labels:') ? 'R' : 'X'),
});

const names = (labels) => (Array.isArray(labels) ? labels : [])
  .map((l) => (typeof l === 'string' ? l : l?.name)).filter((n) => typeof n === 'string');
const isPosInt = (n) => Number.isSafeInteger(n) && n > 0;
const stripTs = (line) => line.replace(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z /, '');
const sameSha = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length > 0 && a.toLowerCase() === b.toLowerCase();

/** Every proof of the old stale-freeze rule, unchanged: manual origin, main CI green, freeze now clear and newer than the verdict. */
function isStaleManualFreeze(row, ctx) {
  if (row.status !== 'hold' || !MANUAL_FREEZE.test(row.reason ?? '')) return false;
  const f = ctx?.freeze;
  return ctx?.mainCiGreen === true && f?.frozen === false && !f.error
    && Number.isFinite(Date.parse(ctx.completedAt)) && Date.parse(f.publishedAt) > Date.parse(ctx.completedAt);
}

/** `main CI (...): green` must be the one diagnostic line between the previous summary and this table's header. */
function mainCiGreenFromLog(logText, num) {
  const lines = String(logText ?? '').split(/\r?\n/).map(stripTs);
  const start = lines.findIndex((l) => l === `#${num}: HOLD` || l === `#${num}: PASS`);
  if (start < 0) return false;
  const prior = lines.slice(0, start).findLastIndex((l) => /^merge-gate: (?:PASS|HOLD)\b/.test(l));
  const ci = lines.slice(prior + 1, start).filter((l) => /^main CI\b/.test(l));
  return ci.length === 1 && /^main CI \(.+\): green$/.test(ci[0]);
}

function footerOk(logText, num) {
  const lines = String(logText ?? '').split(/\r?\n/).map(stripTs);
  const start = lines.findIndex((l) => l === `#${num}: HOLD` || l === `#${num}: PASS`);
  const after = lines.slice(start + 1).filter((l) => /^merge-gate:/.test(l));
  return after.length === 1 && after[0] === MERGE_GATE_FOOTER;
}

const bad = (why) => ({ ok: false, why, holds: [], red: false });

const DEFER_SKIP = 'candidacy hold deferred to the merge_group run (mergeGate.prEventCandidacyHoldsPass=on): ';
const DEFERRABLE = Object.freeze(['candidate-label', 'producer-certified', 'review-hold-labels', 'review-acceptance', 'ledger']);
function policySkipOk(row) {
  const reason = String(row.reason ?? '');
  // The drain-placement skip rewrites the verdict and keeps only prose, so a failed or fail-closed gate
  // is indistinguishable from a clear one: unproven, hence unreadable here. S3 may relax it with a producer-side proof.
  return reason.startsWith(DEFER_SKIP) && reason.length > DEFER_SKIP.length && DEFERRABLE.includes(row.id)
    && !reason.slice(DEFER_SKIP.length).startsWith('human-only:');
}

function evalMergeGate({ mergeGate: mg, headSha, prNumber, freeze }) {
  if (mg == null || mg.state === 'absent' || mg.state === 'pending' || mg.state === 'queued' || mg.state === 'in_progress') {
    return { ok: true, pending: true, holds: [], red: false, why: 'verdict-pending' };
  }
  if (mg.state !== 'completed') return bad('merge-gate:unreadable-state');
  if (mg.conclusion !== 'failure' && mg.conclusion !== 'success') return bad(`merge-gate:conclusion-${String(mg.conclusion)}`);
  if (!isPosInt(mg.runId) || !isPosInt(mg.jobId)) return bad('merge-gate:unbound-job');
  if (!sameSha(mg.jobHeadSha, headSha)) return bad('merge-gate:wrong-head');
  if (mg.latest !== true) return bad('merge-gate:not-latest-run');
  if (mg.conclusion === 'success') return { ok: true, holds: [], red: false, why: 'green' };
  if (!Number.isSafeInteger(prNumber)) return bad('merge-gate:no-pr');
  const table = parsePrResultTable(mg.logText, prNumber);
  if (table.error) return bad(`merge-gate:${table.error}`);
  if (table.num !== prNumber) return bad('merge-gate:wrong-pr');
  if (table.ok !== false) return bad('merge-gate:header-not-hold');
  if (!footerOk(mg.logText, prNumber)) return bad('merge-gate:footer');
  const ctx = { freeze, completedAt: mg.completedAt, mainCiGreen: mainCiGreenFromLog(mg.logText, prNumber) };
  const holds = [];
  for (const row of table.results) {
    if (row.status !== 'hold' && row.status !== 'fail-closed') {
      // A clear row must carry the status its placement can emit; anything else is unproven evidence.
      const where = DRAIN_GATES.find((g) => g.id === row.id)?.where;
      const allowed = where === 'merge-gate' ? ['pass', 'skipped-by-policy'] : [where, 'skipped-by-policy'];
      if (!allowed.includes(row.status)) return bad(`merge-gate:misplaced-status:${row.id}`);
      // skipped-by-policy: only merge-gate-placed gates, and only the two shapes the producers emit
      // (merge-gate-ci.mjs `placement drain`, merge-gate-hold-class.mjs candidacy deferral). Anything else is unreadable.
      if (row.status === 'skipped-by-policy' && !(where === 'merge-gate' && policySkipOk(row))) {
        holds.push({ gate: row.id, id: row.id, class: 'U', reason: `unproven skipped-by-policy: ${row.reason}` });
      }
      continue;
    }
    const cls = row.status === 'fail-closed' ? 'U' : GATE_HOLD_CLASS[row.id](row, ctx);
    holds.push({ gate: row.id, id: row.id, class: cls, reason: row.reason });
  }
  if (!holds.length) return bad('merge-gate:no-blocking-row');
  return { ok: holds.every((h) => 'RAHS'.includes(h.class)), holds, red: true, why: 'classified' };
}

function evalReviewGate({ reviewGate: rg, headSha, labels }) {
  if (rg == null || rg.state === 'absent' || rg.state === 'pending') return { ok: true, why: 'clear' };
  if (rg.state !== 'failure' && rg.state !== 'success') return { ok: false, why: 'review-gate:unreadable-state' };
  if (!isPosInt(rg.runId) || !isPosInt(rg.jobId)) return { ok: false, why: 'review-gate:unbound-job' };
  if (!sameSha(rg.jobHeadSha, headSha)) return { ok: false, why: 'review-gate:wrong-head' };
  if (rg.latest !== true) return { ok: false, why: 'review-gate:not-latest-run' };
  if (rg.state === 'success') return { ok: true, why: 'clear' };
  const steps = Array.isArray(rg.steps) ? rg.steps : null;
  if (!steps || !steps.length || steps.some((s) => s?.status !== 'completed')) return { ok: false, why: 'review-gate:steps-incomplete' };
  const failed = steps.filter((s) => s.conclusion === 'failure');
  if (failed.length !== 1 || !REVIEW_GATE_VERDICT_STEPS.includes(failed[0].name)
    || steps.some((s) => s !== failed[0] && !['success', 'skipped'].includes(s.conclusion))) return { ok: false, why: 'review-gate:infrastructure-failure' };
  const markers = String(rg.logText ?? '').split(/\r?\n/).map(stripTs).filter((l) => l.startsWith(REVIEW_GATE_MARKER));
  if (markers.length !== 1) return { ok: false, why: 'review-gate:marker-count' };
  let m;
  try { m = JSON.parse(markers[0].slice(REVIEW_GATE_MARKER.length)); } catch { return { ok: false, why: 'review-gate:marker-unreadable' }; }
  if (!Array.isArray(m?.holds) || m.holds.length !== 1 || m.holds[0] !== 'review-hold-labels') return { ok: false, why: 'review-gate:marker-holds' };
  if (!sameSha(m.headSha, headSha) || m.runId !== rg.runId) return { ok: false, why: 'review-gate:marker-stale' };
  if (!Array.isArray(labels) || !names(labels).some((n) => REVIEW_HOLD_LABEL_NAMES.includes(n))) return { ok: false, why: 'review-gate:labels-clear' };
  return { ok: true, why: 'review-hold-labels' };
}

/**
 * Classify the verdict once. Any carried annotation or setting on the inputs is ignored by construction.
 * @returns {{candidacy:boolean, holds:Array, publishable:boolean, reason:string, key:object}}
 */
export function deriveReviewHold({ headSha, prNumber, labels, mergeGate, reviewGate, freeze } = {}) {
  const key = { headSha: headSha ?? null,
    mergeGate: { runId: mergeGate?.runId ?? null, jobId: mergeGate?.jobId ?? null },
    reviewGate: { runId: reviewGate?.runId ?? null, jobId: reviewGate?.jobId ?? null } };
  const fail = (reason, holds = []) => ({ candidacy: false, holds, publishable: false, reason, key });
  if (typeof headSha !== 'string' || !headSha) return fail('no-head');
  if (!Array.isArray(labels) || labels.some((l) => typeof (typeof l === 'string' ? l : l?.name) !== 'string')) return fail('unreadable-labels');
  let mg, rg;
  try {
    mg = evalMergeGate({ mergeGate, headSha, prNumber, freeze });
    rg = evalReviewGate({ reviewGate, headSha, labels });
  } catch (error) { return fail(`unreadable:${String(error?.message ?? error).slice(0, 80)}`); }
  if (!mg.ok) {
    const x = mg.holds.filter((h) => h.class === 'X' || h.class === 'U');
    const rtFail = x.find((h) => h.gate === 'red-team');
    const reason = !mg.holds.length ? mg.why : rtFail ? 'red-team-failed' : `real-hold:${x[0].id}`;
    return fail(reason, mg.holds);
  }
  if (!rg.ok) return fail(rg.why, mg.holds);
  const hasReady = names(labels).includes('ready-to-merge');
  const candidacy = mg.red && mg.holds.every((h) => 'RAS'.includes(h.class)) && !hasReady;
  return { candidacy, holds: mg.holds, publishable: true, reason: mg.pending ? 'verdict-pending' : 'publishable', key };
}

/** The v2 annotation, only for a publishable red verdict that is not candidacy. Legacy alias is derived, never trusted. */
export function serializeReviewHold(result) {
  if (!result?.publishable || result.candidacy || !result.holds?.length) return null;
  const { headSha, mergeGate } = result.key;
  return {
    reviewHold: { v: 2, headSha, runId: mergeGate.runId, jobId: mergeGate.jobId,
      classes: [...new Set(result.holds.map((h) => h.class))].sort(),
      holds: result.holds.map(({ gate, id, class: cls, reason }) => ({ gate, id, class: cls, reason })) },
    mergeGateReviewHold: { holds: result.holds.map((h) => h.id), jobId: mergeGate.jobId },
  };
}

/** Null unless the version, head and the row's own job id all match. */
export function readReviewHold(row, { headSha } = {}) {
  const h = row?.reviewHold;
  if (!h || h.v !== 2 || !sameSha(h.headSha, headSha)) return null;
  const jobId = Number(/\/actions\/runs\/\d+\/job\/(\d+)/.exec(row.detailsUrl ?? row.details_url ?? '')?.[1]);
  if (!isPosInt(jobId) || h.jobId !== jobId) return null;
  return h;
}

export { GATE_IDS };
