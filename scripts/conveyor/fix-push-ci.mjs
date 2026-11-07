/** The pusher hands its exact new head to CI immediately; the existing missing-run watch repairs missed triggers. */
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { recordFixPush } from './fix-push-state.mjs';
import { resolveChildTimeoutMs } from '../lib/bounded-child.mjs';
import { collapseRollupToLatestPerName } from '../lib/rollup-collapse.mjs';
import { getRequiredStatusChecks } from '../lib/required-status-checks.mjs';
import { withoutImpliedRequiredChecks } from '../lib/required-check-implication.mjs';
import { planSizeGrowth, planGrowthTransition, SIZE_OVER_CAP_LABEL } from '../lib/pr-size-admission.mjs';
/**
 * Required, but a gate evaluator rather than CI: `merge-gate` also fails on review/freeze/candidacy holds (the label
 * writers excuse those via `excusePrMergeGateHolds`). Its failure never decides red here, but it does block green.
 * Every other required check counts as CI: a given required set replaces the shared exclusion list, as in
 * `reduceCheckState`.
 */
export const FIX_PUSH_GATE_CHECK = 'merge-gate';
const defaultRun = (cmd, args) => execFileSyncThrottled(cmd, args, { encoding: 'utf8', timeout: resolveChildTimeoutMs(), maxBuffer: 4 * 1024 * 1024 });
function defaultReadNumstat({ repo, pr, run }) {
  // A repo-less read would be implicit; callers always pass the slug, so no repo is unmeasurable (fails closed).
  if (!repo) throw new Error('size evidence needs an explicit repo');
  const text = run('gh', ['api', '--paginate', `repos/${repo}/pulls/${pr}/files`, '--jq', FILES_JQ]);
  return filesToNumstat(text);
}
/** One compact JSON object per file; `hasPatch` lets the reader tell a binary file from a measured zero. */
export const FILES_JQ = '.[]|{additions,deletions,filename,hasPatch:(.patch != null)}|tojson';
/**
 * Convert the files-API rows to numstat text. The API reports binary files (and deletions of them) as 0/0 with no
 * patch, which git numstat spells `-\t-`: a zero-change row with no patch is unmeasurable, never a zero-sized diff.
 * Any row that is not exactly well-formed throws (the caller falls back to human review).
 */
