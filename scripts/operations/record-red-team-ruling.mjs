/**
 * @file scripts/operations/record-red-team-ruling.mjs
 * @description Operator card ruling for a confirmed live-head break parked at the round cap.
 * Requires a trusted round-cap record, an optional existing readable --card, a human operator poster,
 * and the operator's --reason and --channel. review:changes may coexist with the cap record.
 * The ruling binds to the head and result. Preview plans without writing; the sink rechecks
 * before writing and proves release by reading back the human-authored record.
 * Without --card, queues one follow-up through the detached landing job with retry-safe claims.
 * Reader and sink: ./record-red-team-ruling-io.mjs. Other ruling kinds come later.
 */
import { createHash } from 'node:crypto';
import { buildRedTeamCardInput } from './red-team-gate-apply.mjs';
import { op } from './registry.mjs';
import { compute, effect as effectStep } from './step-kinds.mjs';
import { OPERATOR_LOGINS } from '../lib/marker-authorship.mjs';
import { assertHumanOperator, isHumanOperatorComment, operatorBoundComments } from '../lib/operator-identity.mjs';
import { GATE_OUTCOMES, liveResultGateState, readRedTeamDisposition, redTeamGateMarker } from '../lib/red-team-gate.mjs';
import { sanitizeCardField } from '../lib/review-loop-policy.mjs';

export const RECORD_RED_TEAM_RULING_OP = 'record-red-team-ruling';
export const RED_TEAM_RULINGS = Object.freeze(['card']);
export const RED_TEAM_RULING_CARD_EFFECT = 'github.red-team-ruling-card';
export const OPERATOR_CARD_OUTCOME = 'operator-card';

/** The bare intent marker written BEFORE the card job is spawned: it has no action line, so the break stays held. */
export const CARD_PENDING_OUTCOME = 'card-pending';

/** The stable key one card ruling spawns under: same PR, head, result and breaks always map to the same job. PURE. */
export function cardJobKey({ repo, pr, head, resultId, indices }) {
  return createHash('sha256').update(JSON.stringify(['v1', repo, Number(pr), head, resultId, [...indices].sort((a, b) => a - b)])).digest('hex').slice(0, 12);
}

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
  // Escape HTML text rather than matching comment delimiters, including alternate and partial forms.
  // Normalize every line boundary before quoting, including JS multiline-regex boundaries and control separators.
  const quote = String(reason).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .split(/\r\n|[\n\r\u000b\u000c\u001c-\u001e\u0085\u2028\u2029]/u).map((l) => `> ${l}`).join('\n');
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

/** Shared cap-only eligibility rule for planning and the sink's pre-write check. PURE. */
export function rulableBreaks({ comments, repo, pr, head, setting, standingRuling = null }) {
  const state = liveResultGateState(comments, pr, head, repo, standingRuling);
  if (!state.result) throw new Error(`no red-team result on the live head ${head.slice(0, 9)} — nothing to rule on`);
  if (!state.outcomes.has(GATE_OUTCOMES.ROUND_CAP)) {
    throw new Error(`the red-team result on head ${head.slice(0, 9)} was not parked at the round cap (no trusted \`round-cap\` gate record decides it)`);
  }
  // A grant unseen by the cap record returns the decision to automation. The reader
  // still reports held until that decision is recorded, so held alone is not enough.
  if (state.reopened) {
    throw new Error('a pending round extension reopened the red-team gate; let the gate consume the grant before ruling on a break');
  }
  const held = readRedTeamDisposition({ comments, repo, pr, head, setting, standingRuling }).held;
  if (!held.length) throw new Error('no red-team break is held for the operator on the live head (already carded, ruled or cleared)');
  return { state, rulable: held, noun: 'held for the operator' };
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

/** A trusted intent for this exact job, including one started under another host's state root. PURE. */
export function hasPendingCardIntent(comments, { pr, head, resultId, jobKey }) {
  const marker = redTeamGateMarker(pr, head, CARD_PENDING_OUTCOME, resultId);
  return (Array.isArray(comments) ? comments : []).some((c) => {
    const body = String(c?.body ?? '').trimStart();
    return body.startsWith(marker) && isHumanOperatorComment(c)
      && /Operator card ruling pending \(job ([0-9a-f]{12}), break\(s\) (#\d+(?:, #\d+)*)\)/.exec(body)?.[1] === jobKey;
  });
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
  if ((String(input.card ?? '').trim() || read.card) && !read.card?.readable) {
    throw new Error(`--card ${read.card?.requested ?? input.card} does not resolve to a readable backlog card (${read.card?.reason ?? 'unresolved'})`);
  }
  // Bind to who actually posts: the authenticated gh identity must be a human operator and equal --actor.
  assertHumanOperator(read.identity, actor);
  const head = String(read.head ?? '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error('the PR head could not be read; nothing to rule on');
  const comments = operatorBoundComments(read.comments);
  const { state, rulable, noun } = rulableBreaks({ comments, repo: input.repo, pr, head, setting: read.setting, standingRuling: read.standingRuling });
  const selected = selectBreaks(rulable, input.break, noun);
  const unconfirmed = selected.filter((f) => !f.confirmed);
  if (unconfirmed.length) throw new Error(`break(s) ${unconfirmed.map((f) => `#${f.index}`).join(', ')} were not confirmed by the re-check; only a confirmed break can be ruled on`);
  const base = { repo: input.repo, pr: Number(pr), head, ruling, actor: String(actor).toLowerCase(), channel: String(channel).trim(),
    reason: String(reason), at: read.now, resultId: state.resultId, findings: selected, setting: read.setting,
    indices: selected.map((f) => f.index) };
  if (read.card) {
    return { ...base, effect: RED_TEAM_RULING_CARD_EFFECT, cardRef: read.card.ref };
  }
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
      preview: { type: 'boolean', required: false, default: false },
    },
    verdictFrom: 'plan',
    read: compute({
      reads: ['input.repo', 'input.pr', 'input.card'],
      fn: (view) => readRulingContext({ repo: view.input.repo, pr: view.input.pr, card: view.input.card }),
    }),
    plan: compute({
      reads: ['input.repo', 'input.pr', 'input.break', 'input.ruling', 'input.actor', 'input.channel', 'input.reason', 'input.card', 'findings.read'],
      fn: (view) => planRedTeamRuling(view.findings.read, view.input),
    }),
    write: effectStep({
      reads: ['verdict', 'input.preview'],
      // The sink re-reads the thread and refuses when the selected breaks are no longer held.
      effects: (view) => (view.input.preview ? [] : [{
        type: view.verdict.effect, idempotent: false,
        payload: {
          repo: view.verdict.repo, pr: view.verdict.pr, head: view.verdict.head, ruling: view.verdict.ruling,
          actor: view.verdict.actor, channel: view.verdict.channel, reason: view.verdict.reason, at: view.verdict.at,
          resultId: view.verdict.resultId, findings: view.verdict.findings, indices: view.verdict.indices,
          setting: view.verdict.setting, cardRef: view.verdict.cardRef,
          cardInput: view.verdict.cardInput, jobKey: view.verdict.jobKey, session: view.verdict.session,
        },
      }]),
    }),
  });
}
