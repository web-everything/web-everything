/** Repo-root scratch paths shared by fixer agents and the drain. */
/** R503: the exact repo-root-relative paths whose changes never count as a PR's own change when proving that a net
 *  diff is unchanged (approval, audit and prototype-load carry). The drain's lane manifest and the regenerated CI
 *  timing file. Exact paths only: a nested lookalike stays substantive. */
export const MECHANICAL_DIFF_PATHS = Object.freeze(['.lane-manifest.json', 'scripts/ci/test-timings.json']);

/** The timing file is only mechanical as an in-place content refresh: adding, deleting, renaming, mode changes or
 *  binary replacement of it are real changes. (The drain's lane manifest keeps its historical every-kind exclusion.) */
const MODIFY_ONLY = new Set(['scripts/ci/test-timings.json']);
/** Extended-header line prefixes that make a timing-file section a real change. Exported so a test pins one variant
 *  per prefix. */
export const NOT_A_REFRESH_PREFIXES = Object.freeze(['deleted file mode', 'new file mode', 'old mode', 'new mode', 'rename ', 'copy ', 'similarity index', 'dissimilarity index', 'Binary files', 'GIT binary patch']);
const NOT_A_REFRESH = { test: (line) => NOT_A_REFRESH_PREFIXES.some((p) => line.startsWith(p)) };
/** PURE: does the `diff --git` header at lines[i] open a section the fingerprints skip? */
export function isMechanicalDiffSection(lines, i) {
  const header = lines[i];
  const path = MECHANICAL_DIFF_PATHS.find((p) => header === `diff --git a/${p} b/${p}`);
  if (!path) return false;
  if (!MODIFY_ONLY.has(path)) return true;
  for (let j = i + 1; j < lines.length && !lines[j].startsWith('diff --git ') && !lines[j].startsWith('@@'); j++) {
    if (NOT_A_REFRESH.test(lines[j])) return false;
  }
  return true;
}

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
