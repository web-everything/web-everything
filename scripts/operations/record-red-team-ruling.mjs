/**
 * @file scripts/operations/record-red-team-ruling.mjs
 * @description THE `record-red-team-ruling` DECLARATION — the sanctioned way for the OPERATOR to rule on a confirmed
 *   post-accept red-team break on the live head: parked at the review round cap (`outcome=round-cap`), sent back, or
 *   carded (setting `redTeam.operatorRulings.anyState`, default on; off restores the round-cap-only rule).
 *   Live: PR #5502 (head 617823342, sent back at repair cap 11/10: the old cap-only rule refused the operator's
 *   "5502 approved"), and #5758 (a carded break could not be operator-sent-back).
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
 *   - `card --card=<we:backlog ref>`  cite an EXISTING readable card (resolved as for referral rulings): one
 *                `operator-card` gate record (`carded by the operator to <ref>`), no new filing, plus the reason;
 *   - `card`     (no --card) queue ONE follow-up card through the shared detached landing job (the gate's own card seam), then post
 *                the gate's own `card-queued` record for that head and result (its per-finding line is what releases
 *                the hold), then a durable comment quoting the operator's reason;
 *   - `block`    an `operator-block` gate record (its send-back line re-holds the break), then, unless the PR is
 *                already under `review:changes`, the send-back through `review-set-label.mjs --to=changes`;
 *   - `not-real --cause=<false-finding cause>`  a gate record that leaves the break advisory, plus the reason
 *                comment. It does NOT clear `review:human` and approves nothing.
 *
 * WHAT IT REFUSES (every refusal is a thrown error naming why; nothing is posted):
 *   - an actor that is not a registered operator login, a blank `--reason`, a blank or multi-line `--channel`;
 *   - a posting identity (`gh api user` under the operator channel) that is not a HUMAN operator login equal to `--actor`
 *     (an App or bot, another login, or an unreadable identity), so the ruling is bound to who really posts it;
 *   - a PR with no red-team result on the LIVE head (a new head always re-evaluates: rulings bind to head + result);
 *   - a `--break` that names nothing, is ambiguous, is not CONFIRMED, or whose latest operator ruling on this result
 *     is already the same ruling. A card is never filed twice for one break.
 *   - kill switch off: also a result not parked at the cap, a PR under `review:changes`, or a break not still held.
 * `--preview` plans and prints without writing. The sink re-checks the head and the held set right before it writes.
 *
 * PURE. The reader and the sinks live in `./record-red-team-ruling-io.mjs`.
 */
import { op } from './registry.mjs';
import { compute, effect as effectStep } from './step-kinds.mjs';
import { createHash } from 'node:crypto';
import { OPERATOR_LOGINS } from '../lib/marker-authorship.mjs';
import { assertHumanOperator, isHumanOperatorComment, operatorBoundComments } from '../lib/operator-identity.mjs';
import { GATE_OUTCOMES, OPERATOR_RULINGS_DEFAULTS, liveResultGateState, operatorRulingsOnLiveResult, readRedTeamDisposition, redTeamGateMarker } from '../lib/red-team-gate.mjs';
import { FALSE_FINDING_CAUSES } from '../lib/false-finding-causes.mjs';
import { sanitizeCardField } from '../lib/review-loop-policy.mjs';
import { buildRedTeamCardInput, buildSendBackBody } from './red-team-gate-apply.mjs';

export const RECORD_RED_TEAM_RULING_OP = 'record-red-team-ruling';
export const RED_TEAM_RULINGS = Object.freeze(['card', 'block', 'not-real']);
export const RED_TEAM_RULING_CARD_EFFECT = 'github.red-team-ruling-card';
export const RED_TEAM_RULING_BLOCK_EFFECT = 'github.red-team-ruling-block';
export const RED_TEAM_RULING_NOT_REAL_EFFECT = 'github.red-team-ruling-not-real';
/** The gate-record outcomes for an operator's `not-real` / `card` ruling (the per-finding line releases the hold; the
 *  `operator-` outcome is what lets a reader accept the record only from a human operator account). */
export const OPERATOR_NOT_REAL_OUTCOME = 'operator-not-real';
export const OPERATOR_CARD_OUTCOME = 'operator-card';
/** An operator `block` ruling's gate record: its `send-back` line re-holds the break even if an earlier ruling released it. */
export const OPERATOR_BLOCK_OUTCOME = 'operator-block';
/** The bare intent marker written BEFORE the card job is spawned: it has no action line, so the break stays held. */
export const CARD_PENDING_OUTCOME = 'card-pending';

