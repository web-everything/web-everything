/**
 * One `status:*` label per PR, derived from the snapshot, live work and planner rows.
 * `needs-you` uses the operator queue's predicates; other states explain the wait.
 * Required red CI overrides readiness until green again. Label IO belongs to review-status-tag.
 */
import { PR_STATUS_SETTING_DEFAULTS } from './pr-status-settings.mjs';
import { rulingNeeded } from '../lib/ruling-ledger.mjs';
import { latestAdvisory, advisoryCoversHead, ADVISORY_OUTCOMES } from '../lib/advisory-labels.mjs';
import { takeoverEpisodes, takeoverProgress } from './takeover-budget.mjs';
// The queue's stand-down CLI lazily reaches the tagger; load the queue dynamically too.
// Its import-time dependencies have no path back here (including its ruling-ledger load).
const { evaluatePr, rulingNeededRow } = await import('../operations/operator-queue.mjs');
import { FALLBACK_REQUIRED_STATUS_CHECKS, withoutImpliedRequiredChecks } from '../lib/required-status-checks.mjs';
import { redTeamQueueReason, redTeamRulingNeeded } from '../lib/red-team-gate.mjs';
let savedRedTeamFallback = null;
try { ({ savedRedTeamFallback } = await import('../lib/drain-saved-red-team.mjs')); }
catch { /* Partial CLI copies can still label from posted evidence. */ }
import { standDownComments } from './stand-down.mjs';
import { latestUnresolvedStandDown } from './stand-down-answer-core.mjs';

export const PR_STATUS_PREFIX = 'status:';
export const PR_STATUS_STATES = Object.freeze([
  'needs-you', 'ci-red', 'conflict', 'red-team', 'ready-to-merge', 'takeover-running', 'fixing', 'escalated', 'stood-down',
  'answered-waiting-fixer', 'sent-back-red-team', 'at-round-limit', 'waiting-on-base', 'awaiting-ci', 'awaiting-review', 'sent-back-review',
]);
const LEGACY_PR_STATUS_STATES = Object.freeze(['awaiting-base']);
export const PR_STATUS_LABEL_RE = new RegExp(`^status:(${[...PR_STATUS_STATES, ...LEGACY_PR_STATUS_STATES].join('|')})$`);
export const PR_STATUS_DESCRIPTIONS = Object.freeze({
  'needs-you': 'Waiting on the operator (operator queue: NEEDS YOU / RULING NEEDED) — auto-managed',
  'takeover-running': 'A takeover fixer is working this PR past the round limit — auto-managed',
  fixing: 'A fixer is working this PR, or a fix is owed — auto-managed',
  'at-round-limit': 'Round limit reached; a takeover is planned or its review is owed — auto-managed',
  'waiting-on-base': 'Waiting for the base PR to land — auto-managed',
  'awaiting-ci': 'Waiting for CI — auto-managed',
  'awaiting-review': 'A review is owed or running — auto-managed',
  'red-team': 'Accepted; the post-accept red team is still running — auto-managed',
  'ready-to-merge': 'Accepted with no red required checks; waiting to land — auto-managed',
  'ci-red': 'Required CI is red; waiting for repair — auto-managed',
  conflict: 'Merge conflicts need repair — auto-managed',
  escalated: 'Handed to a person; see the operator queue ESCALATIONS — auto-managed',
  'stood-down': 'A fixer stood down; no later human reply — auto-managed',
  'answered-waiting-fixer': 'The operator answered the stand-down; the fixer owes the next move — auto-managed',
  'sent-back-red-team': 'Confirmed red-team breaks sent back to the fixer — auto-managed',
  'sent-back-review': 'Changes requested; waiting for a fixer — auto-managed',
});

/** Takeover reasons that hand the PR to a person (the note says "a person must decide/take it over"). */
const ESCALATED = new Set(['takeover-budget-spent', 'takeover-not-converging', 'takeover-spent', 'takeover-void-limit', 'ruling-dispute', 'setting-person', 'setting-disabled']);
const names = (labels) => (Array.isArray(labels) ? labels : []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);

