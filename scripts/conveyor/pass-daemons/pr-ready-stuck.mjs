/** Ready-label stall detection and conservative, once-per-head stale-check refresh.
 * All GitHub evidence uses the watcher's shared tick budget. Unknown blockers hold
 * refresh; unavailable label history instead starts a durable observation timer.
 */
import { humanReviewHold } from '../../operations/pr-sweep-core.mjs';
import { GH_UNSTARTED_SENTINEL } from '../ci-queue-watch.mjs';

export const isUnretryable = check => check?.rerunError?.status === 403
  && /cannot be retried/i.test(check.rerunError.message ?? '');
const conclusion = c => String(c?.conclusion || c?.state || c?.status || 'UNKNOWN').toUpperCase();
const successful = c => ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(conclusion(c));
const checkName = c => c?.name ?? c?.context;
// A queued or running check is not stale: it has no result to retry. GitHub reports the
// unfinished-run time as the year-1 sentinel, so treat that (and any implausible date)
// as absent and fall through to the next field.
const UNFINISHED = new Set(['QUEUED', 'IN_PROGRESS', 'PENDING', 'WAITING', 'REQUESTED', 'EXPECTED']);
const unfinished = c => UNFINISHED.has(conclusion(c))
  || (typeof c?.status === 'string' && c.status.toUpperCase() !== 'COMPLETED');
const realDate = v => typeof v === 'string' && v !== GH_UNSTARTED_SENTINEL && Date.parse(v) > Date.UTC(2000, 0, 1);
export const checkDate = c => [c?.completedAt, c?.completed_at, c?.startedAt, c?.started_at, c?.createdAt]
  .find(realDate) ?? null;
// Conservative ref-name shape for anything that reaches a git argv.
// Only conveyor lane branches are ever advanced by the self-heal.
const SAFE_REF = /^lane\/[A-Za-z0-9][\w./-]*$/;
// Retry window for evidence reads that failed or were refused (bounds shared-budget spend).
export const RETRY_COOLDOWN_MS = 60 * 60000;
const cooling = (at, now) => Number.isFinite(at) && now - at < RETRY_COOLDOWN_MS;
const TIMER_KEYS = ['readyStuckSince', 'readyLabelAt', 'readyLabelTriedAt', 'refreshTriedAt'];

export function readReadyLabelTime({ repo, pr, read }) {
  let latest = null;
  for (let page = 1; page <= 10; page++) {
    const rows = read(['api', `repos/${repo}/issues/${pr.number}/events?per_page=100&page=${page}`]);
    if (!Array.isArray(rows)) throw Error('unreadable label events');
    for (const row of rows) if (row.event === 'labeled' && row.label?.name === 'ready-to-merge') {
      const time = Date.parse(row.created_at);
      if (!Number.isFinite(time)) throw Error('unreadable label date');
      latest = Math.max(latest ?? -Infinity, time);
    }
    if (rows.length < 100) return latest;
  }
  throw Error('label history cap; use observed-since, operator can inspect full history');
}

async function drainSkip({ repo, pr }) {
  const { DRAIN_LOG, tailOf, parseDrainSkips } = await import('../../operations/pr-sweep-io.mjs');
  const parsed = parseDrainSkips(tailOf(DRAIN_LOG));
  if (parsed.error) return null;
  return parsed.rows.filter(r => r.num === pr.number && (r.repo === null || r.repo === repo)).at(-1)?.reason ?? null;
}

const CHECK_ONLY_RULES = new Set(['deletion', 'non_fast_forward', 'workflows', 'required_status_checks', 'merge_queue']);

function checksOnlyRule(rule, repositoryId) {
  if (!CHECK_ONLY_RULES.has(rule?.type)) return false;
  if (rule.type === 'required_status_checks') {
    const checks = rule.parameters?.required_status_checks;
    return Array.isArray(checks) && checks.every(check => typeof check?.context === 'string' && check.context.trim());
  }
  if (rule.type === 'workflows') {
    const workflows = rule.parameters?.workflows;
    return Number.isSafeInteger(repositoryId) && repositoryId > 0 && Array.isArray(workflows)
      && workflows.every(workflow => workflow?.repository_id === repositoryId && workflow.ref === 'refs/heads/main'
        && typeof workflow.path === 'string' && workflow.path.startsWith('.github/workflows/')
        && workflow.path.slice('.github/workflows/'.length).length > 0
        && !workflow.path.split('/').some(part => !part || part === '.' || part === '..')
        && !/[\\\x00-\x1f\x7f]/.test(workflow.path));
  }
  return true;
}

