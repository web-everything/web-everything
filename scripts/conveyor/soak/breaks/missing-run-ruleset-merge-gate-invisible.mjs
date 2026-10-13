/** Live #5060: classic protection checks hid a ruleset-only merge-gate that never ran. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const CLASSIC_CONTEXTS = ['test', 'smoke', 'daemon-soak', 'soak-replay-gate'];
const done = (name, conclusion = 'SUCCESS') => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion });

export default {
  id: 'missing-run-ruleset-merge-gate-invisible',
  title: 'PR #5060 (2026-10-13): a head whose ruleset-only merge-gate never ran was invisible to the missing-run pass — never re-triggered, review refused forever (merge-gate=missing)',
  card: '#5060',
  fixedBy: { sha: 'd77826772', where: 'lane/missing-run-ruleset-checks', paths: ['scripts/conveyor/ci-red-recovery-watch.mjs'] },
  fixPresent(root) {
    const source = readFileSync(join(root, 'scripts/conveyor/ci-red-recovery-watch.mjs'), 'utf8');
    const sweep = source.split('export function sweepMissingRunRecovery(')[1]?.split('\nexport ')[0];
    return sweep?.includes('readAttributedRequiredChecks') ?? false;
  },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const { sweepMissingRunRecovery } = await import(pathToFileURL(join(root, 'scripts/conveyor/ci-red-recovery-watch.mjs')).href);
    const triggered = [];
    const result = sweepMissingRunRecovery({
      repo: ['web-everything', 'web-everything'].join('/'), apply: true, mainRuns: [],
      now: Date.parse('2026-10-13T11:00:00Z'),
      readOpenPrs: () => [{
        number: 5060, headRefName: 'lane/5060', baseRefName: 'main', headRefOid: '9cb7cc0',
        mergeable: 'MERGEABLE',
        statusCheckRollup: [...CLASSIC_CONTEXTS.map(name => done(name)), done('review-gate', 'FAILURE')],
      }],
      readRequiredContexts: () => CLASSIC_CONTEXTS,
      readAttributedRequiredChecks: () => [...CLASSIC_CONTEXTS, 'merge-gate'],
      readHeadCommittedAt: () => '2026-10-12T21:21:24Z', readComments: () => [],
      trigger: d => {
        triggered.push(d.prNumber);
        return { ok: true, action: 'pull-request-push' };
      },
      postComment: () => {}, clearLabel: () => true,
    });
    return { ...result, triggered };
  },
  judge(report) {
    return report.triggered.includes(5060) ? [] : ['PR #5060 missing ruleset-only merge-gate was not triggered'];
  },
};
