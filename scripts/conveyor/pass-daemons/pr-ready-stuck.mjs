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
const SAFE_REF = /^[A-Za-z0-9][\w./-]*$/;

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

/** A BLOCKED status alone cannot prove checks are the sole blocker. Refuse active
 * rulesets, push restrictions, conversation requirements and unknown protection.
 * The existing refresh helper independently enforces live fix claims/scope jumps.
 */
export function readChecksOnly({ repo, pr, read, now }) {
  // Comment-derived holds (red-team send-back, open fix claim) need comments; fail closed without them.
  if (!Array.isArray(pr.comments)) return false;
  const pull = read(['api', `repos/${repo}/pulls/${pr.number}`]);
  if (pull?.head?.sha !== pr.headRefOid || pull.head.repo?.full_name !== repo
    || pull.base?.ref !== 'main' || pull.mergeable !== true || pull.draft !== false
    || pull.state !== 'open' || humanReviewHold(pr, now).length) return false;
  const rules = read(['api', `repos/${repo}/rulesets?includes_parents=true&per_page=100`]);
  if (!Array.isArray(rules) || rules.length >= 100 || rules.some(r => r.enforcement !== 'disabled')) return false;
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
  isUnretryable: unretryable = isUnretryable, refresh = refreshBranch } = {}) {
  if (pr.state !== 'OPEN' || pr.isDraft || !pr.labels.some(l => l.name === 'ready-to-merge')) {
    if (receipt.readyStuckSince !== undefined || receipt.readyLabelAt !== undefined) {
      delete receipt.readyStuckSince; delete receipt.readyLabelAt; save();
    }
    return;
  }
  receipt.readyStuckSince ??= now;
  save();
  const checks = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup.filter(c => !successful(c)) : [];
  // The label time only decides the alert. Once it has fired, spend no more GitHub calls
  // on label history; before that, read it once and keep it on the receipt.
  if (!receipt.readyStuckAlerted) {
    if (!Number.isFinite(receipt.readyLabelAt)) {
      let labeled;
      try { labeled = await readLabelTime({ repo, pr, read }); } catch {
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
    || !['BLOCKED', 'BEHIND'].includes(pr.mergeStateStatus) || !checks.length) return;
  try {
    if (checks.some(unfinished)) return;
    if (!checks.every(c => checkName(c) && (unretryable(c) || (Number.isFinite(Date.parse(checkDate(c)))
      && now - Date.parse(checkDate(c)) > config.selfHealStaleHours * 3600000)))) return;
    if (!await onlyChecksBlock({ repo, pr, read, now })) return;
    const main = await readMainChecks({ repo, pr, read });
    const green = Array.isArray(main) ? main : main?.checks;
    if (!Array.isArray(green) || !checks.every(c => {
      const matches = green.filter(m => checkName(m) === checkName(c));
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
