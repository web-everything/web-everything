/** Draft PR #3850 (2026-10-03/04): `test` never reported beside green siblings and no pass ever owned it. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONSTELLATION_REPOS } from '../../../lib/constellation-repos.mjs';

const done = (name, conclusion = 'SUCCESS') => ({ __typename: 'CheckRun', workflowName: 'CI', name, status: 'COMPLETED', conclusion });

export default {
  id: 'missing-required-check-on-stalled-partial-rollup',
  title: 'PR #3850: a required check that never reported (a test-shard CANCELLED, aggregate `test` never ran) is never re-requested, so the draft is never promoted',
  card: 'unstick PRs #3850/#3830/#3826 (epic #3383/#4075)',
  fixedBy: { sha: '274c4400b2f756feb89f19430fb7c64c404d3c37', where: 'lane/unstick-3850-3830-3826', paths: ['scripts/conveyor/main-red-recovery.mjs', 'scripts/conveyor/ci-red-recovery-watch.mjs'] },
  fixPresent(root) { return readFileSync(join(root, 'scripts/conveyor/main-red-recovery.mjs'), 'utf8').includes('isStalledPartialRollup'); },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const { sweepMissingRunRecovery } = await import(pathToFileURL(join(root, 'scripts/conveyor/ci-red-recovery-watch.mjs')).href);
    const pr = { number: 3850, headRefName: 'lane/prepare-org-move-xvgqv8h', headRefOid: '967fee6791e10673214fa811ecac29837db15950',
      mergeable: 'MERGEABLE', isDraft: true, labels: [{ name: 'review:pending' }],
      statusCheckRollup: [done('smoke'), done('daemon-soak'), done('soak-replay-gate'), done('test-shard (1)'), done('test-shard (2)', 'CANCELLED')] };
    const violations = [];
    // The App token cannot read branch protection (null) — the live condition.
    const plan = sweepMissingRunRecovery({ repo: CONSTELLATION_REPOS.we.slug, readOpenPrs: () => [pr], readRequiredContexts: () => null,
      readHeadCommittedAt: () => '2026-10-03T20:50:00Z', readComments: () => [], now: Date.parse('2026-10-04T11:50:00Z') });
    if (!plan.dispatch.some((d) => d.prNumber === 3850 && d.kind === 'trigger-ci')) violations.push('PR #3850 (required `test` absent, every other check completed) was not owed a CI trigger');
    return { violations };
  },
  judge(report) { return report.violations; },
};
