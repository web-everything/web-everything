/**
 * @file breaks/gate-red-stand-down-blocks-own-ci-heal.mjs — live break, 2026-10-21 (PR #5768, head 3a062c359).
 *
 * LIVE INCIDENT: the fix agent stood down at 18:01Z with `<!-- stand-down reason=gate-red -->` — its gate stayed red
 * only on an out-of-diff test (`daemon-live-smoke.test.mjs` "runLiveSmokeWithRetry forwards changedFiles"), and it
 * never checked whether that test is red on main (it is green there). From then on every fix-dispatch pass logged
 * "own-failure, owed a ci-heal" and refused it `stood-down` — "a fix agent already stopped here to ask a question …
 * terminal on this head" — for ~4h. A gate-red stand-down is a failed gate, not a question for a person.
 *
 * FIX — `reconcile-core.mjs#gateRedRetryState` + `fix.standDown.gateRedRetries` (standard 1): ONE own-failure
 * ci-heal per head, whose brief checks each failing test against main first; a second gate-red (or a spent retry)
 * stays terminal and raises needs-you; a real question stays terminal.
 *
 * SCENARIO: the #5768 row through `planReconcile` with the standard setting. RED = no ci-heal is dispatched.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const NOW = Date.parse('2026-10-21T22:00:00Z');
const REQUIRED = ['test', 'smoke'];
const HEAD = '3a062c359'.padEnd(40, '0');
const run = (name, conclusion, completedAt) => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion, completedAt });

export default {
  id: 'gate-red-stand-down-blocks-own-ci-heal',
  title: 'a gate-red stand-down was read as a question for a person and blocked the PR\'s own owed ci-heal forever',
  card: 'gate-red stand-down terminal — live PR #5768, 2026-10-21',
  fixedBy: { sha: 'lane-gate-red-standdown', where: 'lane/gate-red-standdown', paths: ['scripts/conveyor/reconcile-core.mjs'] },
  fixPresent(root) {
    const p = join(root, 'scripts/conveyor/reconcile-core.mjs');
    return existsSync(p) && readFileSync(p, 'utf8').includes('gateRedRetryState');
  },
  async run({ log } = {}) {
    const { planReconcile } = await import('../../reconcile-core.mjs');
    const { buildStandDownComment } = await import('../../stand-down.mjs');
    const { AUTOMATION_LOGINS } = await import('../../../lib/marker-authorship.mjs');
    const author = { login: AUTOMATION_LOGINS[0] };
    const pr = {
      number: 5768, state: 'OPEN', isDraft: false, mergeStateStatus: 'BLOCKED', headRefOid: HEAD,
      headRefName: 'lane/verify-admission-heartbeat-timeout-memory', labels: [{ name: 'review:human' }],
      commits: [{ oid: HEAD, committedDate: '2026-10-21T17:40:00Z' }],
      statusCheckRollup: [run('test', 'FAILURE', '2026-10-21T18:20:00Z'), run('smoke', 'SUCCESS', '2026-10-21T18:10:00Z')],
      comments: [{ author, createdAt: '2026-10-21T18:01:26Z', body: buildStandDownComment({ reason: 'gate-red',
        detail: "attempt 3 @ 3a062c359: only red is daemon-live-smoke.test.mjs 'runLiveSmokeWithRetry forwards changedFiles'" }) }],
    };
    const plan = planReconcile({ prs: [pr], agents: [], now: NOW, requiredChecks: REQUIRED,
      gateRedRetries: { value: 1, source: 'standard' } });
    const heals = (plan.dispatch || []).filter((d) => d.prNumber === 5768 && d.kind === 'ci-heal');
    const refused = (plan.refusals || []).filter((r) => r.prNumber === 5768).map((r) => `${r.kind}: ${String(r.why || '').slice(0, 120)}`);
    log?.(JSON.stringify({ heals: heals.length, refused }));
    const violations = heals.length ? [] : [{ invariant: 'owed', detail: `PR #5768 gate-red stand-down got no ci-heal — ${refused.join(' | ') || 'no row'}` }];
    return { violations };
  },
  judge(report) {
    return report.violations.map((v) => `[${v.invariant}] ${v.detail}`);
  },
};
