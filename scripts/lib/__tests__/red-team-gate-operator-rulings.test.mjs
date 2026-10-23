/**
 * @file red-team-gate-operator-rulings.test.mjs — the shared red-team reader honours a HUMAN OPERATOR's ruling on a
 *   confirmed break in any state (setting `redTeam.operatorRulings.anyState`, kill switch env), bound to head + result.
 *   Live shape: PR #5502 (head 617823342, #1 sent back at repair cap 11/10, #2/#3 owed as a card; operator "5502 approved").
 */
import { describe, expect, it } from 'vitest';
import { renderRedTeamComment } from '../../operations/review-extra-seats.mjs';
import { CONFIRMED_BREAKS_DEFAULTS, gateRoundGrants, liveResultGateState, operatorRulingsOnLiveResult, readRedTeamDisposition, redTeamGateMarker, resolveOperatorRulings, unknownOperatorOutcomes } from '../red-team-gate.mjs';
import { redTeamEnqueueHold } from '../drain-queue-safety.mjs';
import { buildRoundExtensionComment } from '../../conveyor/round-extension-mark.mjs';
import { buildVerdictCarriedMarker } from '../review-verdict-carried-marker.mjs';
import { planRedTeamStatusLabels, syncRedTeamStatusLabels } from '../red-team-status-labels.mjs';

const H = '61782334289124cd4fcb51d0bdadb6ef3c795e82';
const P = 5502;
const CARD = 'we:backlog/xvi6k7s-per-pr-delivery-postmortem-on-merge-incident-coroner-trigger.md@pr5502';
const bot = (body, created_at) => ({ user: { login: 'web-everything', type: 'Bot' }, created_at, body }); // the automation login the test env trusts
const human = (body, created_at) => ({ user: { login: 'chalbert', type: 'User' }, created_at, body });
const F = (line, impact) => ({ summary: `break at ${line}`, category: 'edge-case', impactIfUnfixed: impact, file: 'scripts/operations/coroner-pr-postmortem.mjs', line, confirmedByRecheck: true });
const result = bot(renderRedTeamComment({ pr: P, rev: H, provider: 'codex', model: 'gpt-6.1-sol', recheckStatus: 'ok', foldedVerdict: 'changes',
  findings: [F(159, 'broken'), F(127, 'degraded'), F(166, 'degraded')] }), '2026-10-21T17:07:55Z');
const rid = liveResultGateState([result], P, H).resultId;
const gate = (who, outcome, line, at, id = rid, head = H) => who(`${redTeamGateMarker(P, head, outcome, id)}\n**Red-team gate** (setting \`redTeam.confirmedBreaks\`) on head \`${head.slice(0, 12)}\`:\n${line}`, at);
const live = [result, gate(bot, 'sent-back', '- 1 confirmed break(s) sent back to the fixer (#1).', '2026-10-21T17:12:20Z')];
const cardLine = (ix) => `- ${ix.length} finding(s) carded by the operator to \`${CARD}\` (${ix.map((i) => `#${i}`).join(', ')}).`;
const disp = (comments, anyState = true, head = H) => readRedTeamDisposition({ comments, pr: P, head, setting: CONFIRMED_BREAKS_DEFAULTS, operatorRulings: { anyState } });
const sent = (d) => d.sendBack.map((f) => f.index);

