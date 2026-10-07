/**
 * @file scripts/operations/record-referral-ruling.mjs
 * @description THE `record-referral-ruling` DECLARATION (#4979) — the sanctioned way to record an OPERATOR's
 *   block / card / not-real ruling on a PR's mandatory referrals (CONFIRMED broken/unrecoverable findings).
 *
 * WHY. A mandatory referral holds `review-set-label.mjs --to=clear-human` until each finding has a
 * finding-specific ruling. The only writer of rulings was the assigned independent reviewer (its id is derived
 * from the referral run). When the OPERATOR ruled — PR #3771, 2026-10-04: "card" on the remaining protected-list
 * findings, follow-up card xvm9vbu — nothing could record it, and the PR could not move. Hand-posting a ruling
 * comment would be a forged record. This operation is the one writer; the gate
 * (we:scripts/lib/jury-core.mjs#mandatoryReferralState) reads what it writes.
 *
 *   | step    | kind      | does                                                                           |
 *   |---------|-----------|--------------------------------------------------------------------------------|
 *   | `read`  | `compute` | the PR's live head, body and comments, plus the resolved `--card` reference   |
 *   | `plan`  | `compute` | THE VERDICT: the open findings on the live head, the ones selected, the record |
 *   | `write` | `effect`  | posts the one comment, then reads the thread back and proves the gate sees it  |
 *
 * WHAT IT REFUSES (every refusal is a thrown error naming why; nothing is posted):
 *   - an actor that is not a registered operator login, a blank `--reason` (the operator's words, verbatim),
 *     a blank or multi-line `--channel`;
 *   - `--ruling=card` without a card that resolves to a readable we:backlog card in this checkout, or a
 *     `--card` on any other ruling;
 *   - a selection naming nothing open on the live head (the head is pinned at read time; the write re-checks it);
 *   - a malformed referral thread (the gate already holds it; a ruling cannot repair a broken record).
 *
 * `--finding` selects from the OPEN findings on the live head (pending or blocked), numbered from 1 in thread
 * order: `all-open`, a comma list of numbers (`1,3`), `<file>:<line>`, `<file>` (no line), or one exact finding key.
 * `--preview` plans and prints without posting.
 *
 * FOLLOW-UP (plateau-app #202, 2026-10-04). Once this ruling leaves no pending finding on the head: any `block`
 * sends the PR back through review-set-label's own `--to=changes` path (listing each blocked finding and its
 * rationale); otherwise the posted ruling wakes the paused review. Both clear `advisory:ruling-needed`.
 * Set `--sendBack=false` or `WE_REFERRAL_RULING_FOLLOW_UP=0` to disable this follow-up (enabled by default).
 *
 * PURE. The reader and the sink live in `./record-referral-ruling-io.mjs`.
 */

import { op } from './registry.mjs';
import { compute, effect as effectStep } from './step-kinds.mjs';
import {
  activeReferrals, buildOperatorRulingComment, mandatoryReferralState, referralRecordState,
  validateOperatorRuling, OPERATOR_RULING_RESULTS,
} from '../lib/jury-core.mjs';
import { OPERATOR_LOGINS } from '../lib/marker-authorship.mjs';

export const RECORD_REFERRAL_RULING_OP = 'record-referral-ruling';
export const OPERATOR_RULING_POST_EFFECT = 'github.operator-referral-ruling';
export const OPERATOR_RULING_FOLLOW_UP_EFFECT = 'github.operator-referral-ruling-follow-up';
/** Mirrors the derived label of PR #3889's ruling-needed sweep. */
export const RULING_NEEDED_LABEL = 'advisory:ruling-needed';

/**
 * The findings still open on `head`: every active referral of a current-head record that the gate leaves
 * pending or blocked. Numbered from 1 in thread order. PURE.
 */
