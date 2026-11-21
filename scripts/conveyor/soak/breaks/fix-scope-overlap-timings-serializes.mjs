/** Advisory test timing updates must not serialize otherwise independent fixers. */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export default {
  id: 'fix-scope-overlap-timings-serializes',
  title: 'two fixes sharing only test-timings.json both plan, while code overlap still refuses',
  card: 'fix-scope-overlap-timings',
  fixedBy: { sha: 'pending', where: 'timings-union', paths: ['scripts/conveyor/fix-scope-policy.mjs'] },
  fixPresent(root) {
    // Presence is independent of the planning scenario, so a regression cannot invert its gate.
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e',
      "const { stripProseScope } = await import(process.argv[1]); process.exit(stripProseScope(['we:scripts/ci/test-timings.json']).length === 0 ? 0 : 1);",
      pathToFileURL(join(root, 'scripts/conveyor/fix-scope-policy.mjs')).href], {
      env: { ...process.env, SOAK_TREE_ROOT: root }, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
    });
    return probe.status === 0;
  },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || fileURLToPath(new URL('../../../../', import.meta.url));
    const { filterFixesByInFlightScope } = await import(pathToFileURL(join(root, 'scripts/conveyor/reconcile-fix-dispatch.mjs')).href);
    const fix = (pr, files) => ({ pr, itemNum: null, scope: files, overlapScope: files, headRefOid: String(pr).padEnd(40, 'a') });
    const violations = [];
    for (const shared of ['scripts/ci/test-timings.json', 'we:scripts/ci/test-timings.json']) {
      const queue = [fix(1, [shared, 'we:a.mjs']), fix(2, [shared, 'we:b.mjs'])];
      const out = filterFixesByInFlightScope(queue, [], [], { maxWaitMinutes: null });
      if (out.planned.length !== 2 || out.refusals.length) violations.push(`shared timings serialized fixes: ${shared}`);
      const live = filterFixesByInFlightScope([queue[1]], [], [{ meta: { pr: 1, scope: queue[0].scope } }], { maxWaitMinutes: null });
      if (live.planned.length !== 1 || live.refusals.length) violations.push(`live timings claim serialized fix: ${shared}`);
    }
    const code = filterFixesByInFlightScope([fix(1, ['we:x.mjs']), fix(2, ['we:x.mjs'])], [], [], { maxWaitMinutes: null });
    if (code.planned.length !== 1 || !code.refusals.some(r => r.pr === 2 && r.kind === 'scope-overlap')) violations.push('a shared code file no longer serializes fixes');
    return { violations };
  },
  judge(report) { return report.violations; },
};
