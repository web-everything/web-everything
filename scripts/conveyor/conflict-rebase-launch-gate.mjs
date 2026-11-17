/** Fresh conflict-rebase admission shared by dispatchers and worker execution boundaries. */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLaunchableConflictRebase } from './accepted-conflict-rebase.mjs';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { ghRepoSlug } from '../lib/constellation-repos.mjs';
import { resolveChildTimeoutMs } from '../lib/bounded-child.mjs';
import { describeDispatchFailure } from '../lib/describe-spawn-failure.mjs';
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export { isLaunchableConflictRebase };

/** Serializable original planning evidence; never replace this pin with a later PR read. */
export function launchGuardFor(planned, { repo = 'we', root = REPO_ROOT } = {}) {
  if (planned.mode !== 'conflict-rebase') return undefined;
  return { mode: planned.mode, pinnedHead: planned.headRefOid, pr: planned.pr, repo, root,
    conflictRebase: planned.conflictRebase };
}

/** Reviewed launch purposes. New purposes require boundary and caller review. */
export const FIXER_LAUNCH_MODES = Object.freeze([
  'conflict-rebase', 'ordinary', 'fix', 'advisory-fix', 'ci-heal', 'round-fix',
  'stale-base', 'stale-base-rebase', 'stacked-rebase', 'scope-bloat-rebase', 'takeover',
  'ruling-not-addressed', 'mq-failure-recovery', 'operator-send-back', 'block-ruled-referral',
  'build', 'delivery', 'review', 'inspect', 'investigate', 'prepare', 'verify-resume',
]);

export function refuseFixerLaunch(reason) {
  const error = Object.assign(new Error(`conflict-rebase launch refused: ${reason}; restore original launch evidence or start a newly admitted session`),
    { kind: 'conflict-rebase-launch-refused' });
  console.error(error.message);
  throw error;
}

/** Validate even when a test/provider injects the live gate. Absence is never permission. */
export function assertLaunchDescriptor(descriptor) {
  if (!descriptor || !Object.hasOwn(descriptor, 'mode') || !Object.hasOwn(descriptor, 'launchGuard')
      || !FIXER_LAUNCH_MODES.includes(descriptor.mode)) {
    refuseFixerLaunch('missing launch descriptor, launchGuard, or unknown mode');
  }
  const { mode, launchGuard, pr, repo } = descriptor;
  if (mode !== 'conflict-rebase') {
    if (launchGuard !== null) refuseFixerLaunch('non-conflict mode requires an explicit null launchGuard');
    return;
  }
  const refuse = () => refuseFixerLaunch('missing or mismatched mode, pinned head, PR or repository; refresh PR evidence before retrying');
  if (launchGuard?.mode !== mode
      || !/^[0-9a-f]{40}$/i.test(launchGuard.pinnedHead ?? '')
      || !/^[1-9][0-9]*$/.test(String(launchGuard.pr ?? '')) || !launchGuard.repo
      || !launchGuard.conflictRebase
      || (pr != null && String(pr) !== String(launchGuard.pr))) refuse();
  try { if (repo != null && ghRepoSlug(repo) !== ghRepoSlug(launchGuard.repo)) refuse(); }
  catch { refuse(); }
}

/** At execution, every launch declares its purpose; conflict repairs also re-read live evidence. */
export function assertFixerLaunch(descriptor, options = {}) {
  assertLaunchDescriptor(descriptor);
  const { mode, launchGuard } = descriptor;
  if (mode !== 'conflict-rebase') return;
  assertLaunchable({ ...launchGuard, headRefOid: launchGuard.pinnedHead }, {
    ...options, repo: launchGuard.repo, root: launchGuard.root ?? REPO_ROOT,
  });
}

