/** Serialized into CLI shims: paired stats and patches for known PR file changes. */
export function pinnedLeafGitFixture(argv, prs) {
  // Recognize pinnedGit's config prefix; leave other Git runners' fixture behavior alone.
  if (argv[0] !== '-c' || argv[1] !== 'core.attributesFile=/dev/null') return null;
  const a = [...argv];
  while (a[0] === '-c') a.splice(0, 2);
  const base = 'd'.repeat(40);
  if (a[0] === 'fetch') {
    if (a.at(-1) !== '+refs/heads/main:refs/remotes/origin/main') throw new Error('unknown fixture fetch');
    return '';
  }
  if (a[0] === 'rev-parse') {
    const ref = a.at(-1).replace(/\^\{commit\}$/, '');
    if (['refs/remotes/origin/main', 'FETCH_HEAD'].includes(ref)) return base + '\n';
    const pr = prs.find(p => p.headRefOid === ref);
    if (!pr) throw new Error('unknown fixture commit');
    return pr.headRefOid + '\n';
  }
  const pr = prs.find(p => p.headRefOid === a.at(-1));
  if (!pr || a.at(-2) !== base) throw new Error('unknown fixture diff basis');
  if (a[0] === 'merge-base') return base + '\n';
  if (a[0] !== 'diff') throw new Error('unknown pinned fixture command');
  const files = pr.files.map(f => ({ ...f, additions: f.additions ?? 1, deletions: f.deletions ?? 0 }));
  if (a.includes('--numstat')) return files.map(f => `${f.additions}\t${f.deletions}\t${f.path}\n`).join('');
  if (a.includes('--name-only')) return files.map(f => f.path + '\0').join('');
  return files.map(({ path, additions, deletions }) => {
    if (!Number.isSafeInteger(additions) || additions < 0 || !Number.isSafeInteger(deletions) || deletions < 0) {
      throw new Error('unknown fixture change counts');
    }
    return 'diff --git a/' + path + ' b/' + path + '\n' +
      (!deletions ? 'new file mode 100644\n' : !additions ? 'deleted file mode 100644\n' : '') +
      '--- ' + (deletions ? 'a/' + path : '/dev/null') +
      '\n+++ ' + (additions ? 'b/' + path : '/dev/null') +
      `\n@@ -${deletions ? 1 : 0},${deletions} +${additions ? 1 : 0},${additions} @@\n` +
      '-base\n'.repeat(deletions) + '+leaf\n'.repeat(additions);
  }).join('');
}
