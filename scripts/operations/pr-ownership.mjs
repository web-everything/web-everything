/**
 * @file scripts/operations/pr-ownership.mjs
 * @description #4056 (epic #3383) — "who owns this PR right now, and is that owner alive". Read-only: IO is
 * injected (`pr-ownership-io.mjs`), both declared steps are compute, no sinks. Authorship classification
 * is pure; this module reaches nothing that acts.
 *
 * EVERY FACT IS BORROWED BY THE IO SHELL, NOT RE-DERIVED HERE:
 *   - phase            — `progress-board.mjs#classifyPr`, with the SAME required-check set the reconcile pass read.
 *   - reconcile verdict — the dispatch/refusal row `reconcile-pass.mjs#runReconcilePass` planned for this PR.
 *   - bound sessions   — `reconcile-core.mjs#bindAgents`, whose rows carry `transcriptAgeMs` as evidence.
 *   - daemon liveness  — `runner-activity`'s assessed `runners[]` (`down`/`dead`/`alive-and-*`).
 *   - card             — `pr-ownership-io.mjs#buildPrToCardMap`, the ONE PR→card map.
 * What is decided here is only the fixed owner table and the three flags.
 *
 * THE OWNER TABLE IS FIXED, BY PHASE ({@link ownerFor}). `needs-human` maps to `human`, not `none`: a person owns
 * that move, so it is neither owed to a daemon nor an orphan. A stacked PR (base is not the default branch) is
 * owned by fix-dispatch's stacked-rebase only while conflicted (#4030); once it is queued, the drain will never
 * land it, so nothing owns it — the orphan shape.
 *
 * NEVER GUESSES. An unreadable transcript age, phase-entry time or daemon state stays `null`/`unknown`, and a
 * flag that needs it does not fire. `drain` is not a runner-activity daemon, so its liveness is `unknown`.
 */
import { isAiGeneratedPr } from '../lib/ai-pr-authorship.mjs';
import { op } from './registry.mjs';
import { compute } from './step-kinds.mjs';

export const PR_OWNERSHIP_OP = 'pr-ownership';

/** Every threshold in one place. `tickIntervalMs` mirrors the fix-dispatch daemon's own tick
 *  (`reconcile-fix-dispatch-daemon.mjs#DEFAULT_INTERVAL_MS`), which is what turns time-in-phase into ticks. */
export const PR_OWNERSHIP_THRESHOLDS = Object.freeze({
  staleBindingMs: 20 * 60 * 1000,
  owedTicks: 5,
  tickIntervalMs: 120_000,
});

export const FLAGS = Object.freeze({
  STALE_BINDING: 'stale-binding',
  ORPHAN: 'orphan',
  OWED_NOT_DISPATCHED: 'owed-not-dispatched',
});

/** The daemons that owe a PR a dispatched session. `drain` merges and `human` decides — neither dispatches. */
const DISPATCHING_OWNERS = new Set(['review', 'fix-dispatch']);
const DEAD_DAEMON_STATES = new Set(['down', 'dead']);
const FINISHED_SESSION_STATES = new Set(['done', 'stopped']);

/**
 * The fixed phase → owner table. Pure.
 * @param {{phase:string, stacked?:boolean, isDraft?:boolean}} o
 * @returns {{owner:'review'|'fix-dispatch'|'drain'|'human'|'none', nextMove:string|null, why:string}}
 */
export function ownerFor({ phase, stacked = false, isDraft = false, unlabeledRed = false }) {
  if (stacked && phase === 'conflicted') {
    return { owner: 'fix-dispatch', nextMove: 'stacked-rebase', why: 'conflicted against its own non-default base (#4030)' };
  }
  if (stacked && phase === 'queued') {
    return { owner: 'none', nextMove: null, why: 'queued, but the drain never lands a PR whose base is not the default branch' };
  }
  // A draft is never reviewed (`reconcile-core.mjs#dispatchReviewRow`'s own gate), whatever its label: its next
  // move is fix-dispatch's `promote-draft` once its checks are green. A red draft still falls through to ci-heal.
  if (isDraft && (phase === 'needs-review' || phase === 'open')) {
    return { owner: 'fix-dispatch', nextMove: 'promote-draft', why: 'draft — promoted to ready once its required checks are green' };
  }
  if (unlabeledRed && ['queued', 'open'].includes(phase)) {
    return { owner: 'none', nextMove: null, why: 'ci-red agent PR with no review:* label — the drain will not land it and no daemon owns it' };
  }
  switch (phase) {
    case 'needs-review': return { owner: 'review', nextMove: 'review', why: 'review:pending — a reviewer is owed' };
    case 'bounced': return { owner: 'fix-dispatch', nextMove: 'fix', why: 'review:changes — a fix is owed' };
    case 'conflicted': return { owner: 'fix-dispatch', nextMove: 'conflict-fix', why: 'the branch conflicts with or is behind its base' };
    case 'ci-red': return { owner: 'fix-dispatch', nextMove: 'ci-heal', why: 'a required check is red' };
    case 'queued': return { owner: 'drain', nextMove: 'merge', why: 'accepted — the drain owes the merge' };
    case 'needs-human': return { owner: 'human', nextMove: 'human-review', why: 'review:human — a person owns this move' };
    case 'open': return { owner: 'none', nextMove: null, why: 'no review label — no daemon picks up this phase' };
    default: return { owner: 'none', nextMove: null, why: `phase \`${phase}\` has no owner` };
  }
}