describe('operator ruling in any state (shared reader)', () => {
  it('#5502 before: #1 is sent back and blocks', () => { expect(sent(disp(live))).toEqual([1]); });
  it('a human operator card record for this result releases #1', () => {
    const d = disp([...live, gate(human, 'operator-card', cardLine([1, 2, 3]), '2026-10-21T20:30:00Z')]);
    expect(d.sendBack).toEqual([]);
    expect(d.held).toEqual([]);
  });
  it('automation can never use the operator card line, under any outcome', () => {
    for (const outcome of ['operator-card', 'card-queued', 'sent-back']) {
      expect(sent(disp([...live, gate(bot, outcome, cardLine([1]), '2026-10-21T20:30:00Z')]))).toEqual([1]);
    }
    expect(sent(disp([...live, gate(human, 'card-queued', cardLine([1]), '2026-10-21T20:30:00Z')]))).toEqual([1]);
  });
  it('a record naming another result releases nothing; a new head re-evaluates', () => {
    expect(sent(disp([...live, gate(human, 'operator-card', cardLine([1]), '2026-10-21T20:30:00Z', '0123456789abcdef')]))).toEqual([1]);
    const N = 'a'.repeat(40);
    const next = bot(renderRedTeamComment({ pr: P, rev: N, provider: 'codex', model: 'm', recheckStatus: 'ok', foldedVerdict: 'changes', findings: [F(159, 'broken')] }), '2026-10-21T21:00:00Z');
    expect(sent(disp([...live, gate(human, 'operator-card', cardLine([1]), '2026-10-21T20:30:00Z'), next], true, N))).toEqual([1]);
  });
  it('an operator-block after the card re-holds', () => {
    const comments = [...live, gate(human, 'operator-card', cardLine([1]), '2026-10-21T20:30:00Z'),
      gate(human, 'operator-block', '- 1 confirmed break(s) sent back to the fixer (#1).', '2026-10-21T20:40:00Z')];
    expect(sent(disp(comments))).toEqual([1]);
  });
  it('kill switch off: never overrides a live send-back, still releases a break handed over at the cap', () => {
    const op = gate(human, 'operator-card', cardLine([1]), '2026-10-21T20:30:00Z');
    expect(sent(disp([...live, op], false))).toEqual([1]);
    const cap = gate(bot, 'round-cap', '- 1 confirmed break(s) NOT sent back: cap (#1).', '2026-10-21T18:00:00Z');
    expect(disp([...live, cap], false).held.map((f) => f.index)).toEqual([1]);
    expect(disp([...live, cap, op], false).held).toEqual([]);
  });
  it('operatorRulingsOnLiveResult: the operator actions and every carded break of the live result', () => {
    const gateCard = gate(bot, 'card-queued', '- 1 finding(s) filed as a follow-up card (#2) — landing job j.', '2026-10-21T17:12:23Z');
    const r = operatorRulingsOnLiveResult([...live, gateCard, gate(human, 'operator-card', cardLine([1]), '2026-10-21T20:30:00Z')], P, H);
    expect(r.resultId).toBe(rid);
    expect([...r.ruled]).toEqual([[1, ['card']]]);
    expect([...r.carded].sort()).toEqual([1, 2]);
  });
  it('the cascade: default on, settings file, env kill switch wins, invalid ignored', () => {
    expect(resolveOperatorRulings({}).value.anyState).toBe(true);
    expect(resolveOperatorRulings({ file: { redTeam: { operatorRulings: { anyState: false } } } }).value.anyState).toBe(false);
    expect(resolveOperatorRulings({ file: { redTeam: { operatorRulings: { anyState: true } } }, env: { WE_RED_TEAM_OPERATOR_RULINGS_ANY_STATE: '0' } }).value.anyState).toBe(false);
    expect(resolveOperatorRulings({ env: { WE_RED_TEAM_OPERATOR_RULINGS_ANY_STATE: 'banana' } }).value.anyState).toBe(true);
  });
});

describe('label writers never re-derive over an operator ruling they cannot read', () => {
  it('a trusted operator-* outcome this reader does not know skips the sync (no label write)', () => {
    const future = gate(human, 'operator-defer', '- 1 finding(s) left advisory (#1).', '2026-10-21T20:30:00Z');
    expect(unknownOperatorOutcomes([...live, future], P, H)).toEqual(['operator-defer']);
    expect(unknownOperatorOutcomes([...live, gate(human, 'operator-card', cardLine([1]), '2026-10-21T20:30:00Z')], P, H)).toEqual([]);
    const writes = [];
    const provider = { readPrState: () => ({ headRefOid: H, labels: [{ name: 'red-team:clear' }] }), readComments: () => [...live, future],
      ensureLabel: () => {}, setLabels: (...a) => writes.push(a) };
    const out = syncRedTeamStatusLabels({ repo: 'web-everything/web-everything', pr: P, head: H, env: {}, provider, standingRuling: null, savedResult: null });
    expect(out.skipped).toBe('unknown-operator-outcome');
    expect(writes).toEqual([]);
  });
});