/** The stable key one card ruling spawns under: same PR, head, result and breaks always map to the same job. PURE. */
export function cardJobKey({ repo, pr, head, resultId, indices }) {
  return createHash('sha256').update(JSON.stringify(['v1', repo, Number(pr), head, resultId, [...indices].sort((a, b) => a - b)])).digest('hex').slice(0, 12);
}

const labelNames = (labels) => (Array.isArray(labels) ? labels : []).map((l) => (typeof l === 'string' ? l : l?.name));
const where = (f) => `${f.file ?? '(no file cited)'}${f.line ? `:${f.line}` : ''}`;

/** Pick the selected held breaks from `--break`: `1`, `#1,#3`, `<file>:<line>` or `<file>`. PURE; throws. */
export function selectBreaks(held, spec, noun = 'held for the operator') {
  const sel = String(spec ?? '').trim();
  const list = (xs) => xs.map((f) => `  #${f.index} ${where(f)} — ${f.summary}`).join('\n');
  if (!sel) throw new Error('--break is required: a break number (#1), a comma list (#1,#2), <file>:<line> or <file>');
  if (/^#?\d+(\s*,\s*#?\d+)*$/.test(sel)) {
    return [...new Set(sel.split(',').map((s) => Number(s.trim().replace(/^#/, ''))))].map((n) => {
      const hit = held.find((f) => f.index === n);
      if (!hit) throw new Error(`--break=#${n} is not a break ${noun}. Rulable:\n${list(held)}`);
      return hit;
    });
  }
  const loc = /^(.+):(\d+)$/.exec(sel);
  const hits = held.filter((f) => (loc ? f.file === loc[1] && f.line === Number(loc[2]) : f.file === sel));
  if (hits.length === 1) return hits;
  if (hits.length > 1) throw new Error(`--break=${sel} is ambiguous:\n${list(hits)}\nPick by number.`);
  throw new Error(`--break=${sel} matches no break ${noun}. Rulable:\n${list(held)}`);
}

/** The reason comment: the operator's words, quoted, with no way to forge a marker. PURE. */
export function buildRuleReasonComment({ head, ruling, actor, channel, at, reason, findings, cardNote = '', cause = null }) {
  const quote = String(reason).replace(/<!--/g, '&lt;!--').replace(/-->/g, '--&gt;').replace(/\r\n/g, '\n')
    .split('\n').map((l) => `> ${l}`).join('\n');
  return [
    `**Operator ruling on the post-accept red team: ${ruling}** (head \`${String(head).slice(0, 12)}\`)`,
    '',
    `Ruled by \`${sanitizeCardField(actor, 80)}\` via ${sanitizeCardField(channel, 120)} at ${at}, on the confirmed break(s):`,
    ...(cause ? [`False-finding cause: \`${sanitizeCardField(cause, 60)}\``] : []),
    ...findings.map((f) => `- #${f.index} \`${sanitizeCardField(where(f), 200)}\` — ${sanitizeCardField(f.summary, 300)}`),
    ...(cardNote ? ['', cardNote] : []),
    '',
    "The operator's reason, verbatim:",
    quote,
  ].join('\n');
}

/**
 * The breaks an operator may rule on right now, and why. PURE; throws naming the refusal. Shared by the plan and the
 * sink's pre-write re-check, so both apply the same rule.
 *   - `anyState` ON (the `redTeam.operatorRulings.anyState` setting, default): ANY confirmed break of the live head's
 *     latest result, whatever the gate did with it (parked at the cap, sent back, or carded), except one whose latest
 *     operator ruling on THIS result is already the same ruling (no second card, no duplicate record).
 *   - OFF (kill switch): today's restriction. Only a result parked at the round cap, never under `review:changes`,
 *     and only the breaks the gate still holds for the operator.
 */
export function rulableBreaks({ comments, labels, pr, head, setting, scope, ruling, citesCard = false }) {
  const anyState = scope?.anyState !== false;
  const state = liveResultGateState(comments, pr, head);
  if (!state.result) throw new Error(`no red-team result on the live head ${head.slice(0, 9)} — nothing to rule on`);
  const atCap = state.outcomes.has(GATE_OUTCOMES.ROUND_CAP);
  if (!anyState) {
    if (!atCap) {
      throw new Error(`the red-team result on head ${head.slice(0, 9)} was not parked at the round cap (no trusted \`round-cap\` gate record decides it); `
        + 'a break that is not at the cap belongs to the gate or the fixer (redTeam.operatorRulings.anyState is off)');
    }
    if (labelNames(labels).includes('review:changes')) {
      throw new Error('the PR is under review:changes: the fixer owns the breaks, so there is nothing for the operator to rule on (redTeam.operatorRulings.anyState is off)');
    }
    const { carded } = operatorRulingsOnLiveResult(comments, pr, head);
    // A NEW card filing is never made for a break already carded by anyone, in either mode.
    const held = readRedTeamDisposition({ comments, pr, head, setting, operatorRulings: scope }).held
      .filter((f) => !(ruling === 'card' && !citesCard && carded.has(f.index)));
    if (!held.length) throw new Error('no red-team break is held for the operator on the live head (already carded, ruled or cleared)');
    return { state, atCap, anyState, rulable: held, noun: 'held for the operator' };
  }
  const { ruled, carded } = operatorRulingsOnLiveResult(comments, pr, head);
  const action = RULING_ACTION[ruling];
  // A NEW card filing is never made for a break already carded by anyone (the gate or an operator); citing an
  // existing card (--card) files nothing, so it only has to differ from the latest operator ruling.
  const rulable = state.result.findings.filter((f) => f.confirmed && ruled.get(f.index)?.at(-1) !== action
    && !(ruling === 'card' && !citesCard && carded.has(f.index)));
  if (!rulable.length) throw new Error(`no confirmed red-team break on the live head is left to rule \`${ruling}\` (none confirmed, or each already ruled \`${ruling}\` by the operator on this result)`);
  return { state, atCap, anyState, rulable, noun: `confirmed and not already ruled \`${ruling}\` on the live head` };
}

/**
 * Card jobs another invocation already started for this result (the bare `card-pending` intent a human operator
 * posted before the spawn) whose break set overlaps `indices` under a DIFFERENT job key. A retry with an overlapping
 * but different selection would spawn a second filing for the same break, so it is refused; re-running the exact same
 * selection reconciles that job instead. PURE.
 */
export function conflictingPendingCardJobs(comments, { pr, head, resultId, jobKey, indices }) {
  const marker = redTeamGateMarker(pr, head, CARD_PENDING_OUTCOME, resultId);
  const out = [];
  for (const c of Array.isArray(comments) ? comments : []) {
    const body = String(c?.body ?? '').trimStart();
    if (!body.startsWith(marker) || !isHumanOperatorComment(c)) continue;
    const m = /Operator card ruling pending \(job ([0-9a-f]{12}), break\(s\) (#\d+(?:, #\d+)*)\)/.exec(body);
    if (!m || m[1] === jobKey) continue;
    const theirs = m[2].split(', ').map((x) => Number(x.slice(1)));
    const overlap = indices.filter((i) => theirs.includes(i));
    if (overlap.length) out.push({ jobKey: m[1], indices: theirs, overlap });
  }
  return out;
}

/** The gate action line each ruling records (`gateActionLines` in red-team-gate.mjs reads them back). */
const RULING_ACTION = Object.freeze({ card: 'card', 'not-real': 'advisory', block: 'send-back' });

/** THE VERDICT. Validate, select, and describe the writes. PURE. */
export function planRedTeamRuling(read, input) {
  const { pr, ruling, actor, channel, reason } = input;
  if (!RED_TEAM_RULINGS.includes(ruling)) throw new Error(`--ruling must be one of ${RED_TEAM_RULINGS.join('|')}`);
  if (!OPERATOR_LOGINS.includes(String(actor ?? '').toLowerCase())) {
    throw new Error(`--actor must be a registered operator login (${OPERATOR_LOGINS.join(', ')}); this ruling is the operator's`);
  }
  if (!String(reason ?? '').trim()) throw new Error("--reason is required: the operator's words, verbatim");
  if (!String(channel ?? '').trim() || /[\r\n]/.test(channel)) throw new Error('--channel is required and must be one line');
  if (ruling === 'not-real' && !FALSE_FINDING_CAUSES.includes(input.cause)) {
    throw new Error(`--ruling=not-real requires --cause=<${FALSE_FINDING_CAUSES.join('|')}> (as for referral rulings)`);
  }
  if (ruling !== 'not-real' && input.cause !== undefined) throw new Error('--cause applies only to --ruling=not-real');
  if (ruling !== 'card' && input.card !== undefined && input.card !== '') throw new Error('--card applies only to --ruling=card');
  if (ruling === 'card' && read.card && !read.card.readable) {
    throw new Error(`--card ${read.card.requested} does not resolve to a readable backlog card (${read.card.reason})`);
  }
  // Bind to who actually posts: the authenticated gh identity must be a human operator and equal --actor.
  assertHumanOperator(read.identity, actor);
  const head = String(read.head ?? '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error('the PR head could not be read; nothing to rule on');
  const comments = operatorBoundComments(read.comments);
  const scope = read.scope?.value ?? OPERATOR_RULINGS_DEFAULTS;
  const { state, atCap, rulable, noun } = rulableBreaks({ comments, labels: read.labels, pr, head, setting: read.setting, scope, ruling, citesCard: Boolean(read.card) });
  const selected = selectBreaks(rulable, input.break, noun);
  const unconfirmed = selected.filter((f) => !f.confirmed);
  if (unconfirmed.length) throw new Error(`break(s) ${unconfirmed.map((f) => `#${f.index}`).join(', ')} were not confirmed by the re-check; only a confirmed break can be ruled on`);
  const base = { repo: input.repo, pr: Number(pr), head, ruling, actor: String(actor).toLowerCase(), channel: String(channel).trim(),
    reason: String(reason), at: read.now, resultId: state.resultId, findings: selected, setting: read.setting,
    indices: selected.map((f) => f.index), scope, scopeSources: read.scope?.sources ?? {}, atCap,
    underChanges: labelNames(read.labels).includes('review:changes') };
  if (ruling === 'card' && read.card) {
    return { ...base, effect: RED_TEAM_RULING_CARD_EFFECT, cardRef: read.card.ref };
  }
  if (ruling === 'card') {
    const cardInput = buildRedTeamCardInput({ repo: input.repo, pr, head, findings: selected });
    cardInput.digest += `\n\nOperator ruling (${base.actor} via ${base.channel}): carded. Reason: ${sanitizeCardField(reason, 600)}`;
    const jobKey = cardJobKey(base);
    const pending = conflictingPendingCardJobs(comments, { pr, head, resultId: state.resultId, jobKey, indices: base.indices });
    if (pending.length) {
      throw new Error(`a card job is already pending for ${pending.map((j) => `break(s) ${j.indices.map((i) => `#${i}`).join(', ')} (job ${j.jobKey})`).join('; ')}; `
        + 're-run with exactly that --break selection to finish it (a different overlapping selection would file the same break twice)');
    }
    return { ...base, effect: RED_TEAM_RULING_CARD_EFFECT, cardInput, jobKey, session: `red-team-ruling-card-${jobKey}` };
  }
  if (ruling === 'block') {
    const body = `${buildSendBackBody({ pr, head, findings: selected })}\n\nOperator ruling: block (${base.actor} via ${base.channel}). Reason: ${sanitizeCardField(reason, 600)}`;
    return { ...base, effect: RED_TEAM_RULING_BLOCK_EFFECT, sendBackBody: body };
  }
  return { ...base, effect: RED_TEAM_RULING_NOT_REAL_EFFECT, cause: input.cause };
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
      card: { type: 'string', required: false },
      cause: { type: 'string', enum: [...FALSE_FINDING_CAUSES], required: false },
      preview: { type: 'boolean', required: false, default: false },
    },
    verdictFrom: 'plan',
    read: compute({
      reads: ['input.repo', 'input.pr', 'input.card'],
      fn: (view) => readRulingContext({ repo: view.input.repo, pr: view.input.pr, card: view.input.card }),
    }),
    plan: compute({
      reads: ['input.repo', 'input.pr', 'input.break', 'input.ruling', 'input.actor', 'input.channel', 'input.reason', 'input.card', 'input.cause', 'findings.read'],
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
          setting: view.verdict.setting, scope: view.verdict.scope, cardRef: view.verdict.cardRef, cause: view.verdict.cause, underChanges: view.verdict.underChanges, cardInput: view.verdict.cardInput, jobKey: view.verdict.jobKey, session: view.verdict.session, sendBackBody: view.verdict.sendBackBody,
        },
      }]),
    }),
  });
}
