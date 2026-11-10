/**
 * @file scripts/conveyor/__tests__/dispatch-eligibility.test.mjs
 * @description Table tests for the PURE shared dispatch-eligibility gate (item 38, slice 1). One invariant per hold,
 *   each parametrised over every population so a new population cannot skip a hold; every unread fact is unknown.
 */
import { describe, it, expect } from 'vitest';
import { eligibility, POPULATIONS, REQUIRED_FACTS, REASONS, known, unread } from '../dispatch-eligibility.mjs';

const HEAD = 'a'.repeat(40);
const pr = (over = {}) => ({ number: 7, state: 'OPEN', isDraft: false, labels: [], headRefOid: HEAD, baseRefName: 'main',
  mergeStateStatus: 'CLEAN', comments: [], commentsComplete: true, ...over });
const clean = (population = 'fix') => ({
  population: known(population),
  referral: known({ state: 'none' }),
  alreadyLanded: known('not-landed'),
  scope: known('present'),
  redTeam: known({ state: 'clear', resultId: 'r1', sendBackResultId: null }),
  claim: known({ claimed: false }),
  pause: known({ paused: false }),
  sameHead: known({ spent: false }),
  rounds: known({ attempts: 0, cap: 3 }),
});
const withFact = (population, name, value) => ({ ...clean(population), [name]: value });
const ALL = [...POPULATIONS];
// A population whose own purpose is to answer the hold is exempt from that one hold only.
const except = (...skip) => ALL.filter(p => !skip.includes(p));

describe('dispatch-eligibility: baseline', () => {
  it.each(ALL)('%s dispatches when every rule passes', population => {
    const out = eligibility(pr({ isDraft: population === 'promote-draft' || population === 'main-fix-green' }), clean(population));
    expect(out).toMatchObject({ dispatch: true, population });
    expect(out.evidence).toBeTruthy();
  });
  it('is pure: same inputs, same output, inputs untouched', () => {
    const p = pr(); const f = clean();
    const snap = JSON.stringify([p, f]);
    expect(eligibility(p, f)).toEqual(eligibility(p, f));
    expect(JSON.stringify([p, f])).toBe(snap);
  });
});

describe('dispatch-eligibility: unknown never dispatches', () => {
  it.each(ALL.flatMap(p => REQUIRED_FACTS.map(f => [p, f])))('%s with unread %s -> unknown', (population, name) => {
    const out = eligibility(pr(), withFact(population, name, unread()));
    expect(out).toEqual({ unknown: name });
    expect(out.dispatch).toBeUndefined();
  });
  it.each(ALL)('%s with a possibly truncated thread -> unknown:thread', population => {
    expect(eligibility(pr({ commentsComplete: false }), clean(population))).toEqual({ unknown: 'thread' });
  });
  it.each(ALL)('%s with a missing thread flag -> unknown:thread', population => {
    expect(eligibility(pr({ commentsComplete: undefined }), clean(population))).toEqual({ unknown: 'thread' });
  });
  it('a missing fact object is unknown, not a pass', () => {
    const f = clean(); delete f.alreadyLanded;
    expect(eligibility(pr(), f)).toEqual({ unknown: 'alreadyLanded' });
  });
  it('a known fact with a malformed value is unknown, not a pass', () => {
    expect(eligibility(pr(), withFact('fix', 'alreadyLanded', known('maybe')))).toEqual({ unknown: 'alreadyLanded' });
    expect(eligibility(pr(), withFact('fix', 'rounds', known({ attempts: 'x', cap: 3 })))).toEqual({ unknown: 'rounds' });
  });
  it('an unrecognised population is unknown', () => {
    expect(eligibility(pr(), clean('made-up'))).toEqual({ unknown: 'population' });
  });
  it('a failed diff read (RP bail-out) arrives as unread alreadyLanded and holds', () => {
    expect(eligibility(pr({ labels: ['merge-status:conflicting'] }), withFact('conflict-owes-rebase', 'alreadyLanded', unread())))
      .toEqual({ unknown: 'alreadyLanded' });
  });
  it('unknown wins over a definite hold (unknown-first)', () => {
    expect(eligibility(pr({ state: 'CLOSED' }), withFact('fix', 'scope', unread()))).toEqual({ unknown: 'scope' });
  });
});

