/** Serialized into CLI shims: pinned evidence for leaf PRs adding one file each. */
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
  const path = pr.files[0].path;
  if (a.includes('--numstat')) return '1\t0\t' + path + '\n';
  if (a.includes('--name-only')) return path + '\0';
  return 'diff --git a/' + path + ' b/' + path + '\nnew file mode 100644\n--- /dev/null\n+++ b/' + path + '\n@@ -0,0 +1 @@\n+leaf\n';
}
