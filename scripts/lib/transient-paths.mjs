/** Repo-root scratch paths shared by fixer agents and the drain. */
/** R503: the exact repo-root-relative paths whose changes never count as a PR's own change when proving that a net
 *  diff is unchanged (approval, audit and prototype-load carry). The drain's lane manifest and the regenerated CI
 *  timing file. Exact paths only: a nested lookalike stays substantive. */
export const MECHANICAL_DIFF_PATHS = Object.freeze(['.lane-manifest.json', 'scripts/ci/test-timings.json']);

export function isFixEvidencePath(p) {
  return /^\.fix-(?:[^/]*-)?evidence[^/]*\.md$/.test(p) && !p.includes('/');
}

export function isDrainTransientPath(p, manifest = '.lane-manifest.json') {
  return p === manifest || isFixEvidencePath(p);
}

export function committedFixEvidenceFindings({ changedFiles = [], deletedFiles = [] }) {
  const deleted = new Set(deletedFiles);
  return changedFiles.filter((p) => isFixEvidencePath(p) && !deleted.has(p));
}
