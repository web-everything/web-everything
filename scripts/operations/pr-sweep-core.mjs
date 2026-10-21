/**
 * @file scripts/operations/pr-sweep-core.mjs
 * @description THE PURE DERIVATION behind the `pr-sweep` operation (declared in `./pr-sweep.mjs`) — one read-only answer to "for EVERY open PR, who is it waiting on, since
 *   when, and is anything actually working on it?".
 *
 * WHY IT EXISTS (live 2026-10-21): PR #5485 sat paused from 22:24 ET to 07:15 ET with the comment "review paused: 2
 * referrals need a ruling; it resumes on a new push, a ruling, or a send-back". The overnight sweeps only read labels
 * (`ready-to-merge`, `status:at-round-limit`), `operator-queue` filed it under "advisory is pending-referral", and the
 * needs-you feed raised nothing. The pause lived in a COMMENT, so nothing that reads labels could see it. This
 * operation reads every signal that says who moves next, folds them into ONE `waitingOn` state per PR, and flags
 * the ones nobody is going to move.
 *
 * SIGNALS FOLDED (first match wins, operator-owned holds first because a live job cannot clear them):
 *   1. an OPEN referral hold         — latest `review-referral-hold` / `review paused:` comment with no later operator
 *                                      comment, push or fix re-arm (`referralHoldOpen`)
 *   2. a red-team round-cap record   — `we:red-team-gate … outcome=round-cap` with unresolved findings
 *                                      (`redTeamRulingNeeded`, the same reader operator-queue uses)
 *   3. a ruling dispute / needs-you  — a "conveyor — needs your decision" note with no later operator comment or push
 *   4. labels `status:at-round-limit`, `status:needs-you`
 *   5. a draft-withdrawn hold        — draft + `review-status:draft-withdrawn`
 *   6. a red-team send-back record on the live head nobody is fixing
 *   7. fix / CI / review / red-team labels, the drain's latest `merge-ai-prs · skip-reasons`, the merge queue
 *   LIVE JOBS: `ps` review-job / review-extra-seats / fix-run processes naming the PR, and an open fix claim comment.
 *
 * STALLED = the waiting actor is `operator` or `nobody`, OR the same state has lasted longer than the threshold
 * (setting `prSweep.stalledAfterMinutes`, standard 45) with no live job for the PR. Every stalled row carries the
 * exact next action. PURE: no fs, no clock, no network, no process in this file (`pr-sweep-io.mjs` has them all).
 */
import { isOperatorAuthored, isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';
import { openReferralFindings } from './record-referral-ruling.mjs';
import { referralCardReadable } from '../lib/referral-card-readable.mjs';
import { PR_SWEEP_OP, STALLED_AFTER_MINUTES_DEFAULT } from './pr-sweep.mjs';
import { CONFIRMED_BREAKS_DEFAULTS, gateOutcomesForHead, redTeamRulingNeeded, GATE_OUTCOMES } from '../lib/red-team-gate.mjs';

export { PR_SWEEP_OP, STALLED_AFTER_MINUTES_DEFAULT };
/** A fix claim comment with no later release counts as a live fixer for this long. */
export const FIX_CLAIM_LIVE_MS = 3 * 60 * 60_000;
export const ACTORS = Object.freeze(['fixer', 'reviewer', 'red-team', 'drain', 'ci', 'operator', 'nobody', 'system']);

const REFERRAL_HOLD_MARKER = 'review-referral-hold';
const HOLD_LEAD = /^\s*review paused:/i;
const NEEDS_DECISION_RE = /conveyor\s+—\s+needs your decision/i;
const FIX_BEGIN_RE = /conveyor fix-begin\s+—\s+fix claim held/i;
const FIX_END_RE = /conveyor fix-end\s+—\s+fix claim released/i;
const REARM_RE = /conveyor fix\s+—\s+re-armed for re-review/i;
const ENQUEUE_RE = /we-drain-enqueue-clearance/;

const t = (v) => { const n = Date.parse(v ?? ''); return Number.isFinite(n) ? n : null; };
const mx = (...v) => { const n = v.filter((x) => Number.isFinite(x)); return n.length ? Math.max(...n) : null; };
const labelNames = (pr) => (Array.isArray(pr?.labels) ? pr.labels : []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);
const bodyOf = (c) => String(c?.body ?? '');
const sorted = (comments) => (Array.isArray(comments) ? comments : [])
  .map((c, i) => ({ c, i, at: t(c?.createdAt ?? c?.created_at) }))
  .sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || a.i - b.i);

