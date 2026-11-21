/** Git shim fragment for leaf PRs: serve the same pinned head, numstat and patch. */
export const pinnedLeafDiffFixture = String.raw`
const gitArgs = a.slice();
while (gitArgs[0] === '-c') gitArgs.splice(0, 2);
const leafNumber = gitArgs.join(' ').match(/(?:lane\/leaf-|^)(\d+)(?:\^\{commit\})?$/)?.[1];
const leafPath = n => 'backlog/leaf-' + n + '.md';
if (gitArgs[0] === 'fetch') process.exit(0);
if (gitArgs[0] === 'rev-parse' && gitArgs.includes('--git-common-dir')) {
  const gitDir = process.cwd() + '/.git';
  process.stdout.write(gitDir + '\n' + gitDir + '\n'); process.exit(0);
}
if (gitArgs[0] === 'rev-parse' && gitArgs.at(-1) === 'refs/remotes/origin/main^{commit}') {
  process.stdout.write('b'.repeat(40)); process.exit(0);
}
if (gitArgs[0] === 'merge-base') { process.stdout.write('b'.repeat(40)); process.exit(0); }
if (gitArgs[0] === 'cat-file' && /^[0-9a-f]{40}\^\{commit\}$/.test(gitArgs.at(-1))) process.exit(0);
if (gitArgs[0] === 'rev-parse' && gitArgs.includes('--verify') && /^[0-9a-f]{40}\^\{commit\}$/.test(gitArgs.at(-1))) {
  process.stdout.write(gitArgs.at(-1).slice(0, 40)); process.exit(0);
}
if (gitArgs[0] === 'rev-parse' && gitArgs.includes('--verify') && leafNumber) {
  process.stdout.write(Number(leafNumber).toString(16).padStart(40, '0')); process.exit(0);
}
if (gitArgs[0] === 'diff') {
  const tip = gitArgs.at(-1);
  const n = /^(?:[0-9a-f]{40})$/.test(tip) ? parseInt(tip, 16) : Number(leafNumber);
  if (!n) process.exit(1);
  const path = leafPath(n);
  process.stdout.write(gitArgs.includes('--numstat') ? '1\t0\t' + path + '\n'
    : 'diff --git a/' + path + ' b/' + path + '\n--- a/' + path + '\n+++ b/' + path + '\n@@ -0,0 +1 @@\n+leaf fixture\n');
  process.exit(0);
}
`;