/** When the PR entered its current phase: the latest label or commit event (a phase only moves on one of those,
 *  or on its base moving, which the timeline does not carry). `null` when none is readable. Pure. */
export function phaseSinceFrom(events) {
  let best = null;
  for (const e of Array.isArray(events) ? events : []) {
    if (e?.event !== 'labeled' && e?.event !== 'committed') continue;
    const ms = Date.parse(e.createdAt);
    if (Number.isFinite(ms) && (best === null || ms > best)) best = ms;
  }
  return best === null ? null : new Date(best).toISOString();
}

/** The lane the PR is being worked in: checked out on the PR's head branch, else leased to a bound session. */
function laneFor(pr, lanes, bound) {
  const sessions = new Set(bound.flatMap((b) => [b.name, b.sessionId]).filter(Boolean));
  const lane = lanes.find((l) => l?.branch && l.branch === pr.headRefName)
    ?? lanes.find((l) => l?.lease && [l.lease.workerSession, l.lease.ownerSession, l.lease.session, l.lease.holder]
      .some((s) => s && sessions.has(s)));
  if (!lane) return null;
  return {
    path: lane.path ?? null, branch: lane.branch ?? null, leased: Boolean(lane.lease),
    holder: lane.lease?.holder ?? null, workerSession: lane.lease?.workerSession ?? null,
    acquiredAt: lane.lease?.acquiredAt ?? null,
  };
}

function reconcileRowFor(plan, number) {
  const d = (plan?.dispatch ?? []).find((x) => Number(x?.prNumber) === number);
  if (d) return { verdict: 'dispatch', kind: d.kind ?? null, why: d.why ?? null };
  const r = (plan?.refusals ?? []).find((x) => Number(x?.prNumber) === number);
  if (r) return { verdict: 'refusal', kind: r.kind ?? null, why: r.why ?? null };
  return { verdict: 'none', kind: null, why: null };
}

/**
 * One PR's ownership row. Pure — `pr` is the IO shell's fact row (`phase`, `bound`, `card` already borrowed).
 * @param {{repo:string, number:number, headRefName?:string, baseRefName?:string, isDraft?:boolean, phase:string,
 *   card?:string|null, fixClaim?:object|null, phaseSince?:string|null,
 *   bound:Array<{name?:string, sessionId?:string, state?:string, selfReportedDone?:boolean, transcriptAgeMs:number|null}>}} pr
 */
