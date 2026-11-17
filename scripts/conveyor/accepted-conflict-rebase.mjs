/**
 * @file accepted-conflict-rebase.mjs — pure admission for accepted conflicts.
 * Completed repairs reuse the trusted rearm-review conflict marker and target counter. The actor receipt
 * records the repaired head and target; deduplication is per head. Live dispatches use the shared fix claim.
 * Missing evidence refuses admission; every repair owes independent review.
 */
import { countStaleConflictFixRounds, CONFLICT_FIX_COMMENT_MARKER } from './conflict-fix-round-count.mjs';
import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';
import { isStatutePath, isDeclarativeLeashPath } from '../lib/gate-config.mjs';
import { REVIEW_LABELS, isConflictRebaseHoldLabel } from '../lib/review-labels.mjs';

const SHA = /^[0-9a-f]{40}$/i;

/** Whole-PR file evidence required before the watcher may hand ownership to reconcile.
 * Statute/leash paths and incomplete GraphQL file lists retain watcher ownership. */
export function hasReconcileConflictRebaseFiles(pr) {
  return Array.isArray(pr?.files) && pr.files.length < 100
    && pr.files.every(f => {
      const path = typeof f === 'string' ? f : f?.path;
      return typeof path === 'string' && path.length > 0
        && !isStatutePath(path) && !isDeclarativeLeashPath(path);
    });
}

/** Routing predicate shared with the watch. No missing/malformed labels count as approval. */
export function isAcceptedConflictRebase(pr, defaultBranch = 'main') {
  if (!Array.isArray(pr?.labels) || !pr.labels.length) return false;
  const labels = pr.labels.map(l => typeof l === 'string' ? l : l?.name);
  if (labels.some(l => typeof l !== 'string' || !l)) return false;
  if (labels.some(l => l === REVIEW_LABELS.pending || isConflictRebaseHoldLabel(l))) return false;
  return !pr.isDraft && pr.baseRefName === defaultBranch
    && String(pr.state ?? 'OPEN').toUpperCase() === 'OPEN'
    && (String(pr.mergeStateStatus ?? '').toUpperCase() === 'DIRTY'
      || String(pr.mergeable ?? '').toUpperCase() === 'CONFLICTING')
    && labels.some(l => [REVIEW_LABELS.accepted, 'ready-to-merge', 'status:ready-to-merge'].includes(l));
}

/** Safe actor value for rearm-review --round=conflict; no new marker or state store. */
export function conflictRebaseReceipt(head, target) {
  return SHA.test(head ?? '') && SHA.test(target ?? '')
    ? `accepted-conflict-rebase:${head.toLowerCase()}@${target.toLowerCase()}` : null;
}

/** Trusted producer receipts survive label changes and target movement; identity is the head. */
export function hasConflictRebaseReceipt(pr) {
  if (!SHA.test(pr?.headRefOid ?? '') || !Array.isArray(pr?.comments)) return false;
  return pr.comments.some(c => {
    if (!isTrustedMarkerAuthor(c) || typeof c?.body !== 'string') return false;
    const body = c.body.trimStart();
    const start = /^Conflict-rebase repair admitted by (accepted-conflict-rebase:[0-9a-f]{40}@[0-9a-f]{40}); approval is removed before repair\./i.exec(body);
    const completed = body.split('\n')[0] === CONFLICT_FIX_COMMENT_MARKER
      ? /^A mechanical conflict-resolution round \(no other edits\) was applied by (accepted-conflict-rebase:[0-9a-f]{40}@[0-9a-f]{40}); the PR is re-armed `review:pending` \(an independent re-review is owed\)\.$/im.exec(body)
        ?? /^Conflict-rebase repair completed by (accepted-conflict-rebase:[0-9a-f]{40}@[0-9a-f]{40}); independent review is owed\.$/im.exec(body)
      : null;
    return (start ?? completed)?.[1].split(':')[1].split('@')[0].toLowerCase() === pr.headRefOid.toLowerCase();
  });
}

/** Only this demoted episode is held; ordinary pending conflicts keep their existing route. */
export function isPendingConflictRebase(pr, defaultBranch = 'main') {
  const labels = Array.isArray(pr?.labels) ? pr.labels.map(l => typeof l === 'string' ? l : l?.name) : [];
  return SHA.test(pr?.headRefOid ?? '') && !pr?.isDraft && pr?.baseRefName === defaultBranch
    && String(pr?.state ?? 'OPEN').toUpperCase() === 'OPEN'
    && labels.includes(REVIEW_LABELS.pending)
    && (String(pr?.mergeStateStatus ?? '').toUpperCase() === 'DIRTY'
      || String(pr?.mergeable ?? '').toUpperCase() === 'CONFLICTING');
}

/** Plan after reconcile's stand-down/liveness/hold guards, using its effective conflict budgets. */
export function planAcceptedConflictRebase({ pr, defaultBranch = 'main', mainSha, cap, ceiling }) {
  if (!isAcceptedConflictRebase(pr, defaultBranch)) return null;
  const receipt = conflictRebaseReceipt(pr.headRefOid, mainSha);
  if (!receipt || !Array.isArray(pr.comments) || !Number.isInteger(cap) || !Number.isInteger(ceiling)
      || cap < 1 || ceiling < 1) return { kind: 'refuse', why: 'accepted conflict-rebase evidence incomplete — refresh head, target and comments before retrying' };
  if (pr.fixClaimUnknown) return { kind: 'refuse', why: 'accepted conflict-rebase claim evidence unknown — refresh the claim before retrying' };
  if (pr.fixClaim?.who || pr.referralHold) return { kind: 'refuse', why: 'accepted conflict-rebase has a live claim or referral hold' };
  const { stale: attempts, total } = countStaleConflictFixRounds(pr.comments, { currentRef: defaultBranch, currentSha: mainSha });
  const why = `accepted conflict against ${defaultBranch}; conflict-fix rounds ${attempts}/${cap}, total ${total}/${ceiling}`;
  if (attempts >= cap || total >= ceiling) return { kind: 'cap-exhausted', capKind: 'conflict-rebase', attempts, cap,
    why: `${why} — a person must take over` };
  if (hasConflictRebaseReceipt(pr)) return { kind: 'refuse', why: 'accepted conflict-rebase already completed for this head or admitted — refresh merge evidence or ask a person to inspect' };
  return { kind: 'fix', isConflict: true, mode: 'conflict-rebase', attempts, cap,
    conflictRebase: { oldHead: pr.headRefOid, mainSha, defaultBranch, receipt }, why };
}
