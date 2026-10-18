/** Re-request an absent check without changing CI truth or advancing the PR head.
 * Separate from missing-run-push: #3209's synchronize-only rule remains there.
 * Rerun the head's existing workflow, never dispatch a branch that can move.
 */
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { readCompletePrComments } from './pr-comments-complete.mjs';
import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';
import { readSettings } from '../lib/settings-files.mjs';
import { cascadePolicy } from '../lib/policy-cascade.mjs';

export const MISSING_CHECK_REREQUEST_MARKER = '<!-- conveyor missing-check-rerequest -->';
export function resolveMissingRunRerequestSettings({ env = process.env, settings = readSettings() } = {}) {
  return cascadePolicy('missingRunRerequest', settings?.missingRunRerequest, {
    standard: { enabled: 'on', cooldownMinutes: 15, maxAttemptsPerHead: 2 }, platform: {}, env,
    envValues: {
      enabled: env.WE_MISSING_RUN_REREQUEST,
      cooldownMinutes: env.WE_MISSING_RUN_COOLDOWN_MINUTES === undefined ? undefined : Number(env.WE_MISSING_RUN_COOLDOWN_MINUTES),
      maxAttemptsPerHead: env.WE_MISSING_RUN_MAX_ATTEMPTS_PER_HEAD === undefined ? undefined : Number(env.WE_MISSING_RUN_MAX_ATTEMPTS_PER_HEAD),
    },
    valid: { enabled: v => ['on', 'off'].includes(v), cooldownMinutes: v => Number.isFinite(v) && v > 0,
      maxAttemptsPerHead: v => Number.isSafeInteger(v) && v >= 0 },
  });
}

export function rerequestMissingCheck(d, { repo, now = Date.now(), exec = execFileSyncThrottled,
  readComments = (pr) => readCompletePrComments(pr, { repo, exec }),
  postComment = null, policy = resolveMissingRunRerequestSettings().value,
} = {}) {
  const action = 'missing-check-rerun';
  const defer = (reason) => ({ ok: false, deferred: true, action, reason, error: reason });
  const opts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 };
  const reserve = postComment ?? ((pr, body) => {
    exec('gh', ['api', `repos/${repo}/issues/${pr}/comments`, '-f', `body=${body}`], opts);
    return true;
  });
  if (policy.enabled !== 'on') return defer('disabled');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '') || !Number.isSafeInteger(d?.prNumber)
    || !/^[a-f0-9]{40}$/.test(d?.headSha ?? '') || !/^[\w ()-]+$/.test(d?.check ?? '')
    || !/^[\w.-]+\.ya?ml$/.test(d?.workflow ?? '')) return defer('invalid-target');
  let reserved = false;
  try {
    const comments = readComments(d.prNumber);
    if (!Array.isArray(comments)) return defer('unknown-thread');
    const key = { repo, pr: d.prNumber, head: d.headSha, check: d.check };
    const attempts = comments.flatMap(c => {
      if (!isTrustedMarkerAuthor(c) || !c?.body?.startsWith(MISSING_CHECK_REREQUEST_MARKER + '\n')) return [];
      try {
        const record = JSON.parse(c.body.split('\n')[1]);
        return Object.entries(key).every(([k, v]) => record[k] === v) ? [record] : [];
      } catch { return []; }
    });
    if (attempts.length >= policy.maxAttemptsPerHead) return defer('attempt-cap');
    // A malformed timestamp on a matching reservation fails closed.
    if (attempts.some(a => !Number.isFinite(a.at) || now - a.at < policy.cooldownMinutes * 60000)) return defer('cooldown');
    const runs = JSON.parse(exec('gh', ['api', `repos/${repo}/actions/runs?head_sha=${d.headSha}&per_page=100`, '--paginate', '--slurp'], opts));
    // Repository-wide discovery matters: a historical run can belong to another
    // workflow ID even though it has the same ci.yml path (live #5514).
    const headRuns = runs.flatMap(page => {
      if (!Array.isArray(page.workflow_runs)) throw new Error('unreadable workflow runs');
      return page.workflow_runs;
    });
    const run = headRuns.filter(r => r.head_sha === d.headSha && r.path === `.github/workflows/${d.workflow}`
      && r.event === 'pull_request').sort((a, b) => b.id - a.id)[0];
    if (!run || !Number.isSafeInteger(run.id)) return defer('no-head-workflow-run');
    if (run.status !== 'completed') return defer('workflow-active');
    const readHead = () => JSON.parse(exec('gh', ['api', `repos/${repo}/pulls/${d.prNumber}`], opts));
    const live = readHead();
    if (live.state !== 'open' || live.head?.sha !== d.headSha || live.head?.repo?.full_name !== repo) return defer('head-or-state-changed');
    // Reserve BEFORE mutation. Failed submissions consume the budget too; a failed
    // comment write must never leave an uncounted rerun behind after a restart.
    if (!reserve(d.prNumber, `${MISSING_CHECK_REREQUEST_MARKER}\n${JSON.stringify({ ...key, at: now, run: run.id })}`)) return defer('reservation-failed');
    reserved = true;
    const finalHead = readHead();
    if (finalHead.state !== 'open' || finalHead.head?.sha !== d.headSha
      || finalHead.head?.repo?.full_name !== repo) return defer('head-or-state-changed');
    exec('gh', ['run', 'rerun', String(run.id), '--repo', repo], opts);
    return { ok: true, action, runId: run.id, headSha: d.headSha, check: d.check };
  } catch {
    // Child errors can carry credentials. Never serialize them.
    return { ok: false, action, deferred: !reserved, error: reserved ? 'rerun submission failed (attempt reserved)' : 're-request preflight failed' };
  }
}
