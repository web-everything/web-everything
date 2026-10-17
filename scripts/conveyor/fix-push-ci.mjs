/** The pusher hands its exact new head to CI immediately; the existing missing-run watch repairs missed triggers. */
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { recordFixPush } from './fix-push-state.mjs';
import { resolveChildTimeoutMs } from '../lib/bounded-child.mjs';
const defaultRun = (cmd, args) => execFileSyncThrottled(cmd, args, { encoding: 'utf8', timeout: resolveChildTimeoutMs() });
export function markFixPushAwaitingCi({ repo, pr, head }, { run = defaultRun, recordPush = recordFixPush } = {}) {
  recordPush({ repo, pr, head });
  const repoArgs = repo ? [`--repo=${repo}`] : [];
  const view = JSON.parse(run('gh', ['pr', 'view', String(pr), ...repoArgs, '--json', 'headRefOid,labels']));
  if (!head || view.headRefOid !== head) return false;
  // Like fix-end, provision both labels before applying them: a repository may not have either yet.
  run('gh', ['label', 'create', 'checking', ...repoArgs, '--color', 'fbca04', '--description', 'Waiting for CI', '--force']);
  run('gh', ['label', 'create', 'status:awaiting-ci', ...repoArgs, '--color', 'fbca04', '--description', 'Waiting for CI — auto-managed', '--force']);
  const stale = new Set(['ci:failed', 'status:ci-red', 'status:fixing', 'status:takeover-running', 'status:awaiting-review']);
  const remove = (view.labels ?? []).map(l => l.name ?? l).filter(l => stale.has(l));
  run('gh', ['pr', 'edit', String(pr), ...repoArgs, '--add-label', 'checking', '--add-label', 'status:awaiting-ci', ...remove.flatMap(l => ['--remove-label', l])]);
  return true;
}
