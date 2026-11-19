/** Independent recovery of queued heads; planner refusal/probe turns cannot starve this pass. */
import { appendDaemonEvent } from './daemon-events.mjs';
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

/** Timer-only orchestration. runQueue is the same queue runner used by the planner hook. */
export async function drainRedTeamQueue({ queue, runQueue, readPrs, capacity, alertAfterMin = 60, now = Date.now,
  log = () => {}, alert = appendDaemonEvent }) {
  const at = now();
  const note = message => {
    try { log(`review-daemon: red-team queue drain ${message}`.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')); } catch { /* diagnostic */ }
  };
  const entries = queue.entries().sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  const summary = { dispatched: 0, oldestAgeMin: entries.length ? Math.max(0, (at - entries[0].enqueuedAt) / 60_000) : 0 };
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
  }
  // Include every queued head, even drafts and heads absent from the fresh open-PR list.
  // Shared reconciliation retains unknown evidence and replaces stale heads before admission.
  const snapshots = new Map();
  // Prepare the shared capacity once; later entries must not replenish spent starts via the floor.
  const drainPass = {};
  // An empty pass still repairs a previously failed post-dispatch persistence transaction.
  for (const entry of entries.length ? entries : [{ repo: undefined }]) {
    const repo = entry.repo;
    try {
      if (repo && !snapshots.has(repo)) {
        snapshots.set(repo, null); // A failed list is read only once per repository per interval.
        const rawPrs = await readPrs({ repo, fresh: true });
        if (Array.isArray(rawPrs) && !rawPrs.discoveryIncomplete) snapshots.set(repo, rawPrs);
      }
      if (repo && !snapshots.get(repo)) { note(`${repo}: open PR list unreadable; retry next interval`); continue; }
      const result = await runQueue({ repo, plan: { refusals: queue.entries().filter(current => current.repo === repo)
        .map(current => ({ kind: 'already-reviewed-head', prNumber: current.pr, headSha: current.head })) },
        rawPrs: snapshots.get(repo) ?? [], capacity, drain: true, drainPr: entry.pr, drainPass });
      summary.dispatched += result?.dispatched?.length ?? 0;
    } catch (error) { note(`recovery failed; retry next interval: ${error?.message ?? error}`); }
  }
  note(`dispatched=${summary.dispatched} oldestAgeMin=${summary.oldestAgeMin.toFixed(1)}`);
  await Promise.all(alerts);
  return summary;
}
