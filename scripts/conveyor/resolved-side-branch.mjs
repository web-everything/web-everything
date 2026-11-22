/** Pure ancestry evidence only. No timestamps, labels, verdicts or credentials authorize a push.
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
    && !/\.\.|\/\/|\.lock(?:\/|$)|\/$/.test(name);
}
export function findResolvedSideBranch({ pr, branches } = {}) {
  if (!resolvedSideBranchEvidenceReadable({ pr, branches })) return null;
  const matching = branches.filter(b => resolvedBranchName(b?.name, pr?.number));
  const eligible = matching.filter(b => b.sha !== pr.headRefOid
    && b.ancestors.includes(pr.headRefOid) && b.ancestors.includes(pr.baseRefOid));
  const newest = eligible.filter(b => eligible.every(other => b.ancestors.includes(other.sha)));
  // Equal tips on aliases are the same commit. Pick a stable ref, never a timestamp.
  return newest.sort((a, b) => a.name.localeCompare(b.name))[0] ?? null;
}
export function resolvedSideBranchEvidenceReadable({ pr, branches } = {}) {
  const readable = FULL_SHA.test(pr?.headRefOid ?? '') && FULL_SHA.test(pr?.baseRefOid ?? '')
    && Array.isArray(branches) && branches.length <= MAX_RESOLVED_BRANCHES
    && branches.every(b => b && typeof b.name === 'string' && (!resolvedBranchName(b.name, pr?.number) || (FULL_SHA.test(b.sha ?? '')
      && Array.isArray(b.ancestors) && b.ancestors.length > 0 && b.ancestors.length <= MAX_RESOLVED_ANCESTORS
      && b.ancestors[0] === b.sha && b.ancestors.every(s => FULL_SHA.test(s)))));
  if (!readable) return false;
  // Divergent eligible repairs are a choice for the operator, not a reason to launch fixer seven.
  const eligible = branches.filter(b => resolvedBranchName(b?.name, pr?.number) && b.sha !== pr.headRefOid
    && b.ancestors.includes(pr.headRefOid) && b.ancestors.includes(pr.baseRefOid));
  return !eligible.length || eligible.some(b => eligible.every(other => b.ancestors.includes(other.sha)));
}
