/** PR #5877 send-back: both daemon promotion paths must respect a red-team hold. */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../../..');
const PATHS = ['scripts/conveyor/reconcile-core.mjs', 'scripts/operations/promote-draft-pr-dispatch.mjs'];
const HEAD = 'b'.repeat(40);

export default {
  id: 'blocked-draft-reconcile-promotion',
  title: 'the daemon promotes a red-team:blocked draft through reconcile or a stale promotion plan',
  card: 'PR #5877 send-back x1b8hlo item 1; live blocked draft #5839',
  fixedBy: { sha: 'HEAD', where: 'lane/no-merge-red-team-blocked-v2', paths: PATHS },
  fixPresent(root) {
    return PATHS.every(path => {
      try { return readFileSync(join(root, path), 'utf8').includes('red-team:blocked'); }
      catch { return false; }
    });
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const { planReconcile } = await import(pathToFileURL(join(sourceRoot, PATHS[0])).href);
    const { runReconcilePromoteDraftDispatch } = await import(pathToFileURL(join(sourceRoot, PATHS[1])).href);
    const violations = [];
    const check = (ok, why) => { if (!ok) violations.push(why); };
    const plan = labels => planReconcile({
      prs: [{ number: 5839, state: 'OPEN', isDraft: true, isCrossRepository: false,
        headRefName: 'lane/blocked-draft', headRefOid: HEAD, baseRefName: 'main',
        labels, comments: [], mergeStateStatus: 'CLEAN',
        statusCheckRollup: [{ name: 'gate', status: 'completed', conclusion: 'success' }] }],
      agents: [], durableCounts: {}, requiredChecks: ['gate'],
      reviewTiming: { startAfter: 'ci-green' }, now: Date.parse('2026-10-24T18:24:00Z'),
    });
    for (const objectLabels of [false, true]) {
      const labels = status => [objectLabels ? { name: status } : status];
      const blocked = plan(labels('red-team:blocked'));
      const clear = plan(labels('red-team:clear'));
      check(!blocked.dispatch.some(d => d.kind === 'promote-draft'), 'planner promoted a blocked draft');
      check(clear.dispatch.some(d => d.kind === 'promote-draft'), 'planner did not promote the clear control');
      for (const [name, planned, fresh, expected] of [
        ['blocked snapshot', blocked, 'red-team:blocked', 0],
        ['hold added after planning', clear, 'red-team:blocked', 0],
        ['clear control', clear, 'red-team:clear', 1],
      ]) {
        const readyCalls = [];
        const result = runReconcilePromoteDraftDispatch({
          root: sourceRoot, reconcile: () => planned,
          provider: { ready: number => readyCalls.push(number) },
          checkStaleness: () => ({ fresh: true, behind: 0 }),
          readHeadCheckState: () => ({ state: 'green', why: 'required checks succeeded' }),
          readPrLabels: () => labels(fresh), clearAwaitingCi: () => {},
        });
        check(readyCalls.length === expected, `${name}: provider.ready called ${readyCalls.length} times, expected ${expected}`);
        check(result.dispatched.length === expected, `${name}: unexpected dispatch report`);
        log?.(`${objectLabels ? 'object' : 'string'} labels / ${name}: ready calls=${readyCalls.length}, expected=${expected}\n`);
      }
    }
    return { violations };
  },
  judge: report => report.violations,
};
