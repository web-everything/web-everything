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
    return source.includes('const fixEndHead =') && source.includes('isLatestAdvisoryFindingAddressed(episode)')
      && source.includes('unresolved advisory finding') && source.includes("newest?.outcome === 'accept'")
      && source.includes('pendingNoticeMarker') && source.includes('publishAttention({ ...item');
  },
  async run({ sourceRoot } = {}) {
    const root = sourceRoot ?? process.env.SOAK_TREE_ROOT ?? resolve(fileURLToPath(import.meta.url), '../../../../..');
    const { sweepTestGamingRoutes } = await import(pathToFileURL(join(root, 'scripts/conveyor/test-gaming-route.mjs')).href);
    const { runReviewTick } = await import(pathToFileURL(join(root, 'skills-src/conveyor/review-daemon.mjs')).href);
    const { defaultReadPrs } = await import(pathToFileURL(join(root, 'scripts/conveyor/reconcile-pass.mjs')).href);
    const { sweepAdvisoryLabels } = await import(pathToFileURL(join(root, 'scripts/conveyor/advisory-label-sweep.mjs')).href);
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
    let failDelivery = false;
    const route = args => sweepTestGamingRoutes({ ...args, provider, readVerdict: () => verdict,
      readComments: () => structuredClone(pr.comments), enabled: true, notify: item => {
        if (failDelivery) { failDelivery = false; throw Error('feed unavailable'); }
        notices.push(item);
      } });
    const violations = [];
    // PR #5537 advisory: a completed pass on the still-held head must reach
    // the operator, and a failed ruling comment must not duplicate feed notices.
    for (const completed of [false, true]) {
      Object.assign(pr, structuredClone(initial));
      route({ repo, prs: [pr] });
      if (completed) pr.comments.push(bot(buildAdvisoryFixComment({})));
      pr.comments.push(bot(buildFixEndComment({ who: 'fix-5537', headSha: old })
        + (completed ? '' : '\n\ntest-removal-justified: obsolete behaviour removed')));
      const before = notices.length, post = provider.postComment;
      provider.postComment = () => { throw Error('ruling comment unavailable'); };
      route({ repo, prs: [pr], log: () => {} });
      provider.postComment = post;
      if (notices.length !== before) violations.push('feed was notified before ruling comment persisted');
      failDelivery = true;
      route({ repo, prs: [pr], log: () => {} });
      for (let retry = 0; retry < 2; retry++) {
        route({ repo, prs: [pr] });
        sweepAdvisoryLabels({ repo, listPrs: () => [structuredClone(pr)], readPr: () => structuredClone(pr), provider });
      }
      if (notices.length !== before + 1) violations.push('still-held pass did not notify exactly once');
      if (planReconcile({ repo: 'we', prs: [pr], now: Date.parse(fx.observedAt),
        requiredChecks: ['test', 'smoke', 'daemon-soak', 'soak-replay-gate', 'merge-gate'],
        advisoryReviewOnHumanHandoff: 'on' }).dispatch.some(d => d.kind === 'fix')) violations.push('terminal held pass dispatched another fixer');
    }
    Object.assign(pr, structuredClone(initial));
    const removal = verdict.results[0].reason;
    verdict.results[0].reason += '; skip-only: tests/skipped.test.mjs';
    route({ repo, prs: [pr] });
    if (pr.comments.length) violations.push('mixed skipped/removal finding entered removal-only route');
    verdict.results[0].reason = removal;

    for (const marker of [ADVISORY_NOTE_MARKER, CONVERTED_ADVISORY_NOTE_MARKER]) {
      Object.assign(pr, structuredClone(initial));
      route({ repo, prs: [pr] });
      pr.comments.push(bot(`${marker}\n\n**Verdict:** Changes requested\n\n**Advisory outcome:** \`changes\`\n\nAdmitted finding: unrelated defect\n\nNet basis: \`${'0'.repeat(40)}..${old}\``),
        bot(buildAdvisoryFixComment({})), bot(buildFixEndComment({ who: 'other-fix', headSha: old })));
      const routed = route({ repo, prs: [pr] });
      if (routed[0]?.action !== 'admitted') violations.push('unrelated repair completed the removal obligation');
      if (!pr.comments.at(-1).body.includes(`<!-- test-gaming-route: ${old} -->`)) violations.push('removal binding was not restored after unrelated repair');
      if (!planReconcile({ repo: 'we', prs: [pr], now: Date.parse(fx.observedAt),
        requiredChecks: ['test', 'smoke', 'daemon-soak', 'soak-replay-gate', 'merge-gate'],
        advisoryReviewOnHumanHandoff: 'on' }).dispatch.some(d => d.kind === 'fix')) violations.push('removal obligation is no longer actionable');
    }
    Object.assign(pr, structuredClone(initial));
    notices.length = 0;
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

    // Red-team PR #5537: a later acceptance and its label sweep cannot strand
    // an unfinished route, including a reclaimed fixer that released its claim.
    for (const { marker, acceptedHead } of [ADVISORY_NOTE_MARKER, CONVERTED_ADVISORY_NOTE_MARKER, 'Legacy advisory']
      .flatMap(marker => [old, head].map(acceptedHead => ({ marker, acceptedHead })))) {
      Object.assign(pr, structuredClone(initial));
      route({ repo, prs: [pr] });
      pr.comments.push(bot(`${marker}\n\n**Verdict:** Accept\n\n**Advisory outcome:** \`accept\`\n\nNet basis: \`${'0'.repeat(40)}..${acceptedHead}\``));
      for (let retry = 0; retry < 3; retry++) {
        if (retry === 1) pr.comments.push(bot(buildFixEndComment({ who: 'fix-5537', headSha: old })));
        sweepAdvisoryLabels({ repo, listPrs: () => [structuredClone(pr)], readPr: () => structuredClone(pr), provider });
        plans.length = reviews.length = 0;
        tick();
        sweepAdvisoryLabels({ repo, listPrs: () => [structuredClone(pr)], readPr: () => structuredClone(pr), provider });
        if (!pr.labels.some(l => l.name === 'advisory:changes')) violations.push('later accepting advisory stranded the unfinished repair label');
        if (!plans.some(p => p.dispatch.some(d => d.kind === 'fix'))) violations.push('later accepting advisory stranded the unfinished fixer dispatch');
        if (reviews.length) violations.push('later accepting advisory launched a competing review');
      }
      if (pr.comments.filter(c => c.body.includes(`<!-- test-gaming-route: ${old} -->`)).length !== 2) violations.push('acceptance recovery must repost the binding finding exactly once');
      pr.comments.push(bot(buildAdvisoryFixComment({})), bot(buildFixEndComment({ who: 'fix-5537', headSha: old })),
        bot(`${ADVISORY_NOTE_MARKER}\n\n**Verdict:** Accept\n\n**Advisory outcome:** \`accept\`\n\nNet basis: \`${'0'.repeat(40)}..${old}\``));
      sweepAdvisoryLabels({ repo, listPrs: () => [structuredClone(pr)], readPr: () => structuredClone(pr), provider });
      plans.length = reviews.length = 0;
      tick();
      if (plans.some(p => p.dispatch.some(d => d.kind === 'fix'))) violations.push('acceptance reopened an already completed repair');
      if (pr.comments.filter(c => c.body.includes(`<!-- test-gaming-route: ${old} -->`)).length !== 2) violations.push('completed repair was reposted after acceptance');
    }

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
    // Production discovery projects only the fields in its actual gh query.
    for (const label of ['review:pending', 'review:human']) {
      Object.assign(pr, structuredClone(initial));
      pr.labels = [{ name: label }];
      const prs = defaultReadPrs({ repo, exec: (_file, args) => JSON.stringify([
        Object.fromEntries(args[args.indexOf('--json') + 1].split(',').map(field => [field, pr[field]])),
      ]), readCommits: () => [], readComments: () => [] });
      route({ repo, prs });
      if (!pr.labels.some(l => l.name === 'advisory:changes')) violations.push(`production discovery stranded ${label}`);
    }

    // The label sweep must not undo a justification handed to the operator.
    for (const pushed of [false, true]) {
      Object.assign(pr, structuredClone(initial));
      verdict.head_sha = old;
      route({ repo, prs: [pr] });
      if (pushed) pr.headRefOid = verdict.head_sha = head;
      pr.comments.push(bot(buildFixEndComment({ who: 'fix-5537', headSha: pr.headRefOid })
        + '\n\ntest-removal-justified: obsolete behaviour removed'));
      for (let retry = 0; retry < 2; retry++) {
        route({ repo, prs: [pr] });
        sweepAdvisoryLabels({ repo, listPrs: () => [structuredClone(pr)], readPr: () => structuredClone(pr), provider });
        if (pr.labels.some(l => l.name.startsWith('advisory:'))) violations.push('advisory sweep reopened a justified removal');
        const plan = planReconcile({ repo: 'we', prs: [pr], now: Date.parse(fx.observedAt),
          requiredChecks: ['test', 'smoke', 'daemon-soak', 'soak-replay-gate', 'merge-gate'], advisoryReviewOnHumanHandoff: 'on' });
        if (plan.dispatch.some(d => d.kind === 'fix')) violations.push('justified removal offered another fixer after label sweep');
      }
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};
