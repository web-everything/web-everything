/** The pusher hands its exact new head to CI immediately; the existing missing-run watch repairs missed triggers. */
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { recordFixPush } from './fix-push-state.mjs';
import { resolveChildTimeoutMs } from '../lib/bounded-child.mjs';
import { collapseRollupToLatestPerName } from '../lib/rollup-collapse.mjs';
const defaultRun = (cmd, args) => execFileSyncThrottled(cmd, args, { encoding: 'utf8', timeout: resolveChildTimeoutMs() });
const UNSETTLED = new Set(['QUEUED', 'IN_PROGRESS', 'PENDING', 'EXPECTED', 'WAITING', 'REQUESTED']);
/** True when the head's rollup has at least one check and none still running: its CI verdict is already in. Pure. */
export function ciSettledOnHead(rollup) {
  const rows = collapseRollupToLatestPerName(rollup);
  return rows.length > 0 && rows.every(c => !UNSETTLED.has(String(c?.status ?? '').toUpperCase()) && !UNSETTLED.has(String(c?.state ?? '').toUpperCase()));
}
export const FIX_PUSH_STALE_CI_LABELS = Object.freeze(['ci:failed', 'status:ci-red', 'status:awaiting-review']);
export const FIX_PUSH_FIXER_LABELS = Object.freeze(['status:fixing', 'status:takeover-running']);
export function markFixPushAwaitingCi({ repo, pr, head }, { run = defaultRun, recordPush = recordFixPush } = {}) {
  recordPush({ repo, pr, head });
  const repoArgs = repo ? [`--repo=${repo}`] : [];
  const view = JSON.parse(run('gh', ['pr', 'view', String(pr), ...repoArgs, '--json', 'headRefOid,labels,statusCheckRollup']));
  if (!head || view.headRefOid !== head) return false;
  const present = (view.labels ?? []).map(l => l.name ?? l);
  // A same-head retry (a re-arm owed by an earlier run) can arrive after CI finished: keep that verdict, drop only fixer state.
  if (ciSettledOnHead(view.statusCheckRollup)) {
    const remove = present.filter(l => FIX_PUSH_FIXER_LABELS.includes(l));
    if (remove.length) run('gh', ['pr', 'edit', String(pr), ...repoArgs, ...remove.flatMap(l => ['--remove-label', l])]);
    return false;
  }
  // Like fix-end, provision both labels before applying them: a repository may not have either yet.
  run('gh', ['label', 'create', 'checking', ...repoArgs, '--color', 'fbca04', '--description', 'Waiting for CI', '--force']);
  run('gh', ['label', 'create', 'status:awaiting-ci', ...repoArgs, '--color', 'fbca04', '--description', 'Waiting for CI — auto-managed', '--force']);
  const stale = new Set([...FIX_PUSH_STALE_CI_LABELS, ...FIX_PUSH_FIXER_LABELS]);
  const remove = present.filter(l => stale.has(l));
  run('gh', ['pr', 'edit', String(pr), ...repoArgs, '--add-label', 'checking', '--add-label', 'status:awaiting-ci', ...remove.flatMap(l => ['--remove-label', l])]);
  return true;
}