describe('dispatch-eligibility: holds', () => {
  it.each(ALL)('%s: not open -> hold:not-open', population => {
    for (const state of ['CLOSED', 'MERGED', undefined]) {
      expect(eligibility(pr({ state }), clean(population))).toEqual({ hold: REASONS.NOT_OPEN });
    }
  });
  it.each(except('promote-draft', 'main-fix-green', 'red-team-send-back'))('%s: draft -> hold:draft', population => {
    expect(eligibility(pr({ isDraft: true }), clean(population))).toEqual({ hold: REASONS.DRAFT });
  });
  it('a non-boolean isDraft is not treated as ready', () => {
    expect(eligibility(pr({ isDraft: undefined }), clean('fix'))).toEqual({ unknown: 'pr' });
  });
  it.each(['promote-draft', 'main-fix-green'])('%s: draft exception dispatches', population => {
    expect(eligibility(pr({ isDraft: true }), clean(population))).toMatchObject({ dispatch: true });
  });
  it.each(['red-team:blocked', 'red-team:pending'])('a draft labelled %s cannot use a promotion exemption', label => {
    const bound = known({ state: 'send-back', resultId: 'r1', sendBackResultId: 'r1' });
    for (const population of ['promote-draft', 'main-fix-green']) {
      for (const labels of [[label], [{ name: label }]]) {
        expect(eligibility(pr({ isDraft: true, labels }), withFact(population, 'redTeam', bound)))
          .toEqual({ hold: REASONS.DRAFT });
      }
    }
  });
  it.each(['red-team:blocked', 'red-team:pending'])('a draft labelled %s allows only a live-bound send-back repair', label => {
    for (const labels of [[label], [{ name: label }]]) {
      const state = pr({ isDraft: true, labels });
      const bound = known({ state: 'send-back', resultId: 'r1', sendBackResultId: 'r1' });
      expect(eligibility(state, withFact('red-team-send-back', 'redTeam', bound))).toMatchObject({ dispatch: true });
      for (const redTeam of [
        known({ state: 'send-back', resultId: 'r2', sendBackResultId: 'r1' }),
        known({ state: 'send-back', resultId: null, sendBackResultId: null }),
        known({ state: 'held', resultId: 'r1', sendBackResultId: null }),
        known({ state: 'blocked', resultId: 'r1', sendBackResultId: null }),
        known({ state: 'pending', resultId: 'r1', sendBackResultId: null }),
      ]) {
        expect(eligibility(state, withFact('red-team-send-back', 'redTeam', redTeam))).toEqual({ hold: REASONS.DRAFT });
      }
    }
  });
  it('red-team-send-back: draft allowed ONLY for a send-back bound to the live result', () => {
    const bound = known({ state: 'send-back', resultId: 'r1', sendBackResultId: 'r1' });
    expect(eligibility(pr({ isDraft: true }), withFact('red-team-send-back', 'redTeam', bound))).toMatchObject({ dispatch: true });
    const older = known({ state: 'send-back', resultId: 'r2', sendBackResultId: 'r1' });
    expect(eligibility(pr({ isDraft: true }), withFact('red-team-send-back', 'redTeam', older))).toEqual({ hold: REASONS.DRAFT });
    expect(eligibility(pr({ isDraft: true }), clean('red-team-send-back'))).toEqual({ hold: REASONS.DRAFT });
  });
  it.each(ALL)('%s: pending referral -> hold:referral', population => {
    for (const state of ['pending', 'human-parked', 'auto-resolve-stays']) {
      expect(eligibility(pr(), withFact(population, 'referral', known({ state })))).toEqual({ hold: REASONS.REFERRAL });
    }
  });
  it.each(ALL)('%s: auto-resolve that resumes does not hold', population => {
    expect(eligibility(pr(), withFact(population, 'referral', known({ state: 'auto-resolve-resumes' })))).toMatchObject({ dispatch: true });
  });
  it('block-ruled-referral is NOT exempt: a pending referral still holds (never looser than today)', () => {
    expect(eligibility(pr(), withFact('block-ruled-referral', 'referral', known({ state: 'pending' })))).toEqual({ hold: REASONS.REFERRAL });
  });
  it.each(ALL)('%s: a draft-withdrawn PR holds even where drafts are allowed', population => {
    expect(eligibility(pr({ isDraft: true, labels: ['review-status:draft-withdrawn'] }), clean(population))).toEqual({ hold: REASONS.DRAFT });
  });
  it.each([undefined, 0, -1, 1.5, '7'])('a missing or invalid PR number %s -> unknown:pr', number => {
    expect(eligibility(pr({ number }), clean())).toEqual({ unknown: 'pr' });
  });
  it.each([undefined, '', 'abc', 'a'.repeat(39)])('a missing or invalid head %s -> unknown:pr', headRefOid => {
    expect(eligibility(pr({ headRefOid }), clean())).toEqual({ unknown: 'pr' });
  });
  it.each([
    ['SHA array', [HEAD]],
    ['object with null toString', { toString: null }],
    ['object with SHA toString', { toString: () => HEAD }],
    ['object with throwing toString', { toString: () => { throw new Error('must not coerce head'); } }],
    ['object without a prototype', Object.create(null)],
    ['boxed string', new String(HEAD)],
    ['40-digit number', 1e39],
    ['40-digit bigint', BigInt('1'.repeat(40))],
    ['boolean', true],
    ['symbol', Symbol('head')],
    ['null', null],
  ])('a non-string head (%s) -> unknown:pr without coercion', (_name, headRefOid) => {
    expect(eligibility(pr({ headRefOid }), clean())).toEqual({ unknown: 'pr' });
  });
  it('preserves a valid mixed-case string head in dispatch evidence', () => {
    const headRefOid = 'aB12'.repeat(10);
    expect(eligibility(pr({ headRefOid }), clean())).toMatchObject({ dispatch: true, evidence: { head: headRefOid } });
  });
  it.each(ALL)('%s: an object-shaped withdrawn label holds too', population => {
    expect(eligibility(pr({ isDraft: true, labels: [{ name: 'review-status:draft-withdrawn' }] }), clean(population))).toEqual({ hold: REASONS.DRAFT });
  });
  it.each(ALL)('%s: missing isDraft evidence -> unknown:pr, even for draft-exempt populations', population => {
    expect(eligibility(pr({ isDraft: undefined }), clean(population))).toEqual({ unknown: 'pr' });
  });
  it('unreadable labels -> unknown:pr', () => {
    expect(eligibility(pr({ labels: undefined }), clean())).toEqual({ unknown: 'pr' });
  });
  it('empty-string result ids never authorise a draft send-back', () => {
    const empty = known({ state: 'send-back', resultId: '', sendBackResultId: '' });
    expect(eligibility(pr({ isDraft: true }), withFact('red-team-send-back', 'redTeam', empty))).toEqual({ unknown: 'redTeam' });
  });
  it.each(ALL)('%s: already landed -> hold:already-landed', population => {
    expect(eligibility(pr(), withFact(population, 'alreadyLanded', known('landed')))).toEqual({ hold: REASONS.ALREADY_LANDED });
  });
  it.each(ALL)('%s: empty scope -> hold:no-scope', population => {
    expect(eligibility(pr(), withFact(population, 'scope', known('empty')))).toEqual({ hold: REASONS.NO_SCOPE });
  });
  it.each(ALL)('%s: oversized scope -> hold:scope-too-large', population => {
    expect(eligibility(pr(), withFact(population, 'scope', known('too-large')))).toEqual({ hold: REASONS.SCOPE_TOO_LARGE });
  });
  it.each(ALL)('%s: held / pending / blocked red team -> hold:red-team-<state>', population => {
    for (const state of ['held', 'pending', 'blocked']) {
      const redTeam = known({ state, resultId: 'r1', sendBackResultId: null });
      expect(eligibility(pr(), withFact(population, 'redTeam', redTeam))).toEqual({ hold: `${REASONS.RED_TEAM_PREFIX}${state}` });
    }
  });
  it.each(ALL)('%s: send-back from an OLDER result holds; bound to the live result does not', population => {
    const older = known({ state: 'send-back', resultId: 'r2', sendBackResultId: 'r1' });
    expect(eligibility(pr(), withFact(population, 'redTeam', older))).toEqual({ hold: REASONS.RED_TEAM_STALE_SEND_BACK });
    const bound = known({ state: 'send-back', resultId: 'r1', sendBackResultId: 'r1' });
    expect(eligibility(pr(), withFact(population, 'redTeam', bound))).toMatchObject({ dispatch: true });
  });
  it('a send-back with no result id to bind to holds', () => {
    const unbound = known({ state: 'send-back', resultId: null, sendBackResultId: null });
    expect(eligibility(pr(), withFact('fix', 'redTeam', unbound))).toEqual({ hold: REASONS.RED_TEAM_STALE_SEND_BACK });
  });
  it('an unrecognised red-team state is unknown', () => {
    expect(eligibility(pr(), withFact('fix', 'redTeam', known({ state: 'weird', resultId: 'r1', sendBackResultId: null })))).toEqual({ unknown: 'redTeam' });
  });
  it('a label never stands in for the live result', () => {
    expect(eligibility(pr({ labels: ['red-team:clear'] }), withFact('fix', 'redTeam', known({ state: 'held', resultId: 'r1', sendBackResultId: null }))))
      .toEqual({ hold: `${REASONS.RED_TEAM_PREFIX}held` });
  });
  it.each(ALL)('%s: claimed -> hold:claimed', population => {
    expect(eligibility(pr(), withFact(population, 'claim', known({ claimed: true })))).toEqual({ hold: REASONS.CLAIMED });
  });
  it.each(ALL)('%s: concurrent-author pause -> hold:paused', population => {
    expect(eligibility(pr(), withFact(population, 'pause', known({ paused: true })))).toEqual({ hold: REASONS.PAUSED });
  });
  it.each(ALL)('%s: same-head marker spent -> hold:same-head', population => {
    expect(eligibility(pr(), withFact(population, 'sameHead', known({ spent: true })))).toEqual({ hold: REASONS.SAME_HEAD });
  });
  it.each(ALL)('%s: attempts at the cap -> hold:cap-exhausted:<kind>', population => {
    expect(eligibility(pr(), withFact(population, 'rounds', known({ attempts: 3, cap: 3 })))).toEqual({ hold: `${REASONS.CAP_PREFIX}${population}` });
    expect(eligibility(pr(), withFact(population, 'rounds', known({ attempts: 9, cap: 3 })))).toEqual({ hold: `${REASONS.CAP_PREFIX}${population}` });
    expect(eligibility(pr(), withFact(population, 'rounds', known({ attempts: 2, cap: 3 })))).toMatchObject({ dispatch: true });
  });
  it('the cap counts attempts: a completion count below the cap cannot hide spent attempts (R412)', () => {
    expect(eligibility(pr(), withFact('fix', 'rounds', known({ attempts: 3, completions: 1, cap: 3 })))).toEqual({ hold: `${REASONS.CAP_PREFIX}fix` });
  });
  it('rule order: the first non-pass wins', () => {
    const f = { ...clean('fix'), alreadyLanded: known('landed'), scope: known('empty'), claim: known({ claimed: true }) };
    expect(eligibility(pr({ isDraft: true }), f)).toEqual({ hold: REASONS.DRAFT });
    expect(eligibility(pr(), f)).toEqual({ hold: REASONS.ALREADY_LANDED });
    expect(eligibility(pr(), { ...f, alreadyLanded: known('not-landed') })).toEqual({ hold: REASONS.NO_SCOPE });
  });
});

describe('dispatch-eligibility: monotonicity', () => {
  const blockers = {
    referral: known({ state: 'pending' }), alreadyLanded: known('landed'), scope: known('empty'),
    redTeam: known({ state: 'held', resultId: 'r1', sendBackResultId: null }), claim: known({ claimed: true }),
    pause: known({ paused: true }), sameHead: known({ spent: true }), rounds: known({ attempts: 5, cap: 3 }),
  };
  it.each(ALL.flatMap(p => Object.keys(blockers).map(k => [p, k])))('%s: a hold in %s survives any combination of other facts', (population, name) => {
    const names = Object.keys(blockers).filter(k => k !== name);
    for (let mask = 0; mask < 2 ** names.length; mask++) {
      const facts = { ...clean(population), [name]: blockers[name] };
      names.forEach((k, i) => { if (mask & (1 << i)) facts[k] = blockers[k]; });
      const out = eligibility(pr(), facts);
      expect(out.dispatch).toBeUndefined();
      expect(out.hold ?? out.unknown).toBeTruthy();
    }
  });
});
