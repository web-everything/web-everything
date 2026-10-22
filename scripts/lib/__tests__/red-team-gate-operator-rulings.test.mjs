/** Cap-only shared-reader subset: human card records, author/wrapper and head/result binding. */
import { describe, expect, it } from 'vitest';
import { renderRedTeamComment } from '../../operations/review-extra-seats.mjs';
import { CONFIRMED_BREAKS_DEFAULTS, liveResultGateState, readRedTeamDisposition, redTeamGateMarker } from '../red-team-gate.mjs';
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
