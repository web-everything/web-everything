// Reader half of "operator red-team rulings carry across a provably identical rebase" (live #5502): an operator
// release on head A counts on head B only across a trusted verdict carry AND a trusted cited-line record listing the
// break. The comment layout below is exactly the verdict carry's (rebase-verdict-carry / review-job carryAcrossRebase).
import { describe, it, expect } from 'vitest';
import { CONFIRMED_BREAKS_DEFAULTS, liveResultGateState, readRedTeamDisposition, redTeamCarryLinesMarker,
  redTeamGateMarker, redTeamMarker, resolveOperatorRulings } from '../red-team-gate.mjs';
import { buildVerdictCarriedMarker } from '../review-verdict-carried-marker.mjs';
import { renderRedTeamComment } from '../../operations/review-extra-seats.mjs';

const P = 5502;
const A = '61782334289124cd4fcb51d0bdadb6ef3c795e82';
const B = 'b'.repeat(40);
const bot = (body, createdAt) => ({ author: { login: 'web-everything' }, body, createdAt });
const human = (body, createdAt) => ({ author: { login: 'chalbert' }, body, createdAt });
const F = (line, impact) => ({ summary: `break at ${line}`, category: 'edge-case', impactIfUnfixed: impact, file: 'scripts/operations/coroner-pr-postmortem.mjs', line, confirmedByRecheck: true });
const advisoryBody = renderRedTeamComment({ pr: P, rev: A, provider: 'codex', model: 'm', recheckStatus: 'ok', foldedVerdict: 'changes',
  findings: [F(159, 'broken'), F(127, 'degraded'), F(166, 'degraded')] });
const result = bot(advisoryBody, '2026-10-21T17:07:55Z');
const rid = liveResultGateState([result], P, A).resultId;
const gate = (who, outcome, line, at) => who(`${redTeamGateMarker(P, A, outcome, rid)}\n**Red-team gate** on head \`x\`:\n${line}`, at);
const ruled = [result, gate(bot, 'sent-back', '- 1 confirmed break(s) sent back to the fixer (#1).', '2026-10-21T17:12:20Z'),
  gate(human, 'operator-card', '- 3 finding(s) carded by the operator to `we:backlog/x.md@pr5502` (#1, #2, #3).', '2026-10-21T20:57:41Z')];
const carryComment = bot([redTeamGateMarker(P, B, 'sent-back', rid), redTeamGateMarker(P, B, 'operator-card', rid),
  buildVerdictCarriedMarker({ fromSha: A, toSha: B, patchId: 'c'.repeat(40) }), 'Review verdict carried across an identical contribution.',
  advisoryBody.replace(redTeamMarker(P, A), redTeamMarker(P, B))].join('\n'), '2026-10-21T21:30:00Z');
const lines = (unchanged, who = bot) => who(redTeamCarryLinesMarker({ pr: P, from: A, to: B, result: rid, unchanged }), '2026-10-21T21:30:01Z');
const blocking = (comments, scope = { anyState: true, carryAcrossRebase: true }) => {
  const d = readRedTeamDisposition({ comments, pr: P, head: B, setting: CONFIRMED_BREAKS_DEFAULTS, operatorRulings: scope });
  return [...d.sendBack, ...d.held].map((f) => f.index).sort();
};

describe('operator rulings across a verdict carry (reader)', () => {
  it('the carried result is read on the new head', () => {
    expect(readRedTeamDisposition({ comments: [...ruled, carryComment], pr: P, head: B, setting: CONFIRMED_BREAKS_DEFAULTS }).result?.rev).toBe(B);
  });
  it('rebase-only (cited lines unchanged for all three): the card rulings carry, nothing blocks', () => {
    expect(blocking([...ruled, carryComment, lines([1, 2, 3])])).toEqual([]);
  });
  it('no cited-line record: the gate send-back carries, the operator release does not (#1 blocks)', () => {
    expect(blocking([...ruled, carryComment])).toEqual([1]);
  });
  it('#1\'s cited line changed: only #1 is re-held', () => {
    expect(blocking([...ruled, carryComment, lines([2, 3])])).toEqual([1]);
  });
  it('a record from an untrusted author, or for another result / hop, proves nothing', () => {
    expect(blocking([...ruled, carryComment, lines([1, 2, 3], (b, at) => ({ author: { login: 'mallory' }, body: b, createdAt: at }))])).toEqual([1]);
    const other = bot(redTeamCarryLinesMarker({ pr: P, from: A, to: B, result: '0123456789abcdef', unchanged: [1, 2, 3] }), '2026-10-21T21:30:01Z');
    const hop = bot(redTeamCarryLinesMarker({ pr: P, from: 'd'.repeat(40), to: B, result: rid, unchanged: [1, 2, 3] }), '2026-10-21T21:30:01Z');
    expect(blocking([...ruled, carryComment, other, hop])).toEqual([1]);
  });
  it('kill switch: carryAcrossRebase off never carries an operator release', () => {
    expect(blocking([...ruled, carryComment, lines([1, 2, 3])], { anyState: true, carryAcrossRebase: false })).toEqual([1]);
    expect(resolveOperatorRulings({ env: { WE_RED_TEAM_OPERATOR_RULINGS_CARRY: 'off' } }).value).toEqual({ anyState: true, carryAcrossRebase: false });
    expect(resolveOperatorRulings({ file: { redTeam: { operatorRulings: { carryAcrossRebase: false } } } }).value.carryAcrossRebase).toBe(false);
  });
  it('a different head with no carry is re-evaluated (no result, nothing inherited)', () => {
    const d = readRedTeamDisposition({ comments: [...ruled, lines([1, 2, 3])], pr: P, head: B, setting: CONFIRMED_BREAKS_DEFAULTS });
    expect(d.result).toBeNull();
  });
});
