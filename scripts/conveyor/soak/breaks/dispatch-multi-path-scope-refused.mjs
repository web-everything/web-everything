/**
 * R372 (2026-11-02): PR #6193 was review:changes and conflicting. The fix daemon launched its fixer, then dispatch-lane
 * refused the card's `{{SCOPE}}` because one `scope:` entry named two space-separated paths, so the fixer never ran and
 * the PR stayed stuck. The loader must flatten the entry and dispatch-lane must carry the list, still failing closed on
 * any unsafe piece.
 */
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export default {
  id: 'dispatch-multi-path-scope-refused',
  title: 'PR #6193: a card scope entry with two space-separated paths is refused by dispatch-lane, so the fix daemon\'s fixer never runs',
  card: 'R372 dispatch-lane multi-path scope',
  fixedBy: { sha: '26dcfecacf,24dd70eef0,e06e2a9d26,032d972ef2,f8f35ead7d,265ada1f58', where: 'lane/dispatch-scope-multi', paths: ['scripts/operations/dispatch-lane.mjs', 'src/_data/backlog.js'] },
  // The fix ships in the same PR as this break, so it is required to pass from the first tree that carries it: no
  // source-marker escape into the expected-fail fallback (removing the fix must turn the gate red, not green).
  fixPresent() { return true; },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const violations = [];
    const { normalizeScope } = createRequire(import.meta.url)(join(root, 'src/_data/backlog.js'));
    const loaded = normalizeScope?.(['we:scripts/readiness/heavy-admission.mjs scripts/readiness/remote-exec.mjs']) ?? [];
    if (loaded.length !== 2) violations.push('the loader left a multi-path scope entry unsplit');
    const { shapeDispatchRead } = await import(pathToFileURL(join(root, 'scripts/operations/dispatch-lane.mjs')).href);
    const read = (scope) => shapeDispatchRead({
      resolvedNum: '3037',
      launch: { num: '3037', lane: 8 },
      suppressed: null,
      item: { num: '3037', slug: 'x', specPath: 'backlog/3037-x.md', scope },
      briefTemplate: 'scope: {{SCOPE}}',
      nextState: { tick: 1, buildGuards: [{ num: '3037', lane: 8, spawnedTick: 0 }] },
      dispatchedGuard: { num: '3037', lane: 8, spawnedTick: 0 },
      notes: [], droppedBookkeepingKeys: [],
      inFlightDispatches: { runs: [], unreadable: 0, livenessSource: 'not-needed' },
      bookkeepingSource: 'file',
      observedAt: '2026-08-13T10:00:00.000Z',
      repoTokens: { WE_ROOT: root },
    }, { num: '3037' });
    const want = ['we:scripts/readiness/heavy-admission.mjs', 'we:scripts/readiness/remote-exec.mjs'];
    try {
      const shaped = read(['we:scripts/readiness/heavy-admission.mjs scripts/readiness/remote-exec.mjs']);
      if (shaped.dispatching !== true) violations.push('the multi-path scope did not dispatch');
      if (JSON.stringify(shaped.scope) !== JSON.stringify(want)) violations.push(`the dispatched scope is ${JSON.stringify(shaped.scope)}, not ${JSON.stringify(want)}`);
      if (!String(shaped.prompt).includes(`scope: ${want.join(',')}`)) violations.push('the brief does not carry the comma-joined lease scope');
    } catch (e) { violations.push(`dispatch refused the flattened scope: ${String(e.message).slice(0, 120)}`); }
    try { read(['we:a.mjs ../b.mjs']); violations.push('an unsafe piece (`..`) was accepted'); } catch { /* fail closed */ }
    return { violations };
  },
  judge(report) { return report.violations; },
};
