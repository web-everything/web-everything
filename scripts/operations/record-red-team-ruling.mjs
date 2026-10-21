/**
 * @file scripts/operations/record-red-team-ruling.mjs
 * @description THE `record-red-team-ruling` DECLARATION — the sanctioned way for the OPERATOR to rule on a post-accept
 *   red-team break the gate parked at the review round cap (`outcome=round-cap`).
 *
 * WHY. At the round cap the red-team gate does not send a confirmed break back; it records `round-cap` and the PR is
 * the operator's. Before this operation the operator had two moves: block (`review-set-label --to=changes`) or not-real
 * (`--to=clear-human`, which approves the WHOLE PR). "Card it" (file a follow-up, let the PR land) had no writer, because
 * the gate files cards only for findings its config sorts as `card`. Live: PR #5530 (head d3bee7370) and #5485.
 *
 *   | step    | kind      | does                                                                              |
 *   |---------|-----------|-----------------------------------------------------------------------------------|
 *   | `read`  | `compute` | the PR's live head, labels, complete comment thread and the `redTeam.confirmedBreaks` setting |
 *   | `plan`  | `compute` | THE VERDICT: which held breaks are selected, and exactly what would be written     |
 *   | `write` | `effect`  | the ruling's writes, then a read-back proving the gate no longer holds the breaks  |
 *
 * RULINGS (`--ruling`):
 *   - `card`     queue ONE follow-up card through the shared detached landing job (the gate's own card seam), then post
 *                the gate's own `card-queued` record for that head and result (its per-finding line is what releases
 *                the hold), then a durable comment quoting the operator's reason;
 *   - `block`    send the PR back to the fixer through `review-set-label.mjs --to=changes` (the body lists the breaks
 *                and the operator's reason);
 *   - `not-real` record that the operator judged the break not real: a gate record that leaves it advisory, plus the
 *                reason comment. It does NOT clear `review:human` and approves nothing.
 *
 * WHAT IT REFUSES (every refusal is a thrown error naming why; nothing is posted):
 *   - an actor that is not a registered operator login, a blank `--reason`, a blank or multi-line `--channel`;
 *   - a PR with no red-team result on the LIVE head, or whose result was not parked at the round cap by a trusted
 *     gate record (`round-cap`), or that is already under `review:changes` (the fixer owns it);
 *   - a `--break` that names nothing, is ambiguous, is not CONFIRMED, or is not still held (already carded, ruled, or
 *     cleared by the operator's `clear-human`). A card is never filed twice for one break.
 * `--preview` plans and prints without writing. The sink re-checks the head and the held set right before it writes.
 *
 * PURE. The reader and the sinks live in `./record-red-team-ruling-io.mjs`.
 */
import { op } from './registry.mjs';
import { compute, effect as effectStep } from './step-kinds.mjs';
import { OPERATOR_LOGINS } from '../lib/marker-authorship.mjs';
import { GATE_OUTCOMES, liveResultGateState, readRedTeamDisposition } from '../lib/red-team-gate.mjs';
import { sanitizeCardField } from '../lib/review-loop-policy.mjs';
import { buildRedTeamCardInput, buildSendBackBody } from './red-team-gate-apply.mjs';

export const RECORD_RED_TEAM_RULING_OP = 'record-red-team-ruling';
export const RED_TEAM_RULINGS = Object.freeze(['card', 'block', 'not-real']);
export const RED_TEAM_RULING_CARD_EFFECT = 'github.red-team-ruling-card';
export const RED_TEAM_RULING_BLOCK_EFFECT = 'github.red-team-ruling-block';
export const RED_TEAM_RULING_NOT_REAL_EFFECT = 'github.red-team-ruling-not-real';
/** The gate-record outcome for an operator's `not-real` ruling (the per-finding line, not the outcome, releases the hold). */
export const OPERATOR_NOT_REAL_OUTCOME = 'operator-not-real';

