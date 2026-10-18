/** Re-request an absent check without changing CI truth or advancing the PR head.
 * Separate from missing-run-push: #3209's synchronize-only rule remains there.
 * Rerun the head's existing workflow, never dispatch a branch that can move.
 */
import yaml from 'js-yaml';
import { pushRefusal } from './fix-procedure.mjs';
import { countMissingRunComments, resolveRecoveryCaps } from './main-red-recovery.mjs';
import { attemptMissingCheckBaseRepair } from './parked-pr-conflict-watch.mjs';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { readCompletePrComments } from './pr-comments-complete.mjs';
import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';
import { readSettings } from '../lib/settings-files.mjs';
import { cascadePolicy } from '../lib/policy-cascade.mjs';

export const MISSING_CHECK_BASE_REPAIR_MARKER = '<!-- conveyor missing-check-base-repair -->';

/** true/false only for a readable definition with statically identifiable jobs. */
export function workflowProducesCheck(source, check) {
  try {
    const jobs = yaml.safeLoad(source, { schema: yaml.JSON_SCHEMA })?.jobs;
    if (!jobs || typeof jobs !== 'object' || Array.isArray(jobs) || !Object.keys(jobs).length) return null;
    let unknown = false;
    for (const [id, job] of Object.entries(jobs)) {
      if (!job || typeof job !== 'object' || Array.isArray(job) || job.uses) { unknown = true; continue; }
      const name = job.name ?? id;
      if (typeof name !== 'string') { unknown = true; continue; }
      // Dynamic names with an unrelated literal prefix cannot produce this check
      // (e.g. test-shard (${{ matrix.shard }}) cannot produce standards).
      const pattern = name.split(/\$\{\{[\s\S]*?\}\}/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
      if (name.includes('${{')) {
        if (new RegExp(`^${pattern}$`).test(check)) unknown = true;
        continue;
      }
      if (name === check) return true;
      if (job.strategy?.matrix && check.startsWith(`${name} (`)) unknown = true;
    }
    return unknown ? null : false;
  } catch { return null; }
}

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
  checkClaim = pushRefusal, maxRetriesPerSha = resolveRecoveryCaps().missingRunRetriesPerSha, maxRetriesPerPr = maxRetriesPerSha,
  postComment = null, repairBase = attemptMissingCheckBaseRepair, policy = resolveMissingRunRerequestSettings().value,
} = {}) {
  let action = 'missing-check-rerun';
  const defer = (reason) => ({ ok: false, deferred: true, action, reason, error: reason });
  const opts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 };
  const reserve = postComment ?? ((pr, body) => {
    exec('gh', ['api', `repos/${repo}/issues/${pr}/comments`, '-f', `body=${body}`], opts);
    return true;
  });
  if (policy.enabled !== 'on') return defer('disabled');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '') || !Number.isSafeInteger(d?.prNumber)
    || !d?.headRefName?.startsWith('lane/')
    || !/^[a-f0-9]{40}$/.test(d?.headSha ?? '') || !/^[\w ()-]+$/.test(d?.check ?? '')
    || !/^[\w.-]+\.ya?ml$/.test(d?.workflow ?? '')) return defer('invalid-target');
  let reserved = false;
  try {
    const comments = readComments(d.prNumber);
    if (!Array.isArray(comments)) return defer('unknown-thread');
    if (countMissingRunComments(comments, d.headSha) >= maxRetriesPerSha
      || countMissingRunComments(comments) >= maxRetriesPerPr) return defer('attempt-cap');
    const readHead = () => JSON.parse(exec('gh', ['api', `repos/${repo}/pulls/${d.prNumber}`], opts));
    const eligible = pr => pr.state === 'open' && pr.head?.sha === d.headSha
      && pr.head?.repo?.full_name === repo && pr.base?.ref === 'main'
      && pr.head?.ref === d.headRefName && pr.mergeable === true
      && !checkClaim({ repo, branch: d.headRefName });
    const file = JSON.parse(exec('gh', ['api', `repos/${repo}/contents/.github/workflows/${d.workflow}?ref=${d.headSha}`], opts));
    if (file.encoding !== 'base64' || typeof file.content !== 'string') return defer('unknown-workflow');
    const produces = workflowProducesCheck(Buffer.from(file.content, 'base64').toString('utf8'), d.check);
    if (produces === null) return defer('unknown-workflow');
    if (!produces) action = 'missing-check-base-repair';
    const marker = produces ? MISSING_CHECK_REREQUEST_MARKER : MISSING_CHECK_BASE_REPAIR_MARKER;
    const key = { repo, pr: d.prNumber, head: d.headSha, check: d.check };
    const attempts = comments.flatMap(c => {
      if (!isTrustedMarkerAuthor(c) || ![MISSING_CHECK_REREQUEST_MARKER, MISSING_CHECK_BASE_REPAIR_MARKER]
        .some(m => c?.body?.startsWith(m + '\n'))) return [];
      try {
        const record = JSON.parse(c.body.split('\n')[1]);
        return Object.entries(key).every(([k, v]) => record[k] === v) ? [record] : [];
      } catch { return []; }
    });
    if (attempts.length >= policy.maxAttemptsPerHead) return defer('attempt-cap');
    // A malformed timestamp on a matching reservation fails closed.
    if (attempts.some(a => !Number.isFinite(a.at) || now - a.at < policy.cooldownMinutes * 60000)) return defer('cooldown');
    if (!produces) {
      if (!eligible(readHead())) return defer('head-or-state-changed');
      if (!reserve(d.prNumber, `${marker}\n${JSON.stringify({ ...key, at: now })}`)) return defer('reservation-failed');
      reserved = true;
      const live = readHead();
      if (!eligible(live)) return defer('head-or-state-changed');
      return { ...repairBase(d, { repo, pr: { number: d.prNumber, headRefOid: d.headSha,
        headRefName: live.head.ref, baseRefName: live.base.ref } }), action };
    }
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
    const live = readHead();
    if (!eligible(live)) return defer('head-or-state-changed');
    // Reserve BEFORE mutation. Failed submissions consume the budget too; a failed
    // comment write must never leave an uncounted rerun behind after a restart.
    if (!reserve(d.prNumber, `${MISSING_CHECK_REREQUEST_MARKER}\n${JSON.stringify({ ...key, at: now, run: run.id })}`)) return defer('reservation-failed');
    reserved = true;
    const finalHead = readHead();
    if (!eligible(finalHead)) return defer('head-or-state-changed');
    exec('gh', ['run', 'rerun', String(run.id), '--repo', repo], opts);
    return { ok: true, action, runId: run.id, headSha: d.headSha, check: d.check };
  } catch {
    // Child errors can carry credentials. Never serialize them.
    return { ok: false, action, deferred: !reserved || action === 'missing-check-base-repair', error: reserved ? `${action} submission failed (attempt reserved)` : 're-request preflight failed' };
  }
}
