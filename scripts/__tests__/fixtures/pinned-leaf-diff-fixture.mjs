/** Git shim fragment for leaf PRs: serve the same pinned head, numstat and patch. */
export const pinnedLeafDiffFixture = String.raw`
const leafNumber = a.join(' ').match(/(?:lane\/leaf-|^)(\d+)(?:\^\{commit\})?$/)?.[1];
const leafPath = n => 'backlog/leaf-' + n + '.md';
if (a[0] === 'merge-base') { process.stdout.write('b'.repeat(40)); process.exit(0); }
if (a[0] === 'rev-parse' && a.includes('--verify') && leafNumber) {
  process.stdout.write(Number(leafNumber).toString(16).padStart(40, '0')); process.exit(0);
}
if (a[0] === 'diff') {
  const tip = a.at(-1);
  const n = /^(?:[0-9a-f]{40})$/.test(tip) ? parseInt(tip, 16) : Number(leafNumber);
  if (!n) process.exit(1);
  const path = leafPath(n);
  process.stdout.write(a.includes('--numstat') ? '1\t0\t' + path + '\n'
    : 'diff --git a/' + path + ' b/' + path + '\n--- a/' + path + '\n+++ b/' + path + '\n@@ -0,0 +1 @@\n+leaf fixture\n');
  process.exit(0);
}
`;
