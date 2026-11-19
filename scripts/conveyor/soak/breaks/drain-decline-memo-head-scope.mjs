/** Main CI churn must not wake an unchanged PR just to repeat a known head-bound decline. */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

// Shared behavioral probe: no source-text marker decides whether the fix is present.
function probe(planCatchUp, reason = 'red-team-pending', mainCiRunId = 101) {
  const now = 10_000_000;
  return planCatchUp({
    prs: [{ num: 42, baseRefName: 'main', labels: [{ name: 'ready-to-merge' }],
      headRefOid: 'head-a', labelsDigest: 'labels-a', checksDigest: 'checks-a',
      lastCheckCompletedAt: now - 120_000, lastLabelChangedAt: now - 180_000 }],
    queued: 0, capacity: 1, now, mainCiRunId,
    declines: new Map([[42, { reason, headSha: 'head-a', labelsDigest: 'labels-a',
      checksDigest: 'checks-a', at: now - 60_000, mainCiRunId: 100 }]]),
  });
}

export default {
  id: 'drain-decline-memo-head-scope',
  title: 'unchanged head-bound declines survive main CI churn without another fast drain',
  card: 'drain decline memo head scope',
  fixedBy: { sha: 'pending', where: 'lane/drain-decline-memo-head', paths: ['scripts/lib/enqueue-on-event.mjs'] },
  fixPresent(root) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `const { planCatchUp } = await import(process.argv[1]);
       const plan = (${probe.toString()})(planCatchUp);
       process.exit(plan.run.length === 0 && plan.skippedUnchanged?.[0]?.reason === 'red-team-pending' ? 0 : 1);`,
      pathToFileURL(join(root, 'scripts/lib/enqueue-on-event.mjs')).href],
    { encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 });
    return !result.error && result.status === 0;
  },
  async run({ sourceRoot = process.env.SOAK_TREE_ROOT || ROOT, log } = {}) {
    const { planCatchUp } = await import(pathToFileURL(join(sourceRoot, 'scripts/lib/enqueue-on-event.mjs')).href);
    const violations = [];
    for (const reason of ['red-team-pending', 'mq-same-head-failed']) {
      for (const run of [101, null]) {
        const plan = probe(planCatchUp, reason, run);
        if (plan.run.length || plan.skippedUnchanged?.[0]?.reason !== reason) {
          violations.push(`${reason} repeated after main CI changed to ${run}`);
        }
      }
    }
    for (const reason of ['sent-back', 'bornas-collision']) {
      if (probe(planCatchUp, reason).run[0]?.num !== 42) {
        violations.push(`${reason} did not retry after main CI changed`);
      }
    }
    log?.(`head-scoped decline probe: ${violations.length} violation(s)`);
    return { violations };
  },
  judge(report) { return report.violations; },
};