// No pagination guess: a full page or unknown detail keeps the alert actionable by the operator.
function readActiveRules({ repo, read }) {
  const rows = read(['api', `repos/${repo}/rulesets?includes_parents=true&per_page=100`]);
  if (!Array.isArray(rows) || rows.length >= 100) throw Error('incomplete rulesets; operator must inspect repository rules');
  return rows.flatMap(row => {
    if (row?.enforcement === 'disabled') return [];
    if (!['active', 'evaluate'].includes(row?.enforcement) || !Number.isSafeInteger(row.id) || row.id <= 0) {
      throw Error('unknown ruleset; operator must inspect repository rules');
    }
    const detail = read(['api', `repos/${repo}/rulesets/${row.id}`]);
    if (!Array.isArray(detail?.rules) || detail.rules.some(rule => typeof rule?.type !== 'string')) {
      throw Error('unreadable ruleset; operator must inspect repository rules');
    }
    return detail.rules;
  });
}

/** Union of declared required contexts, preserving the required producer identity. */
export function readRequiredChecks({ repo, read }) {
  const rules = readActiveRules({ repo, read });
  const protection = read(['api', `repos/${repo}/branches/main/protection`]);
  const contexts = protection?.required_status_checks?.contexts;
  if (!Array.isArray(contexts)) throw Error('unreadable required contexts');
  const checks = [];
  const add = (name, appId = null) => {
    if (typeof name !== 'string' || !name.trim()
      || (appId !== null && appId !== -1 && (!Number.isSafeInteger(appId) || appId <= 0))) {
      throw Error('unknown required check name or app');
    }
    appId = appId === -1 ? null : appId;
    if (!checks.some(c => c.name === name && c.appId === appId)) checks.push({ name, appId });
  };
  contexts.forEach(name => add(name));
  const protectionChecks = protection.required_status_checks.checks;
  if (protectionChecks !== undefined) {
    if (!Array.isArray(protectionChecks)) throw Error('unreadable required check apps');
    for (const check of protectionChecks) add(check?.context, check?.app_id ?? null);
  }
  for (const rule of rules) if (rule.type === 'required_status_checks') {
    const required = rule.parameters?.required_status_checks;
    if (!Array.isArray(required)) throw Error('unreadable ruleset required checks');
    for (const check of required) add(check?.context, check?.integration_id ?? null);
  }
  return { checks, hasWorkflows: rules.some(rule => rule.type === 'workflows') };
}

/** A BLOCKED status alone cannot prove checks are the sole blocker. Refuse unknown rules,
 * push restrictions, conversation requirements and unknown protection.
 * The existing refresh helper independently enforces live fix claims/scope jumps.
 */
export function readChecksOnly({ repo, pr, read, now }) {
  // Comment-derived holds (red-team send-back, open fix claim) need comments; fail closed without them.
  if (!Array.isArray(pr.comments)) return false;
  const pull = read(['api', `repos/${repo}/pulls/${pr.number}`]);
  if (pull?.head?.sha !== pr.headRefOid || pull.head.repo?.full_name !== repo
    || pull.base?.ref !== 'main' || pull.mergeable !== true || pull.draft !== false
    || pull.state !== 'open' || humanReviewHold(pr, now).length) return false;
  try {
    if (readActiveRules({ repo, read }).some(rule => !checksOnlyRule(rule, pull.base?.repo?.id))) return false;
  } catch { return false; }
  const protection = read(['api', `repos/${repo}/branches/main/protection`]);
  if (!protection?.required_status_checks || protection.restrictions
    || protection.required_conversation_resolution?.enabled
    || protection.lock_branch?.enabled
    || (protection.required_pull_request_reviews && pr.reviewDecision !== 'APPROVED')) return false;
  return true;
}

