import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeFinding, referralFindingKey, sameGapSameHead, isSecurityClassFinding, findSameHeadSiblingRuling,
  validateReferralRecord, referralRecordState, mandatoryReferralReviewer, REFERRAL_CARRY_REASON,
  buildOperatorRulingComment, renderReferralRecord, readReferralRecords,
} from '../jury-core.mjs';
import { createReviewPrSinks } from '../../operations/review-pr-io.mjs';
import { REVIEW_EFFECTS } from '../../operations/review-pr.mjs';

const head = 'a'.repeat(40), otherHead = 'b'.repeat(40), card = 'we:backlog/6901-card.md';
const base = { file: 'backlog/6901-card.md', line: 20, summary: 'Missing validation of the request payload before use',
  verdict: 'CONFIRMED', impactIfUnfixed: 'broken', category: 'correctness' };
const referral = (seat = 'judgeSecurity', over = {}) => {
  const original = { ...base, ...over };
  return { key: referralFindingKey(seat, original), seat, original, finding: normalizeFinding(original) };
};
const record = (referrals, over = {}) => {
  const r = { version: 1, repo: 'o/r', pr: 5530, head, runId: 'run-1', attempted: false,
    authorBody: '<!-- authored-by-actor: author -->', referrals, rulings: [], ...over };
  r.reviewer = mandatoryReferralReviewer(r.runId);
  expect(validateReferralRecord(r)).toBe(true);
  return r;
};
const world = (over = {}, result = 'not-real') => {
  const ruled = referral('judge', over), rec = record([ruled]);
  const op = { repo: rec.repo, pr: rec.pr, head, runId: rec.runId, key: ruled.key, result,
    ...(result === 'card' ? { card } : {}) };
  return { ruled, ctx: { records: [rec], operatorRulings: [op], head, repo: rec.repo, pr: rec.pr } };
};
const carry = (from, target, result = 'not-real', extra = {}) => ({ key: target.key, reason: REFERRAL_CARRY_REASON,
  from: { head, runId: 'run-1', key: from.key }, result, ...(result === 'card' ? { card } : {}), ...extra });

describe('sameGapSameHead', () => {
  it('accepts reordered wording and case-insensitive negation tokens', () => {
    expect(sameGapSameHead(base, { ...base, line: 24, summary: 'Request payload validation is MISSING before use' })).toBe(true);
  });
  it.each([
    ['another file', { file: 'other.md' }], ['distant line', { line: 60 }], ['missing line', { line: undefined }],
    ['fractional line', { line: 20.5 }], ['severity', { impactIfUnfixed: 'unrecoverable' }],
    ['opposite claim', { summary: 'Not missing validation of the request payload before use' }],
    ['unrelated claim', { summary: 'Timeout is never cleared on teardown paths' }],
  ])('refuses %s', (_label, over) => expect(sameGapSameHead(base, { ...base, ...over })).toBe(false));
  it('refuses create versus delete wording despite the shared claim words', () => {
    expect(sameGapSameHead({ ...base, summary: `${base.summary} create` },
      { ...base, summary: `${base.summary} delete` })).toBe(false);
  });
  it.each(['not', 'no', 'never', 'without', 'missing', 'cannot', 'lacks'])('requires parity for %s', token => {
    const a = { ...base, summary: 'Validation checks request payload before processing' };
    expect(sameGapSameHead(a, { ...a, summary: `${token} ${a.summary}` })).toBe(false);
  });
  it('refuses unreadable inputs', () => expect(sameGapSameHead(null, base)).toBe(false));
});

