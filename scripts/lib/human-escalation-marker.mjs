/**
 * @file scripts/lib/human-escalation-marker.mjs
 * @description WHY an automated escalation put `review:human` on a PR — the machine record the de-escalation
 *   reconcile (`we:scripts/conveyor/human-escalation-deescalate.mjs`) reads.
 *
 * LIVE CASE (2026-10-21). PRs #5502, #5762, #5768 and #5805 carried `review:human` although their net file set does
 * not require a human (`review-core-cli.mjs shape` → humanRequired false). They got the label by ESCALATION — a
 * mandatory referral waiting on a ruling, a ruling ledger write miss — and the label stayed after the cause was
 * cleared, so they waited for an operator clearance the rules never asked for. Nothing on the PR said which
 * escalation had added the label, so nothing could tell an escalation hold from a rule-required one.
 *
 * Every escalation writer that adds `review:human` now posts one trusted comment whose LAST line is
 * `<!-- we:human-escalation kind=<kind> head=<sha|none> -->` and whose FIRST line is that writer's own fixed
 * prefix ({@link ESCALATION_COMMENT_PREFIXES}). A marker anywhere else (quoted in a finding, a file name, agent text)
 * is never read as a record: it is reported as `unknown`, which keeps the hold. Leaf module: no IO.
 *
 * Rule-required parks (the producer's shape score, the drain's tamper/test-gaming/gate parks, the human-surface
 * re-park, the mechanical-hold hand-off) carry NO marker on purpose: a `review:human` add the reconcile cannot
 * explain with a marker is always kept.
 */
import { isTrustedMarkerAuthor } from './marker-authorship.mjs';

/** Every recorded escalation kind. Only {@link CLEARABLE_ESCALATION_KINDS} have a clearing proof. */
export const HUMAN_ESCALATION_KINDS = Object.freeze({
  ROUND_CAP: 'round-cap',
  REFERRAL_PENDING: 'referral-pending',
  REFERRAL_MALFORMED: 'referral-malformed',
  /** The referral thread was written and read back; only the verdict-ledger mirror append failed. */
  REFERRAL_LEDGER_SYNC_FAILED: 'referral-ledger-sync-failed',
  /** The thread itself may be missing the finding: never clearable from the thread. */
  REFERRAL_PERSISTENCE_FAILED: 'referral-persistence-failed',
  /** A ruling too large to store stays pending in no reader: never clearable from the thread. */
  REFERRAL_OVERFLOW: 'referral-overflow',
  ORPHAN_FIX_EXHAUSTED: 'orphan-fix-exhausted',
  CARD_EXTRACTION_HELD: 'card-extraction-held',
});
const KNOWN_KINDS = new Set(Object.values(HUMAN_ESCALATION_KINDS));

/** The referral kinds the live referral thread can prove cleared. */
export const REFERRAL_CLEARABLE_KINDS = Object.freeze([
  HUMAN_ESCALATION_KINDS.REFERRAL_PENDING, HUMAN_ESCALATION_KINDS.REFERRAL_MALFORMED,
  HUMAN_ESCALATION_KINDS.REFERRAL_LEDGER_SYNC_FAILED,
]);
/** Every kind with a clearing proof. No other kind may ever be enabled to de-escalate. */
export const CLEARABLE_ESCALATION_KINDS = Object.freeze([HUMAN_ESCALATION_KINDS.ROUND_CAP, ...REFERRAL_CLEARABLE_KINDS]);

export const ESCALATION_HEADLINE = '🧑‍⚖️ review:human added by escalation';
/** The fixed first line of each writer's escalation comment. */
export const ESCALATION_COMMENT_PREFIXES = Object.freeze([
  ESCALATION_HEADLINE,
  'Mandatory referral review parked to review:human:',
  '🧭 conveyor orphan-guard',
  'Card extraction held for a person:',
]);

const SHA_RE = /^[0-9a-f]{40}$/;
const MARKER_LINE_RE = /^<!-- we:human-escalation kind=([a-z0-9-]+) head=([0-9a-f]{40}|none) -->$/;
const normHead = head => (typeof head === 'string' && SHA_RE.test(head.toLowerCase()) ? head.toLowerCase() : 'none');

/** The marker line. Throws on an unknown kind: a writer must name a real cause. */
export function buildHumanEscalationMarker({ kind, head } = {}) {
  if (!KNOWN_KINDS.has(kind)) throw new Error(`unknown human-escalation kind: ${kind}`);
  return `<!-- we:human-escalation kind=${kind} head=${normHead(head)} -->`;
}

