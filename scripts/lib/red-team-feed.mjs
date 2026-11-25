/**
 * @file scripts/lib/red-team-feed.mjs
 * @description REDTEAM-FEED. The red-team dispatch queue only admits PRs the review plan lists as
 *   `already-reviewed-head` refusals, so a PR labelled red-team:pending whose review finished another way was never
 *   queued (6 enqueues in 6h, ~1 red-team process live against 16 allowed). This pure module nominates those PRs as
 *   synthetic `already-reviewed-head` refusals; the existing queue (dedupe, capacity, minConcurrent, live-head and
 *   gate-comment re-checks in the runner) decides the starts. It never starts anything itself.
 *
 *   A PR is fed when it is open, not a draft, carries red-team:pending, has no red-team result comment for the
 *   live head, carries no hold label and no fix claim, has no planned dispatch and no refusal except `nothing-owed`, and
 *   (a) its review of the live head is finished (a trusted reviewed-sha marker for the head), or (c) it has been
 *   quiet for more than 30 minutes AND the injected `hasLiveProcess` reader says no process holds it. Without that
 *   reader the quiet path stays off (fail closed).
 */
import { parseReviewedSha } from './review-escalation.mjs';
import { redTeamForHead } from './red-team-gate.mjs';

export const QUIET_MS = 30 * 60_000;
const HEAD = /^[0-9a-f]{40}$/i;
const names = labels => (Array.isArray(labels) ? labels : []).map(l => typeof l === 'string' ? l : l?.name).filter(Boolean);
const isHold = name => name === 'review:held-mechanical' || name === 'hold:fix' || name.startsWith('hold:');

/** PURE. Returns `[{ prNumber, headSha, reason: 'a'|'c' }]`. */
export function planRedTeamFeed({ plan, rawPrs, now = Date.now(), hasLiveProcess } = {}) {
  // nothing-owed describes ordinary review work, not a red-team nomination or a safety hold.
  // Preserve every other refusal (including unknown kinds) and every planned dispatch as a blocker.
  const taken = new Set([...(plan?.refusals ?? []).filter(row => row?.kind !== 'nothing-owed'), ...(plan?.dispatch ?? [])]
    .map(row => Number(row?.prNumber ?? row?.pr ?? row?.number)));
  const out = [];
  for (const pr of Array.isArray(rawPrs) ? rawPrs : []) {
    const number = Number(pr?.number), head = pr?.headRefOid;
    if (!Number.isSafeInteger(number) || number < 1 || !HEAD.test(String(head ?? '')) || taken.has(number)) continue;
    if (pr.isDraft || (pr.state && pr.state !== 'OPEN') || !Array.isArray(pr.comments)) continue;
    const labels = names(pr.labels);
    if (!labels.includes('red-team:pending') || labels.some(isHold) || pr.fixClaim?.who) continue;
    if (redTeamForHead(pr.comments, number, head)) continue;
    if (parseReviewedSha(pr.comments) === String(head).toLowerCase()) { out.push({ prNumber: number, headSha: head, reason: 'a' }); continue; }
    const idle = now - Date.parse(pr.updatedAt);
    if (typeof hasLiveProcess !== 'function' || !(idle > QUIET_MS)) continue;
    let live = true;
    try { live = hasLiveProcess({ pr: number, head }) !== false; } catch { /* fail closed */ }
    if (!live) out.push({ prNumber: number, headSha: head, reason: 'c' });
  }
  return out;
}

/** Stateful feeder: returns the plan with the nominated refusals appended; logs once per repo, PR and head. */
export function createRedTeamFeed({ log = () => {}, now = Date.now, hasLiveProcess } = {}) {
  const seen = new Set();
  return function feed({ repo, plan, rawPrs, inventoryComplete = true }) {
    if (inventoryComplete === false) return plan;
    let rows;
    try { rows = planRedTeamFeed({ plan, rawPrs, now: now(), hasLiveProcess }); } catch { return plan; }
    if (!rows.length) return plan;
    for (const row of rows) {
      const key = `${repo}#${row.prNumber}@${row.headSha}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try { log(`review-daemon: red-team enqueue (feed) ${repo}#${row.prNumber} reason=${row.reason}`); } catch { /* diagnostics only */ }
    }
    return { ...plan, refusals: [...(plan?.refusals ?? []),
      ...rows.map(({ prNumber, headSha }) => ({ kind: 'already-reviewed-head', prNumber, headSha }))] };
  };
}
