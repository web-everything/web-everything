/**
 * @file red-team-gate-operator-rulings.test.mjs — the shared red-team reader honours a HUMAN OPERATOR's ruling on a
 *   confirmed break in any state (setting `redTeam.operatorRulings.anyState`, kill switch env), bound to head + result.
 *   Live shape: PR #5502 (head 617823342, #1 sent back at repair cap 11/10, #2/#3 owed as a card; operator "5502 approved").
 */
import { describe, expect, it } from 'vitest';
import { renderRedTeamComment } from '../../operations/review-extra-seats.mjs';
import { CONFIRMED_BREAKS_DEFAULTS, liveResultGateState, operatorRulingsOnLiveResult, readRedTeamDisposition,
  redTeamGateMarker, resolveOperatorRulings, unknownOperatorOutcomes } from '../red-team-gate.mjs';
import { syncRedTeamStatusLabels } from '../red-team-status-labels.mjs';

const H = '61782334289124cd4fcb51d0bdadb6ef3c795e82';
const P = 5502;
const CARD = 'we:backlog/xvi6k7s-per-pr-delivery-postmortem-on-merge-incident-coroner-trigger.md@pr5502';
const bot = (body, created_at) => ({ user: { login: 'web-everything', type: 'Bot' }, created_at, body }); // the automation login the test env trusts
const human = (body, created_at) => ({ user: { login: 'chalbert', type: 'User' }, created_at, body });
const F = (line, impact) => ({ summary: `break at ${line}`, category: 'edge-case', impactIfUnfixed: impact, file: 'scripts/operations/coroner-pr-postmortem.mjs', line, confirmedByRecheck: true });
const result = bot(renderRedTeamComment({ pr: P, rev: H, provider: 'codex', model: 'gpt-6.1-sol', recheckStatus: 'ok', foldedVerdict: 'changes',
  findings: [F(159, 'broken'), F(127, 'degraded'), F(166, 'degraded')] }), '2026-10-21T17:07:55Z');
const rid = liveResultGateState([result], P, H).resultId;
const gate = (who, outcome, line, at, id = rid) => who(`${redTeamGateMarker(P, H, outcome, id)}\n**Red-team gate** (setting \`redTeam.confirmedBreaks\`) on head \`${H.slice(0, 12)}\`:\n${line}`, at);
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
