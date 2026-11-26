/** SHIP-WM-296: four PRs (#7453, #7491, #7497, #7515) deadlocked because red-team:pending refused every repair push. */
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const DISPATCH = 'scripts/conveyor/reconcile-fix-dispatch.mjs';

const CASES = [
  // [name, repair, live view, expected hold reason or null]
  ['E1 advisory-fix launches through pending', { mode: 'advisory-fix', labels: ['review:human'] },
    { labels: ['review:human', 'advisory:changes', 'red-team:pending'] }, null],
  ['E2 default-base conflict bounce launches through pending', { isConflict: true, labels: ['review:changes'] },
    { labels: ['review:changes', 'red-team:pending'], mergeable: 'CONFLICTING', baseRefName: 'main' }, null],
  ['takeover stays held', { mode: 'takeover', takeover: {}, labels: ['review:human'] },
    { labels: ['review:human', 'advisory:changes', 'red-team:pending'] }, 'red-team:pending'],
  ['E2 with UNKNOWN mergeable stays held', { isConflict: true, labels: ['review:changes'] },
    { labels: ['review:changes', 'red-team:pending'], mergeable: 'UNKNOWN', baseRefName: 'main' }, 'red-team:pending'],
  ['red-team:blocked stays held', { mode: 'advisory-fix', labels: ['review:human'] },
    { labels: ['review:human', 'advisory:changes', 'red-team:pending', 'red-team:blocked'] }, 'red-team:pending'],
];

const PROBE = `
const [file, cases] = [process.argv[1], JSON.parse(process.argv[2])];
const { readLivePushHold } = await import(file);
const out = cases.map(([name, repair, view]) => {
  const run = () => JSON.stringify({ state: 'OPEN', ...view, labels: view.labels.map(n => ({ name: n })) });
  const hold = readLivePushHold({ repo: 'we', pr: 1, repair }, { hermetic: false, run });
  return [name, hold ? hold.reason : null];
});
console.log(JSON.stringify(out));`;

function probe(root) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', PROBE,
    pathToFileURL(join(root, DISPATCH)).href, JSON.stringify(CASES)], { encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return null; }
}

export default {
  id: 'fix-push-hold-pending-eligible-route',
  title: 'red-team:pending blocks merge, not an eligible advisory-fix or conflict-bounce push',
  card: 'REDTEAM-REQUEST-RECOVERY S1 (SHIP-WM-296)',
  fixedBy: { sha: 'pending', where: 'lane/redteam-request-recovery', paths: [DISPATCH] },
  // Decided by behaviour: the two eligible routes launch through pending.
  fixPresent(root) {
    const out = probe(root);
    // Either route launching marks the fix as present; run() then demands both, so a one-route regression fails loudly.
    return !!out && (out[0]?.[1] === null || out[1]?.[1] === null);
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const out = probe(sourceRoot);
    log?.(JSON.stringify(out));
    if (!out) return { violations: ['probe failed to run'] };
    return { violations: CASES.flatMap(([name, , , expected], i) =>
      out[i]?.[1] === expected ? [] : [`${name}: got ${out[i]?.[1]}`]) };
  },
  judge: report => report.violations,
};
