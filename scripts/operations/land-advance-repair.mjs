/**
 * @file land-advance-repair.mjs
 * Pure helpers for the two repair owed-actions that had no mechanical handler: `dispatch-ci-heal` (a PR carrying
 * `ci:failed`) and `dispatch-conflict-fix` (a PR whose mergeable state is DIRTY / CONFLICTING, whatever review label
 * it carries, `review:accepted` included). Both are PR-closing work, so the `pr-queue-first` hold never blocks
 * them; while it is active it only orders them (a PR opened before today gets the free slot first) and names the
 * deferral `queue-first` instead of `capacity` when a newer PR loses that slot.
 * Nothing here reads a clock, a file or `gh`: every input is supplied. Neither action ever touches a `review:*` label.
 */
/** Same cap as `conveyor/tick-core.mjs#DEFAULT_CI_HEAL_RETRY_CAP`; the planner takes an override, this is the default. */
export const REPAIR_RETRY_CAP = 3;
export const REPAIR_KINDS = Object.freeze({ 'dispatch-ci-heal': 'ci-heal', 'dispatch-conflict-fix': 'conflict-fix' });
export const isConflicting = (p) => p.mergeStateStatus === 'DIRTY' || p.mergeable === 'CONFLICTING';
/** The operator's calendar day (America/New_York), e.g. `2026-09-20`. */
export function nyDayKey(ms) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
/** Opened before today (New York time). A PR with no usable `createdAt` is never counted as old. */
export function isPreToday(p, now) {
  const created = Date.parse(p.createdAt);
  return Number.isFinite(created) && nyDayKey(created) < nyDayKey(now);
}
/** `pr-queue-first`: active while any PR in any supplied repo was opened before today. Names the oldest one. */
export function queueFirstHold(prs, now) {
  const old = prs.filter((p) => isPreToday(p, now)).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  return { active: old.length > 0, count: old.length, oldest: old[0] ? `${old[0].repo}#${old[0].number}` : null };
}
/**
 * Attempts already spent on one repair. The durable floor is the PR's own CI-heal comments (restart-surviving, same rule
 * as `tick-core.mjs#planCiHealSpawns`); the follow-up ledger covers a dispatch that died before it commented. A PR carrying
 * a stand-down comment is terminal, exactly as `reconcile-core` treats it: a person cleared it or nobody re-dispatches.
 */
export function repairAttempts(subject, kind, { followUps = [], repairEvidence = {} } = {}) {
  const ev = repairEvidence[subject] ?? {};
  const ledger = followUps.filter((e) => e.target === subject && e.kind === kind).length;
  return { attempts: Math.max(ledger, kind === 'ci-heal' ? Number(ev.ciHealComments) || 0 : 0), stoodDown: Number(ev.standDownComments) > 0 };
}
/**
 * The owed repair for one PR, or null. `liveWorker` is true when a slot-holding `fix-<pr>` / `ci-heal-<pr>` session (or a
 * live detached wrapper recorded in the follow-up ledger) already works this PR. Conflict outranks CI: a conflicted
 * branch's checks say nothing until it is rebased.
 * @returns {null | { owedAction: string, kind: string, exhausted?: { why: string, attempts: number } }}
 */
export function repairOwed(p, labels, { liveWorker, subject, followUps = [], repairEvidence = {}, retryCap = REPAIR_RETRY_CAP }) {
  if (liveWorker) return null;
  const conflict = isConflicting(p), owedAction = conflict ? 'dispatch-conflict-fix' : labels.includes('ci:failed') ? 'dispatch-ci-heal' : null;
  if (!owedAction) return null;
  const kind = REPAIR_KINDS[owedAction], spent = repairAttempts(subject, kind, { followUps, repairEvidence });
  if (spent.stoodDown) return { owedAction, kind, exhausted: { why: 'a fix agent already stood down here and asked for human judgment', attempts: spent.attempts } };
  if (spent.attempts >= retryCap) return { owedAction, kind, exhausted: { why: `${spent.attempts} attempts spent (cap ${retryCap})`, attempts: spent.attempts } };
  return { owedAction, kind };
}
/** Why a dispatch row that could not launch is deferred: hold-aware, so a wait behind older PRs is named. */
export function deferralReason(row, { hold, proposed, now, prsByKey }) {
  if (row.refusal) return row.refusal.kind;
  if (!row.dispatchable) return 'draft';
  const mine = prsByKey.get(row.subject);
  if (hold.active && mine && !isPreToday(mine, now) && proposed.some((r) => prsByKey.get(r.subject) && isPreToday(prsByKey.get(r.subject), now))) return 'queue-first';
  return 'capacity';
}
/** While the hold is active, PRs opened before today take the free slots first; the sort is stable so age order otherwise stands. */
export function orderForHold(rows, { hold, now, prsByKey }) {
  if (!hold.active) return rows;
  const old = (r) => (prsByKey.get(r.subject) && isPreToday(prsByKey.get(r.subject), now) ? 0 : 1);
  return [...rows].sort((a, b) => old(a) - old(b));
}
/** The follow-up ledger `kind` a dispatched owed-action records. */
export const followUpKindFor = (owedAction) => ({ 'dispatch-review': 'review', 'dispatch-fix': 'fix' }[owedAction] ?? REPAIR_KINDS[owedAction]);
