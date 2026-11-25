import { createHash } from 'node:crypto';

/** Give descriptive fixture heads the full commit identity required by pinned reads. */
export const fixtureOid = value => createHash('sha1').update(value).digest('hex');

/** Forge shim response for the same PR files used by the pinned Git fixture. Self-contained for executable shims. */
export function comparePrDiffFixture(pr) {
  return {
    status: 'ahead', merge_base_commit: { sha: 'b'.repeat(40) }, base_commit: { sha: 'b'.repeat(40) },
    files: pr.files.map(f => ({
      filename: f.path, status: f.changeType.toLowerCase(), additions: f.additions, deletions: f.deletions,
      changes: f.additions + f.deletions,
      patch: '@@ -' + (f.deletions ? '1,' + f.deletions : '0,0') + ' +' + (f.additions ? '1,' + f.additions : '0,0') + ' @@\n'
        + '-previous fixture line\n'.repeat(f.deletions) + '+updated fixture line\n'.repeat(f.additions),
    })),
  };
}

/** Git shim fragment; `diffPrs` contains {headRefName, headRefOid, files} rows. */
export const pinnedPrDiffFixture = String.raw`
const gitArgs = a.slice();
// Callers may keep their raw argv for logging; net-diff commands prepend -c pairs.
while (gitArgs[0] === '-c') gitArgs.splice(0, 2);
const diffGitDir = process.cwd() + '/.git';
if (gitArgs[0] === 'fetch') process.exit(0);
if (gitArgs[0] === 'rev-parse' && gitArgs.includes('--git-common-dir')) {
  process.stdout.write(diffGitDir + '\n' + diffGitDir + '\n'); process.exit(0);
}
if (gitArgs[0] === 'rev-parse' && gitArgs.at(-1) === 'refs/remotes/origin/main^{commit}') {
  process.stdout.write('b'.repeat(40)); process.exit(0);
}
if (gitArgs[0] === 'merge-base') { process.stdout.write('b'.repeat(40)); process.exit(0); }
if (gitArgs[0] === 'diff' || gitArgs[0] === 'cat-file' || (gitArgs[0] === 'rev-parse' && gitArgs.includes('--verify'))) {
  const ref = gitArgs.at(-1).replace(/\^\{commit\}$/, '').split(/\.{2,3}/).at(-1);
  const pr = diffPrs.find(p => ref === p.headRefOid || ref === p.headRefName || ref === 'origin/' + p.headRefName);
  if (!pr) process.exit(1);
  if (gitArgs[0] === 'cat-file') process.exit(0);
  if (gitArgs[0] === 'rev-parse') { process.stdout.write(pr.headRefOid); process.exit(0); }
  const files = pr.files;
  let text;
  if (gitArgs.includes('--name-only')) {
    const separator = gitArgs.includes('-z') ? '\0' : '\n';
    text = files.map(f => f.path).join(separator) + separator;
  } else if (gitArgs.includes('--numstat')) {
    text = files.map(f => f.additions + '\t' + f.deletions + '\t' + f.path + '\n').join('');
  } else {
    text = files.map(f => 'diff --git a/' + f.path + ' b/' + f.path + '\n--- a/' + f.path + '\n+++ b/' + f.path
      + '\n@@ -' + (f.deletions ? '1,' + f.deletions : '0,0') + ' +' + (f.additions ? '1,' + f.additions : '0,0') + ' @@\n'
      + '-previous fixture line\n'.repeat(f.deletions) + '+updated fixture line\n'.repeat(f.additions)).join('');
  }
  process.stdout.write(text); process.exit(0);
}
`;
