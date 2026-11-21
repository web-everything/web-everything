/** A smoked candidate carrying a withdrawn overlay must never be adopted. */
import { matchReadyCandidate, reportDiscardedCandidate } from '../../../lib/daemon-rebuild/adopt.mjs';

function options(path, removed) {
  const ref = 'lane/withdrawn';
  const adopt = { finalSha: 'candidate', inputsKey: 'ready', applied: [{ ref, sha: 'tip' }] };
  const ready = { kind: 'candidate', prevHead: 'live', passedAt: new Date(1000).toISOString(),
    tree: 'candidate-tree', adopt };
  const plan = { finalSha: path === 'exact' ? adopt.finalSha : 'new-plan', inputsKey: 'new', alerts: [] };
  if (path === 'fallback') Object.assign(ready, { kind: 'fallback', forInputsKey: plan.inputsKey, dropRefs: [] });
  return { ready, plan, prevHead: 'live', nowMs: 2000, maxAgeMs: 10000,
    treeOf: () => path === 'same-tree' ? ready.tree : 'other-tree',
    stillWanted: () => !removed, registered: () => !removed,
    verifyBuilt: () => true, liveApplied: [],
    // A retirement claim must not license benign-removal adoption.
    leftForMain: () => true, contentInBuild: () => true };
}

export default {
  id: 'ready-candidate-removed-overlay-refused',
  title: 'a candidate carrying a removed overlay is discarded, never adopted',
  card: '#7171',
  fixedBy: { sha: 'removed-overlay-refusal', where: '#7171', paths: ['scripts/lib/daemon-rebuild/adopt.mjs'] },
  fixPresent() {
    return ['exact', 'same-tree', 'superseded', 'fallback'].every((path) => {
      const result = matchReadyCandidate(options(path, true));
      return !result.adopt && result.reason === 'overlay-no-longer-wanted';
    });
  },
  async run() {
    const violations = [];
    for (const path of ['exact', 'same-tree', 'superseded', 'fallback']) {
      const control = matchReadyCandidate(options(path, false));
      if (!control.adopt || control.match !== path) throw new Error(`fixture missed ${path}: ${JSON.stringify(control)}`);
      const args = options(path, true);
      const match = matchReadyCandidate(args);
      const alerts = [];
      if (!match.adopt) reportDiscardedCandidate({ ready: args.ready, match,
        alert: (kind, detail) => alerts.push({ kind, detail }), needsYou: () => {} });
      if (match.adopt || match.reason !== 'overlay-no-longer-wanted'
        || !alerts.some((event) => event.kind === 'ready-candidate-discarded'
          && event.detail.reason === 'overlay-no-longer-wanted')) {
        violations.push({ invariant: 'removed-overlay-not-discarded', detail: `${path}: ${JSON.stringify(match)}` });
      }
    }
    return { violations };
  },
  judge(report) { return report.violations.map((v) => `[${v.invariant}] ${v.detail}`); },
};