export function assessPrOwnership(pr, {
  plan = {}, lanes = [], daemons = [], observedAt, defaultBranch = 'main', thresholds = PR_OWNERSHIP_THRESHOLDS,
} = {}) {
  const number = Number(pr.number);
  const stacked = Boolean(pr.baseRefName) && pr.baseRefName !== defaultBranch;
  const planned = [...(plan.dispatch ?? []), ...(plan.refusals ?? [])].find(r => Number(r?.prNumber) === number);
  // Card 278, #5172: IO omits labels and commits; the planned rule already proves agent authorship.
  const labels = (Array.isArray(pr.labels) ? pr.labels : planned?.labels ?? [])
    .map(l => typeof l === 'string' ? l : l?.name).filter(Boolean);
  const unlabeledRed = !pr.isDraft && String(pr.headRefName ?? '').startsWith('lane/')
    && (isAiGeneratedPr(pr) || planned?.rule === 'unlabeled-red')
    && !labels.some(l => l.startsWith('review:'))
    && (labels.some(l => ['status:ci-red', 'ci:failed'].includes(l)) || (pr.check ?? planned?.check) === 'red');
  const { owner, nextMove, why } = ownerFor({ phase: pr.phase, stacked, isDraft: pr.isDraft === true, unlabeledRed });
  const reconcile = reconcileRowFor(plan, number);
  const fixKinds = ['fix', 'ci-heal', 'ci-timeout-rerun', 'promote-draft', 'restore-review-label',
    'convert-advisory', 'close-superseded'];
  const nextActor = reconcile.verdict === 'dispatch'
    ? reconcile.kind === 'review' ? 'review' : fixKinds.includes(reconcile.kind) ? 'fix-dispatch' : owner
    : owner;
  const nextActorState = daemons.find(d => d?.name === nextActor)?.state ?? 'unknown';
  const liveNextActor = DISPATCHING_OWNERS.has(nextActor) && String(nextActorState).startsWith('alive');
  const ownerDaemonState = owner === 'none' || owner === 'human'
    ? null : daemons.find((d) => d?.name === owner)?.state ?? 'unknown';
  const bound = Array.isArray(pr.bound) ? pr.bound : [];

  const nowMs = Date.parse(observedAt);
  const sinceMs = Date.parse(pr.phaseSince ?? '');
  const timeInPhaseMs = Number.isFinite(nowMs) && Number.isFinite(sinceMs) ? Math.max(0, nowMs - sinceMs) : null;
  const ticksInPhase = timeInPhaseMs === null ? null : Math.floor(timeInPhaseMs / thresholds.tickIntervalMs);

  const owed = DISPATCHING_OWNERS.has(owner);
  const flags = [];
  const stale = bound.find((b) => !FINISHED_SESSION_STATES.has(String(b.state ?? '').toLowerCase())
    && b.selfReportedDone !== true
    && Number.isFinite(b.transcriptAgeMs) && b.transcriptAgeMs > thresholds.staleBindingMs);
  if (owed && stale) {
    flags.push({
      flag: FLAGS.STALE_BINDING,
      why: `bound session ${stale.name ?? stale.sessionId ?? '?'} (${stale.state ?? 'unknown state'}) has not`
        + ` touched its transcript for ${Math.round(stale.transcriptAgeMs / 60_000)} min while the PR is owed`,
    });
  }
  if (!liveNextActor && owner === 'none') flags.push({ flag: FLAGS.ORPHAN, why });
  else if (!liveNextActor && DEAD_DAEMON_STATES.has(ownerDaemonState)) {
    flags.push({ flag: FLAGS.ORPHAN, why: `owner daemon \`${owner}\` is ${ownerDaemonState}` });
  }
  const dispatchRecord = bound.length > 0 || Boolean(pr.fixClaim);
  if (owed && !dispatchRecord && ticksInPhase !== null && ticksInPhase > thresholds.owedTicks) {
    flags.push({
      flag: FLAGS.OWED_NOT_DISPATCHED,
      why: `owed ${nextMove} for ${ticksInPhase} reconcile ticks (> ${thresholds.owedTicks}) with no bound session or fix claim`,
    });
  }

  return {
    repo: pr.repo, number, headRefName: pr.headRefName ?? null, baseRefName: pr.baseRefName ?? null, stacked,
    card: pr.card ?? null, phase: pr.phase, owner, nextActor, nextMove, ownerWhy: why, ownerDaemonState,
    reconcile,
    boundSessions: bound.map((b) => ({
      name: b.name ?? null, sessionId: b.sessionId ?? null, state: b.state ?? null,
      transcriptAgeMs: Number.isFinite(b.transcriptAgeMs) ? b.transcriptAgeMs : null,
    })),
    lane: laneFor(pr, lanes, bound), fixClaim: pr.fixClaim ?? null,
    phaseSince: pr.phaseSince ?? null, timeInPhaseMs, ticksInPhase,
    flags, healthy: flags.length === 0,
  };
}

/**
 * The whole read → the ownership report. `read.repos[]` is one entry per constellation repo:
 * `{ repo, prs: [fact rows], plan, lanes, defaultBranch }`.
 */
export function assessOwnership(read, thresholds = PR_OWNERSHIP_THRESHOLDS) {
  if (!read || !Array.isArray(read.repos) || !Array.isArray(read.daemons) || !Array.isArray(read.gaps)) {
    throw new TypeError('pr-ownership: reader must return { observedAt, repos: [...], daemons: [...], gaps: [...] }');
  }
  const prs = read.repos.flatMap((r) => (r.prs ?? []).map((pr) => assessPrOwnership(pr, {
    plan: r.plan, lanes: r.lanes ?? [], daemons: read.daemons, observedAt: read.observedAt,
    defaultBranch: r.defaultBranch ?? 'main', thresholds,
  })));
  const byFlag = Object.fromEntries(Object.values(FLAGS)
    .map((f) => [f, prs.filter((p) => p.flags.some((x) => x.flag === f)).length]));
  return {
    observedAt: read.observedAt, thresholds, prToCard: read.prToCard ?? {},
    daemons: read.daemons.map((d) => ({ name: d.name, state: d.state ?? 'unknown' })),
    summary: { prs: prs.length, flagged: prs.filter((p) => !p.healthy).length, ...byFlag,
      byNextActor: Object.fromEntries(['review', 'fix-dispatch', 'drain', 'human', 'none']
        .map(actor => [actor, prs.filter(p => p.nextActor === actor).length])),
    },
    prs, gaps: read.gaps,
  };
}

export function prOwnershipOperation({ readOwnership } = {}) {
  if (typeof readOwnership !== 'function') throw new TypeError('pr-ownership: needs a readOwnership() reader');
  return op(PR_OWNERSHIP_OP, {
    input: {},
    verdictFrom: 'assess',
    read: compute({ reads: [], fn: () => readOwnership() }),
    assess: compute({ reads: ['findings.read'], fn: ({ findings }) => assessOwnership(findings.read) }),
  });
}
