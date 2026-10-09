/** 2026-10-09 ~04:00Z: seven PRs deadlocked — review refused as scope-bloat, the rebase fix refused as scope-overlap,
 * both judged on GitHub's stale-base, 100-capped PR file lists (card xd1tvd0). */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const FIXTURE = 'scripts/conveyor/__tests__/fixtures/net-scope/stuck-2026-10-09.json';

export default {
  id: 'scope-bloat-net-diff-deadlock',
  title: '#4538 #4536 #4525 #4512 #4479 #4453 #4439: "98 of its 100 files are already on main" and the owed rebase "refused scope-overlap" for 80+ min',
  card: 'xd1tvd0',
  fixedBy: { sha: '38c6a4987', where: 'lane/scope-bloat-deadlock', paths: ['scripts/conveyor/net-scope.mjs', 'scripts/conveyor/scope-bloat.mjs', 'scripts/conveyor/reconcile-fix-dispatch.mjs'] },
  fixPresent(root) { return existsSync(join(root, 'scripts/conveyor/net-scope.mjs')); },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const load = (p) => import(pathToFileURL(join(root, p)).href);
    const { assessScopeBloat } = await load('scripts/conveyor/scope-bloat.mjs');
    const { filterFixesByInFlightScope } = await load('scripts/conveyor/reconcile-fix-dispatch.mjs');
    const { scopeFilesFor, rebaseOverlapExemption } = await load('scripts/conveyor/net-scope.mjs');
    const live = JSON.parse(readFileSync(join(root, FIXTURE), 'utf8'));
    const violations = [];
    for (const p of live.prs.filter((x) => x.number !== 4527)) {
      const files = scopeFilesFor({ net: { ok: true, files: p.netFiles }, listed: p.githubFiles }).files;
      const bloat = assessScopeBloat({ prFiles: files, netFiles: p.twoDotFiles, env: {} });
      if (bloat) violations.push(`#${p.number} still scope-bloat on its net diff: ${bloat.why}`);
    }
    // A stale-base rebase behind a live claim on the same file is still admitted.
    const rebase = { pr: 4439, itemNum: null, scope: ['we:x.mjs'], overlapScope: ['we:x.mjs'], headRefOid: 'a'.repeat(40), scopeBloat: { stale: true, wide: false } };
    const out = filterFixesByInFlightScope([rebase], [], [{ meta: { pr: 4527, scope: ['we:x.mjs'] } }], {
      maxWaitMinutes: null, rebaseExempt: (e) => rebaseOverlapExemption(e, { on: true, used: new Set() }) });
    if (!out.planned.some((e) => e.pr === 4439)) violations.push(`stale-base rebase still refused: ${JSON.stringify(out.refusals.map((r) => r.why))}`);
    return { violations };
  },
  judge(report) { return report.violations; },
};
