/**
 * @file scripts/lib/human-escalation-marker.mjs
 * @description WHY an automated escalation put `review:human` on a PR — the machine record the de-escalation
 *   reconcile (`we:scripts/conveyor/human-escalation-deescalate.mjs`) reads.
 *
 * LIVE CASE (2026-10-21). PRs #5502, #5762, #5768 and #5805 carried `review:human` although their net file set does
 * not require a human (`review-core-cli.mjs shape` → humanRequired false). They got the label by ESCALATION — a
 * mandatory referral waiting on a ruling, a ruling ledger write miss, the fix round cap — and the label stayed after
 * the cause was cleared (the ruling recorded, the round grant posted), so they waited for an operator clearance the
 * rules never asked for. Nothing on the PR said which escalation had added the label, so nothing could tell an
 * escalation hold from a rule-required one.
 *
 * Every escalation writer that adds `review:human` now posts one trusted comment carrying
 * `<!-- we:human-escalation kind=<kind> head=<sha|none> -->`. The kind names the cause; the reconcile only lifts a
 * hold whose recorded causes are all cleared. Leaf module: no IO, imports only the authorship gate.
 *
 * Rule-required parks (the producer's shape score, the drain's tamper/test-gaming/gate parks, the human-surface
 * re-park, the mechanical-hold hand-off) carry NO marker on purpose: a `review:human` add the reconcile cannot
 * explain with a marker is always kept.
 */
import { isTrustedMarkerAuthor } from './marker-authorship.mjs';

/** Every recorded escalation kind. Only the ones the setting enables may ever de-escalate. */
export const HUMAN_ESCALATION_KINDS = Object.freeze({
  ROUND_CAP: 'round-cap',
  REFERRAL_PENDING: 'referral-pending',
  REFERRAL_MALFORMED: 'referral-malformed',
  REFERRAL_OVERFLOW: 'referral-overflow',
  REFERRAL_PERSISTENCE_FAILED: 'referral-persistence-failed',
  ORPHAN_FIX_EXHAUSTED: 'orphan-fix-exhausted',
  CARD_EXTRACTION_HELD: 'card-extraction-held',
});
const KNOWN_KINDS = new Set(Object.values(HUMAN_ESCALATION_KINDS));

/** The referral kinds: all cleared by the same proof (no pending and no blocked referral on the live head). */
export const REFERRAL_ESCALATION_KINDS = Object.freeze([
  HUMAN_ESCALATION_KINDS.REFERRAL_PENDING, HUMAN_ESCALATION_KINDS.REFERRAL_MALFORMED,
  HUMAN_ESCALATION_KINDS.REFERRAL_OVERFLOW, HUMAN_ESCALATION_KINDS.REFERRAL_PERSISTENCE_FAILED,
]);

const SHA_RE = /^[0-9a-f]{40}$/;
const MARKER_RE = /<!-- we:human-escalation kind=([a-z0-9-]+) head=([0-9a-f]{40}|none) -->/g;
const normHead = head => (typeof head === 'string' && SHA_RE.test(head.toLowerCase()) ? head.toLowerCase() : 'none');

/** The marker line. Throws on an unknown kind: a writer must name a real cause. */
export function buildHumanEscalationMarker({ kind, head } = {}) {
  if (!KNOWN_KINDS.has(kind)) throw new Error(`unknown human-escalation kind: ${kind}`);
  return `<!-- we:human-escalation kind=${kind} head=${normHead(head)} -->`;
}

/** A short trusted comment naming the escalation, for writers that post nothing else. */
export function buildHumanEscalationComment({ kind, head, detail = '' } = {}) {
  const marker = buildHumanEscalationMarker({ kind, head });
  // Agent text must never forge a marker.
  const text = String(detail ?? '').replace(/<!--/g, '<!- -').replace(/--(!?)>/g, '- -$1>').trim();
  return [`🧑‍⚖️ review:human added by escalation (${kind})`, ...(text ? ['', text] : []), '',
    'The conveyor lifts this hold by itself once this cause is cleared, the net diff needs no human, and no other human-only reason stands.',
    '', marker].join('\n');
}

const NOTE_ROUND_CAP_RE = /<!-- conveyor-note-key: round-cap-exhausted:\d+:PR #\d+: fix auto-repair rounds exhausted /;
const REFERRAL_PARK_PREFIX = 'Mandatory referral review parked to review:human:';
const REFERRAL_RECORD_PREFIX = 'Mandatory review owner:';

/**
 * Every recorded escalation in a thread, oldest first: `{index, createdAt, kind, head, legacy}`. Only trusted
 * authors count. A marker with an unknown kind is returned as `kind: 'unknown'` (never de-escalates).
 * `inferLegacy` also reads the three shapes written before the marker existed (the referral park comment, the
 * fix round-cap note, the mandatory referral record a pending park follows); they are marked `legacy: true`.
 */
export function readHumanEscalations(comments, { inferLegacy = false } = {}) {
  const out = [];
  (Array.isArray(comments) ? comments : []).forEach((c, index) => {
    if (!isTrustedMarkerAuthor(c) || typeof c?.body !== 'string') return;
    const body = c.body;
    const createdAt = c.createdAt ?? c.created_at ?? null;
    const marks = [...body.matchAll(MARKER_RE)];
    if (marks.length) {
      for (const m of marks) out.push({ index, createdAt, kind: KNOWN_KINDS.has(m[1]) ? m[1] : 'unknown', head: m[2] === 'none' ? null : m[2], legacy: false });
      return;
    }
    if (body.includes('we:human-escalation')) { out.push({ index, createdAt, kind: 'unknown', head: null, legacy: false }); return; }
    if (!inferLegacy) return;
    const start = body.trimStart();
    if (start.startsWith(REFERRAL_PARK_PREFIX)) {
      out.push({ index, createdAt, kind: /referral-overflow:/.test(start) ? HUMAN_ESCALATION_KINDS.REFERRAL_OVERFLOW
        : HUMAN_ESCALATION_KINDS.REFERRAL_PERSISTENCE_FAILED, head: null, legacy: true });
    } else if (NOTE_ROUND_CAP_RE.test(body)) {
      out.push({ index, createdAt, kind: HUMAN_ESCALATION_KINDS.ROUND_CAP, head: null, legacy: true });
    } else if (start.startsWith(REFERRAL_RECORD_PREFIX)) {
      out.push({ index, createdAt, kind: HUMAN_ESCALATION_KINDS.REFERRAL_PENDING, head: null, legacy: true, recordOnly: true });
    }
  });
  return out;
}
