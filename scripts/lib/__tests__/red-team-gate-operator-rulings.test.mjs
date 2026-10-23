/** Cap-only shared-reader subset: human card records, author/wrapper and head/result binding. */
import { describe, expect, it } from 'vitest';
import { renderRedTeamComment } from '../../operations/review-extra-seats.mjs';
import { CONFIRMED_BREAKS_DEFAULTS, operatorRulingsOnLiveResult, resolveOperatorRulings, readOperatorRulings, liveResultGateState, readRedTeamDisposition, redTeamGateMarker } from '../red-team-gate.mjs';
import { buildVerdictCarriedMarker } from '../review-verdict-carried-marker.mjs';
import { planRedTeamStatusLabels } from '../red-team-status-labels.mjs';

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
const live = [result, gate(bot, 'round-cap', '- 1 confirmed break(s) NOT sent back: cap (#1).', '2026-10-21T17:12:20Z')];
const cardLine = (ix) => `- ${ix.length} finding(s) carded by the operator to \`${CARD}\` (${ix.map((i) => `#${i}`).join(', ')}).`;
const disp = (comments, head = H) => readRedTeamDisposition({ comments, pr: P, head, setting: CONFIRMED_BREAKS_DEFAULTS });
const held = (d) => [...d.held, ...d.sendBack].map((f) => f.index);
const N = 'a'.repeat(40);
const carried = bot([
  redTeamGateMarker(P, N, 'round-cap', rid),
  buildVerdictCarriedMarker({ fromSha: H, toSha: N, patchId: 'b'.repeat(40) }),
  'Review verdict carried across an identical contribution.',
  result.body.replace(H, N),
].join('\n'), '2026-10-21T21:00:00Z');

describe('operator card release at the cap (shared reader)', () => {
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
    expect(planRedTeamStatusLabels({ comments, pr: P, head: N, labels: ['red-team:blocked'], env: {} }))
      .toEqual({ add: null, remove: [] });
  });
  it('releases a carried result when the operator card record names that exact head and result', () => {
    const comments = [...live, carried];
    expect(held(disp(comments, N))).toEqual([1]);
    comments.push(gate(human, 'operator-card', cardLine([1]), '2026-10-21T21:30:00Z', rid, N));
    const d = disp(comments, N);
    expect(d.sendBack).toEqual([]);
    expect(d.held).toEqual([]);
    expect(planRedTeamStatusLabels({ comments, pr: P, head: N, labels: ['red-team:blocked'], env: {} }))
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

describe('operator ruling in any state (shared reader)', () => {
  const live = [result, gate(bot, 'sent-back', '- 1 confirmed break(s) sent back to the fixer (#1).', '2026-10-21T17:12:20Z')];
  const disp = (comments, anyState = true, head = H) => readRedTeamDisposition({ comments, pr: P, head, setting: CONFIRMED_BREAKS_DEFAULTS, operatorRulings: { anyState } });
  const sent = (d) => d.sendBack.map(f => f.index);
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

describe('operator ruling policy provenance', () => {
  it('resolves standard → platform → tool → environment and records each source', () => {
    const platform = { operatorRulings: { anyState: false } };
    const file = { redTeam: { operatorRulings: { anyState: true } } };
    expect(resolveOperatorRulings({})).toMatchObject({ value: { anyState: true }, sources: { anyState: 'standard' } });
    expect(resolveOperatorRulings({ platform })).toMatchObject({ value: { anyState: false }, sources: { anyState: 'platform' } });
    expect(resolveOperatorRulings({ platform, file })).toMatchObject({ value: { anyState: true }, sources: { anyState: 'tool' } });
    expect(resolveOperatorRulings({ platform, file, env: { WE_RED_TEAM_OPERATOR_RULINGS_ANY_STATE: 'false' } }))
      .toMatchObject({ value: { anyState: false }, sources: { anyState: 'env' } });
  });
  it('logs the effective scope and source when reading settings', () => {
    const logs = [];
    const scope = readOperatorRulings({ env: { WE_RED_TEAM_OPERATOR_RULINGS_ANY_STATE: 'false' }, log: line => logs.push(line) });
    expect(scope).toMatchObject({ value: { anyState: false }, sources: { anyState: 'env' } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('redTeam.operatorRulings');
    expect(logs[0]).toContain('false');
    expect(logs[0]).toContain('env');
  });
  it('dedup ignores forged, missing-result and stale-result operator records', () => {
    const line = cardLine([1]);
    for (const record of [gate(bot, 'operator-card', line, '2026-10-21T20:30:00Z'),
      gate(human, 'operator-card', line, '2026-10-21T20:30:00Z', null),
      gate(human, 'operator-card', line, '2026-10-21T20:30:00Z', '0123456789abcdef')]) {
      const r = operatorRulingsOnLiveResult([...live, record], P, H);
      expect([...r.ruled]).toEqual([]);
      expect([...r.carded]).toEqual([]);
    }
  });
});

describe('latest operator action deduplication', () => {
  it('keeps action history in thread order and scopes it to the live result', () => {
    const first = gate(human, 'operator-card', cardLine([1]), '2026-10-21T20:30:00Z');
    const later = gate(human, 'operator-card', '- 1 finding(s) left advisory (#1).', '2026-10-21T20:40:00Z');
    const r = operatorRulingsOnLiveResult([...live, later, first], P, H);
    expect(r.ruled.get(1)).toEqual(['card', 'advisory']);
    expect(r.ruled.get(1).at(-1)).toBe('advisory');
    expect([...r.carded]).toEqual([1]);
    const next = bot(renderRedTeamComment({ pr: P, rev: H, provider: 'codex', model: 'm', recheckStatus: 'ok', foldedVerdict: 'changes',
      findings: [F(160, 'broken')] }), '2026-10-21T21:00:00Z');
    const fresh = operatorRulingsOnLiveResult([...live, first, later, next], P, H);
    expect([...fresh.ruled]).toEqual([]);
    expect([...fresh.carded]).toEqual([]);
    expect(operatorRulingsOnLiveResult([], P, H).resultId).toBeNull();
  });
});
