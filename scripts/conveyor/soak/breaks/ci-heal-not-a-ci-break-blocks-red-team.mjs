/**
 * @file breaks/ci-heal-not-a-ci-break-blocks-red-team.mjs — card CI-HEAL-ESCALATION-NONBLOCK (live: PR 7364). A ci-heal
 * escalation of outcome `not-a-ci-break` (the red is only the review gate) folded a review dispatch row into its
 * refusal ONLY for a PR labelled `review:pending`. A PR in any other review phase (accepted and owed its red-team,
 * human re-review) stopped at the `ci-heal-escalated` refusal and got no review row, so nothing ever advanced it.
 *
 * FIX — the not-a-ci-break fold applies in every review phase; the shared review dispatcher still enforces the
 * required-check and head prerequisites.
 *
 * SCENARIO: an `review:accepted` PR, every required check green, carrying a not-a-ci-break escalation on its current
 * head, through the tree's production `planReconcile`. RED = no `review` dispatch row.
 *
 * fixPresent is decided by a SEPARATE behavioural probe (a different phase, `review:human`, run in a child process),
 * never by the accepted-PR scenario the break itself asserts, and never by a marker string.
 */
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');
const CORE = 'scripts/conveyor/reconcile-core.mjs';
const MARK = 'scripts/conveyor/ci-heal-escalation-mark.mjs';
const HEAD = '70326866f0f299ddd005f9da54f0b87a3c169ac4';
const NOW = Date.parse('2026-08-26T17:34:00Z');

/** Plans one escalated PR and returns the kinds of dispatch rows. Shared by the scenario and the probe script. */
const PLAN_SOURCE = `
const [core, mark] = [process.env.SOAK_CORE, process.env.SOAK_MARK];
const { planReconcile } = await import(core);
const { buildCiHealEscalationComment } = await import(mark);
const label = process.env.SOAK_LABEL;
const pr = { rowsComplete: true, rowsHead: '${HEAD}', number: 2783, state: 'OPEN', headRefName: 'lane/x', headRefOid: '${HEAD}',
  labels: [{ name: label }, { name: 'ci:failed' }], mergeStateStatus: 'CLEAN',
  statusCheckRollup: [{ name: 'gate', status: 'completed', conclusion: 'success' }],
  comments: [{ author: { login: 'web-everything' }, body: buildCiHealEscalationComment({ headSha: '${HEAD}', outcome: 'not-a-ci-break', reason: 'review gate only' }) }] };
const plan = planReconcile({ prs: [pr], agents: [], requiredChecks: ['gate'], now: ${NOW} });
console.log(JSON.stringify(plan.dispatch.map((d) => d.kind)));
`;

function planKinds(root, label) {
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', PLAN_SOURCE], {
    env: { ...process.env, SOAK_CORE: pathToFileURL(join(root, CORE)).href, SOAK_MARK: pathToFileURL(join(root, MARK)).href, SOAK_LABEL: label },
    encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'ignore'],
  });
  return JSON.parse(out.trim().split('\n').pop());
}

export default {
  id: 'ci-heal-not-a-ci-break-blocks-red-team',
  title: 'a not-a-ci-break ci-heal escalation blocked review/red-team dispatch for every PR phase except review:pending',
  card: 'CI-HEAL-ESCALATION-NONBLOCK (PR 7364 shape)',
  fixedBy: { sha: 'lane/ci-heal-escalation-nonblock', where: 'lane/ci-heal-escalation-nonblock', paths: [CORE] },
  fixPresent(root) {
    if (!existsSync(join(root, CORE)) || !existsSync(join(root, MARK))) return false;
    return planKinds(root, 'review:human').includes('review');
  },
  async run({ log } = {}) {
    try {
      if (!existsSync(join(REPO_ROOT, CORE))) return { violations: [{ invariant: 'harness', detail: 'no reconcile-core' }] };
      const kinds = planKinds(REPO_ROOT, 'review:accepted');
      log?.(JSON.stringify(kinds));
      const violations = kinds.includes('review') ? [] : [{ invariant: 'escalated-accepted-pr-dispatches-review', detail: `dispatch kinds: ${JSON.stringify(kinds)}` }];
      return { violations, kinds };
    } catch (e) {
      return { violations: [{ invariant: 'crash', detail: String(e?.stack || e).split('\n').slice(0, 3).join(' ') }] };
    }
  },
  judge(report) { return report.violations.map((v) => `[${v.invariant}] ${v.detail}`); },
};
