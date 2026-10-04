/**
 * @file scripts/lib/ruling-ledger.mjs
 * @description Two durable facts about a PR, both read from its own comment thread (the mandatory-referral
 *   records, `jury-core.mjs#readReferralRecords`), so the daemon, the operator queue and the health watch all
 *   answer from ONE definition and no state store of their own:
 *
 *   1. RULING NEEDED — the PR's CURRENT head carries an attempted referral record with CONFIRMED findings that
 *      still await a finding-specific block/card/not-real ruling. Live 2026-10-04, PR #3794: the review parked
 *      correctly ("review paused: N referrals need a ruling") and then nothing told the operator for 8 hours.
 *      This is the input for the `advisory:ruling-needed` label, the NEEDS-YOU row, the push and the health alert.
 *
 *   2. IGNORED RULING — a pending finding on the current head matches (same file, same or similar claim) a
 *      finding the operator already ruled `block` on an EARLIER head. The fixer's push did not satisfy the
 *      ruling. Parking it again just waits for the same human to repeat themselves, so it goes back to the
 *      fixer with the original ruling attached; a second miss is a fixer-versus-reviewer disagreement.
 *
 * PURE. A record is only read from a trusted author (`readReferralRecords` enforces that), and a comment that
 * cannot be read as a record contributes nothing here (the hold itself already fails closed on malformed ones).
 */
import { readReferralRecords, referralRecordState } from './jury-core.mjs';
import { isTrustedMarkerAuthor } from './marker-authorship.mjs';

export const RULING_NEEDED_LABEL = 'advisory:ruling-needed';
export const RULING_NEEDED_LABEL_META = Object.freeze({
  color: 'fbca04',
  description: 'AI review parked with confirmed findings that need an operator ruling on the current head (auto-managed)',
});

/** Leading line of the send-back comment; its hidden second marker carries the head it answered. */
export const RULING_NOT_ADDRESSED_MARKER = '⛔ conveyor — ruling not addressed';
export const RULING_NOT_ADDRESSED_MISSES_TO_ESCALATE = 2;
const SIMILARITY_FLOOR = 0.5;

const SHA = /^[a-f0-9]{40}$/;
const OPENER = /^[ \t]*<!-- mandatory-referrals-v1:/m;
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const sinceOf = (c) => Date.parse(c?.createdAt ?? c?.updatedAt) || null;

/** Each record snapshot with the comment that carried it, in thread order. Reuses the one record reader. */
function recordSnapshots(comments, head) {
  const out = [];
  (Array.isArray(comments) ? comments : []).forEach((comment, index) => {
    if (typeof comment === 'string' || !OPENER.test(comment?.body ?? '')) return;
    for (const record of readReferralRecords([comment], { head }).records) out.push({ record, comment, index });
  });
  return out;
}

const findingView = (f) => ({
  key: f.key, seat: f.seat, file: f.finding?.file ?? null, line: f.finding?.line ?? null,
  summary: oneLine(f.finding?.summary),
});

const activeRulings = (record, key) => {
  const mine = record.rulings.filter((r) => r.key === key);
  const superseded = new Set(mine.flatMap((r) => (r.supersedes == null ? [] : [].concat(r.supersedes))));
  return mine.filter((r) => !superseded.has(r.id));
};

/** Referral keys on `record` that still need a ruling at `head` (card rulings are trusted: no fs read here). */
function pendingKeys(record, head) {
  const state = referralRecordState(record, { head, cardReadable: () => true });
  return state.pending.filter((k) => record.referrals.some((f) => f.key === k));
}

/**
 * The findings that await a ruling on the PR's current head, or null.
 * @param {{comments?: Array, headRefOid?: string}} pr
 * @returns {null|{head:string, since:number|null, findings:Array<{key:string,seat:string,file:?string,line:?number,summary:string}>}}
 */
export function rulingNeeded(pr) {
  const head = String(pr?.headRefOid ?? '').toLowerCase();
  if (!SHA.test(head)) return null;
  // Judge the LAST snapshot of each (record, head): a later one may have ruled a key an earlier one left pending.
  const latest = new Map();
  let since = null;
  for (const s of recordSnapshots(pr?.comments, head)) {
    if (s.record.head !== head || !s.record.attempted) continue;
    latest.set(s.record.runId, s);
    const at = sinceOf(s.comment);
    if (at !== null && (since === null || at < since)) since = at;
  }
  const live = new Map();
  for (const { record } of latest.values()) {
    const pending = pendingKeys(record, head);
    for (const f of record.referrals) if (pending.includes(f.key) && !live.has(f.key)) live.set(f.key, findingView(f));
  }
  return live.size ? { head, since, findings: [...live.values()] } : null;
}

