/** @file accepted-conflict-rebase.test.mjs — admission and durable review hand-back guarantees. */
import { describe, it, expect, vi } from 'vitest';
import { AUTOMATION_LOGINS } from '../../lib/marker-authorship.mjs';
import { isAcceptedConflictRebase, planAcceptedConflictRebase, conflictRebaseReceipt } from '../accepted-conflict-rebase.mjs';
import { buildConflictRearmComment } from '../rearm-review.mjs';
import { buildConflictFixMarkComment } from '../conflict-fix-mark.mjs';
import { planFixesFromReconcile, withPlannedContext } from '../reconcile-fix-dispatch.mjs';

import { enrichPrsWithFixClaims } from '../reconcile-pass.mjs';

const head = 'a'.repeat(40), target = 'b'.repeat(40), earlier = 'c'.repeat(40);
const pr = (over = {}) => ({ number: 6911, state: 'OPEN', baseRefName: 'main', headRefOid: head,
  mergeStateStatus: 'DIRTY', labels: ['review:accepted'], comments: [], ...over });
const plan = (over = {}, opts = {}) => planAcceptedConflictRebase({ pr: pr(over), mainSha: target, cap: 3, ceiling: 9, ...opts });
const marker = (sha = target, actor = 'fixer') => ({ author: { login: AUTOMATION_LOGINS[0] },
  body: buildConflictFixMarkComment({ actor, baseRefName: 'main', baseSha: sha }) });

describe('accepted conflict-rebase planner', () => {
  it.each(['review:accepted', 'ready-to-merge', 'status:ready-to-merge'])('admits %s with no CI requirement', label => {
    expect(plan({ labels: [{ name: label }] })).toMatchObject({ kind: 'fix', isConflict: true, mode: 'conflict-rebase', attempts: 0 });
  });
  it.each(['review:changes', 'review:human', 'review:pending', 'review:pending-with-bounce',
    'review:held-mechanical', 'status:held', 'held'])('refuses approval combined with %s', label => {
    expect(plan({ labels: ['review:accepted', label] })).toBeNull();
  });
  it.each([{ labels: null }, { labels: ['review:accepted', {}] }, { isDraft: true },
    { baseRefName: 'lane/base' }, { baseRefName: null }, { state: 'CLOSED' }, { mergeStateStatus: 'UNKNOWN' }])('refuses ineligible evidence %j', over => {
    expect(isAcceptedConflictRebase(pr(over))).toBe(false);
    expect(plan(over)).toBeNull();
  });
  it.each([{ headRefOid: null }, { comments: null }])('fails closed for incomplete evidence %j', over => {
    expect(plan(over)).toMatchObject({ kind: 'refuse', why: expect.stringContaining('refresh') });
  });
  it('admits mergeable CONFLICTING without DIRTY through the shared predicate', () => {
    expect(plan({ mergeable: 'CONFLICTING', mergeStateStatus: 'UNKNOWN' }).kind).toBe('fix');
  });
  it('fails closed for an unreadable target', () => expect(plan({}, { mainSha: null }).kind).toBe('refuse'));
  it('refuses unknown claim evidence with a refresh fallback', () => {
    expect(plan({ fixClaimUnknown: true })).toMatchObject({ kind: 'refuse', why: expect.stringContaining('refresh the claim') });
  });
  it('uses strict claim reads for accepted conflicts and holds unreadable evidence', () => {
    const readClaim = vi.fn(() => null);
    const readClaimStrict = vi.fn(() => { throw new Error('corrupt claim'); });
    const [enriched] = enrichPrsWithFixClaims([pr()], { readClaim, readClaimStrict });
    expect(readClaim).not.toHaveBeenCalled();
    expect(readClaimStrict).toHaveBeenCalledWith({ repo: 'we', pr: 6911 });
    expect(enriched.fixClaimUnknown).toBe(true);
    expect(planAcceptedConflictRebase({ pr: enriched, mainSha: target, cap: 3, ceiling: 9 }).kind).toBe('refuse');
  });
  it('refuses live fixer claims and referral holds', () => {
    expect(plan({ fixClaim: { who: 'fixer' } }).kind).toBe('refuse');
    expect(plan({ referralHold: { why: 'ruling owed' } }).kind).toBe('refuse');
  });
  it.each([
    ['rearm-review', actor => buildConflictRearmComment({ actor, decision: { keepsHuman: false }, mainRef: 'main', mainSha: target })],
  ])('deduplicates %s receipts for a completed head after main advances and planner restarts', (_name, build) => {
    const first = plan();
    const comments = [{ author: { login: AUTOMATION_LOGINS[0] }, body: build(first.conflictRebase.receipt) }];
    expect(plan({ comments })).toMatchObject({ kind: 'refuse', why: expect.stringContaining('already completed for this head') });
    expect(plan({ comments, headRefOid: earlier }).kind).toBe('fix');
    expect(plan({ comments }, { mainSha: earlier }).kind).toBe('refuse');
    expect(plan({ comments: [{ ...comments[0], author: { login: 'untrusted' } }] }).kind).toBe('fix');
    expect(plan({ comments: [{ ...comments[0], body: build(first.conflictRebase.receipt + 'junk') }] }).kind).toBe('fix');
  });
  it('does not deduplicate a receipt quoted outside the rearm actor or under a different marker', () => {
    const actor = conflictRebaseReceipt(head, target);
    const real = buildConflictRearmComment({ actor: 'fixer', decision: { keepsHuman: false } });
    for (const body of [real + '\n' + actor, real.replace('fixer', actor + 'junk'),
      buildConflictFixMarkComment({ actor, baseRefName: 'main', baseSha: target })]) {
      expect(plan({ comments: [{ author: { login: AUTOMATION_LOGINS[0] }, body }] }).kind).toBe('fix');
    }
  });
  it('refuses both existing conflict budgets with an operator fallback', () => {
    for (const comments of [Array.from({ length: 3 }, () => marker()), Array.from({ length: 9 }, () => marker(earlier))]) {
      expect(plan({ comments })).toMatchObject({ kind: 'cap-exhausted', capKind: 'conflict-rebase', why: expect.stringContaining('person must take over') });
    }
  });
  it('carries mode and review receipt through itemless planning into the fix mandate', () => {
    const entry = { ...plan(), prNumber: 6911, headRefName: 'topic', headRefOid: head, files: ['scripts/example.mjs'] };
    const { planned, refusals } = planFixesFromReconcile([entry], () => null, () => []);
    expect(refusals).toEqual([]);
    expect(planned[0]).toMatchObject({ mode: 'conflict-rebase', conflictRebase: { receipt: conflictRebaseReceipt(head, target) } });
    expect(withPlannedContext('brief', planned[0])).toContain('ACCEPTED-CONFLICT-REBASE MODE');
  });
});
