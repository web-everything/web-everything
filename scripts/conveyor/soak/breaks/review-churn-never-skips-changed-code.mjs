/** R365 fix 4 replay: past the per-PR loop cap a changed head is still reviewed, and one needs-you note is raised. */
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');

export default {
  id: 'review-churn-never-skips-changed-code',
  title: 'a PR past the review loop cap still gets its changed head reviewed, with one needs-you note',
  card: 'R365 fix 4, perf 2026-11-01 (PRs 6158/6033/6141 took 5-13 review loops)',
  fixedBy: { sha: 'HEAD', where: 'lane/r365-rereview-churn', paths: ['scripts/conveyor/review-churn.mjs', 'scripts/conveyor/reconcile-core.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/conveyor/reconcile-core.mjs'), 'utf8').includes('decideReviewChurn(pr)');
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const { planReconcile } = await import(pathToFileURL(join(sourceRoot, 'scripts/conveyor/reconcile-core.mjs')).href);
    const bot = { login: 'web-everything' };
    const sha = (c) => c.repeat(40);
    const accept = (head, h) => ({ author: bot, createdAt: `2026-10-10T0${h}:00:00Z`, body: `✅ review — accepted\n\n<!-- reviewed-sha: ${head} -->` });
    const comments = [accept(sha('a'), 1), accept(sha('b'), 2), accept(sha('c'), 3)];
    const head = sha('d');
    const mk = (settings) => ({ number: 7, headRefName: 'lane/x-thing', headRefOid: head, baseRefName: 'main', isDraft: false,
      createdAt: '2026-10-10T00:00:00Z', labels: [{ name: 'review:pending' }], files: [{ path: 'src/a.mjs' }],
      statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', headSha: head }], comments,
      reviewChurn: { settings, headTree: sha('9'), trees: { [sha('a')]: sha('8') } } });
    const violations = [];
    for (const capMode of ['shadow', 'on']) {
      const plan = planReconcile({ reviewTiming: { startAfter: 'ci-green' }, prs: [mk({ sameTree: 'shadow', capMode, maxLoopsPerPr: 3 })],
        agents: [], durableCounts: {}, now: Date.parse('2026-10-10T20:00:00Z'), requiredChecks: ['test'] });
      const row = plan.dispatch.find((d) => d.prNumber === 7);
      log?.(`capMode=${capMode}: ${row?.kind ?? 'none'}`);
      if (row?.kind !== 'review') violations.push(`capMode=${capMode}: the changed head must still be reviewed`);
      if (capMode === 'on' && !plan.notes.some((n) => n.kind === 'review-churn' && n.prNumber === 7))
        violations.push('the enforcing cap must raise a needs-you note');
      if (capMode === 'shadow' && plan.notes.some((n) => n.kind === 'review-churn'))
        violations.push('shadow must raise no note');
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};
