/** The pusher hands its exact new head to CI immediately; the existing missing-run watch repairs missed triggers. */
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { recordFixPush } from './fix-push-state.mjs';
import { resolveChildTimeoutMs } from '../lib/bounded-child.mjs';
import { collapseRollupToLatestPerName } from '../lib/rollup-collapse.mjs';
import { getRequiredStatusChecks } from '../lib/required-status-checks.mjs';
import { withoutImpliedRequiredChecks } from '../lib/required-check-implication.mjs';
import { CI_TRUTH_EXCLUDED_CHECKS } from '../operations/pr-status.mjs';
/**
 * Required, but gate evaluators rather than CI: `merge-gate` fails on review/freeze/candidacy holds too (the label
 * writers excuse those via `excusePrMergeGateHolds`), and the shared exclusion list names the advisory gates. Their
 * failure is never a CI verdict here; the real CI checks beside them decide.
 */
export const FIX_PUSH_NOT_CI_CHECKS = Object.freeze(['merge-gate', ...CI_TRUTH_EXCLUDED_CHECKS]);
const defaultRun = (cmd, args) => execFileSyncThrottled(cmd, args, { encoding: 'utf8', timeout: resolveChildTimeoutMs() });
export const FIX_PUSH_RED_CI_LABELS = Object.freeze(['ci:failed', 'status:ci-red']);
export const FIX_PUSH_FIXER_LABELS = Object.freeze(['status:fixing', 'status:takeover-running']);
export const FIX_PUSH_WAITING_LABELS = Object.freeze(['checking', 'status:awaiting-ci']);
const PASSED = new Set(['SUCCESS', 'SKIPPED', 'NEUTRAL']); // the same pass set as reconcile-core#failingCheckNames
const rowVerdict = row => {
  if (!row) return 'pending'; // not reported yet: a partial rollup is never a verdict
  const status = String(row.status ?? '').toUpperCase();
  if (status) return status !== 'COMPLETED' ? 'pending' : PASSED.has(String(row.conclusion ?? '').toUpperCase()) ? 'green' : 'red';
  const state = String(row.state ?? '').toUpperCase();
  return state === 'SUCCESS' ? 'green' : state === 'FAILURE' || state === 'ERROR' ? 'red' : 'pending';
};
/**
 * This head's CI verdict, judged on the REQUIRED checks only. Pure. `red`: a required check finished failing (final
 * for that check, whatever still runs). `green`: every required check reported and passed. Otherwise `pending` —
 * including an unknown required set, so a missing read falls back to the ordinary hand-off.
 */
export function headCiVerdict(rollup, requiredChecks) {
  const rows = collapseRollupToLatestPerName(rollup);
  const required = withoutImpliedRequiredChecks(Array.isArray(requiredChecks) ? requiredChecks : [], rows)
    .filter(name => !FIX_PUSH_NOT_CI_CHECKS.includes(name));
  if (!rows.length || !required.length) return 'pending';
  const verdicts = required.map(name => rowVerdict(rows.find(r => (r?.name || r?.context) === name)));
  return verdicts.includes('red') ? 'red' : verdicts.every(v => v === 'green') ? 'green' : 'pending';
}
/** The required set for a slug; any read failure is "unknown" (the caller hands off as if CI were pending). */
export function readRequiredChecksSafe(repo, read = r => getRequiredStatusChecks({ repo: r }).checks) {
  try { return read(repo) ?? []; } catch { return []; }
}
/**
 * The label change a fixer push owes, from the labels present and this head's CI verdict. Pure. Pending: hand to CI
 * (add `checking` + `status:awaiting-ci`, drop red and green-state labels). A finished verdict stands: only fixer
 * state goes, plus the labels that contradict it (red labels on a green head, `status:awaiting-review` on a red one).
 */
export function fixPushLabelPlan(present, verdict) {
  const has = l => present.includes(l);
  // A finished verdict also ends any earlier hand-off's wait (push → CI done → fix-end).
  if (verdict === 'green') return { handOff: false, remove: [...FIX_PUSH_FIXER_LABELS, ...FIX_PUSH_WAITING_LABELS, ...FIX_PUSH_RED_CI_LABELS].filter(has) };
  if (verdict === 'red') return { handOff: false, remove: [...FIX_PUSH_FIXER_LABELS, ...FIX_PUSH_WAITING_LABELS, 'status:awaiting-review'].filter(has) };
  return { handOff: true, remove: [...FIX_PUSH_RED_CI_LABELS, ...FIX_PUSH_FIXER_LABELS, 'status:awaiting-review'].filter(has) };
}
export function markFixPushAwaitingCi({ repo, pr, head }, { run = defaultRun, recordPush = recordFixPush, readRequired = readRequiredChecksSafe } = {}) {
  recordPush({ repo, pr, head });
  const repoArgs = repo ? [`--repo=${repo}`] : [];
  const view = JSON.parse(run('gh', ['pr', 'view', String(pr), ...repoArgs, '--json', 'headRefOid,labels,statusCheckRollup']));
  if (!head || view.headRefOid !== head) return false;
  const present = (view.labels ?? []).map(l => l.name ?? l);
  // A same-head retry (a re-arm owed by an earlier run) can arrive after CI finished: that verdict stands.
  const verdict = view.statusCheckRollup?.length ? headCiVerdict(view.statusCheckRollup, readRequired(repo)) : 'pending';
  const plan = fixPushLabelPlan(present, verdict);
  if (!plan.handOff) {
    if (plan.remove.length) run('gh', ['pr', 'edit', String(pr), ...repoArgs, ...plan.remove.flatMap(l => ['--remove-label', l])]);
    return false;
  }
  // Like fix-end, provision both labels before applying them: a repository may not have either yet.
  run('gh', ['label', 'create', 'checking', ...repoArgs, '--color', 'fbca04', '--description', 'Waiting for CI', '--force']);
  run('gh', ['label', 'create', 'status:awaiting-ci', ...repoArgs, '--color', 'fbca04', '--description', 'Waiting for CI — auto-managed', '--force']);
  run('gh', ['pr', 'edit', String(pr), ...repoArgs, '--add-label', 'checking', '--add-label', 'status:awaiting-ci', ...plan.remove.flatMap(l => ['--remove-label', l])]);
  return true;
}