const labelNames = (labels) => (Array.isArray(labels) ? labels : []).map((l) => (typeof l === 'string' ? l : l?.name));
const where = (f) => `${f.file ?? '(no file cited)'}${f.line ? `:${f.line}` : ''}`;

/** Pick the selected held breaks from `--break`: `1`, `#1,#3`, `<file>:<line>` or `<file>`. PURE; throws. */
export function selectBreaks(held, spec) {
  const sel = String(spec ?? '').trim();
  const list = (xs) => xs.map((f) => `  #${f.index} ${where(f)} — ${f.summary}`).join('\n');
  if (!sel) throw new Error('--break is required: a break number (#1), a comma list (#1,#2), <file>:<line> or <file>');
  if (/^#?\d+(\s*,\s*#?\d+)*$/.test(sel)) {
    return [...new Set(sel.split(',').map((s) => Number(s.trim().replace(/^#/, ''))))].map((n) => {
      const hit = held.find((f) => f.index === n);
      if (!hit) throw new Error(`--break=#${n} is not a break held for the operator on the live head. Held:\n${list(held)}`);
      return hit;
    });
  }
  const loc = /^(.+):(\d+)$/.exec(sel);
  const hits = held.filter((f) => (loc ? f.file === loc[1] && f.line === Number(loc[2]) : f.file === sel));
  if (hits.length === 1) return hits;
  if (hits.length > 1) throw new Error(`--break=${sel} is ambiguous:\n${list(hits)}\nPick by number.`);
  throw new Error(`--break=${sel} matches no break held for the operator on the live head. Held:\n${list(held)}`);
}

/** The reason comment: the operator's words, quoted, with no way to forge a marker. PURE. */
export function buildRuleReasonComment({ head, ruling, actor, channel, at, reason, findings, cardNote = '' }) {
  const quote = String(reason).replace(/<!--/g, '&lt;!--').replace(/-->/g, '--&gt;').replace(/\r\n/g, '\n')
    .split('\n').map((l) => `> ${l}`).join('\n');
  return [
    `**Operator ruling on the post-accept red team: ${ruling}** (head \`${String(head).slice(0, 12)}\`)`,
    '',
    `Ruled by \`${sanitizeCardField(actor, 80)}\` via ${sanitizeCardField(channel, 120)} at ${at}, on the break(s) the gate parked at the round cap:`,
    ...findings.map((f) => `- #${f.index} \`${sanitizeCardField(where(f), 200)}\` — ${sanitizeCardField(f.summary, 300)}`),
    ...(cardNote ? ['', cardNote] : []),
    '',
    "The operator's reason, verbatim:",
    quote,
  ].join('\n');
}

/** THE VERDICT. Validate, select, and describe the writes. PURE. */
export function planRedTeamRuling(read, input) {
  const { pr, ruling, actor, channel, reason } = input;
  if (!RED_TEAM_RULINGS.includes(ruling)) throw new Error(`--ruling must be one of ${RED_TEAM_RULINGS.join('|')}`);
  if (!OPERATOR_LOGINS.includes(String(actor ?? '').toLowerCase())) {
    throw new Error(`--actor must be a registered operator login (${OPERATOR_LOGINS.join(', ')}); this ruling is the operator's`);
  }
  if (!String(reason ?? '').trim()) throw new Error("--reason is required: the operator's words, verbatim");
  if (!String(channel ?? '').trim() || /[\r\n]/.test(channel)) throw new Error('--channel is required and must be one line');
  const head = String(read.head ?? '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error('the PR head could not be read; nothing to rule on');
  const state = liveResultGateState(read.comments, pr, head);
  if (!state.result) throw new Error(`no red-team result on the live head ${head.slice(0, 9)} — nothing to rule on`);
  if (!state.outcomes.has(GATE_OUTCOMES.ROUND_CAP)) {
    throw new Error(`the red-team result on head ${head.slice(0, 9)} was not parked at the round cap (no trusted \`round-cap\` gate record decides it); `
      + 'a break that is not at the cap belongs to the gate or the fixer');
  }
  if (labelNames(read.labels).includes('review:changes')) {
    throw new Error('the PR is under review:changes: the fixer owns the breaks, so there is nothing for the operator to rule on');
  }
  const disposition = readRedTeamDisposition({ comments: read.comments, pr, head, setting: read.setting });
  const held = disposition.held;
  if (!held.length) throw new Error('no red-team break is held for the operator on the live head (already carded, ruled or cleared)');
  const selected = selectBreaks(held, input.break);
  const unconfirmed = selected.filter((f) => !f.confirmed);
  if (unconfirmed.length) throw new Error(`break(s) ${unconfirmed.map((f) => `#${f.index}`).join(', ')} were not confirmed by the re-check; only a confirmed break can be ruled on`);
  const base = { repo: input.repo, pr: Number(pr), head, ruling, actor: String(actor).toLowerCase(), channel: String(channel).trim(),
    reason: String(reason), at: read.now, resultId: state.resultId, findings: selected, setting: read.setting,
    indices: selected.map((f) => f.index) };
  if (ruling === 'card') {
    const cardInput = buildRedTeamCardInput({ repo: input.repo, pr, head, findings: selected });
    cardInput.digest += `\n\nOperator ruling (${base.actor} via ${base.channel}): carded at the round cap. Reason: ${sanitizeCardField(reason, 600)}`;
    return { ...base, effect: RED_TEAM_RULING_CARD_EFFECT, cardInput };
  }
  if (ruling === 'block') {
    const body = `${buildSendBackBody({ pr, head, findings: selected })}\n\nOperator ruling: block (${base.actor} via ${base.channel}). Reason: ${sanitizeCardField(reason, 600)}`;
    return { ...base, effect: RED_TEAM_RULING_BLOCK_EFFECT, sendBackBody: body };
  }
  return { ...base, effect: RED_TEAM_RULING_NOT_REAL_EFFECT };
}

export function recordRedTeamRulingOperation({ readRulingContext } = {}) {
  if (typeof readRulingContext !== 'function') {
    throw new TypeError('record-red-team-ruling: needs a `readRulingContext({repo, pr})` reader — the real binding is '
      + '`we:scripts/operations/record-red-team-ruling-io.mjs`.');
  }
  return op(RECORD_RED_TEAM_RULING_OP, {
    input: {
      pr: 'number',
      repo: 'string',
      break: 'string',
      ruling: { type: 'string', enum: [...RED_TEAM_RULINGS] },
      actor: 'string',
      channel: 'string',
      reason: 'string',
      preview: { type: 'boolean', required: false, default: false },
    },
    verdictFrom: 'plan',
    read: compute({
      reads: ['input.repo', 'input.pr'],
      fn: (view) => readRulingContext({ repo: view.input.repo, pr: view.input.pr }),
    }),
    plan: compute({
      reads: ['input.repo', 'input.pr', 'input.break', 'input.ruling', 'input.actor', 'input.channel', 'input.reason', 'findings.read'],
      fn: (view) => planRedTeamRuling(view.findings.read, view.input),
    }),
    write: effectStep({
      reads: ['verdict', 'input.preview'],
      // NOT idempotent: a repeat would queue a second card. The sink re-reads the thread and refuses when the breaks
      // are no longer held, so a replay after a crash cannot double-file.
      effects: (view) => (view.input.preview ? [] : [{
        type: view.verdict.effect, idempotent: false,
        payload: {
          repo: view.verdict.repo, pr: view.verdict.pr, head: view.verdict.head, ruling: view.verdict.ruling,
          actor: view.verdict.actor, channel: view.verdict.channel, reason: view.verdict.reason, at: view.verdict.at,
          resultId: view.verdict.resultId, findings: view.verdict.findings, indices: view.verdict.indices,
          setting: view.verdict.setting, cardInput: view.verdict.cardInput, sendBackBody: view.verdict.sendBackBody,
        },
      }]),
    }),
  });
}
