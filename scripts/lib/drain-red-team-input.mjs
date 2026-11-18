/** Admission normalization leaf: loading queue policy must not load the review/recovery IO graph. */
import { readRedTeamDisposition, redTeamHoldPendingOnly, redTeamResultCommentForHead, readRedTeamProbes } from './red-team-gate.mjs';

export function drainRedTeamDecisionInput({ evidence: raw, comments, head, pr, repo, env = process.env,
  standingRuling, confirmedBreaks, readSource = raw?.decisionInput?.readSource } = {}) {
  const disposition = readRedTeamDisposition({ comments, pr, head, repo, env, standingRuling, setting: confirmedBreaks });
  const hit = redTeamResultCommentForHead(comments, pr, head);
  const fromRev = hit?.carriedFrom ?? raw.carry?.loopPayload?.carriedFrom;
  let carry = raw.carry && Object.hasOwn(raw.carry, 'fromRev') ? raw.carry : null;
  if (fromRev && !carry) {
    try {
      carry = { fromRev, proof: readSource({ head: fromRev, comments: hit ? comments.slice(0, hit.commentIndex) : [] }) };
    } catch { /* unreadable source is a carry conflict, never payment */ }
  }
  const pendingPublish = redTeamHoldPendingOnly(disposition);
  return { head, read: raw.loopPayload?.findings?.read, seats: raw.seats ?? [], result: hit?.parsed ?? null, carry,
    ok: raw.ok, reason: raw.reason, carryConflict: raw.carryConflict || !!(fromRev && !carry),
    hasBreak: !pendingPublish && !!(disposition.sendBack.length || disposition.held.length), pendingPublish,
    scheduling: { inFlight: !!raw.inFlight, queued: !!raw.queued, scheduled: !!raw.scheduled,
      skipCardOnly: raw.skipCardOnly ?? readRedTeamProbes({ env }).value.skipCardOnly } };
}
