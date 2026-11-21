import { createHash } from 'node:crypto';

/** Give descriptive fixture heads the full commit identity required by pinned reads. */
export const fixtureOid = value => createHash('sha1').update(value).digest('hex');

/** Git shim fragment; `diffPrs` contains {headRefName, headRefOid, files} rows. */
export const pinnedPrDiffFixture = String.raw`
if (a[0] === 'merge-base') { process.stdout.write('b'.repeat(40)); process.exit(0); }
if (a[0] === 'diff' || (a[0] === 'rev-parse' && a.includes('--verify'))) {
  const ref = a.at(-1).replace(/\^\{commit\}$/, '').split(/\.{2,3}/).at(-1);
  const pr = diffPrs.find(p => ref === p.headRefOid || ref === p.headRefName || ref === 'origin/' + p.headRefName);
  if (!pr) process.exit(1);
  if (a[0] === 'rev-parse') { process.stdout.write(pr.headRefOid); process.exit(0); }
  const files = pr.files;
  let text;
  if (a.includes('--name-only')) {
    const separator = a.includes('-z') ? '\0' : '\n';
    text = files.map(f => f.path).join(separator) + separator;
  } else if (a.includes('--numstat')) {
    text = files.map(f => f.additions + '\t' + f.deletions + '\t' + f.path + '\n').join('');
  } else {
    text = files.map(f => 'diff --git a/' + f.path + ' b/' + f.path + '\n--- a/' + f.path + '\n+++ b/' + f.path
      + '\n@@ -' + (f.deletions ? '1,' + f.deletions : '0,0') + ' +' + (f.additions ? '1,' + f.additions : '0,0') + ' @@\n'
      + '-previous fixture line\n'.repeat(f.deletions) + '+updated fixture line\n'.repeat(f.additions)).join('');
  }
  process.stdout.write(text); process.exit(0);
}
`;