/** Cap-only shared-reader subset: human card records, author/wrapper and head/result binding. */
describe('operator card release at the cap (shared reader)', () => {
  // Pin the original cap-only policy while the any-state suite above covers the new default.
  const env = { WE_RED_TEAM_OPERATOR_RULINGS_ANY_STATE: 'false' };
  const live = [result, gate(bot, 'round-cap', '- 1 confirmed break(s) NOT sent back: cap (#1).', '2026-10-21T17:12:20Z')];
  const disp = (comments, head = H) => readRedTeamDisposition({ comments, pr: P, head, setting: CONFIRMED_BREAKS_DEFAULTS, env });
  const held = (d) => [...d.held, ...d.sendBack].map((f) => f.index);
  const N = 'a'.repeat(40);
  const carried = bot([
    redTeamGateMarker(P, N, 'round-cap', rid),
    buildVerdictCarriedMarker({ fromSha: H, toSha: N, patchId: 'b'.repeat(40) }),
    'Review verdict carried across an identical contribution.',
    result.body.replace(H, N),
  ].join('\n'), '2026-10-21T21:00:00Z');
  it.each([
    ['accepts a trusted human operator-card after a trusted cap', { login: 'chalbert', type: 'User' }, true],
    ['rejects an unregistered human operator-card after a trusted cap', { login: 'mallory', type: 'User' }, false],
    ['rejects a bot operator-card after a trusted cap', { login: 'web-everything', type: 'Bot' }, false],
  ])('%s across reader, queue and labels', (_, user, releases) => {
    const card = gate(human, 'operator-card', cardLine([1]), '2026-10-21T20:30:00Z');
    const comments = [...live, { ...card, user }];
    expect(held(disp(comments))).toEqual(releases ? [] : [1]);
    const hold = redTeamEnqueueHold({ comments, pr: P, head: H, env });
    if (releases) expect(hold).toBeNull();
    else expect(hold).not.toBeNull();
    expect(planRedTeamStatusLabels({ comments, pr: P, head: H, labels: ['red-team:blocked'], env }))
      .toEqual(releases ? { add: 'red-team:clear', remove: ['red-team:blocked'] } : { add: null, remove: [] });
  });
  it('keeps an identical re-posted result held when the operator card predates it', () => {
    const card = gate(human, 'operator-card', cardLine([1]), '2026-10-21T20:30:00Z');
    const comments = [...live, card];
    expect(held(disp(comments))).toEqual([]);
    const repost = { ...result, created_at: '2026-10-21T21:00:00Z' };
    expect(liveResultGateState([repost], P, H).resultId).toBe(rid);
    // A marker-only new cap must not mask a stale release by overwriting its action with `held`.
    comments.push(repost, gate(bot, 'round-cap', '', '2026-10-21T21:10:00Z'));
    expect(liveResultGateState(comments, P, H).resultId).toBe(rid);
    expect(held(disp(comments))).toEqual([1]);
    expect(redTeamEnqueueHold({ comments, pr: P, head: H, env })).not.toBeNull();
    expect(planRedTeamStatusLabels({ comments, pr: P, head: H, labels: ['red-team:blocked'], env }))
      .toEqual({ add: null, remove: [] });
    comments.push(gate(human, 'operator-card', cardLine([1]), '2026-10-21T21:30:00Z'));
    expect(held(disp(comments))).toEqual([]);
  });
  it.each(['missing', 'sent-back', 'wrong result', 'wrong head', 'untrusted', 'later'])('rejects an operator card with a %s round-cap handover across reader, queue and labels', (variant) => {
    const cap = gate(bot, 'round-cap', '', '2026-10-21T17:12:20Z');
    const before = {
      missing: [],
      'sent-back': [gate(bot, 'sent-back', '- 1 confirmed break(s) sent back to the fixer (#1).', '2026-10-21T17:12:20Z')],
      'wrong result': [gate(bot, 'round-cap', '', cap.created_at, '0123456789abcdef')],
      'wrong head': [gate(bot, 'round-cap', '', cap.created_at, rid, N)],
      untrusted: [{ ...cap, user: { login: 'mallory', type: 'User' } }],
      later: [],
    }[variant];
    const comments = [result, ...before, gate(human, 'operator-card', cardLine([1]), '2026-10-21T20:30:00Z'),
      ...(variant === 'later' ? [cap] : [])];
    const d = disp(comments);
    expect(held(d)).toEqual([1]);
    expect(redTeamEnqueueHold({ comments, pr: P, head: H, env })).not.toBeNull();
    expect(planRedTeamStatusLabels({ comments, pr: P, head: H, labels: ['red-team:blocked'], env }))
      .toEqual({ add: null, remove: [] });
  });
  it('does not treat a held action in an operator record as a round-cap handover', () => {
    const d = disp([result, gate(human, 'operator-card', '- 1 confirmed break(s) NOT sent back: cap (#1).\n' + cardLine([1]), '2026-10-21T20:30:00Z')]);
    expect(held(d)).toEqual([1]);
  });
  it.each(['human', 'standing ruling'])('rejects cards after pending or consumed %s grants, including stale cap posts', (kind) => {
    const repo = 'o/r';
    const standingRuling = kind === 'standing ruling' ? { ok: true, id: `${repo}#6000`, author: 'chalbert', by: 1,
      maxPerPr: 3, repos: [repo], cardOnlyHeads: { [H]: true }, uneditedComments: ['IC_auto'] } : null;
    const at = '2026-10-21T18:00:00Z';
    const grant = { id: 'IC_auto', author: { login: standingRuling ? 'web-everything[bot]' : 'chalbert', type: standingRuling ? 'Bot' : 'User' },
      createdAt: at, body: buildRoundExtensionComment({ repo, pr: P, by: 1, actor: 'chalbert', channel: 'chat', reason: 'one more round', at,
        ...(standingRuling ? { standingRuling: standingRuling.id, head: H, episode: `${repo}#${P}@${H}:review:12/12` } : {}) }) };
    const ids = gateRoundGrants([grant], P, repo, standingRuling).map(g => g.id);
    expect(ids).toHaveLength(1);
    const cap = bot(redTeamGateMarker(P, H, 'round-cap', rid, []), '2026-10-21T17:12:20Z');
    const sent = bot(`${redTeamGateMarker(P, H, 'sent-back', rid, ids)}\n- 1 confirmed break(s) sent back to the fixer (#1).`, at);
    const card = gate(human, 'operator-card', cardLine([1]), '2026-10-21T20:30:00Z');
    for (const prefix of [[result, cap, grant], [result, grant, cap], [result, cap, grant, sent], [result, grant, sent, cap]]) {
      const comments = [...prefix, card];
      const context = { comments, pr: P, head: H, repo, standingRuling, env };
      expect(held(readRedTeamDisposition(context))).toEqual([1]);
      expect(redTeamEnqueueHold(context)).not.toBeNull();
      expect(planRedTeamStatusLabels({ ...context, labels: ['red-team:blocked'] })).toEqual({ add: null, remove: [] });
    }
  });
  it('does not let a later grant retroactively invalidate a valid operator card', () => {
    const repo = 'o/r';
    const at = '2026-10-21T21:00:00Z';
    const grant = human(buildRoundExtensionComment({ repo, pr: P, by: 1, actor: 'chalbert', channel: 'chat', reason: 'another round', at }), at);
    const comments = [...live, gate(human, 'operator-card', cardLine([1]), '2026-10-21T20:30:00Z'), grant];
    expect(held(readRedTeamDisposition({ comments, repo, pr: P, head: H, setting: CONFIRMED_BREAKS_DEFAULTS, env }))).toEqual([]);
  });
  it('keeps fixer-owned breaks sent back without any gate record', () => {
    const d = disp([result]);
    expect(d.sendBack.map((f) => f.index)).toEqual([1]);
    expect(d.held).toEqual([]);
  });
  it('a human operator card record for this result releases #1', () => {
    const d = disp([...live, gate(human, 'operator-card', cardLine([1, 2, 3]), '2026-10-21T20:30:00Z')]);
    expect(d.sendBack).toEqual([]);
    expect(d.held).toEqual([]);
  });
  it('a human operator card record without a result id leaves #1 held', () => {
    const d = disp([...live, gate(human, 'operator-card', cardLine([1]), '2026-10-21T20:30:00Z', null)]);
    expect(d.sendBack).toEqual([]);
    expect(d.held.map(f => f.index)).toEqual([1]);
  });
  it.each([
    ['no result id', null],
    ['the older result id', rid],
  ])('an operator card record with %s posted after a newer same-head result leaves it held', (_, id) => {
    const next = bot(renderRedTeamComment({ pr: P, rev: H, provider: 'codex', model: 'm', recheckStatus: 'ok', foldedVerdict: 'changes',
      findings: [F(160, 'broken')] }), '2026-10-21T21:00:00Z');
    const nextId = liveResultGateState([next], P, H).resultId;
    expect(nextId).not.toBe(rid);
    const comments = [...live, next,
      gate(bot, 'round-cap', '- 1 confirmed break(s) NOT sent back: cap (#1).', '2026-10-21T21:10:00Z', nextId),
      gate(human, 'operator-card', cardLine([1]), '2026-10-21T21:30:00Z', id)];
    const d = disp(comments);
    expect(d.sendBack).toEqual([]);
    expect(d.held.map(f => f.index)).toEqual([1]);
    comments.push(gate(human, 'operator-card', cardLine([1]), '2026-10-21T21:40:00Z', nextId));
    expect(held(disp(comments))).toEqual([]);
  });
  it('does not inherit an operator card release through a verdict carry without cited-line proof', () => {
    const comments = [...live, gate(human, 'operator-card', cardLine([1]), '2026-10-21T20:30:00Z'), carried];
    const d = disp(comments, N);
    expect(d.result.rev).toBe(N);
    expect(liveResultGateState(comments, P, N).resultId).toBe(rid);
    expect(d.sendBack).toEqual([]);
    expect(d.held.map(f => f.index)).toEqual([1]);
    expect(planRedTeamStatusLabels({ comments, pr: P, head: N, labels: ['red-team:blocked'], env }))
      .toEqual({ add: null, remove: [] });
  });
  it('releases a carried result when the operator card record names that exact head and result', () => {
    const comments = [...live, carried];
    expect(held(disp(comments, N))).toEqual([1]);
    comments.push(gate(human, 'operator-card', cardLine([1]), '2026-10-21T21:30:00Z', rid, N));
    const d = disp(comments, N);
    expect(d.sendBack).toEqual([]);
    expect(d.held).toEqual([]);
    expect(planRedTeamStatusLabels({ comments, pr: P, head: N, labels: ['red-team:blocked'], env }))
      .toEqual({ add: 'red-team:clear', remove: ['red-team:blocked'] });
  });
  it('automation can never use the operator card line, under any outcome', () => {
    for (const outcome of ['operator-card', 'card-queued', 'sent-back']) {
      expect(held(disp([...live, gate(bot, outcome, cardLine([1]), '2026-10-21T20:30:00Z')]))).toEqual([1]);
    }
    expect(held(disp([...live, gate(human, 'card-queued', cardLine([1]), '2026-10-21T20:30:00Z')]))).toEqual([1]);
  });
  it('a record naming another result releases nothing; a new head re-evaluates', () => {
    expect(held(disp([...live, gate(human, 'operator-card', cardLine([1]), '2026-10-21T20:30:00Z', '0123456789abcdef')]))).toEqual([1]);
    const N = 'a'.repeat(40);
    const next = bot(renderRedTeamComment({ pr: P, rev: N, provider: 'codex', model: 'm', recheckStatus: 'ok', foldedVerdict: 'changes', findings: [F(159, 'broken')] }), '2026-10-21T21:00:00Z');
    expect(held(disp([...live, gate(human, 'operator-card', cardLine([1]), '2026-10-21T20:30:00Z'), next], N))).toEqual([1]);
  });
});
