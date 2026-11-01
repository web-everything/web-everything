/** Reconcile derived labels from stored, live-head evidence. No evidence is never a clearance. */
import { planRedTeamStatusLabels, RED_TEAM_STATUS_LABEL_META } from '../lib/red-team-status-labels.mjs';
import { readRedTeamDisposition, redTeamResultId } from '../lib/red-team-gate.mjs';
import { readRedTeamStatus } from '../lib/drain-red-team-evidence.mjs';
import { createGhProvider } from '../lib/review-label-provider.mjs';
import { appendDaemonEvent } from '../lib/daemon-events.mjs';
import { liveReferralState } from '../lib/referral-live-context.mjs';
import { readRun } from '../operations/run-store.mjs';
import { readReviewRunEvidence, reviewRunEvidence } from './review-referral-hold.mjs';
import { defaultReadPr } from './advisory-label-sweep.mjs';
import { readCompletePrComments } from './pr-comments-complete.mjs';

const names = labels => labels.map(l => typeof l === 'string' ? l : l.name);

/** Pure: all inputs are observations; only exact SHA equality permits a stored result to decide. */
export function planLabelStateReconcile({ repo, pr, review = null, redTeam = null } = {}) {
  const from = names(pr.labels), after = new Set(from), evidence = {};
  const head = pr.headRefOid;
  if (!/^[a-f0-9]{40}$/.test(head ?? '') || !Array.isArray(pr.comments)) return null;
  const disposition = readRedTeamDisposition({ repo, pr: pr.number, head, comments: pr.comments, env: {} });
  const result = disposition.result?.rev === head ? disposition.result : null;
  const status = redTeam?.repo === repo && Number(redTeam.pr) === pr.number && redTeam.head === head
    && redTeam.status === 'finished' && ['accept', 'changes'].includes(redTeam.result?.foldedVerdict) ? redTeam : null;
  let redBlocked = false, reviewBlocked = false;
  if (result || status) {
    const plan = status?.result.foldedVerdict === 'changes'
      ? { add: 'red-team:blocked', remove: ['red-team:clear', 'red-team:pending'] }
      : planRedTeamStatusLabels({ repo, pr: pr.number, head, labels: from, comments: pr.comments,
        env: {}, evidence: status ? { status } : {} });
    if (plan.add) after.add(plan.add);
    for (const label of plan.remove) after.delete(label);
    redBlocked = after.has('red-team:blocked');
    evidence.redTeam = { id: result ? redTeamResultId(result) : status.loopPayload?.id ?? null, sha: head };
  }
  const observed = reviewRunEvidence(review);
  if (observed?.repo === repo && observed.pr === pr.number && observed.head === head
    && Number.isFinite(observed.completedAt) && !observed.incomplete
    && observed.parked === false && observed.persistenceFailed === false) {
    const verdict = review.findings?.referralVerdict ?? review.verdict;
    const referrals = liveReferralState(pr, { repo, pr: pr.number });
    const settled = !referrals.malformed && !referrals.pending.length && !referrals.blocked.length
      && Array.isArray(verdict?.pendingReferrals) && !verdict.pendingReferrals.length
      && Array.isArray(verdict?.blockedReferrals) && !verdict.blockedReferrals.length;
    if (verdict?.verdict === 'accept' && settled && !after.has('red-team:blocked')) {
      after.delete('review:changes');
      for (const label of after) if (label.startsWith('fix-waiting:')) after.delete(label);
    }
    reviewBlocked = referrals.pending.length > 0 || referrals.blocked.length > 0 || verdict?.verdict === 'changes'
      || verdict?.pendingReferrals?.length > 0 || verdict?.blockedReferrals?.length > 0;
    evidence.review = { id: observed.id, sha: head };
  }
  if ((redBlocked && after.has('red-team:blocked')) || (reviewBlocked && after.has('review:changes'))) after.delete('ready-to-merge');
  const to = [...after];
  const add = to.filter(l => !from.includes(l)), remove = from.filter(l => !after.has(l));
  return add.length || remove.length ? { from, to, add, remove, evidence } : null;
}

/** IO shell: one live metadata/thread read per candidate; read failures leave labels untouched for the next pass. */
export function sweepLabelStateReconcile({ prs = [], repo, resolveRepo = () => repo, dryRun = false,
  provider = createGhProvider(), readPr = defaultReadPr, readComments = readCompletePrComments,
  readReviews = readReviewRunEvidence, readReview = readRun, readRedTeam = readRedTeamStatus,
  emit = appendDaemonEvent } = {}) {
  const results = [];
  let reviews;
  for (const candidate of prs) {
    if (!names(candidate.labels ?? []).some(l => ['red-team:blocked', 'red-team:pending', 'review:changes'].includes(l)
      || l.startsWith('fix-waiting:'))) continue;
    try {
      const slug = repo ?? resolveRepo();
      if (!slug) throw Error('missing repository');
      const pr = readPr({ repo: slug, number: candidate.number, fields: 'number,state,headRefOid,labels,body,createdAt' });
      if (pr?.state !== 'OPEN' || pr.number !== candidate.number || !Array.isArray(pr.labels)) continue;
      pr.comments = readComments(pr.number, { repo: slug });
      let review = null, redTeam = null;
      // Independent evidence planes: an unavailable run store cannot invalidate a recorded red-team result.
      try {
        reviews ??= readReviews();
        const latest = reviews.filter(r => r.repo === slug && r.pr === pr.number)
          .sort((a, b) => b.startedAt - a.startedAt)[0];
        if (latest?.head === pr.headRefOid) review = readReview(latest.id);
      } catch { /* unknown review state never clears its labels */ }
      try { redTeam = readRedTeam({ repo: slug, pr: pr.number, head: pr.headRefOid }); } catch { /* retain unknown state */ }
      const plan = planLabelStateReconcile({ repo: slug, pr, review, redTeam });
      if (!plan) continue;
      // Evidence reads can span a push. Never apply the old head's clearance to the new head.
      const fresh = readPr({ repo: slug, number: pr.number, fields: 'number,state,headRefOid' });
      if (fresh?.number !== pr.number || fresh.state !== 'OPEN' || fresh.headRefOid !== pr.headRefOid) continue;
      if (!dryRun) {
        for (const label of plan.add) provider.ensureLabel(slug, label, RED_TEAM_STATUS_LABEL_META[label]);
        provider.setLabels(slug, pr.number, { add: plan.add.join(',') || null, remove: plan.remove });
        void emit({ kind: 'labels-reconciled', repo: slug, pr: pr.number,
          detail: { pr: pr.number, from: plan.from, to: plan.to, evidence: plan.evidence } });
      }
      results.push({ num: pr.number, labelsReconciled: plan, dryRun });
    } catch (e) {
      results.push({ num: candidate.number, labelsReconciled: 'skipped', error: String(e?.message ?? e).split('\n')[0] });
    }
  }
  return results;
}