/** Fold text that must never form a marker line or an HTML comment delimiter. */
export const neutralizeEscalationText = text => String(text ?? '').replace(/<!--/g, '<!- -').replace(/--(!?)>/g, '- -$1>');

/** A short trusted comment naming the escalation, for writers that post nothing else. */
export function buildHumanEscalationComment({ kind, head, detail = '' } = {}) {
  const marker = buildHumanEscalationMarker({ kind, head });
  const text = neutralizeEscalationText(detail).trim();
  return [`${ESCALATION_HEADLINE} (${kind})`, ...(text ? ['', text] : []), '',
    'The conveyor lifts this hold by itself once this cause is cleared, the net diff needs no human, and no other human-only reason stands.',
    '', marker].join('\n');
}

/** The escalation kind for a referral sink failure message: only a ledger mirror failure is thread-clearable. */
export function referralFailureKind(message) {
  return /^mandatory ruling ledger(?:-write-miss| sync did not settle)\b/.test(String(message ?? '').trim())
    ? HUMAN_ESCALATION_KINDS.REFERRAL_LEDGER_SYNC_FAILED : HUMAN_ESCALATION_KINDS.REFERRAL_PERSISTENCE_FAILED;
}

const NOTE_ROUND_CAP_RE = /^<!-- conveyor-note-key: round-cap-exhausted:\d+:PR #\d+: fix auto-repair rounds exhausted /m;
const NOTE_COMMENT_HEAD = '🔔 conveyor — needs your decision';
const REFERRAL_PARK_PREFIX = 'Mandatory referral review parked to review:human:';
const REFERRAL_RECORD_PREFIX = 'Mandatory review owner:';
const loginOf = c => String(c?.author?.login ?? c?.user?.login ?? '').toLowerCase().replace(/\[bot\]$/, '');

/**
 * Every recorded escalation in a thread, oldest first: `{index, createdAt, kind, head, legacy, author}`. Only trusted
 * authors count. A marker that is not its writer's own (not the last line under a known first line), or an unknown
 * kind, is returned as `kind: 'unknown'` (never de-escalates). `inferLegacy` also reads the three shapes written
 * before the marker existed (the referral park comment, the fix round-cap note, the mandatory referral record a
 * pending park follows); they are marked `legacy: true`.
 */
export function readHumanEscalations(comments, { inferLegacy = false } = {}) {
  const out = [];
  (Array.isArray(comments) ? comments : []).forEach((c, index) => {
    if (!isTrustedMarkerAuthor(c) || typeof c?.body !== 'string') return;
    const body = c.body;
    const base = { index, createdAt: c.createdAt ?? c.created_at ?? null, author: loginOf(c) };
    if (body.includes('we:human-escalation')) {
      const lines = body.replace(/\r\n?/g, '\n').split('\n');
      const lastLine = lines.filter(l => l.trim()).at(-1)?.trim() ?? '';
      const m = MARKER_LINE_RE.exec(lastLine);
      const owned = ESCALATION_COMMENT_PREFIXES.some(p => body.trimStart().startsWith(p));
      // Exactly one marker, as the last line, under a writer's own first line. Anything else holds.
      const count = (body.match(/we:human-escalation/g) ?? []).length;
      out.push(m && owned && count === 1 && KNOWN_KINDS.has(m[1])
        ? { ...base, kind: m[1], head: m[2] === 'none' ? null : m[2], legacy: false }
        : { ...base, kind: 'unknown', head: null, legacy: false });
      return;
    }
    if (!inferLegacy) return;
    const start = body.trimStart();
    if (start.startsWith(REFERRAL_PARK_PREFIX)) {
      const reason = start.slice(REFERRAL_PARK_PREFIX.length).trim();
      out.push({ ...base, kind: /^referral-overflow:/.test(reason) ? HUMAN_ESCALATION_KINDS.REFERRAL_OVERFLOW : referralFailureKind(reason),
        head: null, legacy: true });
    } else if (start.startsWith(NOTE_COMMENT_HEAD) && NOTE_ROUND_CAP_RE.test(body)) {
      out.push({ ...base, kind: HUMAN_ESCALATION_KINDS.ROUND_CAP, head: null, legacy: true });
    } else if (start.startsWith(REFERRAL_RECORD_PREFIX)) {
      out.push({ ...base, kind: HUMAN_ESCALATION_KINDS.REFERRAL_PENDING, head: null, legacy: true, recordOnly: true });
    }
  });
  return out;
}
