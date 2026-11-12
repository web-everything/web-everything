/**
 * we:scripts/lib/settled-referral-pause.mjs — is a "review paused: N referrals need a ruling" notice already SETTLED?
 * Live #6719: the reviewer re-posted its findings-less pause notice AFTER the auto-policy ruling for the live head was
 * recorded, so the sweep read it as "ruling needed" and parked the PR on the operator. Settled = the notice is the
 * plain pause shape (no findings block, no persistence-failure detail) AND a trusted ruling record names the live head
 * AND no referral is still open on that head (the caller proves that). PURE.
 */
import { isTrustedMarkerAuthor } from './marker-authorship.mjs';

const PAUSE_LEAD = /^review paused: \d+ referrals need a ruling; it resumes on a new push, a ruling, or a send-back(?:\n|$)/;
const PERSIST_DETAIL = /Referral persistence (?:failed|retries are exhausted)/;
const RULING_RECORD = /^## Automatic policy ruling on mandatory referrals/;

/** @param {{body:string}} hold  @param {object[]} comments  @param {string} head full live head sha */
export function isSettledReferralHold({ holdBody, comments, head }) {
  const body = String(holdBody ?? '').trim();
  const live = String(head ?? '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(live) || !PAUSE_LEAD.test(body) || /Waiting on your ruling/.test(body) || PERSIST_DETAIL.test(body)) return false;
  return (Array.isArray(comments) ? comments : []).some((c) => isTrustedMarkerAuthor(c) && typeof c?.body === 'string'
    && RULING_RECORD.test(c.body.trimStart()) && c.body.toLowerCase().includes(live));
}