// Controls, DEL, U+2028/2029 and quotes in a path could forge numstat rows or break the tab-delimited framing.
const UNSAFE_PATH_CHARS = new RegExp('[\\u0000-\\u001f\\u007f\\u2028\\u2029"]');
export function filesToNumstat(text) {
  if (typeof text !== 'string') throw new Error('incomplete PR files');
  if (!text) return '';
  if (!text.endsWith('\n')) throw new Error('truncated PR files');
  const lines = text.slice(0, -1).split('\n');
  // The files endpoint silently caps evidence at 3000 files.
  if (lines.length >= 3000) throw new Error('incomplete PR files');
  return lines.map(line => {
    const row = JSON.parse(line);
    const { additions, deletions, filename, hasPatch } = row ?? {};
    const count = n => Number.isSafeInteger(n) && n >= 0;
    if (!count(additions) || !count(deletions) || typeof filename !== 'string' || !filename || UNSAFE_PATH_CHARS.test(filename) || typeof hasPatch !== 'boolean') {
      throw new Error('unreadable PR file row');
    }
    return `${!hasPatch && additions + deletions === 0 ? '-\t-' : `${additions}\t${deletions}`}\t${filename}\n`;
  }).join('');
}
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
  const required = withoutImpliedRequiredChecks(Array.isArray(requiredChecks) ? requiredChecks : [], rows);
  const ci = required.filter(name => name !== FIX_PUSH_GATE_CHECK);
  if (!rows.length || !ci.length) return 'pending';
  const verdictOf = name => rowVerdict(rows.find(r => (r?.name || r?.context) === name));
  const verdicts = ci.map(verdictOf);
  if (verdicts.includes('red')) return 'red';
  const gateGreen = !required.includes(FIX_PUSH_GATE_CHECK) || verdictOf(FIX_PUSH_GATE_CHECK) === 'green';
  return gateGreen && verdicts.every(v => v === 'green') ? 'green' : 'pending';
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
export function markFixPushAwaitingCi({ repo, pr, head }, { run = defaultRun, recordPush = recordFixPush, readRequired = readRequiredChecksSafe, readNumstat = defaultReadNumstat } = {}) {
  recordPush({ repo, pr, head });
  const repoArgs = repo ? [`--repo=${repo}`] : [];
  const view = JSON.parse(run('gh', ['pr', 'view', String(pr), ...repoArgs, '--json', 'headRefOid,labels,statusCheckRollup']));
  if (!head || view.headRefOid !== head) return false;
  const present = (view.labels ?? []).map(l => l.name ?? l);
  let numstatText;
  try {
    numstatText = readNumstat({ repo, pr, run });
    // Never repair a truncated last row into apparently complete evidence.
    if (typeof numstatText !== 'string' || (numstatText && !numstatText.endsWith('\n'))) numstatText = 'unreadable size evidence';
  } catch { numstatText = 'unreadable size evidence'; }
  const before = { status: present.includes(SIZE_OVER_CAP_LABEL) ? 'over-cap' : 'ok' };
  const after = planSizeGrowth({ numstatText });
  const transition = planGrowthTransition({ before, after });
  let sizeError;
  try {
    if (transition.flag) {
      run('gh', ['label', 'create', SIZE_OVER_CAP_LABEL, ...repoArgs, '--color', 'd93f0b', '--description',
        'PR grew over the 300 non-test line cap: split plan proposed — auto-managed', '--force']);
      if (transition.crossed) {
        const body = `${after.event}: ${after.lines ?? 'unknown'} non-test lines.\n\n${after.splitPlan?.text ?? after.reason}\n\n`
          + 'Proposed: split into the file groups above; the PR is not closed and review continues.';
        run('gh', ['pr', 'comment', String(pr), ...repoArgs, '--body', body]);
      }
      // Record the crossing only after its visible event succeeds, so a failed comment can retry.
      if (!present.includes(SIZE_OVER_CAP_LABEL)) run('gh', ['pr', 'edit', String(pr), ...repoArgs, '--add-label', SIZE_OVER_CAP_LABEL]);
    } else if (after.status === 'ok' && present.includes(SIZE_OVER_CAP_LABEL)) {
      run('gh', ['pr', 'edit', String(pr), ...repoArgs, '--remove-label', SIZE_OVER_CAP_LABEL]);
    }
  } catch (error) { sizeError = { error }; }
  // A same-head retry (a re-arm owed by an earlier run) can arrive after CI finished: that verdict stands.
  const verdict = view.statusCheckRollup?.length ? headCiVerdict(view.statusCheckRollup, readRequired(repo)) : 'pending';
  const plan = fixPushLabelPlan(present, verdict);
  if (!plan.handOff) {
    if (plan.remove.length) run('gh', ['pr', 'edit', String(pr), ...repoArgs, ...plan.remove.flatMap(l => ['--remove-label', l])]);
    if (sizeError) throw sizeError.error;
    return false;
  }
  // Like fix-end, provision both labels before applying them: a repository may not have either yet.
  run('gh', ['label', 'create', 'checking', ...repoArgs, '--color', 'fbca04', '--description', 'Waiting for CI', '--force']);
  run('gh', ['label', 'create', 'status:awaiting-ci', ...repoArgs, '--color', 'fbca04', '--description', 'Waiting for CI — auto-managed', '--force']);
  run('gh', ['pr', 'edit', String(pr), ...repoArgs, '--add-label', 'checking', '--add-label', 'status:awaiting-ci', ...plan.remove.flatMap(l => ['--remove-label', l])]);
  if (sizeError) throw sizeError.error;
  return true;
}
