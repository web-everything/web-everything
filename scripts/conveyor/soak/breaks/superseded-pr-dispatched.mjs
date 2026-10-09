/** Live #4522: a merged superseder must stop fresh dispatch and remain idempotent. */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export default {
  id: 'superseded-pr-dispatched',
  card: 'xiqtf7w',
  title: '#4532 merged with "Supersedes #4522"; fix-4522 still launched at 04:34Z',
  fixedBy: { sha: '8509c022b', where: 'lane/fixd-supersede-verdict', paths: [
    'scripts/conveyor/supersede-rule.mjs', 'scripts/conveyor/supersede-watch.mjs',
    'scripts/conveyor/stand-down.mjs', 'skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs',
  ] },
  fixPresent(root) { return existsSync(join(root, 'scripts/conveyor/supersede-rule.mjs')); },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const violations = [];
    if (!this.fixPresent(root)) return { violations: ['supersede hold rule is absent; #4522 remains dispatchable'] };
    const { planSupersedeHolds, parseSupersedes } = await import(pathToFileURL(join(root, 'scripts/conveyor/supersede-rule.mjs')).href);
    const { buildSupersededStandDownComment } = await import(pathToFileURL(join(root, 'scripts/conveyor/stand-down.mjs')).href);
    const { countUnresolvedStandDowns } = await import(pathToFileURL(join(root, 'scripts/conveyor/reconcile-core.mjs')).href);
    const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../__tests__/fixtures/supersede/pr4522-2026-10-09.json'), 'utf8'));
    const input = { mergedPrs: [fixture.merged], openPrs: [fixture.open], settings: { hold: true } };
    const hold = planSupersedeHolds(input).find((h) => h.pr === 4522 && h.by === 4532);
    if (!hold) violations.push('no hold for #4522 superseded by merged #4532');
    else {
      const comments = [...fixture.open.comments, { author: { login: 'web-everything' }, body: buildSupersededStandDownComment(hold) }];
      if (countUnresolvedStandDowns(comments) <= 0) violations.push('superseded stand-down does not block reconcile dispatch');
      if (planSupersedeHolds({ ...input, openPrs: [{ ...fixture.open, comments }] }).length) violations.push('supersede hold re-planned after trusted comment');
    }
    // PR #4560 review: a Supersedes line inside a nested/mixed fence is documentation, never a hold on an unrelated PR.
    for (const body of ['````md\n```\nSupersedes #4522\n```\nSupersedes #4523\n````', '~~~\n```\nSupersedes #4522\n~~~']) {
      if (parseSupersedes(body).length) violations.push(`fenced example read as a supersede marker: ${JSON.stringify(body)}`);
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};
