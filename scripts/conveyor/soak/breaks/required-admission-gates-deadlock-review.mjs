/** Required review/merge gates must not send unreviewed PRs to CI healing. */
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
export default {
  id: 'required-admission-gates-deadlock-review',
  title: 'required admission gates leave review reachable and real CI repairable',
  card: 'review daemon admission deadlock',
  fixedBy: { sha: 'HEAD', where: 'working tree', paths: [
    'scripts/conveyor/reconcile-core.mjs', 'scripts/operations/pr-status.mjs', 'scripts/lib/review-timing.mjs',
  ] },
  fixPresent(root) {
    // Probe the target tree's behavior, never a source-string signature of the fix.
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import b from ${JSON.stringify(import.meta.url)}; const r = await b.run({ sourceRoot: ${JSON.stringify(root)} }); process.exit(b.judge(r).length ? 1 : 0);`],
    { timeout: 15000, maxBuffer: 65536, encoding: 'utf8' });
    return !probe.error && probe.status === 0;
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const { planReconcile } = await import(pathToFileURL(join(sourceRoot, 'scripts/conveyor/reconcile-core.mjs')).href);
    const requiredChecks = ['test', 'smoke', 'daemon-soak', 'merge-gate', 'review-gate'];
    const violations = [];
    for (const failing of [null, 'test', 'smoke', 'daemon-soak']) {
      const pr = { number: 7, state: 'OPEN', headRefOid: 'a'.repeat(40), headRefName: 'lane/soak-admission',
        mergeStateStatus: 'CLEAN', labels: [{ name: 'review:pending' }], comments: [],
        statusCheckRollup: requiredChecks.map(name => ({ name, status: 'COMPLETED',
          conclusion: name.endsWith('-gate') || name === failing ? 'FAILURE' : 'SUCCESS' })) };
      for (const elapsed of [0, 60000, 120000]) {
        const plan = planReconcile({ prs: [pr], requiredChecks, agents: [],
          now: Date.parse('2026-11-18T12:00:00Z') + elapsed, reviewTiming: { startAfter: 'ci-green' } });
        const expected = failing ? 'ci-heal' : 'review';
        const kinds = plan.dispatch.map(row => row.kind);
        log?.(`${elapsed}: failing=${failing}, dispatch=${kinds.join(',')}`);
        if (!kinds.includes(expected) || kinds.includes(failing ? 'review' : 'ci-heal'))
          violations.push(`${elapsed}: ${failing ?? 'held gates'} expected ${expected}, got ${kinds.join(',')}`);
      }
    }
    return { violations };
  },
  judge: report => report.violations,
};