export function readMainCheckEvidence({ repo, read }) {
  const commit = read(['api', `repos/${repo}/commits/main`]);
  if (!/^[a-f0-9]{40}$/i.test(commit?.sha ?? '')) throw Error('unknown main tip');
  const runs = read(['api', `repos/${repo}/commits/${commit.sha}/check-runs?filter=latest&per_page=100`]);
  const statuses = read(['api', `repos/${repo}/commits/${commit.sha}/status?per_page=100`]);
  if (!Array.isArray(runs?.check_runs) || runs.total_count !== runs.check_runs.length || runs.check_runs.length >= 100
    || !Array.isArray(statuses?.statuses) || statuses.total_count !== statuses.statuses.length || statuses.statuses.length >= 100) {
    throw Error('incomplete main checks; operator must inspect main');
  }
  return { sha: commit.sha, checks: [...runs.check_runs, ...statuses.statuses] };
}

async function refreshBranch({ repo, pr, mainSha }) {
  const { repoProfile } = await import('../../lib/repo-profile.mjs');
  const { rebaseDropManifest, gitRunner } = await import('../../lib/rebase-drop-manifest.mjs');
  const cwd = repoProfile(repo)?.checkoutPath;
  if (!cwd || !mainSha || !SAFE_REF.test(pr.headRefName ?? '') || pr.headRefName.includes('..')) return { action: 'skip' };
  // Pin both merge inputs to the evidence. Never merge a newer unexamined head.
  if (gitRunner('git', ['fetch', 'origin', 'main', pr.headRefName], { cwd }).status !== 0) return { action: 'error' };
  const oid = ref => gitRunner('git', ['rev-parse', ref], { cwd }).stdout?.trim();
  if (oid('origin/main') !== mainSha || oid(`origin/${pr.headRefName}`) !== pr.headRefOid) return { action: 'skip' };
  return rebaseDropManifest({ laneRef: pr.headRefName, base: 'origin/main', fetch: false, cwd });
}

