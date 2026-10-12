/** Repo-root scratch paths shared by fixer agents and the drain. */
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
