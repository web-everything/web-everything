/** PR #5487 / #5537: routing and reclaim must preserve unfinished findings. */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export default {
  id: 'test-gaming-new-head-stranded',
  title: 'PR #5487 test-gaming routing preserves unfinished findings and re-arms new heads',
  card: 'xxprfth / PR #5537',
  fixedBy: { sha: 'HEAD', where: 'lane/test-gaming-route', paths: ['scripts/conveyor/test-gaming-route.mjs'] },
  fixPresent(root) {
    const source = readFileSync(join(root, 'scripts/conveyor/test-gaming-route.mjs'), 'utf8');
    return source.includes('const fixEndHead =') && source.includes('ended && isLatestAdvisoryFindingAddressed(comments)')
      && source.includes('unresolved advisory finding');
  },
  async run({ sourceRoot } = {}) {
    const root = sourceRoot ?? process.env.SOAK_TREE_ROOT ?? resolve(fileURLToPath(import.meta.url), '../../../../..');
    const { sweepTestGamingRoutes } = await import(pathToFileURL(join(root, 'scripts/conveyor/test-gaming-route.mjs')).href);
    const { runReviewTick } = await import(pathToFileURL(join(root, 'skills-src/conveyor/review-daemon.mjs')).href);
    const { planReconcile } = await import(pathToFileURL(join(root, 'scripts/conveyor/reconcile-core.mjs')).href);
    const { buildFixEndComment } = await import(pathToFileURL(join(root, 'scripts/conveyor/fix-procedure.mjs')).href);
    const { buildAdvisoryFixComment } = await import(pathToFileURL(join(root, 'scripts/conveyor/advisory-fix-mark.mjs')).href);
    const { ADVISORY_NOTE_MARKER } = await import(pathToFileURL(join(root, 'scripts/conveyor/advisory-round-count.mjs')).href);
    const { CONVERTED_ADVISORY_NOTE_MARKER } = await import(pathToFileURL(join(root, 'scripts/lib/review-escalation.mjs')).href);
    const fx = JSON.parse(readFileSync(join(root, 'scripts/conveyor/__tests__/fixtures/pr-ownership/pr-5157-before-ci-heal.json'), 'utf8'));
    const pr = fx.pr, repo = 'test-gaming-fixture/example', old = 'a'.repeat(40), head = 'b'.repeat(40);
    pr.number = 5487;
    pr.headRefOid = old;
    pr.labels = [{ name: 'review:pending' }];
    pr.comments = [];
    pr.statusCheckRollup.filter(r => r.name === 'merge-gate').at(-1).mergeGateReviewHold = { holds: ['test-gaming'], jobId: 1 };
    const verdict = { num: pr.number, head_sha: old, ok: false, results: [
      { id: 'test-gaming', status: 'hold', reason: 'test-gaming suspected: tests-removed: tests/removed.test.mjs (net 1 test case(s) removed)' },
    ] };
    const initial = structuredClone(pr);
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
    const tick = () => runReviewTick({ repo, readPrs: () => [structuredClone(pr)], readAgents: () => [], routeTestGaming: route,
      holdReconcile: () => [], tagRound: () => {}, tagStatus: () => {}, dispatch: item => reviews.push(item),
      onPlan: ({ plan }) => plans.push(plan),
      reconcile: ({ readPrs }) => planReconcile({ repo: 'we', prs: readPrs(), now: Date.parse(fx.observedAt),
        requiredChecks: ['test', 'smoke', 'daemon-soak', 'soak-replay-gate', 'merge-gate'], advisoryReviewOnHumanHandoff: 'on' }),
    });
    tick();
    const violations = [];
    if (notices.length) violations.push('old-head justification was forwarded to needs-you');
    if (!pr.comments.some(c => c.body.includes(`<!-- test-gaming-route: ${head} -->`))) violations.push('new head received no binding repair finding');
    if (!plans.some(p => p.dispatch.some(d => d.kind === 'fix'))) violations.push('daemon plan did not offer the new-head repair to the fix dispatcher');
    if (reviews.length) violations.push('a competing review was dispatched');
    if (pr.statusCheckRollup.filter(r => r.name === 'merge-gate').at(-1).conclusion !== 'FAILURE') violations.push('merge-gate hold was cleared');

    // A reclaimed worker's production claim-release sentence is not repair evidence.
    Object.assign(pr, structuredClone(initial));
    verdict.head_sha = old;
    route({ repo, prs: [pr] });
    pr.comments.push(bot(buildFixEndComment({ who: 'fix-5537', headSha: old })));
    for (let retry = 0; retry < 2; retry++) {
      plans.length = reviews.length = 0;
      tick();
      if (!pr.labels.some(l => l.name === 'advisory:changes')) violations.push('reclaimed unfinished repair lost advisory:changes');
      if (!plans.some(p => p.dispatch.some(d => d.kind === 'fix'))) violations.push('reclaimed unfinished repair is not eligible for a fixer');
    }
    if (pr.comments.filter(c => c.body.includes(`<!-- test-gaming-route: ${old} -->`)).length !== 1) violations.push('reclaim posted a duplicate route');

    // The latest advisory is binding fixer input: let an earlier defect finish first.
    for (const { marker, hasLabel } of [ADVISORY_NOTE_MARKER, CONVERTED_ADVISORY_NOTE_MARKER]
      .flatMap(marker => [true, false].map(hasLabel => ({ marker, hasLabel })))) {
      Object.assign(pr, structuredClone(initial));
      pr.labels = [{ name: 'review:human' }, ...(hasLabel ? [{ name: 'advisory:changes' }] : [])];
      const finding = `${marker}\n\n**Verdict:** Changes requested\n\n**Advisory outcome:** \`changes\`\n\nAdmitted finding: reject unauthenticated DELETE requests\n\n---\n\nNet basis: \`${'0'.repeat(40)}..${hasLabel ? old : head}\``;
      pr.comments.push(bot(finding));
      plans.length = reviews.length = 0;
      tick();
      if (pr.comments.at(-1).body !== finding) violations.push('initial route superseded an unresolved advisory finding');
      if (hasLabel && !plans.some(p => p.dispatch.some(d => d.kind === 'fix'))) violations.push('existing advisory finding lost its fixer');
      pr.comments.push(bot(buildAdvisoryFixComment({})));
      tick();
      if (!pr.comments.at(-1).body.includes(`<!-- test-gaming-route: ${old} -->`)) violations.push('test-removal route did not resume after prior repair');
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};