export function openReferralFindings({ comments, repo, pr, head, body = '', createdAt = '', cardReadable = () => false }) {
  const context = { repo, pr, head, body, createdAt, cardReadable };
  const state = mandatoryReferralState(comments, context);
  const open = [];
  for (const record of state.records) {
    if (record.head !== head || record.repo !== repo || record.pr !== Number(pr)) continue;
    const s = referralRecordState(record, { ...context, records: state.records, operatorRulings: state.operatorRulings });
    const held = new Set([...s.pending, ...s.blocked]);
    for (const f of activeReferrals(record)) {
      if (held.has(f.key)) {
        const blocked = s.blocked.includes(f.key);
        const effective = s.rulings.filter((r) => r.key === f.key).at(-1);
        open.push({ index: open.length + 1, runId: record.runId, key: f.key, seat: f.seat,
          file: f.finding?.file ?? '', line: Number.isInteger(f.finding?.line) ? f.finding.line : null,
          summary: f.finding?.summary ?? '', state: blocked ? 'blocked' : 'pending',
          rationale: blocked ? (effective?.rationale ?? effective?.reason ?? '') : '' });
      }
    }
  }
  return { open, malformed: state.malformed, pending: state.pending, blocked: state.blocked };
}

/** Pick the selected open findings. PURE; throws on a selection that names nothing or something not open. */
export function selectFindings(open, finding) {
  const sel = String(finding ?? '').trim();
  if (!sel) throw new Error('--finding is required: all-open, a comma list of open-finding numbers, <file>:<line>, <file>, or one exact key');
  if (sel === 'all-open') {
    if (!open.length) throw new Error('no open mandatory-referral findings on the live head — nothing to rule on');
    return open;
  }
  if (/^\d+(,\d+)*$/.test(sel)) {
    const picked = [...new Set(sel.split(',').map(Number))].map((n) => {
      const hit = open.find((o) => o.index === n);
      if (!hit) throw new Error(`--finding=${n} is not an open finding on the live head (open: 1..${open.length})`);
      return hit;
    });
    return picked;
  }
  const hits = open.filter((o) => o.key === sel);
  if (hits.length) return hits;
  const location = /^(.+):(\d+)$/.exec(sel);
  const matches = open.filter((o) => location
    ? o.file === location[1] && o.line === Number(location[2])
    : o.file === sel && o.line == null);
  if (matches.length === 1) return matches;
  const list = (entries) => entries.map((o) => `  ${o.index}. ${o.seat} ${findingLocation(o)} — ${o.summary}`).join('\n');
  if (matches.length > 1) throw new Error(`--finding=${sel} is ambiguous:\n${list(matches)}\nPick by number.`);
  throw new Error(`--finding=${sel} matches no open finding on the live head. Open:\n${list(open)}`);
}

/** Render a finding's location. PURE. */
const findingLocation = ({ file, line }) => `${file ?? ''}${line == null ? '' : `:${line}`}`;

/** Decide the handoff after the last pending ruling, preserving blocks from other findings. PURE. */
export function planRulingFollowUp({ open, selected, ruling, reason, enabled, head }) {
  if (!enabled) return null;
  const isSelected = (o) => selected.some((s) => s.runId === o.runId && s.key === o.key);
  if (open.some((o) => o.state === 'pending' && !isSelected(o))) return null;
  const blocked = open.filter((o) => isSelected(o) ? ruling === 'block' : o.state === 'blocked')
    .map((o) => ({ seat: o.seat, file: o.file, line: o.line, summary: o.summary,
      rationale: isSelected(o) ? reason : o.rationale }));
  if (!blocked.length) return { action: 'resume' };
  const prose = (s) => String(s ?? '').replace(/<!--/g, '&lt;!--').replace(/-->/g, '--&gt;').replace(/\s+/g, ' ').trim();
  const body = '### Blocked referral findings (operator ruling)\n\n'
    + `The operator ruled these mandatory-referral findings \`block\` on head \`${head}\`. Fix each one, then push.\n\n`
    + blocked.map((o, i) => `${i + 1}. \`${findingLocation(o)}\` (${o.seat}) — ${prose(o.summary)}`
      + (prose(o.rationale) ? `\n   Rationale: ${prose(o.rationale)}` : '')).join('\n');
  return { action: 'send-back', blocked, body };
}

