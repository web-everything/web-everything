import { execFileSync } from 'node:child_process';
import { changedLines } from './diff-branch-coverage.mjs';

export const TESTING_GUIDE = 'docs/agent/testing.md';
const HINT = 'Put new testing notes in docs/agent/testing.d/ as separate topic files; do not append to docs/agent/testing.md.';

/** Pure: paths with added lines, not merely touched/deleted paths. Advisory only. */
export function testingNotesAdvisory(addedPaths) {
  return [...addedPaths].includes(TESTING_GUIDE) ? [HINT] : [];
}

/** Include committed, staged and unstaged additions relative to the PR merge base. */
export function scanTestingNotesAdvisory(root, { git = execFileSync } = {}) {
  const options = { cwd: root, encoding: 'utf8', timeout: 5000,
    maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] };
  try {
    const base = git('git', ['merge-base', 'origin/main', 'HEAD'], options).trim();
    if (!/^[a-f0-9]{40,64}$/.test(base)) throw new Error('missing merge base');
    const patch = git('git', ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--text', '--unified=0',
      base, '--', TESTING_GUIDE], options);
    return testingNotesAdvisory(changedLines(patch).size ? [TESTING_GUIDE] : []);
  } catch {
    return [`Testing notes advisory could not inspect the diff against origin/main (unavailable base, failed read or 1 MiB/5s limit). Review the diff manually. ${HINT}`];
  }
}
