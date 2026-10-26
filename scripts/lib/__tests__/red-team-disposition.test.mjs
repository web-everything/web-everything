import { describe, expect, it } from 'vitest';
import { rulableBreaks } from '../../operations/record-red-team-ruling.mjs';
import { renderRedTeamComment } from '../../operations/review-extra-seats.mjs';
import { readRedTeamDisposition, liveResultGateState, redTeamGateMarker } from '../red-team-gate.mjs';
import { buildReviewedShaMarker, buildClearedHumanMarker } from '../review-escalation.mjs';
import { buildVerdictCarriedMarker } from '../review-verdict-carried-marker.mjs';
import { DISPOSITION_PRECEDENCE, resolveDisposition } from '../red-team-disposition.mjs';

// Independent expected ranks: changing the production table cannot change the oracle.
const cases = [
  ['operator block', 'block', 'operator', 'held'],
  ['operator clear-human', 'clear-human', 'operator', 'cleared'],
  ['operator not-real', 'not-real', 'operator', 'released not-real'],
  ['operator card', 'card', 'operator', 'released carded'],
  ['automatic card', 'card', 'automatic', 'released carded'],
  ['automatic not-real', 'not-real', 'automatic', 'released not-real'],
  ['none', null, null, 'open'],
];
const ruling = (row, at) => row[1] ? { kind: row[1], source: row[2], keys: ['A'], at } : null;
const resolve = rs => resolveDisposition('A', rs.filter(Boolean));

describe('disposition precedence', () => {
  it('freezes the table and every row', () => {
    expect(Object.isFrozen(DISPOSITION_PRECEDENCE)).toBe(true);
    expect(DISPOSITION_PRECEDENCE.every(Object.isFrozen)).toBe(true);
  });
  it.each(cases)('single %s', (_name, kind, source, state) => {
    expect(resolve(kind ? [{ kind, source, at: 0 }] : []).state).toBe(state);
  });
  for (let a = 0; a < cases.length; a++) for (let b = a; b < cases.length; b++) {
    for (const [first, last] of [[a, b], [b, a]]) {
      it(`${cases[first][0]} before ${cases[last][0]} (also shuffled input)`, () => {
        const rs = [ruling(cases[first], 1), ruling(cases[last], 2)].filter(Boolean);
        const winner = Math.min(first, last);
        expect(resolve(rs).state).toBe(cases[winner][3]);
        expect(resolve([...rs].reverse())).toEqual(resolve(rs));
        if (winner !== 6) expect(resolve(rs).by).toBe(rs.findLast(r => r.kind === cases[winner][1] && r.source === cases[winner][2]));
      });
    }
  }
  it.each(cases.slice(0, 6))('latest wins only within %s', (_name, kind, source) => {
    const older = { kind, source, at: 1 }, latest = { kind, source, at: 2 };
    expect(resolve([latest, older]).by).toBe(latest);
  });
  it('legacy block holds all keys; indexed block holds only named keys', () => {
    const legacy = { kind: 'block', source: 'operator', at: 1 };
    expect(resolveDisposition('B', [legacy]).state).toBe('held');
    expect(resolveDisposition('B', [{ ...legacy, keys: ['A'] }])).toEqual({ state: 'open', by: null });
    expect(resolveDisposition('A', [{ ...legacy, keys: [] }]).state).toBe('open');
  });
  it('two findings: blocking A preserves the release of B', () => {
    const rs = [{ kind: 'not-real', source: 'operator', keys: ['B'], at: 1 },
      { kind: 'block', source: 'operator', keys: ['A'], at: 2 }];
    expect(resolveDisposition('A', rs).state).toBe('held');
    expect(resolveDisposition('B', rs).state).toBe('released not-real');
  });
  it('block before clear-human still holds; clearance applies only to keys outside the block', () => {
    const rs = [{ kind: 'block', source: 'operator', at: 1 },
      { kind: 'clear-human', source: 'operator', keys: ['A'], at: 2 }];
    expect(resolveDisposition('A', rs).state).toBe('held');
    expect(resolveDisposition('B', rs).state).toBe('held');
    const indexed = [{ ...rs[0], keys: ['B'] }, rs[1]];
    expect(resolveDisposition('A', indexed).state).toBe('cleared');
    expect(resolveDisposition('B', indexed).state).toBe('held');
    expect(resolveDisposition('A', [...rs, { kind: 'block', source: 'operator', at: 3 }]).state).toBe('held');
  });
  it('does not mutate frozen evidence', () => {
    const rs = Object.freeze([Object.freeze({ kind: 'card', source: 'automatic', keys: Object.freeze(['A']), at: 1 })]);
    expect(resolve(rs).by).toBe(rs[0]);
  });
  it.each([null, {}, [{ kind: 'card', source: 'unknown', at: 1 }],
    [{ kind: 'clear-human', source: 'automatic', at: 1 }], [{ kind: 'card', source: 'operator' }],
    [{ kind: 'block', source: 'operator', keys: 'A', at: 1 }]])('refuses malformed evidence; operator must inspect/retry (%j)', rs => {
    expect(() => resolveDisposition('A', rs)).toThrow(TypeError);
  });
});

