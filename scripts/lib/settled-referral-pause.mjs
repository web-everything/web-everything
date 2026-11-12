/**
 * we:scripts/lib/settled-referral-pause.mjs — is a "review paused: N referrals need a ruling" notice already SETTLED?
 * Live #6719: the reviewer re-posted its findings-less pause notice AFTER the auto-policy rulings for the live head
 * were recorded, so the sweep read it as "ruling needed" and parked the PR on the operator. Settled = the notice is the
 * plain pause shape (no findings block, no persistence-failure detail) AND trusted automatic-policy ruling records,
 * decoded from their structured payload, name the live head and rule at least as many DISTINCT findings as the
 * notice counts. Prose alone proves nothing. The caller also proves nothing is open on that head. PURE.
 */
import { isTrustedMarkerAuthor } from './marker-authorship.mjs';

const PAUSE_LEAD = /^review paused: (\d+) referrals need a ruling; it resumes on a new push, a ruling, or a send-back(?:\n|$)/;
const PERSIST_DETAIL = /Referral persistence (?:failed|retries are exhausted)/;
const RULING_RECORD = /^## Automatic policy ruling on mandatory referrals/;
const PAYLOAD = /<!-- mandatory-referral-operator-ruling-v1: ([A-Za-z0-9+/=]+) -->/;

function autoRulingKeys(comment, live) {
  if (!isTrustedMarkerAuthor(comment) || typeof comment?.body !== 'string' || !RULING_RECORD.test(comment.body.trimStart())) return [];
  const m = PAYLOAD.exec(comment.body);
  if (!m) return [];
  try {
    const p = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
    if (p?.actor !== 'auto-policy' || String(p.head ?? '').toLowerCase() !== live || !Array.isArray(p.rulings)) return [];
    return p.rulings.filter((r) => typeof r?.key === 'string' && r.key && typeof r.result === 'string').map((r) => `${r.runId}\u0000${r.key}`);
  } catch { return []; }
}

/** @param {{holdBody:string, comments:object[], head:string}} o `head` is the full live head sha. */
export function isSettledReferralHold({ holdBody, comments, head }) {
  const body = String(holdBody ?? '').trim();
  const live = String(head ?? '').toLowerCase();
  const lead = PAUSE_LEAD.exec(body);
  if (!/^[0-9a-f]{40}$/.test(live) || !lead || /Waiting on your ruling/.test(body) || PERSIST_DETAIL.test(body)) return false;
  const ruled = new Set((Array.isArray(comments) ? comments : []).flatMap((c) => autoRulingKeys(c, live)));
  return Number(lead[1]) >= 1 && ruled.size >= Number(lead[1]);
}
