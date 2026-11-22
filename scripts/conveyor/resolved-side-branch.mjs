import { isAutomationAuthored, AUTOMATION_LOGINS } from '../lib/marker-authorship.mjs';
import { parseAltBranch, concurrentAuthorPauses, loadFlakeHolds, STAND_DOWN_MARKER } from './stand-down.mjs';
import { isReviewVerdictComment, reviewedHeadsOf, basisLineOf } from './mechanical-round-cap.mjs';
/** Bounded ancestry orders repairs; an exact automation-authored alt record authorizes the candidate.
 * `ancestors` is a complete, bounded rev-list from the IO shell, including the tip itself.
 * Null means no unambiguous proof, never permission to force or clear a merge hold.
 */
export const FULL_SHA = /^[a-f0-9]{40}(?![\s\S])/;
export const MAX_RESOLVED_BRANCHES = 16;
export const MAX_RESOLVED_ANCESTORS = 32768;
export function resolvedBranchName(name, number) {
  return Number.isSafeInteger(number) && number > 0 && typeof name === 'string'
    && new RegExp(`^lane/.+-fix-${number}-.+(?![\\s\\S])`).test(name)
    && /^[\w./-]+(?![\s\S])/.test(name)
    && !/\s/.test(name) && !/\.\.|\/\/|\.lock(?:\/|$)|\/$/.test(name);
}
export const laneHeadRef = ref => typeof ref === 'string' && /^lane\/[\w./-]+$/.test(ref) && !/\s/.test(ref)
  && !/\.\.|\/\/|\.lock(?:\/|$)|\/$/.test(ref);

/** The producer record, not a branch name or spoofable git author, authorizes promotion. */
export function isResolvedRepairAuthor(c) {
  const login = c?.author?.login ?? c?.user?.login;
  return typeof login === 'string' && AUTOMATION_LOGINS.includes(login.toLowerCase()) && isAutomationAuthored(c);
}
export function hasResolvedRepairRecord(pr, branch) {
  if (!Array.isArray(pr?.comments)) return false;
  return pr.comments.some(c => repairRecords(c).some(r => r?.branch === branch.name
    && r.sha === branch.sha && FULL_SHA.test(r.sha)));
}
function repairRecords(c) {
  if (!isResolvedRepairAuthor(c)) return [];
  if (!String(c.body ?? '').trimStart().startsWith(STAND_DOWN_MARKER)
    && !concurrentAuthorPauses([c]).length && !loadFlakeHolds([c]).length) return [];
  return [parseAltBranch(c.body), ...concurrentAuthorPauses([c]).map(r => r.alt),
    ...loadFlakeHolds([c]).map(r => r.alt)];
}

/** The existing full-SHA producer record is a durable review handoff once its repair becomes the PR head.
 * No live side ref or successful post-push write is needed. Only a later, trusted review of this EXACT
 * head consumes it; label changes, re-arms, other heads and abbreviated/quoted evidence grant nothing.
 */
export function pushedResolvedRepairReviewOwed(pr) {
  if (pr?.state !== 'OPEN' || pr.isCrossRepository !== false || !laneHeadRef(pr.headRefName)
    || !FULL_SHA.test(pr.headRefOid ?? '') || !Array.isArray(pr.comments)) return null;
  for (let index = pr.comments.length - 1; index >= 0; index--) {
    const record = repairRecords(pr.comments[index]).find(r => r && resolvedBranchName(r.branch, pr.number)
      && FULL_SHA.test(r.sha ?? '') && r.sha === pr.headRefOid);
    if (!record) continue;
    const reviewed = pr.comments.slice(index + 1).some(c => isReviewVerdictComment(c)
      && (basisLineOf(c) || String(c.body ?? '').trimStart().startsWith('✅ review — accepted'))
      && reviewedHeadsOf(c).includes(pr.headRefOid));
    return reviewed ? null : { branch: record.branch, sha: record.sha };
  }
  return null;
}

export function findResolvedSideBranch({ pr, branches } = {}) {
  if (!resolvedSideBranchEvidenceReadable({ pr, branches })) return null;
  const matching = branches.filter(b => resolvedBranchName(b?.name, pr?.number));
  const eligible = matching.filter(b => hasResolvedRepairRecord(pr, b) && b.sha !== pr.headRefOid
    && b.ancestors.includes(pr.headRefOid) && b.ancestors.includes(pr.baseRefOid));
  const newest = eligible.filter(b => eligible.every(other => b.ancestors.includes(other.sha)));
  // Equal tips on aliases are the same commit. Pick a stable ref, never a timestamp.
  return newest.sort((a, b) => a.name.localeCompare(b.name))[0] ?? null;
}
export function resolvedSideBranchEvidenceReadable({ pr, branches } = {}) {
  const readable = laneHeadRef(pr?.headRefName) && FULL_SHA.test(pr?.headRefOid ?? '') && FULL_SHA.test(pr?.baseRefOid ?? '')
    && Array.isArray(branches) && branches.length <= MAX_RESOLVED_BRANCHES
    && branches.every(b => b && typeof b.name === 'string' && (!resolvedBranchName(b.name, pr?.number) || (FULL_SHA.test(b.sha ?? '')
      && Array.isArray(b.ancestors) && b.ancestors.length > 0 && b.ancestors.length <= MAX_RESOLVED_ANCESTORS
      && b.ancestors[0] === b.sha && b.ancestors.every(s => FULL_SHA.test(s)))));
  if (!readable) return false;
  // Divergent eligible repairs are a choice for the operator, not a reason to launch fixer seven.
  const eligible = branches.filter(b => resolvedBranchName(b?.name, pr?.number) && b.sha !== pr.headRefOid
    && b.ancestors.includes(pr.headRefOid) && b.ancestors.includes(pr.baseRefOid));
  if (eligible.some(b => !hasResolvedRepairRecord(pr, b))) return false;
  return !eligible.length || eligible.some(b => eligible.every(other => b.ancestors.includes(other.sha)));
}
