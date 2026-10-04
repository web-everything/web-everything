/**
 * @file breaks/pr-scoped-gate-red-never-healed.mjs — live break, 2026-10-04 (PR #3903). A PR red only on
 * `soak-replay-gate` was never dispatched a ci-heal.
 *
 * LIVE INCIDENT: PR #3903 (`review:pending`, `review-status:awaiting-ci`, `test` green) failed the required
 * `soak-replay-gate` at 16:24:27Z ("touches daemon-soak scope … adds no soak break"). Main's own CI happened to be
 * red then, so `failingRequiredCheckForAttribution` attributed the failure to main and the planner refused
 * `owed-ci-rerun` ("owed a mechanical rebase onto main once main has recovered") every tick. No ci-heal ran and
 * the review daemon sat at awaiting-ci. But `soak-replay-gate` judges only the PR's own diff: no rebase clears it.
 *
 * FIX — `main-red-recovery.mjs#DEFAULT_PR_SCOPED_CHECKS` (configurable via `WE_PR_SCOPED_CHECKS`): a failing
 * PR-scoped check is never main-attributable, so the ordinary ci-red → ci-heal path owns it.
 *
 * SCENARIO: the #3903 row, run the way `reconcile-pass.mjs` runs it (attribution facts, then `planReconcile`)
 * inside a main-red window. RED = no ci-heal is dispatched for it. GREEN = one is.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const NOW = Date.parse('2026-10-04T17:10:00Z');
const REQUIRED = ['test', 'smoke', 'daemon-soak', 'soak-replay-gate'];
const WINDOWS = [{ start: '2026-10-04T16:00:00Z', end: '2026-10-04T16:50:00Z' }];
const run = (name, conclusion, completedAt) => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion, completedAt });

export default {
  id: 'pr-scoped-gate-red-never-healed',
  title: 'a PR red only on the PR-scoped soak-replay-gate was attributed to a red main and never ci-healed',
  card: 'red soak-replay-gate never healed — live PR #3903, 2026-10-04',
  fixedBy: { sha: '393b3de64', where: 'lane/pr-scoped-checks-ciheal', paths: ['scripts/conveyor/main-red-recovery.mjs'] },
  fixPresent(root) {
    const p = join(root, 'scripts/conveyor/main-red-recovery.mjs');
    return existsSync(p) && readFileSync(p, 'utf8').includes('DEFAULT_PR_SCOPED_CHECKS');
  },
  async run({ log } = {}) {
    // reconcile-core first: it and main-red-recovery import each other, and this is the order the pass loads them.
    const { planReconcile } = await import('../../reconcile-core.mjs');
    const { failingRequiredCheckForAttribution } = await import('../../main-red-recovery.mjs');
    const pr = {
      number: 3903, state: 'OPEN', isDraft: false, mergeStateStatus: 'BLOCKED', headRefOid: '00a3ad1f5'.padEnd(40, '0'),
      labels: [{ name: 'review:pending' }, { name: 'review-status:awaiting-ci' }],
      statusCheckRollup: [
        run('test', 'SUCCESS', '2026-10-04T16:30:00Z'), run('smoke', 'SUCCESS', '2026-10-04T16:20:00Z'),
        run('daemon-soak', 'SUCCESS', '2026-10-04T16:26:00Z'), run('soak-replay-gate', 'FAILURE', '2026-10-04T16:24:27Z'),
      ],
      comments: [],
    };
    const failing = failingRequiredCheckForAttribution(pr, { requiredChecks: REQUIRED, mainRedWindows: WINDOWS });
    const row = { ...pr, requiredCheckName: failing?.name ?? null, requiredCheckCompletedAt: failing?.completedAt ?? null, aheadByOnMain: 12 };
    const plan = planReconcile({ prs: [row], agents: [], now: NOW, mainRedWindows: WINDOWS, requiredChecks: REQUIRED });
    const heals = (plan.dispatch || []).filter((d) => d.prNumber === 3903 && d.kind === 'ci-heal');
    const refused = (plan.refusals || []).filter((r) => r.prNumber === 3903).map((r) => `${r.kind}: ${String(r.why || '').slice(0, 120)}`);
    log?.(JSON.stringify({ heals: heals.length, refused }));
    const violations = heals.length ? [] : [{ invariant: 'owed', detail: `PR #3903 red only on soak-replay-gate got no ci-heal — ${refused.join(' | ') || 'no row'}` }];
    return { violations };
  },
  judge(report) {
    return report.violations.map((v) => `[${v.invariant}] ${v.detail}`);
  },
};