// Exercise normalization as well as ranking: trust, result binding, carries and
// legacy wire shapes are intentionally outside the pure resolver's input shape.
const head = 'a'.repeat(40), nextHead = 'b'.repeat(40), pr = 5923;
const bot = body => ({ author: { login: 'web-everything', type: 'Bot' }, body });
const human = body => ({ author: { login: 'chalbert', type: 'User' }, body });
const result = bot(renderRedTeamComment({ pr, rev: head, provider: 'codex', model: 'm',
  recheckStatus: 'ok', foldedVerdict: 'changes', findings: [1, 2].map(i => ({
    summary: `Break ${i}`, category: 'edge-case', impactIfUnfixed: 'broken',
    file: 'scripts/example.mjs', line: i, confirmedByRecheck: true,
  })) }));
const id = liveResultGateState([result], pr, head).resultId;
const gate = (outcome, line, who = human, rev = head) => who(`${redTeamGateMarker(pr, rev, outcome, id)}\n${line}`);
const hold = '- 2 confirmed break(s) NOT sent back: cap (#1, #2).';
const block = gate('operator-block', '- 1 confirmed break(s) sent back to the fixer (#1).');
const release = gate('operator-not-real', '- 1 finding(s) left advisory (#1).');
const cap = gate('round-cap', hold, bot);
const read = (comments, rev = head) => readRedTeamDisposition({ comments, pr, head: rev,
  operatorRulings: { anyState: true }, env: {} });
const heldKeys = d => [...d.held, ...d.sendBack].map(f => f.index);

describe('historical break shapes through the shared reader', () => {
  it('automatic card cannot clear an inherited operator block', () => {
    const carried = bot([redTeamGateMarker(pr, nextHead, 'round-cap', id),
      buildVerdictCarriedMarker({ fromSha: head, toSha: nextHead, patchId: 'c'.repeat(40) }),
      'Review verdict carried across an identical contribution.', result.body.replace(head, nextHead)].join('\n'));
    const card = gate('card-queued', '- 1 finding(s) filed as a follow-up card (#1).', bot, nextHead);
    expect(heldKeys(read([result, cap, block, carried, card], nextHead))).toContain(1);
  });
  it('unindexed legacy block does not re-hold a released finding', () => {
    const legacy = gate('operator-block', '- 2 confirmed break(s) NOT sent back: cap.');
    expect(heldKeys(read([result, cap, release, legacy]))).toEqual([2]);
  });
  it('a repost retires a not-real ruling that can no longer release', () => {
    expect(heldKeys(read([result, cap, release]))).toEqual([2]);
    const reposted = read([result, cap, release, result, cap]);
    expect(heldKeys(reposted)).toEqual([1, 2]);
    expect(reposted.dispositions.get(1).state).toBe('open');
  });
  it('a block of A leaves B released', () => {
    const releaseB = gate('operator-not-real', '- 1 finding(s) left advisory (#2).');
    expect(heldKeys(read([result, cap, releaseB, block]))).toEqual([1]);
  });
  it('a block before clear-human still holds A; clear-human clears only B', () => {
    const clear = human(['✅ review — `review:human` cleared via the sanctioned path', '',
      'Cleared by chalbert via `review-set-label.mjs --to=clear-human` (gate-self).', '',
      buildReviewedShaMarker(head), buildClearedHumanMarker('chalbert')].join('\n'));
    const disposition = read([result, cap, block, clear]);
    expect(heldKeys(disposition)).toEqual([1]);
    expect(disposition.dispositions.get(1).state).toBe('held');
    expect(disposition.dispositions.get(2).state).toBe('cleared');
    expect(heldKeys(read([result, cap, block, clear, block]))).toEqual([1]);
  });
  it('later indexed gate holds retire operator releases before ranking', () => {
    expect(heldKeys(read([result, cap, release, cap]))).toEqual([1, 2]);
    expect(heldKeys(read([result, cap, release]))).toEqual([2]);
  });
});

describe('planning uses the same live precedence', () => {
  const plan = (comments, ruling) => rulableBreaks({ comments, pr, head,
    scope: { anyState: true }, ruling, citesCard: true });
  it('refuses a card proposal below a live operator not-real', () => {
    // B is released too, so it cannot hide a refusal on A in the candidate list.
    const allReleased = gate('operator-not-real', '- 2 finding(s) left advisory (#1, #2).');
    expect(() => plan([result, cap, allReleased], 'card')).toThrow(/left to rule/);
  });
  it('allows operator not-real to supersede an operator card', () => {
    const card = gate('operator-card', '- 1 finding(s) carded by the operator to `we:backlog/example.md` (#1).');
    expect(plan([result, cap, card], 'not-real').rulable.map(f => f.index)).toContain(1);
  });
});