const tokens = (text) => new Set(oneLine(text).toLowerCase().split(/[^a-z0-9_./-]+/).filter((w) => w.length > 2));
export function claimSimilarity(a, b) {
  const x = tokens(a), y = tokens(b);
  if (!x.size || !y.size) return oneLine(a).toLowerCase() === oneLine(b).toLowerCase() ? 1 : 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / (x.size + y.size - shared);
}
const normPath = (p) => String(p ?? '').replace(/^\.\//, '').replace(/^\/+/, '');
/** Same file, and the same or a similar claim (the line may drift after a fix, so it is never compared). */
export function sameFinding(a, b) {
  if (a.file && b.file && normPath(a.file) !== normPath(b.file)) return false;
  if ((a.file || b.file) && !(a.file && b.file)) return false;
  return claimSimilarity(a.summary, b.summary) >= SIMILARITY_FLOOR;
}

/** The operator's own words for a ruling, one block of text for the fixer. */
export function rulingText(ruling) {
  const parts = [`${ruling.result}${ruling.card ? ` (${ruling.card})` : ''}: ${oneLine(ruling.rationale)}`];
  if (Array.isArray(ruling.evidence) && ruling.evidence.length) parts.push(`evidence: ${ruling.evidence.map(oneLine).join('; ')}`);
  return parts.join(' | ');
}

/**
 * Pending findings on the current head that repeat a finding ruled `block` on an earlier head.
 * `misses` = distinct heads, after the ruling, on which the finding came back (the current head included).
 * @returns {null|{head:string, misses:number, escalate:boolean, sentBack:boolean, matches:Array<object>}}
 */
export function ignoredRulings(pr) {
  const head = String(pr?.headRefOid ?? '').toLowerCase();
  const need = rulingNeeded(pr);
  if (!need) return null;
  const snaps = recordSnapshots(pr?.comments, head);
  // First thread position at which each block ruling appears, on a head other than the current one.
  const blocks = new Map();
  for (const { record, index } of snaps) {
    if (record.head === head) continue;
    for (const f of record.referrals) {
      for (const r of activeRulings(record, f.key)) {
        if (r.result !== 'block') continue;
        const id = `${record.head}:${r.id}`;
        if (!blocks.has(id)) blocks.set(id, { finding: findingView(f), ruling: r, priorHead: record.head, index });
      }
    }
  }
  const matches = [];
  let worst = 0;
  for (const g of need.findings) {
    for (const b of blocks.values()) {
      if (!sameFinding(g, b.finding)) continue;
      const heads = new Set();
      for (const { record, index } of snaps) {
        if (index <= b.index || record.head === b.priorHead) continue;
        if (record.referrals.some((f) => sameFinding(findingView(f), b.finding))) heads.add(record.head);
      }
      heads.add(head);
      const misses = heads.size;
      worst = Math.max(worst, misses);
      matches.push({ finding: g, ruledFinding: b.finding, ruling: rulingText(b.ruling), priorHead: b.priorHead, misses });
      break;
    }
  }
  if (!matches.length) return null;
  return {
    head, misses: worst, escalate: worst >= RULING_NOT_ADDRESSED_MISSES_TO_ESCALATE,
    sentBack: sentBackAt(pr?.comments, head) !== null, sentBackAt: sentBackAt(pr?.comments, head), matches,
  };
}

const sentBackLine = (head) => `<!-- ruling-not-addressed: ${head} -->`;
/** When a trusted author sent this head back (ms), or null. Also the once-per-head guard for the post. */
export function sentBackAt(comments, head) {
  const times = (Array.isArray(comments) ? comments : []).filter((c) => isTrustedMarkerAuthor(c)
    && String(c?.body ?? '').trimStart().startsWith(RULING_NOT_ADDRESSED_MARKER)
    && String(c.body).includes(sentBackLine(head))).map((c) => sinceOf(c) ?? 0);
  return times.length ? Math.min(...times) : null;
}
export const hasSentBack = (comments, head) => sentBackAt(comments, head) !== null;

const where = (f) => `${f.file ?? '(no file)'}${f.line ? `:${f.line}` : ''}`;
/** The PR comment that goes with the send-back: the durable record AND what the fixer reads. */
export function renderRulingNotAddressed({ head, matches }) {
  return `${RULING_NOT_ADDRESSED_MARKER}\n\nThe last fix did not satisfy a ruling the operator already gave. `
    + 'A review on the new head reports the same confirmed finding again, so this goes straight back to the fixer.\n\n'
    + matches.map((m) => `- \`${where(m.finding)}\` — ${m.finding.summary}\n`
      + `  - earlier ruling (head \`${m.priorHead.slice(0, 9)}\`): ${m.ruling}\n`
      + `  - times it came back after the ruling: ${m.misses}`).join('\n')
    + `\n\n${sentBackLine(head)}`;
}

/** The text put in front of the fixer's brief. */
export function fixerRulingBrief({ matches }) {
  return '# Ruling not addressed — read this first\n\n'
    + 'The operator already ruled on the finding(s) below, and your predecessor\'s last push did not satisfy the ruling. '
    + 'This is the whole ask: change the code so each finding is actually fixed as ruled. '
    + 'Treat the "⛔ conveyor — ruling not addressed" comment on the PR as the authoritative finding '
    + '(advisory-fix style: repair only this, no verdict, never touch review:human).\n\n'
    + matches.map((m) => `- ${where(m.finding)} — ${m.finding.summary}\n  Operator ruling, verbatim: ${m.ruling}\n  Note: the last fix did not satisfy this.`).join('\n')
    + '\n\n';
}

export const rulingDisputeText = (prNumber, ig) => `PR #${prNumber}: ${ig.matches.length} confirmed finding(s) the operator ruled "block" came back on the new head `
  + (ig.sentBack && !ig.escalate ? '(the fixer was sent back and returned without a new head)' : `(${ig.misses} misses after the ruling)`)
  + ' — fixer and reviewer disagree; a person (or an arbiter) must decide. '
  + ig.matches.map((m) => `${where(m.finding)}`).join(', ');