/** Exactly the operator queue's NEEDS YOU or RULING NEEDED gate; saved evidence is read lazily. */
export function operatorQueueNeedsYou(pr, { humanAt } = {}) {
  const subject = { ...pr, labels: names(pr?.labels).map((name) => ({ name })) };
  // The daemon snapshot omits mergeable; preserve an explicit value when supplied.
  if (subject.mergeable === undefined && subject.mergeStateStatus && subject.mergeStateStatus !== 'UNKNOWN') {
    subject.mergeable = subject.mergeStateStatus === 'DIRTY' ? 'CONFLICTING' : 'MERGEABLE';
  }
  if (evaluatePr(subject).ready || Boolean(humanAt === undefined
    ? rulingNeededRow('', subject) : rulingNeeded(subject, { humanAt }))) return true;
  try {
    const readSaved = subject.repo
      ? savedRedTeamFallback?.({ repo: subject.repo, pr: subject.number, head: subject.headRefOid }) ?? null : null;
    return redTeamRulingNeeded(subject, undefined, { readSaved }) !== null;
  } catch { return false; }
}

const timeOf = (c) => { const t = Date.parse(c?.createdAt ?? c?.created_at ?? ''); return Number.isFinite(t) ? t : NaN; };

/** PURE: only required checks (or the CI failure label) can make the stage red. */
function requiredCiRed(pr, labels, requiredChecks, settings) {
  if (labels.includes('ci:failed')) return true;
  const checks = Array.isArray(pr?.statusCheckRollup) ? pr.statusCheckRollup : [];
  const required = new Set(withoutImpliedRequiredChecks(requiredChecks, checks));
  return checks.some((c) => required.has(c.name ?? c.context)
    && !(settings.reviewGateSignal === 'review' && c.mergeGateReviewHold)
    && ((c.status === 'COMPLETED' && !['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(c.conclusion))
      || ['FAILURE', 'ERROR'].includes(c.state)));
}

/** PURE: classify a planner refusal using only this caller's required checks. */
function reviewCiWait(row, { pr, defaultBranch, requiredChecks, settings }) {
  if (!['required-checks-not-successful', 'required-review-gate-conflict'].includes(row.ci?.reason)
    || !Array.isArray(row.ci?.affected) || !row.ci.affected.length
    || !Array.isArray(requiredChecks) || !requiredChecks.length
    || requiredChecks.some(name => typeof name !== 'string' || !name.trim())) return 'awaiting-ci';
  const affected = row.ci.affected.filter(check =>
    requiredChecks.includes(check?.name)
    && (settings.reviewGateSignal !== 'review' || check?.name !== 'review-gate'));
  if (!affected.length) return 'awaiting-review';
  if (pr.baseRefName && pr.baseRefName !== defaultBranch
    && settings.stackedMainOnlyChecks === 'waiting-on-base'
    && affected.every(check => settings.mainOnlyRequiredChecks.includes(check?.name)
      && ['missing', 'pending'].includes(check?.reason))) return 'waiting-on-base';
  return 'awaiting-ci';
}

// Neither stand-down nor advisory-labels exports a bot-author helper.
const isHumanComment = (c) => {
  const login = c?.author?.login ?? c?.user?.login;
  return typeof login === 'string' && login.length > 0
    && !/^(web-everything|github-actions)$/i.test(login) && !/\[bot\]$/i.test(login);
};

/** PURE: the latest takeover has not been judged yet — no review of its own work landed (a delayed review of the old
 *  head does not count; the same rule as the takeover budget's progress guard). */
export function takeoverUnjudged(comments) {
  const latest = takeoverEpisodes(comments).at(-1);
  if (!latest) return false;
  return !takeoverProgress(comments, latest).judged;
}

/**
 * PURE: the ONE `status:*` state for a PR, or null when none applies.
 * @param {{pr?:object, labels?:Array, reviewStatus?:{role?:string,state?:string}|null, rows?:Array<object>, defaultBranch?:string, humanAt?:number, requiredChecks?:string[]|null, settings?:object}} o
 *   `rows` = this tick's planner rows for the PR (dispatch rows, refusals, notes).
 *   `requiredChecks: null` means unknown; CI refusals stay conservative, known fallback failures stay red.
 */
export function derivePrStatusLabel({ pr = {}, labels, reviewStatus = null, rows = [], defaultBranch = 'main', humanAt, requiredChecks = FALLBACK_REQUIRED_STATUS_CHECKS, settings = PR_STATUS_SETTING_DEFAULTS } = {}) {
  settings = { ...PR_STATUS_SETTING_DEFAULTS, ...settings };
  const redChecks = requiredChecks ?? FALLBACK_REQUIRED_STATUS_CHECKS;
  const ciChecks = settings.reviewGateSignal === 'review' && Array.isArray(redChecks)
    ? redChecks.filter(name => name !== 'review-gate') : redChecks;
  const l = names(labels ?? pr?.labels);
  const comments = Array.isArray(pr?.comments) ? pr.comments : [];
  const rs = reviewStatus?.state ?? null;
  const list = Array.isArray(rows) ? rows : [];
  const subject = { ...pr, labels: l.map((name) => ({ name })) };
  if (operatorQueueNeedsYou(subject, { humanAt })) return 'needs-you';
  const liveFix = (reviewStatus?.role === 'fix' || reviewStatus?.role === 'ci-heal') && rs !== 'needs-human';
  if (requiredCiRed(subject, l, ciChecks, settings)) return liveFix ? 'fixing' : 'ci-red';
  if (subject.mergeable === 'CONFLICTING' || subject.mergeStateStatus === 'DIRTY') return liveFix ? 'fixing' : 'conflict';
  if (l.includes('review:accepted') && !l.includes('ready-to-merge')
    && reviewStatus?.role === 'review' && ['reviewing', 'review-stalled'].includes(rs)
    && settings.acceptedRedTeamStatus === 'red-team') return 'red-team';
  if (l.includes('review:accepted')) return 'ready-to-merge';
  if (liveFix) return takeoverUnjudged(comments) && reviewStatus.role === 'fix' ? 'takeover-running' : 'fixing';
  const escalated = list.some((r) => (r.kind === 'cap-exhausted' && ESCALATED.has(r.takeover))
    || r.kind === 'ruling-dispute' || r.takeoverNotConverging === true);
  if (escalated || rs === 'needs-human') return 'escalated';
  const stands = standDownComments(comments, { headRefOid: pr?.headRefOid });
  const unresolved = latestUnresolvedStandDown([...comments].sort((a, b) => (timeOf(a) || 0) - (timeOf(b) || 0)));
  if (stands.length && unresolved) {
    const latestAt = timeOf(unresolved);
    const answered = Number.isFinite(latestAt) && comments.some((c) => isHumanComment(c) && timeOf(c) > latestAt);
    return answered ? 'answered-waiting-fixer' : 'stood-down';
  }
  if (stands.length && l.includes('review:changes')) return 'answered-waiting-fixer';
  if ((!stands.length || unresolved) && list.some((r) => r.kind === 'stood-down')) return 'stood-down';
  if (redTeamQueueReason(subject)) return 'sent-back-red-team';
  if (list.some((r) => r.mode === 'takeover' || r.takeoverReview?.ok || r.kind === 'cap-exhausted' || r.kind === 'takeover-awaiting-review')) return 'at-round-limit';
  if (rs === 'awaiting-base' || l.includes('review-status:awaiting-base')
    || list.some((r) => r.kind === 'stacked-awaiting-base' || (r.kind === 'gate-hold' && /base/.test(String(r.hold ?? ''))))) return 'waiting-on-base';
  if (rs === 'awaiting-ci' || list.some((r) => r.kind === 'owed-ci-rerun')) return 'awaiting-ci';
  const ciWaits = list.filter(r => r.kind === 'review-ci')
    .map(row => reviewCiWait(row, { pr, defaultBranch, requiredChecks, settings }));
  if (ciWaits.includes('awaiting-ci')) return 'awaiting-ci';
  if (ciWaits.includes('waiting-on-base')) return 'waiting-on-base';
  if (ciWaits.includes('awaiting-review')) return 'awaiting-review';
  if (rs === 'reviewing' || rs === 'review-stalled' || list.some((r) => r.kind === 'review') || l.includes('review:pending')) return 'awaiting-review';
  if (list.some((r) => r.kind === 'fix' || r.kind === 'ci-heal')) return 'fixing';
  const advisory = latestAdvisory(comments);
  if (l.includes('review:changes') || (advisory?.outcome === ADVISORY_OUTCOMES.CHANGES
    && advisoryCoversHead(advisory, String(pr?.headRefOid ?? '').toLowerCase()))) return 'sent-back-review';
  return null;
}

/** PURE: what to add/remove so the PR carries exactly `status:<state>` (or no `status:*` label when null). */
export function planPrStatusLabel({ state, currentLabels = [] } = {}) {
  const l = names(currentLabels);
  const desired = state ? `${PR_STATUS_PREFIX}${state}` : null;
  const stale = l.filter((n) => PR_STATUS_LABEL_RE.test(n) && n !== desired);
  const has = desired ? l.includes(desired) : true;
  return { add: has ? null : desired, remove: stale };
}