describe('same-head operator matching and read-time validation', () => {
  it.each(['not-real', 'card'])('persists a valid %s carry and settles the sibling', result => {
    const { ruled, ctx } = world({}, result), target = referral();
    const match = findSameHeadSiblingRuling(target, ctx);
    expect(match).toMatchObject({ result, from: { head, runId: 'run-1', key: ruled.key } });
    const r = record([target], { carried: [carry(ruled, target, result)] });
    expect(referralRecordState(r, { ...ctx, cardReadable: () => true }).pending).toEqual([]);
    expect(referralRecordState(r, { ...ctx, records: [] }).pending).toEqual([target.key]);
  });
  it.each([undefined, null, '', '   ', 42, {}, 'security', '  security/authz  ', 'SECURITY/INJECTION'])('refuses not-real with security/unknown category %j on either side', category => {
    expect(isSecurityClassFinding({ category })).toBe(true);
    for (const source of [true, false]) {
      const { ruled, ctx } = world(source ? { category } : {});
      const target = referral('judgeSecurity', source ? {} : { category });
      expect(findSameHeadSiblingRuling(target, ctx)).toBeNull();
      const r = record([target], { carried: [carry(ruled, target)] });
      expect(referralRecordState(r, ctx).pending).toEqual([target.key]);
    }
  });
  it('recognizes a present non-security category', () => expect(isSecurityClassFinding({ category: ' Correctness ' })).toBe(false));
  it('refuses unreadable security classification but permits a security card carry', () => {
    expect(isSecurityClassFinding(null)).toBe(true);
    const { ctx } = world({ category: 'SECURITY' }, 'card');
    expect(findSameHeadSiblingRuling(referral('judgeSecurity', { category: undefined }), ctx)).toMatchObject({ result: 'card', card });
  });
  it.each(['opposite', 'create/delete', 'line'])('withdraws a forged same-head carry at read time: %s', mode => {
    const { ruled, ctx } = world(mode === 'create/delete' ? { summary: `${base.summary} create` } : {});
    const target = referral('judgeSecurity', mode === 'opposite' ? { summary: `Not ${base.summary}` }
      : mode === 'line' ? { line: undefined } : { summary: `${base.summary} delete` });
    expect(findSameHeadSiblingRuling(target, ctx)).toBeNull();
    expect(referralRecordState(record([target], { carried: [carry(ruled, target)] }), ctx).pending).toEqual([target.key]);
  });
  it.each(['block', 'self', 'reviewer'])('rejects invalid same-head carry provenance: %s', mode => {
    const { ruled } = world(), target = referral(), c = carry(ruled, target);
    if (mode === 'block') c.result = 'block';
    if (mode === 'self') c.from.key = target.key;
    if (mode === 'reviewer') c.from.rulingId = 'run-1:0';
    expect(validateReferralRecord({ ...record([target]), carried: [c] })).toBe(false);
  });
  it.each(['record', 'referral'])('refuses an unresolved newer ruling with missing %s', missing => {
    const { ctx } = world();
    ctx.operatorRulings.push({ ...ctx.operatorRulings[0], ...(missing === 'record' ? { runId: 'missing' } : { key: 'missing' }) });
    expect(findSameHeadSiblingRuling(referral(), ctx)).toBeNull();
  });
  it('refuses a later block, another head/PR, its own key and missing context', () => {
    const { ruled, ctx } = world();
    expect(findSameHeadSiblingRuling(ruled, ctx)).toBeNull();
    expect(findSameHeadSiblingRuling(referral(), { ...ctx, head: otherHead })).toBeNull();
    expect(findSameHeadSiblingRuling(referral(), { ...ctx, pr: 1 })).toBeNull();
    expect(findSameHeadSiblingRuling(referral())).toBeNull();
    ctx.operatorRulings.push({ ...ctx.operatorRulings[0], result: 'block' });
    expect(findSameHeadSiblingRuling(referral(), ctx)).toBeNull();
  });
});

// Sink coverage stays here to respect the explicit three-file edit boundary.
describe('mandatory-referral sink same-head persistence', () => {
  it.each(['none', 'unreadable-card', 'unknown-lines', 'changed-lines', 'old-lines'])('persists without a same-head comparison, falling through failed cross-head proof: %s', async mode => {
    const root = mkdtempSync(join(tmpdir(), 'same-head-carry-'));
    try {
      const { ruled, ctx } = world(), target = referral(), current = record([ruled, target]);
      const post = (body, login = 'web-everything') => ({ body, author: { login } });
      const state = { headRefOid: head, body: current.authorBody, labels: [], comments: [post(renderReferralRecord(current))] };
      const operatorPost = (r, result = 'not-real') => post(buildOperatorRulingComment({ version: 1,
        repo: r.repo, pr: r.pr, head: r.head, actor: 'chalbert', channel: 'test', reason: 'checked',
        at: '2026-10-04T12:00:00Z', clearerId: '', rulings: [{ runId: r.runId, key: ruled.key, result,
          ...(result === 'card' ? { card } : {}) }] }), 'chalbert');
      state.comments.push(operatorPost(current));
      if (mode !== 'none') {
        const old = record([ruled], { head: otherHead, runId: 'old' });
        state.comments.push(post(renderReferralRecord(old)), operatorPost(old, mode === 'unreadable-card' ? 'card' : 'not-real'));
      }
      const changedLines = vi.fn(() => mode === 'old-lines' ? Object.assign(new Set(), { old: new Set([20]) })
        : mode === 'changed-lines' ? new Set([20]) : null), judge = vi.fn(() => { throw new Error('unexpected judge'); });
      const provider = {
        readPrState: () => { state.comments.forEach((c, i) => { c.id ??= String(i); }); return structuredClone(state); },
        editComment: (id, body) => { state.comments.find(c => c.id === id).body = body; },
        postComment: (_repo, _pr, body) => state.comments.push(post(body)), setLabels: () => {},
      };
      const sinks = createReviewPrSinks({ root, env: {}, labelProvider: provider, readChangedLines: changedLines,
        referralJudge: judge, cardReadable: () => false, mirrorReferral: () => {}, appendLedgerRow: () => ({ ok: true }), out: () => {} });
      const result = await sinks[REVIEW_EFFECTS.MANDATORY_REFERRALS]({ referrals: [], read: {
        repo: ctx.repo, pr: ctx.pr, netBasis: { rev: head }, body: state.body } }, { runId: 'sink-run' });
      const saved = readReferralRecords(state.comments).records.find(r => r.runId === current.runId);
      expect(validateReferralRecord(saved)).toBe(true);
      expect(saved.carried).toEqual([carry(ruled, target)]);
      expect(result.pending).toEqual([]);
      expect(judge).not.toHaveBeenCalled();
      expect(changedLines).toHaveBeenCalledTimes(['none', 'unreadable-card'].includes(mode) ? 0 : 1);
      for (const [, baseHead, targetHead] of changedLines.mock.calls) expect([baseHead, targetHead]).toEqual([otherHead, head]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
