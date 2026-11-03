/** PR #6254 (2026-11-02, D-R338): an open, green, non-draft BOT PR on a non-lane head with no review:* label was `nothing-owed` 13x. */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const done = (name) => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '2026-11-02T15:20:00Z' });

export default {
  id: 'unlabelled-bot-pr-on-non-lane-head-nothing-owed',
  title: 'PR #6254: an unlabelled open green bot PR on a non-lane head (ci/refresh-test-timings) is refused nothing-owed forever and never reviewed',
  card: 'D-R338 reconcile treats no labels as already reviewed',
  fixedBy: { sha: '2665d4226207d8f4c81a970c06cafa60f1cc08da,49e6b4224b463a6a6d6a0092369d0d42a6295e1a,99634539ae2deccbd1f6bfa73759bb038708ee80,28b0aa9fb78fbfe4e723229a1d21974f8e38e678', where: 'lane/reconcile-unlabelled-nonlane-pr', paths: ['scripts/conveyor/reconcile-core.mjs'] },
  // Always present: the fix ships in the same PR as this break, so a reproduced violation must FAIL the gate (never an expected-fail escape).
  fixPresent() { return true; },
  async run() {
    const root = process.env.SOAK_TREE_ROOT || new URL('../../../../', import.meta.url).pathname;
    const { planReconcile, greenSettledForRestoreGrace } = await import(pathToFileURL(join(root, 'scripts/conveyor/reconcile-core.mjs')).href);
    const { mapGraphqlPr } = await import(pathToFileURL(join(root, 'scripts/lib/pr-list-paged.mjs')).href);
    const pr = { number: 6254, state: 'OPEN', headRefName: 'ci/refresh-test-timings', headRefOid: 'f81bcb488ef9fdb3a38ea92fac80830b17753b69',
      author: { login: 'app/web-everything', is_bot: true }, isDraft: false, labels: [], comments: [], mergeStateStatus: 'CLEAN',
      statusCheckRollup: ['test', 'smoke', 'daemon-soak'].map(done) };
    const plan = planReconcile({ prs: [pr], agents: [], durableCounts: {}, now: Date.parse('2026-11-02T16:00:00Z'),
      requiredChecks: ['test', 'smoke', 'daemon-soak'] });
    const violations = [];
    if (!plan.dispatch.some((d) => d.prNumber === 6254 && d.kind === 'restore-review-label')) {
      violations.push(`PR #6254 (open, green, bot, no review label) was not owed a label: ${JSON.stringify(plan.refusals.map((r) => r.kind))}`);
    }
    // PR #6296 red-team: the real paged mapper exposes StatusContext.createdAt as startedAt.
    const mapped = mapGraphqlPr({ commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes: [
      done('test'), { __typename: 'StatusContext', context: 'external-ci', state: 'SUCCESS', createdAt: '2026-11-02T15:20:00Z' },
    ] } } } }] } });
    for (const now of ['2026-11-02T16:20:00Z', '2026-11-03T16:20:00Z']) {
      const mixed = planReconcile({ prs: [{ ...pr, statusCheckRollup: mapped.statusCheckRollup }], agents: [], durableCounts: {},
        now: Date.parse(now), requiredChecks: ['test'] });
      if (!mixed.dispatch.some((d) => d.prNumber === 6254 && d.kind === 'restore-review-label' && d.label === 'review:pending')) {
        violations.push(`Successful optional StatusContext still prevents review restoration at ${now}`);
      }
    }
    // PR #6296 send-back: grace must use the same winning rows as CI truth and reject mapper zero dates.
    const cases = [
      { name: 'legacy failure superseded by CheckRun', nodes: [
        { __typename: 'StatusContext', context: 'test', state: 'FAILURE', createdAt: '2026-11-02T15:00:00Z' }, done('test'),
      ], owed: true },
      { name: 'optional queued run', nodes: [done('test'),
        { __typename: 'CheckRun', name: 'optional', status: 'QUEUED', conclusion: null, completedAt: null },
      ], owed: false },
      { name: 'optional run freshly completed', nodes: [done('test'),
        { ...done('optional'), completedAt: '2026-11-02T16:00:00Z' },
      ], owed: false },
      { name: 'optional run completed and settled', nodes: [done('test'), done('optional')], owed: true },
    ];
    for (const { name, nodes, owed } of cases) {
      const mappedCase = mapGraphqlPr({ commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes, pageInfo: { hasNextPage: false } } } } }] } });
      const result = planReconcile({ prs: [{ ...pr, statusCheckRollup: mappedCase.statusCheckRollup }], agents: [],
        now: Date.parse('2026-11-02T16:00:00Z'), requiredChecks: ['test'] });
      if (result.dispatch.some((d) => d.kind === 'restore-review-label') !== owed) {
        violations.push(`${name}: expected restore-review-label=${owed}`);
      }
    }
    // PR #6296 operator send-back: hidden same-name timing and unread check pages cannot prove grace.
    for (const contexts of [
      { nodes: [{ ...done('test'), completedAt: null }, done('test')], pageInfo: { hasNextPage: false } },
      { nodes: [done('test'), { ...done('test'), completedAt: 'unreadable' }], pageInfo: { hasNextPage: false } },
      { nodes: [done('test')], pageInfo: { hasNextPage: true } },
      { nodes: [done('test')] },
    ]) {
      const mappedCase = mapGraphqlPr({ commits: { nodes: [{ commit: { statusCheckRollup: { contexts } } }] } });
      const result = planReconcile({ prs: [{ ...pr, ...mappedCase, number: pr.number,
        headRefName: pr.headRefName, author: pr.author, labels: [] }], agents: [],
        now: Date.parse('2026-11-02T16:00:00Z'), requiredChecks: ['test'] });
      if (result.dispatch.some(d => d.kind === 'restore-review-label')) {
        violations.push(`Incomplete check evidence restored review: ${JSON.stringify(contexts)}`);
      }
    }
    // A queued rerun must not turn a fresh completion into settled non-strict grace.
    for (const status of ['QUEUED', 'IN_PROGRESS']) {
      const rollup = [
        { ...done('test'), completedAt: '2026-11-02T15:59:00Z' },
        { __typename: 'CheckRun', name: 'test', status, conclusion: null, startedAt: '2026-11-02T15:59:30Z', completedAt: null },
      ];
      const now = Date.parse('2026-11-02T16:00:00Z');
      for (const strict of [false, true]) {
        if (greenSettledForRestoreGrace(rollup, now, undefined, { strict })) {
          violations.push(`${status} rerun bypassed the grace window (strict=${strict})`);
        }
      }
      const stacked = planReconcile({ prs: [{ ...pr, headRefName: 'lane/child', baseRefName: 'lane/parent', statusCheckRollup: rollup }],
        agents: [], now, requiredChecks: ['test'] });
      if (stacked.dispatch.some(d => d.kind === 'restore-review-label')) {
        violations.push(`${status} rerun prematurely restored the stacked lane PR's review label`);
      }
    }
    return { violations };
  },
  judge(report) { return report.violations; },
};
