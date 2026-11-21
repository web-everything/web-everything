// Shared by function ports and executable Git shims. Keep unrelated commands in
// the caller so each scenario still controls its own Git evidence.
export function drainScoredGit(args, { gitDir, head = 'a'.repeat(40), files = [{ path: 'backlog/leaf.md', additions: 1, deletions: 0 }] } = {}) {
  let a = args;
  while (a[0] === '-c') a = a.slice(2);
  const base = 'b'.repeat(40);
  const ok = stdout => ({ status: 0, stdout, stderr: '' });
  if (a[0] === 'rev-parse') {
    if (a.includes('--git-common-dir')) return ok(`${gitDir}\n${gitDir}\n`);
    const ref = a.at(-1).replace(/\^\{commit\}$/, '');
    return ok((a.includes('refs/remotes/origin/main^{commit}') ? base : /^[a-f0-9]{40}$/i.test(ref) ? ref : head) + '\n');
  }
  if (a[0] === 'cat-file' && a[1] === '-e') {
    return { status: /^[a-f0-9]{40}\^\{commit\}$/i.test(a[2]) ? 0 : 1, stdout: '', stderr: '' };
  }
  if (a[0] === 'merge-base') return ok(a.includes('--is-ancestor') ? '' : base + '\n');
  if (a[0] !== 'diff') return null;
  if (a.includes('--name-only')) return ok(files.map(f => f.path).join('\0') + (files.length ? '\0' : ''));
  if (a.includes('--numstat')) return ok(files.map(f => `${f.additions ?? 1}\t${f.deletions ?? 0}\t${f.path}\n`).join(''));
  return ok(files.map(f => {
    const added = f.additions ?? 1, removed = f.deletions ?? 0;
    return `diff --git a/${f.path} b/${f.path}\n--- a/${f.path}\n+++ b/${f.path}\n@@ -${removed ? 1 : 0},${removed} +${added ? 1 : 0},${added} @@\n`
      + '-old\n'.repeat(removed) + '+new\n'.repeat(added);
  }).join(''));
}

export const scoredGitScript = `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === 'remote' && a[1] === 'get-url') {
  process.stdout.write('git@github.com:web-everything/web-everything.git\\n'); process.exit(0);
}
const result = (${drainScoredGit.toString()})(a, { gitDir: process.cwd() + '/.git' });
if (result) { process.stdout.write(result.stdout); process.exit(result.status); }
process.exit(0);
`;