// Only automation or the operator can open or close a hold: an outsider's comment must never suppress a stall nor
// manufacture an operator item (same rule as every other marker reader, `isTrustedMarkerAuthor`).
const trusted = (e) => isTrustedMarkerAuthor(e.c);
/** A trusted comment that ends a pause: an operator reply, a send-back, an operator ruling record, a fix re-arm,
 * or an accept / human-clearance record. */
const CLOSERS = [REARM_RE, /^\s*🔁 review — changes requested/, /^\s*## Operator ruling/, /^\s*✅ review — /];
const closesHold = (e) => isOperatorAuthored(e.c) || (trusted(e) && CLOSERS.some((re) => re.test(bodyOf(e.c))));

/**
 * Is the review paused on referrals that still need a ruling? Open = the newest TRUSTED hold comment has no later
 * closer (operator comment, send-back, ruling record, fix re-arm, accept) and no later push to the head. The
 * `review:accepted` LABEL alone never closes it: only a dated record after the hold does. Returns the hold
 * (`{at, count, text}`) or null. PURE.
 * @param {Array} comments
 * @param {{headCommittedAt?: (string|null)}} [o]
 */
export function referralHoldOpen(comments, { headCommittedAt = null } = {}) {
  const list = sorted(comments);
  let hold = null;
  for (const e of list) {
    if (!isTrustedMarkerAuthor(e.c)) continue;
    const body = bodyOf(e.c);
    if (body.includes(`<!-- ${REFERRAL_HOLD_MARKER}`) || HOLD_LEAD.test(body)) hold = e;
  }
  if (!hold || hold.at === null) return null;
  if (!/need a ruling|waiting on your ruling|referral/i.test(bodyOf(hold.c))) return null;
  const pushed = t(headCommittedAt);
  if (pushed !== null && pushed > hold.at) return null;
  for (const e of list) {
    if (e === hold || e.at === null || e.at <= hold.at) continue;
    if (closesHold(e)) return null;
  }
  const n = /(\d+)\s+referrals?\s+need/i.exec(bodyOf(hold.c));
  return { at: hold.at, count: n ? Number(n[1]) : null, text: bodyOf(hold.c).split('\n')[0].trim(), body: bodyOf(hold.c) };
}

// A failed save is recognised only in the shapes the reviewer itself writes: the hold comment's own words, or the
// reviewer's "parked" / advisory notice. A trusted comment that merely MENTIONS a ledger miss (another PR, telemetry)
// must never excuse the operator.
const PERSISTENCE_FAILED_RE = /referral persistence failed|referral-persistence-failed/i;
const PARKED_FAILURE_RE = /^\s*Mandatory referral review parked to review:human: mandatory ruling ledger-write-miss/i;
const failureComment = (body) => PERSISTENCE_FAILED_RE.test(body) || PARKED_FAILURE_RE.test(body);
const holdCount = (hold) => hold.count ?? ((hold.body.match(/^\s*- `/gm) ?? []).length || null);

/**
 * EVIDENCE BEHIND AN OPEN REFERRAL HOLD. A hold comment says "N referrals need a ruling", but that count can be stale:
 * every finding on the live head may already have a standing ruling while the reviewer's referral save failed (live
 * #5530). Counts the findings actually OPEN on the live head with the SAME reader `record-referral-ruling`'s plan uses
 * (`openReferralFindings`), and whether a trusted comment at or after the hold reports a failed save. PURE.
 * @returns {{open: Array<{key:string,file:string,line:(number|null)}>, ruled: number, persistenceFailed: boolean, unreadable: (string|null)}}
 */
export function holdEvidence(pr, hold, { cardReadable = (ref) => referralCardReadable(ref) } = {}) {
  const persistenceFailed = PERSISTENCE_FAILED_RE.test(hold.body ?? '')
    || sorted(pr.comments).some((e) => e.at !== null && e.at >= hold.at && trusted(e) && failureComment(bodyOf(e.c)));
  try {
    const r = openReferralFindings({ comments: pr.comments ?? [], repo: pr.repo, pr: pr.number, head: String(pr.headRefOid ?? '').toLowerCase(),
      body: pr.body ?? '', createdAt: pr.createdAt ?? '', cardReadable });
    return { open: r.open.map((f) => ({ key: f.key, file: f.file, line: f.line })), ruled: r.ruled.length, persistenceFailed,
      unreadable: r.malformed || r.protectionMalformed || (r.pending ?? []).includes('malformed-operator-ruling')
        ? 'the referral thread is malformed' : null };
  } catch (e) {
    return { open: [], ruled: 0, persistenceFailed, unreadable: String(e?.message ?? e).split('\n')[0] };
  }
}

/**
 * An unanswered "needs your decision" escalation note (trusted author): no later operator comment, no later push.
 * `dispute` is true only for the fixer/reviewer ruling disagreement; other notes (permission block, exhausted
 * repairs, infrastructure) share the headline and need a different answer. PURE.
 */
export function needsDecisionOpen(comments, { headCommittedAt = null } = {}) {
  const list = sorted(comments);
  let note = null;
  for (const e of list) if (trusted(e) && NEEDS_DECISION_RE.test(bodyOf(e.c))) note = e;
  if (!note || note.at === null) return null;
  const pushed = t(headCommittedAt);
  if (pushed !== null && pushed > note.at) return null;
  for (const e of list) if (e.at !== null && e.at > note.at && isOperatorAuthored(e.c)) return null;
  const body = bodyOf(note.c);
  return { at: note.at, dispute: /disagree about a ruling|operator ruled .* came back/i.test(body),
    text: body.split('\n').filter(Boolean).slice(1, 3).join(' ').slice(0, 200) };
}

/** An open fix claim (trusted begin with no later release) younger than {@link FIX_CLAIM_LIVE_MS}. PURE. */
export function openFixClaim(comments, now) {
  let begin = null; let end = null;
  for (const e of sorted(comments)) {
    if (!trusted(e)) continue;
    if (FIX_BEGIN_RE.test(bodyOf(e.c))) begin = e;
    else if (FIX_END_RE.test(bodyOf(e.c))) end = e;
  }
  if (!begin || begin.at === null) return null;
  if (end && end.at !== null && end.at >= begin.at) return null;
  return now - begin.at <= FIX_CLAIM_LIVE_MS ? { at: begin.at } : null;
}

const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
/** The exact next-action commands, one place. */
export function nextActions(pr) {
  const r = pr.repo; const n = pr.number;
  const label = `node scripts/review-set-label.mjs ${n} --repo=${r}`;
  return {
    referralRuling: { summary: 'rule on each referral (block / card / not-real); a block sends it back',
      command: `node scripts/operations/run.mjs record-referral-ruling --pr=${n} --repo=${r} --finding=all-open --ruling=<block|not-real> --actor=<your login> --channel=<where you ruled> --reason=${sh('<your words>')}   # for a card ruling use --ruling=card --card=<card id> (a card is required)` },
    redTeamRuling: { summary: 'rule on the red-team round-cap findings: send back (block) or clear (not-real)',
      command: `${label} --to=changes --body-file=<fix-list.md> --actor=<your login> --channel=<where you ruled>   # or: ${label} --to=clear-human --actor=<your login> --reason=${sh('<your words>')}` },
    roundLimit: { summary: 'grant more review rounds, or rule',
      command: `node scripts/operations/run.mjs extend-rounds --pr=${n} --repo=${r} --by=2 --actor=<your login> --channel=<where> --reason=${sh('<your words>')}` },
    answerNote: { summary: 'read the escalation note and answer it on the PR',
      command: `gh pr view ${n} --repo ${r} --comments` },
    humanReview: { summary: 'human review: accept or send back', command: `/review ${n}   # repo ${r}` },
    sendBack: { summary: 'send it back to the fixer (the break is unfixed and no fixer owns it)',
      command: `${label} --to=changes --body-file=<fix-list.md> --actor=<your login> --channel=<where you ruled>` },
    release: { summary: 'release the draft-withdrawn hold (re-open for review) or close the PR',
      command: `gh pr ready ${n} --repo ${r} && gh pr edit ${n} --repo ${r} --remove-label review-status:draft-withdrawn   # or: gh pr close ${n} --repo ${r}` },
    rerunReview: { summary: 'start the review / red-team job that nobody is running',
      command: `node scripts/operations/review-job.mjs run --pr=${n} --repo=${r}` },
    why: { summary: 'nothing is running it: find the dispatch hold, then fix the tooling (file a card), not the PR by hand',
      command: `node scripts/operations/run.mjs why --pr=${n} --repo=${r}` },
  };
}

const DRAIN_SKIP_ACTOR = Object.freeze({
  'red-team-pending': 'red-team', 'not-certified': 'operator', 'queue-file-overlap': 'drain', 'overlap-yield': 'drain',
  'ready-not-reached': 'drain',
});

// `review-gate` is the review's own mirror, not CI (operator-queue drops it too).
const realChecks = (pr) => (Array.isArray(pr?.statusCheckRollup) ? pr.statusCheckRollup : [])
  .filter((c) => (c?.name ?? c?.context) !== 'review-gate');
const failingChecks = (pr) => realChecks(pr)
  .some((c) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED'].includes(String(c?.conclusion ?? c?.state ?? '').toUpperCase()));
const runningChecks = (pr) => realChecks(pr)
  .some((c) => ['IN_PROGRESS', 'QUEUED', 'PENDING'].includes(String(c?.status ?? c?.state ?? '').toUpperCase()) && !c?.conclusion);

/**
 * Derive ONE waiting state for one PR. PURE.
 * @param {object} pr  {repo, number, title, isDraft, headRefOid, headCommittedAt, updatedAt, labels, comments, statusCheckRollup}
 * @param {{now:number, drainSkips?:Array, liveJobs?:Array}} ctx
 * @returns {{state:string, actor:string, since:number|null, approxSince:boolean, why:string, evidence:string[], next:(object|null)}}
 */
export function deriveWaitingOn(pr, ctx) {
  const { now, drainSkips = [], liveJobs = [] } = ctx;
  const labels = labelNames(pr);
  const has = (l) => labels.includes(l);
  const actions = nextActions(pr);
  const head = pr.headRefOid;
  const pushedAt = pr.headCommittedAt ?? null;
  // WHEN THE STATE BEGAN. A PR's `updatedAt` moves on every comment or label, so a bookkeeping comment would reset the
  // stall clock for good. The real start is the newest `labeled` event of a label that is still on the PR (read by the
  // io shell from the issue events) and, for automation-owned states, the head push. Only when neither is known is
  // `updatedAt` used, and the row says so (`approxSince`).
  const present = new Set(labels);
  const labelAt = (...names) => mx(...(pr.labelEvents ?? []).filter((e) => names.includes(e.label) && present.has(e.label)).map((e) => t(e.at)));
  // A push only counts once the label time is known: an old push would otherwise overstate how long the state has lasted.
  const moved = (...names) => { const l = labelAt(...names); return l === null ? null : mx(l, t(pushedAt)); };
  const done = (state, actor, rawSince, why, next, evidence = []) => {
    const since = typeof rawSince === 'string' ? t(rawSince) : rawSince;
    return { state, actor, since: since ?? t(pr.updatedAt), approxSince: since === null || since === undefined, why, next, evidence };
  };

  const hold = referralHoldOpen(pr.comments, { headCommittedAt: pushedAt });
  if (hold) {
    const ev = holdEvidence(pr, hold, ctx.holdOptions);
    const keys = ev.open.map((f) => `${f.file}${f.line ? `:${f.line}` : ''}`);
    const NO_ASK = { summary: 'no operator action: resumes on the next successful review save; the fix is the reviewer\'s outbox', command: null };
    // An unreadable thread is never excused: the operator is asked, as before.
    if (!ev.unreadable && ev.persistenceFailed) return done('system:ledger-write-miss', 'system', hold.at,
      `the review is paused but the reviewer's referral save failed (ledger-write-miss); ${ev.open.length} finding(s) open on the live head${keys.length ? ` (${keys.join(', ')})` : ''}`,
      NO_ASK, ['review-referral-hold comment', 'referral persistence failed']);
    // STALE needs PROOF: the hold names N referrals, none is open, and at least N findings carry a standing ruling. A
    // thread with no (or fewer) saved records proves nothing: a failed save leaves exactly that (live #5485), and an
    // older ruled run must not hide newer unsaved referrals. An unknown N is never proof.
    const named = holdCount(hold);
    if (!ev.unreadable && ev.open.length === 0 && named !== null && ev.ruled >= named) return done('system:stale-hold', 'system', hold.at,
      'the hold is stale: every finding on the live head already has a standing ruling', NO_ASK, ['review-referral-hold comment', '0 open findings']);
    return done('ruling-needed:referral-hold', 'operator', hold.at,
      `review paused: ${ev.open.length || hold.count || 'some'} open referral(s) need an operator ruling${keys.length ? ` [${keys.join(', ')}]` : ''}${ev.unreadable ? ` (evidence unreadable: ${ev.unreadable})` : ''} (${hold.text})`,
      actions.referralRuling, ['review-referral-hold comment', ...(keys.length ? [`open: ${keys.join(', ')}`] : [])]);
  }

  const rt = redTeamRulingNeeded({ ...pr, number: pr.number }, CONFIRMED_BREAKS_DEFAULTS, { repo: pr.repo });
  if (rt) return done('ruling-needed:red-team-round-cap', 'operator', rt.since ?? null,
    `red team round cap reached with ${rt.findings.length} unresolved finding(s)`, actions.redTeamRuling, ['we:red-team-gate outcome=round-cap']);

  const decision = needsDecisionOpen(pr.comments, { headCommittedAt: pushedAt });
  if (decision) return done(decision.dispute ? 'ruling-needed:dispute' : 'needs-decision:note', 'operator', decision.at,
    decision.dispute ? `fixer and reviewer disagree; a person must decide (${decision.text})` : `an escalation note awaits your answer (${decision.text})`,
    decision.dispute ? actions.referralRuling : actions.answerNote, ['needs-your-decision note']);

  if (has('status:at-round-limit')) return done('at-round-limit', 'operator', labelAt('status:at-round-limit'), 'review round limit reached', actions.roundLimit, ['label status:at-round-limit']);

  const draftWithdrawn = has('review-status:draft-withdrawn');
  if (pr.isDraft && draftWithdrawn) return done('draft-withdrawn', 'operator', labelAt('review-status:draft-withdrawn'),
    'the PR was withdrawn to draft after its card batch gave up; only a person releases it', actions.release, ['label review-status:draft-withdrawn']);

  if (has('status:needs-you')) return done('needs-you', 'operator', labelAt('status:needs-you'), 'the PR carries status:needs-you', actions.humanReview, ['label status:needs-you']);

  const outcomes = head ? gateOutcomesForHead(pr.comments, pr.number, head) : new Set();
  const sentBack = outcomes.has(GATE_OUTCOMES.SENT_BACK);
  const fixing = has('review:changes') || has('status:fixing') || has('review-status:fixing') || has('status:sent-back-red-team');
  const claim = openFixClaim(pr.comments, now);
  if (sentBack && !fixing && !claim && (has('ready-to-merge') || has('review:accepted') || has('review:human'))) {
    return done('red-team-sent-back-cleared', 'nobody', labelAt('ready-to-merge', 'review:accepted', 'review:human'),
      'a confirmed red-team break was sent back, but the review label was cleared, so no fixer owns it', actions.sendBack, ['we:red-team-gate outcome=sent-back']);
  }

  // A draft with no hold label is a PR its author is still building or repairing: the fixer owns it, and it is only
  // flagged once it has sat past the threshold with no live job.
  if (pr.isDraft) return done('draft', 'fixer', claim?.at ?? null,
    claim ? 'draft while a fix claim is held' : 'draft with no hold label; its author is still working', actions.why, ['draft']);

  if (fixing) return done(has('status:sent-back-red-team') ? 'sent-back-red-team' : 'fixing', 'fixer', mx(claim?.at, moved('review:changes', 'status:fixing', 'review-status:fixing', 'status:sent-back-red-team')),
    'a fixer owns the next move', actions.why, [labels.find((l) => /fixing|changes|sent-back/.test(l))].filter(Boolean));

  if (has('ci:failed') || failingChecks(pr)) return done('ci-failed', 'fixer', moved('ci:failed'), 'CI failed; the CI-heal fixer owns it', actions.why, ['failing check']);
  if (has('status:awaiting-ci') || has('checking') || runningChecks(pr)) {
    return done('awaiting-ci', 'ci', moved('status:awaiting-ci', 'checking'), 'checks are running', actions.why, ['checks running']);
  }

  const skip = drainSkips.find((s) => s.num === pr.number && (!s.repo || s.repo === pr.repo));
  if (has('red-team:pending') || skip?.kind === 'red-team-pending') {
    return done('red-team-pending', 'red-team', moved('red-team:pending', 'ready-to-merge', 'review:accepted'), `post-accept red team has no result on this head${skip ? ` (drain: ${skip.reason})` : ''}`,
      actions.rerunReview, [has('red-team:pending') ? 'label red-team:pending' : null, skip ? 'drain skip red-team-pending' : null].filter(Boolean));
  }
  if (has('review:human') && has('advisory:accepted')) return done('human-review', 'operator', labelAt('advisory:accepted', 'review:human'),
    'advisory review accepted; the human review is owed', actions.humanReview, ['labels review:human + advisory:accepted']);
  if (has('review:human')) return done('human-review-pending-advisory', 'reviewer', moved('review:human'), 'review:human with no accepted advisory yet', actions.rerunReview, ['label review:human']);
  if (has('review:pending') || has('status:awaiting-review') || has('review-status:reviewing')) {
    return done('awaiting-review', 'reviewer', moved('review:pending', 'status:awaiting-review', 'review-status:reviewing'), 'an independent review is owed', actions.rerunReview, ['review label']);
  }

  const enqueued = sorted(pr.comments).filter((e) => ENQUEUE_RE.test(bodyOf(e.c)) && bodyOf(e.c).includes(head ?? '\0')).pop();
  if (has('ready-to-merge') || has('review:accepted')) {
    if (skip) {
      const actor = DRAIN_SKIP_ACTOR[skip.kind] ?? 'drain';
      return done(`drain-skip:${skip.kind}`, actor, moved('ready-to-merge', 'review:accepted'), `the drain skipped it: ${skip.reason}`,
        actor === 'red-team' ? actions.rerunReview : actions.why, ['merge-ai-prs skip-reasons']);
    }
    if (enqueued) return done('in-merge-queue', 'drain', enqueued.at, 'enqueued on the merge queue', null, ['we-drain-enqueue-clearance']);
    return done('ready-to-merge', 'drain', moved('ready-to-merge', 'review:accepted'), 'ready; the drain has not merged it yet', null, ['label ready-to-merge']);
  }
  return done('unclassified', 'nobody', null, 'no signal says who moves next', actions.why, []);
}

/** The live jobs that cover this PR: ps processes naming it, plus an open fix claim. PURE. */
export function jobsFor(pr, liveJobs, now) {
  const mine = (liveJobs ?? []).filter((j) => Number(j.pr) === pr.number && (!j.repo || j.repo === pr.repo));
  const claim = openFixClaim(pr.comments, now);
  return claim ? [...mine, { kind: 'fix', source: 'fix-claim comment', pr: pr.number }] : mine;
}

/**
 * Assess every PR. A row is STALLED when the actor is operator/nobody, or the state is older than the threshold
 * with no live job (a running CI check counts as live for `ci`). PURE.
 */
export function assessPrSweep(read) {
  if (!read || !Array.isArray(read.prs)) throw new TypeError('pr-sweep: unreadable PR list is not an empty sweep');
  const now = Number(read.now);
  const thresholdMinutes = Number.isFinite(read.stalledAfterMinutes) && read.stalledAfterMinutes > 0
    ? read.stalledAfterMinutes : STALLED_AFTER_MINUTES_DEFAULT;
  const rows = read.prs.map((pr) => {
    const d = deriveWaitingOn(pr, { now, drainSkips: read.drainSkips ?? [], liveJobs: read.liveJobs ?? [], holdOptions: read.holdOptions });
    const jobs = jobsFor(pr, read.liveJobs, now);
    const live = jobs.length > 0 || (d.state === 'awaiting-ci' && runningChecks(pr));
    const ageMinutes = d.since === null ? null : Math.max(0, Math.round((now - d.since) / 60_000));
    let stalledReason = null;
    if (d.actor === 'operator') stalledReason = 'waiting on the operator';
    else if (d.actor === 'nobody') stalledReason = 'nobody owns the next move';
    else if (!live && ageMinutes !== null && ageMinutes > thresholdMinutes) {
      stalledReason = `waiting on ${d.actor} for ${ageMinutes} min (> ${thresholdMinutes}) with no live job`;
    }
    return {
      repo: pr.repo, number: pr.number, title: pr.title ?? '', url: pr.url ?? `https://github.com/${pr.repo}/pull/${pr.number}`,
      waitingOn: d.state, actor: d.actor,
      since: d.since === null ? null : new Date(d.since).toISOString(), approxSince: d.approxSince, ageMinutes,
      liveJob: live ? (jobs[0]?.kind ?? 'checks') : null, why: d.why, evidence: d.evidence,
      stalled: stalledReason !== null, stalledReason,
      next: stalledReason ? (d.next ?? nextActions(pr).why) : null,
    };
  }).sort((a, b) => Number(b.stalled) - Number(a.stalled) || (b.ageMinutes ?? -1) - (a.ageMinutes ?? -1) || a.number - b.number);
  return {
    generatedAt: new Date(now).toISOString(), stalledAfterMinutes: thresholdMinutes,
    repos: read.repos ?? [], total: rows.length, stalledCount: rows.filter((r) => r.stalled).length,
    unreadable: read.unreadable ?? [], prs: rows,
  };
}

const age = (m) => (m === null ? '?' : m >= 120 ? `${Math.round(m / 60)}h` : `${m}m`);
/** The human table. PURE. */
export function renderSweepTable(report) {
  const out = [`pr-sweep: ${report.total} open PR(s), ${report.stalledCount} STALLED (threshold ${report.stalledAfterMinutes} min)`, ''];
  const pad = (s, n) => String(s).padEnd(n).slice(0, Math.max(n, String(s).length));
  out.push(`${pad('PR', 36)} ${pad('WAITING ON', 34)} ${pad('ACTOR', 9)} ${pad('AGE', 6)} ${pad('LIVE', 8)} STALLED`);
  for (const r of report.prs) {
    out.push(`${pad(`${r.repo.split('/').pop()}#${r.number}`, 36)} ${pad(r.waitingOn, 34)} ${pad(r.actor, 9)} ${pad(`${r.approxSince ? '~' : ''}${age(r.ageMinutes)}`, 6)} ${pad(r.liveJob ?? '-', 8)} ${r.stalled ? 'STALLED' : ''}`);
  }
  const stalled = report.prs.filter((r) => r.stalled);
  if (stalled.length) {
    out.push('', 'STALLED — next action:');
    for (const r of stalled) {
      out.push(`  ${r.repo}#${r.number}  ${r.title.slice(0, 70)}`, `    why:  ${r.stalledReason}; ${r.why}`, `    next: ${r.next.summary}`, `    run:  ${r.next.command ?? '(none)'}`);
    }
  }
  if (report.unreadable.length) out.push('', `UNREADABLE (not swept): ${report.unreadable.join('; ')}`);
  return out;
}

/** The `finish` hook: plain mode prints the table; `--json` prints the report alone (not the whole run record, which
 * carries every PR's full comment thread). */
export function finishPrSweep({ run, code, lines, json = false } = {}) {
  if (!run?.verdict?.prs) return { code, lines };
  return { code, lines: json ? [JSON.stringify(run.verdict, null, 2)] : renderSweepTable(run.verdict) };
}
