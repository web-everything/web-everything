/** Reconcile derived labels from stored, live-head evidence. No evidence is never a clearance. */
import { planRedTeamStatusLabels, RED_TEAM_STATUS_LABEL_META } from '../lib/red-team-status-labels.mjs';
import { readRedTeamDisposition, redTeamResultId } from '../lib/red-team-gate.mjs';
import { buildRedTeamDispositionInputs } from '../lib/red-team-disposition-inputs.mjs';
import { readRedTeamStatus } from '../lib/drain-red-team-evidence.mjs';
import { createGhProvider } from '../lib/review-label-provider.mjs';
import { appendDaemonEvent } from '../lib/daemon-events.mjs';
import { liveReferralState } from '../lib/referral-live-context.mjs';
import { readRun } from '../operations/run-store.mjs';
import { REVIEW_EFFECTS } from '../operations/review-pr-constants.mjs';
import { readReviewRunEvidence, reviewRunEvidence } from './review-referral-hold.mjs';
import { defaultReadPr } from './advisory-label-sweep.mjs';
import { readCompletePrComments, readCompletePrCommentEditHistory } from './pr-comments-complete.mjs';
import { isLaterVerdictBody, laterReviewHold } from '../lib/accept-carry-forward.mjs';
import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';

const names = labels => labels.map(l => typeof l === 'string' ? l : l.name);

/** The shared body reader omits edit times. Join the complete edit metadata by node ID before trusting age. */
export function readLabelReconcileComments(number, options = {}) {
  const comments = readCompletePrComments(number, options);
  const edits = readCompletePrCommentEditHistory(number, options);
  const byId = new Map(edits.map(c => [c.id, c.lastEditedAt]));
  if (byId.size !== edits.length || byId.size !== comments.length || comments.some(c => !byId.has(c.id))) {
    throw Error('comment edit metadata does not cover the complete thread');
  }
  return comments.map(c => {
    const updatedAt = byId.get(c.id) ?? c.createdAt;
    if (!Number.isFinite(Date.parse(updatedAt))) throw Error('comment edit metadata has invalid timing');
    return { ...c, updatedAt };
  });
}

/**
 * Pure: all inputs are observations; only exact SHA equality permits a stored result to decide.
 * `reviews` is the PR's native GitHub reviews; anything but an array is unreadable and never clears a review hold.
 */
export function planLabelStateReconcile({ repo, pr, review = null, redTeam = null, reviews = null, env = process.env,
  standingRuling = null } = {}) {
  const from = names(pr.labels), after = new Set(from), evidence = {};
  const head = pr.headRefOid;
  if (!/^[a-f0-9]{40}$/.test(head ?? '') || !Array.isArray(pr.comments)) return null;
  const { statusLabels, ...inputs } = buildRedTeamDispositionInputs({ repo, pr: pr.number, head,
    comments: pr.comments, env, standingRuling });
  const disposition = readRedTeamDisposition(inputs);
  const result = disposition.result?.rev === head ? disposition.result : null;
  const status = redTeam?.repo === repo && Number(redTeam.pr) === pr.number && redTeam.head === head
    && redTeam.status === 'finished' && ['accept', 'changes'].includes(redTeam.result?.foldedVerdict) ? redTeam : null;
  let redBlocked = false, reviewBlocked = false;
  if (statusLabels && (result || status)) {
    // Live send-back/held dispositions include policy and operator rulings. A stored verdict
    // is only a fallback when no live result exists; it cannot undo a recorded release.
    const plan = planRedTeamStatusLabels({ ...inputs, labels: from, evidence: status ? { status } : {} });
    if (plan.add) after.add(plan.add);
    for (const label of plan.remove) after.delete(label);
    redBlocked = after.has('red-team:blocked');
    evidence.redTeam = { id: result ? redTeamResultId(result) : status.loopPayload?.id ?? null, sha: head };
  }
  const observed = reviewRunEvidence(review);
  if (observed?.repo === repo && observed.pr === pr.number && observed.head === head
    && Number.isFinite(observed.completedAt) && !observed.incomplete
    && observed.parked === false && observed.persistenceFailed === false
    && review.findings?.confirm !== 'abstain') {
    const verdict = review.findings?.referralVerdict ?? review.verdict;
    // Confirmation is the recorded operator decision; an accepted panel cannot supersede changes.
    const confirmedChanges = review.findings?.confirm === 'changes';
    // Only an affirmative recorded accept clears: an unanswered confirm may still end in abstain or changes.
    const confirmedAccept = review.findings?.confirm === 'accept';
    // Panel completion and confirmation precede the publication-time independence check. Only the
    // successful label-swap effect proves that check passed; failed/pending/staged/advisory runs cannot clear.
    const publishedAccept = review.findings?.record?.effects?.some(e =>
      e.type === REVIEW_EFFECTS.LABEL && e.status === 'applied') === true;
    // A completed panel cannot erase a trusted verdict/hold it never read: anything posted since the run read
    // the thread (startedAt), including while it was still running. Unknown or tied times cannot prove the
    // accept supersedes it; a newer completed accept can reconcile it next tick.
    const laterHold = pr.comments.some(c => {
      if (!isTrustedMarkerAuthor(c) || !isLaterVerdictBody(c?.body)) return false;
      const created = Date.parse(c.createdAt ?? c.created_at ?? '');
      const edited = Date.parse(c.updatedAt ?? c.updated_at ?? '');
      // Both times must be known: creation alone cannot date an objection edited into an old note.
      const at = Math.max(created, edited);
      return !Number.isFinite(at) || at >= observed.startedAt;
    }) || (Array.isArray(reviews) && laterReviewHold(reviews, new Date(observed.startedAt).toISOString()));
    const referrals = liveReferralState(pr, { repo, pr: pr.number });
    const settled = !referrals.malformed && !referrals.pending.length && !referrals.blocked.length
      && Array.isArray(verdict?.pendingReferrals) && !verdict.pendingReferrals.length
      && Array.isArray(verdict?.blockedReferrals) && !verdict.blockedReferrals.length;
    // Unreadable native reviews cannot prove no formal change request stands, so they never clear.
    if (confirmedAccept && publishedAccept && Array.isArray(reviews) && !laterHold && verdict?.verdict === 'accept' && settled && !after.has('red-team:blocked')) {
      after.delete('review:changes');
      for (const label of after) if (label.startsWith('fix-waiting:')) after.delete(label);
    }
    reviewBlocked = confirmedChanges || laterHold || referrals.pending.length > 0 || referrals.blocked.length > 0 || verdict?.verdict === 'changes'
      || verdict?.pendingReferrals?.length > 0 || verdict?.blockedReferrals?.length > 0;
    evidence.review = { id: observed.id, sha: head };
  }
  if ((redBlocked && after.has('red-team:blocked')) || (reviewBlocked && after.has('review:changes'))) after.delete('ready-to-merge');
  const to = [...after];
  const add = to.filter(l => !from.includes(l)), remove = from.filter(l => !after.has(l));
  return add.length || remove.length ? { from, to, add, remove, evidence } : null;
}

