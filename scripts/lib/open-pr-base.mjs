/** Only a currently open PR in the same repository can own a stacked branch wait. */
export function openBasePr(pr, prs = []) {
  if (!pr?.repo || typeof pr.baseRefName !== 'string' || !pr.baseRefName) return null;
  return prs.find(base => Number.isSafeInteger(base?.number) && base.number > 0 && base.number !== pr.number && base.repo === pr.repo
    && (!base.state || base.state.toUpperCase() === 'OPEN') && base.headRefName === pr.baseRefName) ?? null;
}
