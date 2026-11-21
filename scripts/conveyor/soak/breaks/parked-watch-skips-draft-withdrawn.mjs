/** The parked-PR conflict watch must not dispatch a conflict fix on a review-status:draft-withdrawn PR. */
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ghRepoSlug } from '../../../lib/constellation-repos.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');

export function exercise(watchParkedPrConflicts) {
  const violations = [];
  const run = labels => {
    let dispatched = 0, effects = 0, threw = false, results = null;
    const eff = () => { effects++; };
    const provider = { ensureLabel: eff, setLabels: eff, postComment: eff };
    const realWrite = process.stderr.write;
    process.stderr.write = () => true;
    try {
      results = watchParkedPrConflicts({
        repo: ghRepoSlug('we'), sameLineConflict: 'stand-down',
        listPrs: () => [{ number: 7101, headRefName: 'lane/x', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', labels }],
        inCardGroupFn: () => false, cardGroupStateUnreadable: () => false,
        provider, postFinding: () => { dispatched++; }, postStandDown: () => { effects++; }, postRearm: () => { effects++; },
        listPrFiles: () => ['scripts/example.mjs'], listPrComments: () => [],
        computeConflictingPaths: () => null, computeConflictDisposition: () => null,
      });
    } catch { threw = true; } finally { process.stderr.write = realWrite; }
    return { dispatched, effects, threw, results };
  };
  const w = run([{ name: 'review:human' }, { name: 'review-status:draft-withdrawn' }, null]);
  if (w.threw) violations.push('withdrawn PR sweep threw');
  if (w.dispatched !== 0 || w.effects !== 0 || (w.results && w.results.length !== 0)) violations.push('withdrawn PR was dispatched or mutated');
  const o = run([{ name: 'review:human' }]);
  if (o.threw || o.dispatched !== 1) violations.push('ordinary parked PR no longer gets its conflict-fix finding');
  return { violations };
}

export default {
  id: 'parked-watch-skips-draft-withdrawn',
  title: 'parked conflict watch leaves draft-withdrawn PRs alone',
  card: 'parked-watch-skip',
  fixedBy: { sha: 'HEAD', where: 'working tree', paths: ['scripts/conveyor/parked-pr-conflict-watch.mjs'] },
  fixPresent(root) {
    const probe = `import { exercise } from ${JSON.stringify(import.meta.url)};
      import { watchParkedPrConflicts } from ${JSON.stringify(pathToFileURL(join(root, 'scripts/conveyor/parked-pr-conflict-watch.mjs')).href)};
      process.stdout.write(JSON.stringify(exercise(watchParkedPrConflicts)));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { cwd: root, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
    try { return r.status === 0 && JSON.parse(r.stdout).violations.length === 0; } catch { return false; }
  },
  async run({ sourceRoot = ROOT } = {}) {
    const { watchParkedPrConflicts } = await import(pathToFileURL(join(sourceRoot, 'scripts/conveyor/parked-pr-conflict-watch.mjs')).href);
    return exercise(watchParkedPrConflicts);
  },
  judge: report => report.violations,
};
