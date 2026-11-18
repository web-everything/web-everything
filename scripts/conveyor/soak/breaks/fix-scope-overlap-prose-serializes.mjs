/** 2026-11-17/18: #6945 waited ~50 min behind #6949, and #7028 sat 3rd in line behind #7042 and #7031, only because
 * the PRs shared one backlog card or `docs/agent/testing.md`. Prose merges trivially and must not serialize fixes. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export default {
  id: 'fix-scope-overlap-prose-serializes',
  title: '#6945 behind #6949 (backlog card), #7028 behind #7042/#7031 (docs/agent/testing.md): a shared prose file refused the fix as scope-overlap',
  card: 'fix-scope-overlap-prose',
  fixedBy: { sha: 'd7881bc7f6', where: 'lane/fix-scope-overlap-prose-globs', paths: ['scripts/conveyor/fix-scope-policy.mjs', 'scripts/conveyor/reconcile-fix-dispatch.mjs'] },
  fixPresent(root) {
    const p = join(root, 'scripts/conveyor/fix-scope-policy.mjs');
    return existsSync(p) && readFileSync(p, 'utf8').includes('FIX_OVERLAP_PROSE_GLOBS');
  },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const { filterFixesByInFlightScope } = await import(pathToFileURL(join(root, 'scripts/conveyor/reconcile-fix-dispatch.mjs')).href);
    const fix = (pr, files) => ({ pr, itemNum: null, scope: files, overlapScope: files, headRefOid: String(pr).padEnd(40, 'a') });
    const violations = [];
    for (const shared of ['we:docs/agent/testing.md', 'we:backlog/6949-card.md']) {
      const out = filterFixesByInFlightScope([fix(7028, [shared, 'we:a.mjs'])], [], [{ meta: { pr: 7042, scope: [shared, 'we:b.mjs'] } }], { maxWaitMinutes: null });
      if (!out.planned.some((e) => e.pr === 7028)) violations.push(`#7028 refused over shared prose ${shared}: ${JSON.stringify(out.refusals.map((r) => r.why))}`);
    }
    const code = filterFixesByInFlightScope([fix(7028, ['we:x.mjs'])], [], [{ meta: { pr: 7042, scope: ['we:x.mjs'] } }], { maxWaitMinutes: null });
    if (code.planned.length) violations.push('a shared CODE file no longer serializes the fix');
    return { violations };
  },
  judge(report) { return report.violations; },
};
