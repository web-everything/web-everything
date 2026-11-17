/**
 * @file accepted-conflict-rebase.mjs — pure admission and net-change proof for accepted conflicts.
 * Completed repairs reuse the trusted conflict-fix marker and target counter. The actor receipt
 * records its original head and target; deduplication is per head. Live dispatches use the shared fix claim.
 * Missing evidence refuses admission; failed/oversized diff evidence owes independent review.
 */
import { countStaleConflictFixRounds, CONFLICT_FIX_COMMENT_MARKER } from './conflict-fix-round-count.mjs';
import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';
import { isStatutePath, isDeclarativeLeashPath } from '../lib/gate-config.mjs';
import { REVIEW_LABELS } from '../lib/review-labels.mjs';

const SHA = /^[0-9a-f]{40}$/i;
export const MAX_REBASE_DIFF_BYTES = 8 * 1024 * 1024;

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
  if (labels.some(l => [REVIEW_LABELS.pending, REVIEW_LABELS.changes, REVIEW_LABELS.human].includes(l)
      || /held|pending-with-bounce/.test(l))) return false;
  return !pr.isDraft && pr.baseRefName === defaultBranch
    && String(pr.state ?? 'OPEN').toUpperCase() === 'OPEN'
    && (String(pr.mergeStateStatus ?? '').toUpperCase() === 'DIRTY'
      || String(pr.mergeable ?? '').toUpperCase() === 'CONFLICTING')
    && labels.some(l => [REVIEW_LABELS.accepted, 'ready-to-merge', 'status:ready-to-merge'].includes(l));
}

/** Safe actor value for either existing hand-back CLI; no new marker or state store. */
export function conflictRebaseReceipt(head, target) {
  return SHA.test(head ?? '') && SHA.test(target ?? '')
    ? `accepted-conflict-rebase:${head.toLowerCase()}@${target.toLowerCase()}` : null;
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
  if (pr.comments.some(c => isTrustedMarkerAuthor(c) && typeof c?.body === 'string'
      && c.body.trimStart().startsWith(CONFLICT_FIX_COMMENT_MARKER)
      && c.body.split(/[\s;]+/).some(token => new RegExp(`^accepted-conflict-rebase:${pr.headRefOid.toLowerCase()}@[0-9a-f]{40}$`, 'i').test(token)))) return { kind: 'refuse', why: 'accepted conflict-rebase already completed for this head — refresh merge evidence or ask a person to inspect' };
  return { kind: 'fix', isConflict: true, mode: 'conflict-rebase', attempts, cap,
    conflictRebase: { oldHead: pr.headRefOid, mainSha, defaultBranch, receipt }, why };
}

/** Compare per-file contextual hunks, ignoring object IDs and line numbers only.
 * Context-free hunks cannot establish correspondence and require independent review. */
export function classifyRebaseTriviality(before, after) {
  const normalize = patch => {
    if (typeof patch !== 'string' || !patch.startsWith('diff --git ')
        || patch.length > MAX_REBASE_DIFF_BYTES || /GIT binary patch|Binary files .* differ/.test(patch)) return null;
    if (!patch.endsWith('\n')) return null;
    const out = [];
    let removed = 0, added = 0, files = 0, evidence = false, contextual = false;
    const complete = () => removed === 0 && added === 0;
    let inHunk = false, changed = false;
    const hunkComplete = () => complete() && (!inHunk || (contextual && changed));
    for (const line of patch.slice(0, -1).split('\n')) {
      if (line.startsWith('diff --git ')) {
        if (!hunkComplete() || (files && !evidence)) return null;
        files++; evidence = false; out.push(line);
      } else if (line.startsWith('index ')) {
        const index = /^index [0-9a-f]+\.\.[0-9a-f]+( [0-7]{6})?$/.exec(line);
        if (!index) return null;
        out.push('index' + (index[1] ?? ''));
      } else if (line.startsWith('@@ ')) {
        if (!hunkComplete()) return null;
        const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@.*$/.exec(line);
        if (!hunk) return null;
        removed = Number(hunk[1] ?? 1); added = Number(hunk[2] ?? 1);
        inHunk = true; contextual = false; changed = false;
        evidence = true; out.push(`@@ -${removed} +${added} @@`);
      } else if (removed || added) {
        if (line.startsWith('-')) { removed--; changed = true; }
        else if (line.startsWith('+')) { added--; changed = true; }
        else if (line.startsWith(' ')) { removed--; added--; contextual = true; }
        else return null;
        if (removed < 0 || added < 0) return null;
        out.push(line);
      } else if (/^(?:old mode|new mode|new file mode|deleted file mode) [0-7]{6}$/.test(line)) {
        evidence = true; out.push(line);
      } else if (/^(?:--- |\+\+\+ )/.test(line) || line === '\\ No newline at end of file') {
        out.push(line);
      } else return null;
    }
    return hunkComplete() && files && evidence ? out.join('\n') : null;
  };
  const a = normalize(before), b = normalize(after);
  const trivial = a !== null && b !== null && a === b;
  return { trivial, handback: trivial ? 'conflict-fix-mark' : 'rearm-review',
    why: trivial ? 'PR changes identical' : 'changed or incomplete diff evidence — independent review required' };
}
