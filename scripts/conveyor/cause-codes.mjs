/** Stable reason vocabulary. Ordered: specific causes precede their generic wrappers. */
const TABLE = [
 [/shared freeze unreadable/i, 'drain:blocked-all:freeze-unreadable'],
 [/red-main-hold.*main is red/i, 'drain:blocked-all:main-red'],
 [/SCOPE.*(?:cannot carry safely|unsafe)|scope-unsafe/i, 'dispatch:scope-unsafe'],
 [/host-load|cpu idle.*(?:<|wait)/i, 'dispatch:host-load'],
 [/stale-clone|stale-checkout|behind origin\/main/i, 'dispatch:stale-clone'],
 [/timeout-evidence|timeout-rerun|timeout-retry-ineligible|juror.*timed? ?out/i, 'review:juror-timeout'],
 [/ruling-dispute/i, 'redteam:ruling-dispute'],
 [/mq-same-head/i, 'mq:same-head-hold'],
 [/removed.from.(?:merge.)?queue|merge.queue.*re-entry/i, 'mq:removed-reentry'],
 [/draft-not-promoted|draft-promotion: skip/i, 'dispatch:draft-not-promoted'],
 [/round-cap|round cap/i, 'review:round-cap'],
 [/cap-exhausted/i, 'fix:cap-exhausted'],
 [/fix-loop-hold/i, 'fix:loop-hold'],
 [/fix-claimed/i, 'fix:claimed'],
 [/own-failure/i, 'fix:ci-heal-wait'],
 [/fix-not-live/i, 'daemon:fix-not-live'],
 [/no-lane|no acquirable lane/i, 'review:pickup-wait:no-lane'],
 [/live-review cap/i, 'review:pickup-wait:live-review-cap'],
 [/dispatch-failed/i, 'dispatch:failed'],
 [/nothing-owed/i, 'dispatch:nothing-owed'],
 [/owed-elsewhere/i, 'dispatch:owed-elsewhere'],
 [/ci-heal/i, 'fix:ci-heal-wait'],
 [/red-team:pending.*no dispatch/i, 'redteam:pending-no-dispatch'],
 [/reconcile-refused (?:review-ci|draft|already-reviewed-head|review-referrals-pending|live-process|stood-down)\b/i, 'dispatch:reconcile-refused'],
 [/checks-pending|required.check.*not green/i, 'ci:queued'],
 [/checks-failed/i, 'ci:failed'],
 [/rerun.on.push/i, 'ci:rerun-on-push'],
 [/review:human/i, 'human:review-human'],
 [/status:needs-you/i, 'human:needs-you'],
];
const PICKUP = ['review-ci', 'draft', 'already-reviewed-head', 'review-referrals-pending', 'live-process', 'stood-down', 'owed', 'auth', 'cooldown', 'disabled'];
/** Remove volatile identity before using any text as a key detail. Raw evidence is retained separately. */
export function stableDetail(value) {
 return String(value ?? '').toLowerCase()
  .replace(/\d{4}-\d\d-\d\dt[\d:.]+z/g, ' ')
  .replace(/(?:pr\s*#?\s*|#)\d+\b/g, ' ')
  .replace(/\b[0-9a-f]{7,64}\b/g, ' ')
  .replace(/\b\d+\b/g, ' ').replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');
}
export function classifyReason(rawLine, { daemon } = {}) {
 const raw = String(rawLine ?? '');
 let key;
 // Preserve specific nested failures even inside a generic pickup/refusal wrapper.
 for (const [re, mapped] of TABLE.slice(0, 16)) if (re.test(raw)) { key = mapped; break; }
 if (!key) {
  const tail = raw.match(/no review dispatched [—-] (.*)/)?.[1];
  const reason = tail || raw.match(/reconcile-refused (.*)/)?.[1];
  if (reason) {
   const pickup = PICKUP.find(x => x === 'owed' ? /^owed(?:\s|$)/.test(reason) : new RegExp(`^${x}\\b`).test(reason));
   if (pickup) key = `review:pickup-wait:${pickup}`;
  }
 }
 if (!key) for (const [re, mapped] of TABLE.slice(16)) if (re.test(raw)) { key = mapped; break; }
 if (!key && /pass-timing/.test(raw)) key = `daemon:pass-latency:${stableDetail(daemon || 'pass')}`;
 if (!key) {
  const text = raw.replace(/^.*?(?:daemon:|no review dispatched [—-])\s*/, '').replace(/^(?:reconcile-refused|refused)\s+/, '');
  key = `other:${stableDetail(text).split('-').slice(0,3).join('-') || 'empty'}`;
  return {key, stage:'unknown', code:'other', detail:key.slice(6), raw};
 }
 const [stage, code, ...details] = key.split(':');
 return {key, stage, code, ...(details.length ? {detail:details.join(':')} : {}), raw};
}
export function bucketCauseKey(bucket, note = '') {
 if (bucket === 'CI running') return `ci:running:${stableDetail(note.split('/').pop()) || 'unknown-job'}`;
 if (bucket === 'CI queued') return 'ci:queued';
 if (/re-entry/.test(bucket)) return 'mq:removed-reentry';
 if (bucket === 'merge queue') return 'mq:queued';
 if (/red-team/.test(bucket)) return /running/.test(bucket) ? 'redteam:running' : 'redteam:pending-no-dispatch';
 if (/no transcript/.test(bucket)) return 'fix:agent-unattributed';
 if (/human/.test(bucket)) return /needs-you/.test(note) ? 'human:needs-you' : 'human:review-human';
 if (/idle/.test(bucket)) return 'unknown:idle';
 if (/pickup wait: fix/.test(bucket)) return 'fix:pickup-wait';
 if (/pickup wait: review/.test(bucket)) return 'review:pickup-wait';
 if (/review juror/.test(bucket)) return 'review:running';
 if (/agent editing/.test(bucket)) return 'fix:editing';
 if (/non-gating/.test(bucket)) return 'ci:non-gating';
 if (/local:/.test(bucket)) return `fix:local:${stableDetail(bucket.slice(6))}`;
 return 'unknown:idle';
}