/** THE VERDICT. Build and validate the record; refuse anything the gate would not honour. PURE. */
export function planOperatorRuling(read, input) {
  const { repo, pr, finding, ruling, actor, channel, reason } = input;
  if (!OPERATOR_RULING_RESULTS.includes(ruling)) throw new Error(`--ruling must be one of ${OPERATOR_RULING_RESULTS.join('|')}`);
  if (!OPERATOR_LOGINS.includes(String(actor ?? '').toLowerCase())) {
    throw new Error(`--actor must be a registered operator login (${OPERATOR_LOGINS.join(', ')}); this ruling is the operator's`);
  }
  if (!String(reason ?? '').trim()) throw new Error('--reason is required: the operator\'s words, verbatim');
  if (!String(channel ?? '').trim() || /[\r\n]/.test(channel)) throw new Error('--channel is required and must be one line');
  if (ruling === 'card' && !read.card) throw new Error('--ruling=card requires --card=<id or we:backlog path> naming a readable backlog card');
  if (ruling === 'card' && !read.card.readable) throw new Error(`--card ${read.card.requested} does not resolve to a readable backlog card in this checkout (${read.card.reason})`);
  if (ruling !== 'card' && read.card) throw new Error('--card applies only to --ruling=card');
  if (read.malformed) throw new Error('the PR thread carries a malformed referral record or ruling; the gate holds it and a ruling cannot repair it');
  const selected = selectFindings(read.open, finding);
  const record = {
    version: 1, repo, pr: Number(pr), head: read.head,
    rulings: selected.map((o) => ({ runId: o.runId, key: o.key, result: ruling, ...(ruling === 'card' ? { card: read.card.ref } : {}) })),
    actor: String(actor).toLowerCase(), channel: String(channel).trim(), reason: String(reason), at: read.now,
    clearerId: read.clearerId,
  };
  if (!validateOperatorRuling(record)) throw new Error('the operator ruling record failed validation; nothing posted');
  const followUp = planRulingFollowUp({ open: read.open, selected, ruling, reason, head: read.head,
    enabled: input.sendBack !== false && read.followUpEnabled !== false });
  return { record, body: buildOperatorRulingComment(record), selected, open: read.open, followUp };
}

export function recordReferralRulingOperation({ readRulingContext } = {}) {
  if (typeof readRulingContext !== 'function') {
    throw new TypeError('record-referral-ruling: needs a `readRulingContext({repo, pr, card})` reader — the real '
      + 'binding is `we:scripts/operations/record-referral-ruling-io.mjs`.');
  }
  return op(RECORD_REFERRAL_RULING_OP, {
    input: {
      pr: 'number',
      repo: 'string',
      finding: 'string',
      ruling: { type: 'string', enum: [...OPERATOR_RULING_RESULTS] },
      card: { type: 'string', required: false },
      actor: 'string',
      channel: 'string',
      reason: 'string',
      sendBack: { type: 'boolean', required: false, default: true },
      preview: { type: 'boolean', required: false, default: false },
    },
    verdictFrom: 'plan',
    read: compute({
      reads: ['input.repo', 'input.pr', 'input.card'],
      fn: (view) => readRulingContext({ repo: view.input.repo, pr: view.input.pr, card: view.input.card }),
    }),
    plan: compute({
      reads: ['input.repo', 'input.pr', 'input.finding', 'input.ruling', 'input.actor', 'input.channel',
        'input.reason', 'input.sendBack', 'findings.read'],
      fn: (view) => planOperatorRuling(view.findings.read, view.input),
    }),
    write: effectStep({
      reads: ['verdict', 'input.preview'],
      // NOT idempotent: a repeat posts a second comment. The sink re-reads the thread first and skips a
      // byte-identical ruling already present, so a replay after a crash cannot double-post.
      effects: (view) => (view.input.preview ? [] : [{
        type: OPERATOR_RULING_POST_EFFECT, idempotent: false,
        payload: { repo: view.verdict.record.repo, pr: view.verdict.record.pr, head: view.verdict.record.head, body: view.verdict.body,
          rulings: view.verdict.record.rulings.map((r) => ({ key: r.key, result: r.result })),
          actor: view.verdict.record.actor, channel: view.verdict.record.channel },
      }, ...(view.verdict.followUp ? [{
        type: OPERATOR_RULING_FOLLOW_UP_EFFECT, idempotent: true,
        payload: { repo: view.verdict.record.repo, pr: view.verdict.record.pr, head: view.verdict.record.head,
          action: view.verdict.followUp.action, body: view.verdict.followUp.body,
          actor: view.verdict.record.actor, channel: view.verdict.record.channel },
      }] : [])]),
    }),
  });
}