export async function runReadyStuck({ repo, pr, receipt, now, config, read, send, save, log,
  readLabelTime = readReadyLabelTime, readSkipReason = drainSkip,
  onlyChecksBlock = readChecksOnly, readMainChecks = readMainCheckEvidence,
  readRequiredChecks: requiredChecks = readRequiredChecks,
  isUnretryable: unretryable = isUnretryable, refresh = refreshBranch } = {}) {
  if (pr.state !== 'OPEN' || pr.isDraft || !pr.labels.some(l => l.name === 'ready-to-merge')) {
    if (TIMER_KEYS.some(k => receipt[k] !== undefined)) {
      for (const k of TIMER_KEYS) delete receipt[k];
      save();
    }
    return;
  }
  receipt.readyStuckSince ??= now;
  save();
  const checks = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup.filter(c => !successful(c)) : [];
  // The label time only decides the alert. Once it has fired, spend no more GitHub calls
  // on label history; before that, read it once and keep it on the receipt.
  if (!receipt.readyStuckAlerted) {
    // A failed or capped history read is remembered, so it is retried at most once per cooldown.
    if (!Number.isFinite(receipt.readyLabelAt) && !cooling(receipt.readyLabelTriedAt, now)) {
      let labeled;
      try { labeled = await readLabelTime({ repo, pr, read }); } catch {
        receipt.readyLabelTriedAt = now; save();
        log('pr-merge-watch: ready-stuck label history unavailable; using observed-since');
      }
      const labelTime = typeof labeled === 'number' ? labeled : Date.parse(labeled);
      if (Number.isFinite(labelTime) && labelTime <= now) { receipt.readyLabelAt = labelTime; save(); }
    }
    const since = Number.isFinite(receipt.readyLabelAt) ? receipt.readyLabelAt : receipt.readyStuckSince;
    const minutes = (now - since) / 60000;
    if (minutes > config.readyStuckMinutes) {
      let skipReason = null;
      try { skipReason = await readSkipReason({ repo, pr }); } catch { /* diagnostic only */ }
      const result = await send({ kind: 'ready-stuck', repo, pr: pr.number, detail: {
        minutes, head: pr.headRefOid, threshold: config.readyStuckMinutes, needsYou: true,
        cause: { skipReason, nonSuccessChecks: checks.map(c => ({ name: checkName(c) ?? null,
          conclusion: conclusion(c), date: checkDate(c) })), mergeStateStatus: pr.mergeStateStatus },
      } });
      if (result === false) throw Error('ready-stuck delivery failed');
      receipt.readyStuckAlerted = true;
      save();
    }
  }
  // Refresh only after the ready-stuck threshold has passed (the delivered alert is the proof),
  // and only for finished checks: a queued or running check is not stale.
  if (!receipt.readyStuckAlerted || receipt.refreshed
    || !['BLOCKED', 'BEHIND'].includes(pr.mergeStateStatus)) return;
  // Evidence reads for a refused refresh cost ~6 shared-budget calls; repeat them at most once per cooldown.
  if (cooling(receipt.refreshTriedAt, now)) return;
  try {
    if (!Array.isArray(pr.statusCheckRollup) || checks.some(unfinished)) return;
    if (!checks.every(c => checkName(c) && (unretryable(c) || (Number.isFinite(Date.parse(checkDate(c)))
      && now - Date.parse(checkDate(c)) > config.selfHealStaleHours * 3600000)))) return;
    receipt.refreshTriedAt = now; save(); // before the first evidence read, so any refusal is remembered
    if (!await onlyChecksBlock({ repo, pr, read, now })) return;
    const evidence = await requiredChecks({ repo, read });
    const declared = Array.isArray(evidence) ? evidence : evidence?.checks;
    if (!Array.isArray(declared)) return;
    const required = declared.map(c => typeof c === 'string' ? { name: c, appId: null } : c);
    if (required.some(c => typeof c?.name !== 'string' || !c.name.trim()
      || (c.appId !== null && (!Number.isSafeInteger(c.appId) || c.appId <= 0)))) return;
    const present = new Set(pr.statusCheckRollup.map(checkName));
    // Missing runs have no check date: use the label time, or the durable observation timer.
    for (const name of new Set(required.map(c => c.name))) if (!present.has(name)) {
      if (!(now - (receipt.readyLabelAt ?? receipt.readyStuckSince) > config.selfHealStaleHours * 3600000)) return;
      checks.push({ name, conclusion: 'MISSING' });
    }
    if (!checks.length) return;
    const main = await readMainChecks({ repo, pr, read });
    const green = Array.isArray(main) ? main : main?.checks;
    // Workflow paths cannot be mapped reliably to job names here. Fail closed:
    // prove EVERY rollup name green on main, and require SUCCESS for all PR checks
    // beyond the stale failures being refreshed. Otherwise leave the alert for the operator.
    const workflowChecks = evidence?.hasWorkflows ? pr.statusCheckRollup : [];
    if (evidence?.hasWorkflows && workflowChecks.some(c => !checks.includes(c) && conclusion(c) !== 'SUCCESS')) return;
    const needed = [...checks, ...required, ...workflowChecks];
    if (!Array.isArray(green) || !needed.every(c => {
      const matches = green.filter(m => checkName(m) === checkName(c)
        && (c.appId == null || (typeof m.name === 'string' && m.app?.id === c.appId)));
      return matches.length > 0 && matches.every(m => conclusion(m) === 'SUCCESS');
    })) return;
    // Persist the attempt before mutation, including refusals and interrupted calls.
    receipt.refreshed = true;
    save();
    let action = 'error';
    try {
      const result = await refresh({ repo, pr, mainSha: main.sha });
      if (['rebased', 'current', 'skip', 'error'].includes(result?.action)) action = result.action;
    } catch { /* one fixed log line; never expose child output */ }
    log(`pr-merge-watch: ready-stuck self-heal #${pr.number} ${action}`);
  } catch { /* Unknown evidence holds refresh; the alert carries the blocker. */ }
}
