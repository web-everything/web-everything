/** Independent recovery of queued heads; planner refusal/probe turns cannot starve this pass. */
import { readLiveRedTeamPr } from './red-team-dispatch-queue.mjs';
import { appendDaemonEvent } from './daemon-events.mjs';
import { OPERATOR_CAPACITY_MAX } from './operator-override-reader.mjs';
import { readFileSync } from 'node:fs';
import { cascadePolicy } from './policy-cascade.mjs';

export function loadRedTeamQueueDrainSettings(options = {}) {
  let tool;
  try { tool = JSON.parse(readFileSync(new URL('../settings/red-team-queue.json', import.meta.url), 'utf8'))?.redTeam?.queue; } catch { /* standard */ }
  return cascadePolicy('redTeamQueue', tool, {
    ...options, standard: { alertAfterMin: 60 },
    valid: { alertAfterMin: value => Number.isSafeInteger(value) && value > 0 },
  }).value;
}

/** capacity.minConcurrent is the resolved queue floor; inFlight must be freshly observed.
 * Unknown capacity holds entries for the next pass (and still reports/alerts their age).
 * Recovery is synchronous, matching runRedTeamOnSkip and the shared queue's settlement ledger.
 */
export async function drainRedTeamQueue({ queue, readLivePr = readLiveRedTeamPr, runRecovery, capacity, now = Date.now,
  log = () => {}, alert = appendDaemonEvent }) {
  const at = now();
  const note = message => {
    try { log(`review-daemon: red-team queue drain ${message}`.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')); } catch { /* diagnostic */ }
  };
  const liveEvidence = queue.reconcile({ readLivePr });
  const entries = queue.entries().sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  const summary = { admitted: 0, dispatched: 0, oldestAgeMin: entries.length ? Math.max(0, (at - entries[0].enqueuedAt) / 60_000) : 0 };
  const valid = value => Number.isSafeInteger(value) && value >= 0;
  let slots = valid(capacity?.minConcurrent) && capacity.minConcurrent <= OPERATOR_CAPACITY_MAX.redTeam
    && valid(capacity?.inFlight) && valid(capacity?.lanes) && valid(capacity?.remainingStarts)
    ? Math.max(0, Math.min(capacity.minConcurrent - capacity.inFlight, capacity.lanes, capacity.remainingStarts)) : 0;
  if (capacity?.budget) slots = valid(capacity.budget.left) ? Math.min(slots, capacity.budget.left) : 0;
  if (!slots && entries.length) note('no readable capacity; retained for next interval; inspect host/lane/queue limits if persistent');
  const alertAfterMin = valid(capacity?.alertAfterMin) && capacity.alertAfterMin > 0 ? capacity.alertAfterMin : 60;
  const alerts = [];
  for (const entry of entries) {
    const ageMin = Math.max(0, (at - entry.enqueuedAt) / 60_000);
    if (ageMin > alertAfterMin && entry.alertedHead !== entry.head) {
      // Only delivered alerts suppress this head on later drains or daemon restarts.
      try {
        alerts.push(Promise.resolve(alert({ kind: 'red-team-queue-aged', repo: entry.repo, pr: entry.pr,
          daemon: 'review-daemon', detail: { key: entry.key, head: entry.head, ageMin, needsYou: true } }))
          .then(delivered => { if (delivered !== false) queue.noteDrain(entry, { alertedHead: entry.head }); }).catch(() => {}));
      } catch { /* Leave unmarked so the next drain retries delivery. */ }
    }
    const livePr = liveEvidence.get(entry.key);
    // Retention is not admission evidence: unknown heads must not spend a recovery slot.
    if (livePr?.state !== 'OPEN' || livePr.headRefOid !== entry.head) continue;
    if (livePr.isDraft !== false) {
      note(`hold ${entry.key}: draft or unreadable draft state; retry next interval`);
      continue;
    }
    if (!slots) continue;
    // Recheck at dispatch: the PR may have become a draft since reconciliation.
    let dispatchPr;
    try { dispatchPr = readLivePr({ repo: entry.repo, pr: entry.pr }); } catch { /* Retain unknown evidence. */ }
    if (dispatchPr?.state !== 'OPEN' || dispatchPr.headRefOid !== entry.head || dispatchPr.isDraft !== false) {
      note(`hold ${entry.key}: live PR/head/draft state changed or unreadable; retry next interval`);
      continue;
    }
    if (!queue.admitDrain(entry, at).length) continue;
    slots--; summary.admitted++;
    let result;
    try {
      result = runRecovery({ repo: entry.repo,
        plan: { refusals: [{ kind: 'already-reviewed-head', prNumber: entry.pr, headSha: entry.head }] },
        capacity, log: note });
    } catch (error) { note(`recovery failed for ${entry.key}: ${error?.message ?? error}`); }
    // An unreadable result is a failed attempt, never evidence that the head is no longer owed.
    result ??= { notStarted: [{ prNumber: entry.pr, reason: 'recovery unreadable' }] };
    queue.settle(entry.repo, result);
    summary.dispatched += (result.dispatched ?? []).length;
    // The existing attempt limit rotates failed entries. A cooldown also bounds repeated planner skips.
    const remaining = queue.entries().find(e => e.key === entry.key && e.head === entry.head);
    if (remaining) queue.noteDrain(entry, { retryAt: at + 60_000 * 2 ** Math.min(remaining.attempts, 3) });
  }
  note(`admitted=${summary.admitted} dispatched=${summary.dispatched} oldestAgeMin=${summary.oldestAgeMin.toFixed(1)}`);
  await Promise.all(alerts);
  return summary;
}
