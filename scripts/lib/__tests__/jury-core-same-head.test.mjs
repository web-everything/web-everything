import { describe, it, expect } from 'vitest';
import {
  normalizeFinding, referralFindingKey, sameGapSameHead, isSecurityClassFinding, findSameHeadSiblingRuling,
  carriedBackingHolds,
} from '../jury-core.mjs';

const head = 'a'.repeat(40), otherHead = 'b'.repeat(40);
const base = { file: 'backlog/6901-card.md', line: 20, summary: 'Missing validation of the request payload before use',
  verdict: 'CONFIRMED', impactIfUnfixed: 'broken', category: 'correctness' };
const referral = (seat, over = {}) => {
  const original = { ...base, ...over };
  return { key: referralFindingKey(seat, original), seat, original, finding: normalizeFinding(original) };
};
const world = (ruledOver = {}, { result = 'not-real', rulingHead = head, recordHead = head, card } = {}) => {
  const ruled = referral('judge', ruledOver);
  const rec = { repo: 'o/r', pr: 5530, head: recordHead, runId: 'run-1', referrals: [ruled], rulings: [] };
  const op = { repo: 'o/r', pr: 5530, head: rulingHead, runId: 'run-1', key: ruled.key, result, ...(card ? { card } : {}) };
  return { ruled, ctx: { records: [rec], operatorRulings: [op], head, repo: 'o/r', pr: 5530 } };
};

describe('sameGapSameHead (pure predicate)', () => {
  const f = (over) => normalizeFinding({ ...base, ...over });
  it('accepts the same file, nearby lines, high text similarity, same severity', () => {
    expect(sameGapSameHead(f(), f({ line: 24, summary: 'Request payload validation is missing before use' }))).toBe(true);
  });
  it.each([
    ['another file', { file: 'backlog/other.md' }],
    ['lines too far apart', { line: 60 }],
    ['unrelated text', { summary: 'Timeout is never cleared on teardown paths' }],
    ['different severity', { impactIfUnfixed: 'unrecoverable' }],
    ['a missing line', { line: undefined }],
  ])('refuses %s', (_n, over) => {
    expect(sameGapSameHead(f(), f(over))).toBe(false);
  });
  it('refuses unreadable input', () => {
    expect(sameGapSameHead(null, f())).toBe(false);
    expect(sameGapSameHead(f(), undefined)).toBe(false);
  });
});

describe('isSecurityClassFinding', () => {
  it('reads the category lens', () => {
    expect(isSecurityClassFinding({ category: 'security/injection' })).toBe(true);
    expect(isSecurityClassFinding({ category: 'Security' })).toBe(true);
    expect(isSecurityClassFinding({ category: 'correctness' })).toBe(false);
  });
  it('treats an unreadable finding as security class (fail closed)', () => {
    expect(isSecurityClassFinding(null)).toBe(true);
  });
});

describe('findSameHeadSiblingRuling', () => {
  it('inherits a same-head operator not-real onto the same gap from another seat with other wording', () => {
    const { ctx } = world();
    const sibling = referral('judgeSecurity', { line: 24, summary: 'Request payload validation is missing before use' });
    const m = findSameHeadSiblingRuling(sibling, ctx);
    expect(m).toMatchObject({ result: 'not-real', from: { head, runId: 'run-1' } });
    // the gate's existing backing check accepts the resulting carry entry
    expect(carriedBackingHolds({ from: m.from, result: m.result, card: m.card }, { repo: 'o/r', pr: 5530, operatorRulings: ctx.operatorRulings })).toBeTruthy();
  });
  it('inherits a same-head card ruling and keeps its card', () => {
    const { ctx } = world({}, { result: 'card', card: 'abc1234' });
    expect(findSameHeadSiblingRuling(referral('judgeSecurity', { line: 22 }), ctx)).toMatchObject({ result: 'card', card: 'abc1234' });
  });
  it('never inherits a block', () => {
    const { ctx } = world({}, { result: 'block' });
    expect(findSameHeadSiblingRuling(referral('judgeSecurity', { line: 22 }), ctx)).toBeNull();
  });
  it('a later block ends the search over an earlier clearance', () => {
    const { ruled, ctx } = world();
    ctx.operatorRulings.push({ ...ctx.operatorRulings[0], result: 'block' });
    expect(ruled && findSameHeadSiblingRuling(referral('judgeSecurity', { line: 22 }), ctx)).toBeNull();
  });
  it('never inherits a not-real onto a security-class finding, on either side', () => {
    const sec = world({ category: 'security' });
    expect(findSameHeadSiblingRuling(referral('judgeSecurity', { line: 22 }), sec.ctx)).toBeNull();
    const { ctx } = world();
    expect(findSameHeadSiblingRuling(referral('judgeSecurity', { line: 22, category: 'security/authz' }), ctx)).toBeNull();
  });
  it('does not touch a ruling on another head (that is the cross-head carry)', () => {
    const { ctx } = world({}, { rulingHead: otherHead, recordHead: otherHead });
    expect(findSameHeadSiblingRuling(referral('judgeSecurity', { line: 22 }), ctx)).toBeNull();
  });
  it('does not inherit onto the ruled finding itself', () => {
    const { ruled, ctx } = world();
    expect(findSameHeadSiblingRuling(ruled, ctx)).toBeNull();
  });
  it('refuses a different gap: other file, distant line, other claim, other severity', () => {
    const { ctx } = world();
    for (const over of [{ file: 'x.md' }, { line: 90 }, { summary: 'Timeout is never cleared on teardown paths' },
      { impactIfUnfixed: 'unrecoverable' }]) {
      expect(findSameHeadSiblingRuling(referral('judgeSecurity', over), ctx)).toBeNull();
    }
  });
  it('fails closed on a ruling whose record is missing or on another PR', () => {
    const { ctx } = world();
    expect(findSameHeadSiblingRuling(referral('judgeSecurity', { line: 22 }), { ...ctx, records: [] })).toBeNull();
    expect(findSameHeadSiblingRuling(referral('judgeSecurity', { line: 22 }), { ...ctx, pr: 1 })).toBeNull();
    expect(findSameHeadSiblingRuling(referral('judgeSecurity', { line: 22 }))).toBeNull();
  });
});