/** IO shell: re-read evidence and then the live head; read failures leave labels untouched for the next pass. */
export function sweepLabelStateReconcile({ prs = [], repo, resolveRepo = () => repo, dryRun = false, env = process.env,
  provider = createGhProvider(), readPr = defaultReadPr, readComments = readLabelReconcileComments,
  readReviews = readReviewRunEvidence, readReview = readRun, readRedTeam = readRedTeamStatus,
  readGrantScope, emit = appendDaemonEvent } = {}) {
  const results = [];
  let reviews;
  for (const candidate of prs) {
    if (!names(candidate.labels ?? []).some(l => ['red-team:blocked', 'red-team:pending', 'review:changes'].includes(l)
      || l.startsWith('fix-waiting:'))) continue;
    try {
      const slug = repo ?? resolveRepo();
      if (!slug) throw Error('missing repository');
      // Labels, thread and native reviews: everything a hold can arrive through. Unreadable reviews stay null.
      const readLive = () => {
        const live = readPr({ repo: slug, number: candidate.number, fields: 'number,state,headRefOid,labels,body,createdAt' });
        if (live?.state !== 'OPEN' || live.number !== candidate.number || !Array.isArray(live.labels)) return null;
        // Keep the reader's source intact so a later refresh can observe edits to its comments.
        const comments = readComments(live.number, { repo: slug });
        let native = null;
        try { native = provider.readPrReviews(slug, live.number); } catch { /* unreadable never clears */ }
        return { pr: { ...live, comments }, native };
      };
      const first = readLive();
      if (!first) continue;
      const { pr } = first;
      // Independent evidence planes: an unavailable run store cannot invalidate a recorded red-team result.
      // `uncached` re-reads the run index so a newer same-head run started mid-sweep is seen before a write.
      const readStored = (uncached = false) => {
        let review = null, redTeam = null;
        try {
          if (uncached || !reviews) reviews = readReviews();
          const latest = reviews.filter(r => r.repo === slug && r.pr === pr.number)
            .sort((a, b) => b.startedAt - a.startedAt)[0];
          if (latest?.head === pr.headRefOid) review = readReview(latest.id);
        } catch { /* unknown review state never clears its labels */ }
        try { redTeam = readRedTeam({ repo: slug, pr: pr.number, head: pr.headRefOid }); } catch { /* retain unknown state */ }
        return { review, redTeam };
      };
      const planLive = ({ pr: live, native }, stored) => {
        const inputs = buildRedTeamDispositionInputs({ repo: slug, pr: live.number, head: live.headRefOid,
          comments: live.comments, env, readGrantScope });
        // Enabled red-team reconciliation needs readable scope to preserve automation-owned rounds.
        if (inputs.statusLabels && inputs.scopeUnreadable) return null;
        return planLabelStateReconcile({ ...inputs, pr: live, ...stored, reviews: native });
      };
      const initialPlan = planLive(first, readStored());
      if (!initialPlan) continue;
      // Provision before refreshing evidence: provisioning can publish a same-head objection too.
      if (!dryRun) {
        for (const label of initialPlan.add) provider.ensureLabel(slug, label, RED_TEAM_STATUS_LABEL_META[label]);
      }
      // Evidence reads can span a push, a new verdict or a new run. Never apply the old head's clearance to the
      // new head, and re-plan from a final read of every plane so a hold that arrived meanwhile is honoured.
      // Read stores before the live refresh so objections arriving during store IO are included in the plan.
      const stored = readStored(true);
      const fresh = readLive();
      if (!fresh || fresh.pr.headRefOid !== pr.headRefOid) continue;
      const plan = planLive(fresh, stored);
      if (!plan) continue;
      if (!dryRun) {
        // A changed plan may need a different label. Retry next tick rather than provision after the refresh.
        if (plan.add.some(label => !initialPlan.add.includes(label))) continue;
        // Evidence reads may span a push. Keep this metadata-only read next to
        // the write: defaultReadPr's thread read must not open another evidence-read race afterward.
        const writeHead = readPr({ repo: slug, number: pr.number, fields: 'number,state,headRefOid',
          readComments: () => [] });
        if (writeHead?.state !== 'OPEN' || writeHead.number !== pr.number || writeHead.headRefOid !== pr.headRefOid) continue;
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
