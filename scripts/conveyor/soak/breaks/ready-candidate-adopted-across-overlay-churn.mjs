/**
 * Break: ref-only ready matching drops a passed candidate when its wanted check requires a recorded tip.
 * Fix: judge each candidate overlay by (ref, sha), accepting equal or descendant wanted tips.
 * Expectation: descendant churn adopts the verified superseded candidate; removed and divergent inputs refuse.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { matchReadyCandidate } from '../../../lib/daemon-rebuild/adopt.mjs';

// Reuse the scenario's positive and negative controls, so moving wanted-tip checks into a helper
// cannot turn a passing regression into an expected failure. Import the matcher from the supplied tree.
const PROBE = `
const { matchReadyCandidate } = await import(process.argv[1]);
if (typeof matchReadyCandidate !== 'function') throw new TypeError('matcher export missing');
const { default: scenario } = await import(process.argv[2]);
const report = await scenario.run({ matchCandidate: matchReadyCandidate });
process.stdout.write(scenario.judge(report).length === 0 ? 'fixed' : 'broken');
`;

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
      const matcher = pathToFileURL(join(root, 'scripts/lib/daemon-rebuild/adopt.mjs')).href;
      const out = execFileSync(process.execPath, ['--input-type=module', '-e', PROBE, matcher, import.meta.url], {
        encoding: 'utf8', timeout: 20_000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
      });
      return out === 'fixed';
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
