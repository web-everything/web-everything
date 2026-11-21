/**
 * Break: ref-only ready matching drops a passed candidate when its wanted check requires a recorded tip.
 * Fix: judge each candidate overlay by (ref, sha), accepting equal or descendant wanted tips.
 * Expectation: descendant churn adopts the verified superseded candidate; removed and divergent inputs refuse.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { matchReadyCandidate } from '../../../lib/daemon-rebuild/adopt.mjs';

export default {
  id: 'ready-candidate-adopted-across-overlay-churn',
  title: 'a smoke-passed ready candidate adopts across descendant overlay churn without restoring removed or divergent inputs',
  card: 'ready-candidate adoption across overlay churn',
  fixedBy: {
    sha: 'working-tree', where: 'working-tree',
    paths: ['scripts/lib/daemon-rebuild/adopt.mjs', 'scripts/lib/daemon-rebuild/prepare.mjs'],
  },
  fixPresent(root) {
    try {
      return readFileSync(join(root, 'scripts/lib/daemon-rebuild/adopt.mjs'), 'utf8').includes('stillWanted(a.ref, a.sha)');
    } catch { return false; }
  },
  async run({ log, matchCandidate = matchReadyCandidate } = {}) {
    const ref = 'lane/churning-overlay';
    const candidateSha = 'a'.repeat(40);
    const descendantSha = 'b'.repeat(40);
    const divergentSha = 'c'.repeat(40);
    // The only non-identity ancestry edge in this closed fixture graph is candidate -> descendant.
    const ancestor = (sha, tip) => sha === candidateSha && tip === descendantSha;
    const ready = {
      kind: 'candidate', prevHead: 'live-head', tree: 'candidate-tree', passedAt: new Date(1000).toISOString(),
      adopt: { finalSha: 'candidate-build', mainSha: 'main-before', inputsKey: 'candidate-inputs', applied: [{ ref, sha: candidateSha }] },
    };
    const violations = [];
    const results = [];
    for (const scenario of [
      { name: 'descendant-advanced', registered: true, tip: descendantSha, adopt: true },
      { name: 'removed-overlay', registered: false, tip: candidateSha, adopt: false },
      { name: 'non-descendant-tip', registered: true, tip: divergentSha, adopt: false },
    ]) {
      const registered = (r) => r === ref && scenario.registered;
      const result = matchCandidate({
        ready,
        plan: { finalSha: 'new-plan', mainSha: 'main-after', inputsKey: scenario.name,
          applied: scenario.registered ? [{ ref, sha: scenario.tip }] : [] },
        prevHead: ready.prevHead, treeOf: () => 'different-tree',
        stillWanted: (r, sha) => registered(r) && Boolean(sha) && (sha === scenario.tip || ancestor(sha, scenario.tip)),
        registered, overlayTip: () => scenario.tip, carries: ancestor,
        verifyBuilt: () => true, liveApplied: [], nowMs: 2000, maxAgeMs: 10000,
      });
      results.push({ scenario: scenario.name, result });
      log?.(`${scenario.name}: ${result.match ?? result.reason}`);
      const valid = scenario.adopt
        ? result.adopt?.finalSha === ready.adopt.finalSha && result.match === 'superseded'
        : result.adopt === null && result.reason === 'overlay-no-longer-wanted';
      if (!valid) violations.push({ invariant: scenario.name, detail: JSON.stringify(result) });
    }
    return { violations, results };
  },
  judge(report) {
    return report.violations.map((v) => `[${v.invariant}] ${v.detail}`);
  },
};