/** Run the sanctioned demotion CLI; it posts the admission receipt and verifies fresh labels. */
export function demoteConflictRebase(planned, { repo = 'we', root = REPO_ROOT, exec = execFileSync } = {}) {
  const head = planned.headRefOid;
  const evidence = planned.conflictRebase;
  if (!/^[0-9a-f]{40}$/i.test(head ?? '') || evidence?.oldHead !== head
      || !/^[0-9a-f]{40}$/i.test(evidence?.mainSha ?? '')
      || evidence?.receipt !== `accepted-conflict-rebase:${head.toLowerCase()}@${evidence.mainSha.toLowerCase()}`) {
    throw new Error('incomplete or mismatched dispatched head receipt; refresh conflict evidence before retrying');
  }
  const result = JSON.parse(exec(process.execPath, [join(root, 'scripts/conveyor/rearm-review.mjs'), String(planned.pr),
    `--repo=${ghRepoSlug(repo)}`, '--round=conflict-start',
    `--only-if=${planned.labels?.includes('review:accepted') ? 'accepted' : 'missing'}`,
    `--expect-head=${head}`, `--actor=${evidence.receipt}`], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
  }));
  return result;
}

/** Uncached, bounded live read at the launch boundary; shared GitHub throttle applies. */
export function readConflictRebaseLive(pr, repo, { exec = execFileSyncThrottled, throttle = {} } = {}) {
  return JSON.parse(exec('gh', ['pr', 'view', String(pr), '--repo', ghRepoSlug(repo),
    '--json', 'headRefOid,labels,state,isDraft,baseRefName,mergeStateStatus,mergeable'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: resolveChildTimeoutMs(),
    killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, throttle: { ...throttle, noMemo: true },
  }));
}

/** The sole conflict-rebase launch gate. Proof is local to this call, never reusable by a retry. */
export function assertLaunchable(planned, {
  repo = 'we', root = REPO_ROOT, demote = demoteConflictRebase, readLive = readConflictRebaseLive,
} = {}) {
  if (planned.mode !== 'conflict-rebase') return;
  const approvals = ['review:accepted', 'ready-to-merge', 'status:ready-to-merge'];
  const names = live => live.labels.map(l => typeof l === 'string' ? l : l.name);
  try {
    const live = readLive(planned.pr, repo);
    if (!isLaunchableConflictRebase(live, planned)) {
      throw new Error('live head, labels, or conflict admission state changed or is incomplete');
    }
    const labels = names(live);
    if (labels.some(l => approvals.includes(l))) {
      requireConflictRebaseDemotion({ ...planned, labels }, { repo, root }, demote);
    }
    // Even an already-demoted episode needs a second fresh read: pending is not a cached proof.
    const verified = readLive(planned.pr, repo);
    if (!isLaunchableConflictRebase(verified, planned)
        || !names(verified).includes('review:pending')
        || names(verified).some(l => approvals.includes(l))) {
      throw new Error('fresh live verification requires unchanged head, review:pending, no approvals or holds, and conflict admission');
    }
  } catch (cause) {
    const error = cause?.kind === 'conflict-rebase-demotion-failed' ? cause
      : Object.assign(new Error(`conflict-rebase launch refused: ${describeDispatchFailure(cause)}; refresh PR evidence before retrying`),
        { kind: 'conflict-rebase-launch-refused' });
    console.error(error.message);
    throw error;
  }
}

/** A CLI refusal or incomplete proof must never reach any fixer launch path. */
function requireConflictRebaseDemotion(planned, options, demote) {
  if (planned.mode !== 'conflict-rebase') return;
  try {
    const result = demote(planned, options);
    if (result?.ok !== true || result.round !== 'conflict-start' || result.pr !== planned.pr
        || !Array.isArray(result.labels) || !result.labels.every(l => typeof l === 'string' && l.length > 0)
        || !result.labels.includes('review:pending')
        || ['review:accepted', 'ready-to-merge', 'status:ready-to-merge'].some(l => result.labels.includes(l))) {
      throw new Error(result?.reason || 'demotion could not be confirmed from conflict-start result');
    }
    return result;
  } catch (cause) {
    const error = new Error(`conflict-rebase demotion failed: ${describeDispatchFailure(cause)}; refresh PR labels and conflict evidence before retrying`);
    error.kind = 'conflict-rebase-demotion-failed';
    throw error;
  }
}

