/** Planner read an all-green but incomplete (or other-head) required-check row set as proof, so it dispatched review. */
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const PATHS = ['scripts/conveyor/reconcile-core.mjs', 'scripts/lib/review-ci-gate.mjs',
  'scripts/lib/review-timing.mjs', 'scripts/conveyor/ci-heal-verdict-recheck.mjs'];
const HEAD = 'c'.repeat(40);

export default {
  id: 'review-ci-ignores-incomplete-rows',
  title: 'review dispatch trusts required-check rows whose evidence is incomplete or for another head',
  card: 'rowsComplete hydration fix (split from #7042)',
  fixedBy: { sha: 'HEAD', where: 'lane/rowscomplete-hydration-fix', paths: PATHS },
  // Fix presence is decided by behaviour (run), not by markers: report present only when the planner refuses.
  fixPresent(root) {
    try {
      const out = execFileSync(process.execPath, ['--input-type=module', '-e',
        `const { probe } = await import(${JSON.stringify(import.meta.url)}); console.log(JSON.stringify(await probe(${JSON.stringify(root)})));`],
      { encoding: 'utf8', timeout: 60000 });
      return JSON.parse(out.trim().split('\n').pop()).length === 0;
    } catch { return false; }
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const violations = await probe(sourceRoot);
    for (const v of violations) log?.(`${v}\n`);
    return { violations };
  },
  judge: report => report.violations,
};

export async function probe(root) {
  const { planReconcile } = await import(pathToFileURL(join(root, PATHS[0])).href);
  const violations = [];
  const row = name => ({ name, status: 'completed', conclusion: 'success' });
  const plan = extra => planReconcile({
    prs: [{ number: 7042, state: 'OPEN', isDraft: false, isCrossRepository: false, headRefName: 'lane/x',
      headRefOid: HEAD, baseRefName: 'main', labels: ['review:pending'], comments: [], mergeStateStatus: 'CLEAN',
      statusCheckRollup: [row('test')], ...extra }],
    agents: [], durableCounts: {}, requiredChecks: ['test'], reviewTiming: { startAfter: 'ci-green' },
    now: Date.parse('2026-11-18T12:00:00Z'),
  });
  const reviews = extra => plan(extra).dispatch.filter(d => d.kind === 'review').length;
  if (reviews({ rowsComplete: true, rowsHead: HEAD }) !== 1) violations.push('complete rows for the head: review not dispatched');
  if (reviews({ rowsComplete: false, rowsHead: HEAD }) !== 0) violations.push('incomplete rows: review dispatched');
  if (reviews({ rowsComplete: true, rowsHead: 'd'.repeat(40) }) !== 0) violations.push('rows for another head: review dispatched');
  return violations;
}
