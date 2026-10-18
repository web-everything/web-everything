/** PR #5487 routing / #5537 review: an old newline-scoped justification must not strand a new head. */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export default {
  id: 'test-gaming-new-head-stranded',
  title: 'PR #5487 test-gaming repair re-arms after an old head was justified',
  card: 'xxprfth / PR #5537',
  fixedBy: { sha: 'HEAD', where: 'lane/test-gaming-route', paths: ['scripts/conveyor/test-gaming-route.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/conveyor/test-gaming-route.mjs'), 'utf8').includes('const fixEndHead =');
  },
  async run({ sourceRoot } = {}) {
    const root = sourceRoot ?? process.env.SOAK_TREE_ROOT ?? resolve(fileURLToPath(import.meta.url), '../../../../..');
    const { sweepTestGamingRoutes } = await import(pathToFileURL(join(root, 'scripts/conveyor/test-gaming-route.mjs')).href);
    const { runReviewTick } = await import(pathToFileURL(join(root, 'skills-src/conveyor/review-daemon.mjs')).href);
    const { planReconcile } = await import(pathToFileURL(join(root, 'scripts/conveyor/reconcile-core.mjs')).href);
    const fx = JSON.parse(readFileSync(join(root, 'scripts/conveyor/__tests__/fixtures/pr-ownership/pr-5157-before-ci-heal.json'), 'utf8'));
    const pr = fx.pr, repo = 'web-everything/web-everything', old = 'a'.repeat(40), head = 'b'.repeat(40);
    pr.number = 5487;
    pr.headRefOid = old;
    pr.labels = [{ name: 'review:pending' }];
    pr.comments = [];
    pr.statusCheckRollup.filter(r => r.name === 'merge-gate').at(-1).mergeGateReviewHold = { holds: ['test-gaming'], jobId: 1 };
    const verdict = { num: pr.number, head_sha: old, ok: false, results: [
      { id: 'test-gaming', status: 'hold', reason: 'test-gaming suspected: tests-removed: tests/removed.test.mjs (net 1 test case(s) removed)' },
    ] };
    const bot = body => ({ body, author: { login: 'web-everything' } });
    const provider = {
      readPrState: () => structuredClone(pr),
      postComment: (_repo, _n, body) => pr.comments.push(bot(body)),
      setLabels: (_repo, _n, { add, remove = [] }) => {
        pr.labels = pr.labels.filter(l => !remove.includes(l.name));
        if (add && !pr.labels.some(l => l.name === add)) pr.labels.push({ name: add });
      },
    };
    const notices = [], plans = [], reviews = [];
    const route = args => sweepTestGamingRoutes({ ...args, provider, readVerdict: () => verdict,
      readComments: () => structuredClone(pr.comments), enabled: true, notify: item => notices.push(item) });
    route({ repo, prs: [pr] });
    pr.comments.push(bot(`🔓 conveyor fix-end — fix claim released\n\nat \`${old.slice(0, 9)}\`\n\ntest-removal-justified: old behaviour removed`));
    pr.headRefOid = verdict.head_sha = head;
    runReviewTick({ repo, readPrs: () => [structuredClone(pr)], readAgents: () => [], routeTestGaming: route,
      holdReconcile: () => [], tagRound: () => {}, tagStatus: () => {}, dispatch: item => reviews.push(item),
      onPlan: ({ plan }) => plans.push(plan),
      reconcile: ({ readPrs }) => planReconcile({ repo: 'we', prs: readPrs(), now: Date.parse(fx.observedAt),
        requiredChecks: ['test', 'smoke', 'daemon-soak', 'soak-replay-gate', 'merge-gate'], advisoryReviewOnHumanHandoff: 'on' }),
    });
    const violations = [];
    if (notices.length) violations.push('old-head justification was forwarded to needs-you');
    if (!pr.comments.some(c => c.body.includes(`<!-- test-gaming-route: ${head} -->`))) violations.push('new head received no binding repair finding');
    if (!plans.some(p => p.dispatch.some(d => d.kind === 'fix'))) violations.push('daemon plan did not offer the new-head repair to the fix dispatcher');
    if (reviews.length) violations.push('a competing review was dispatched');
    if (pr.statusCheckRollup.filter(r => r.name === 'merge-gate').at(-1).conclusion !== 'FAILURE') violations.push('merge-gate hold was cleared');
    return { violations };
  },
  judge(report) { return report.violations; },
};
