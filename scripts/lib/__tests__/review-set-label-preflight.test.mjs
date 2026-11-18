import { describe, it, expect } from 'vitest';
import { reviewSetLabelPreflight } from '../review-set-label-preflight.mjs';

const head = 'a'.repeat(40);
const state = { state: 'OPEN', headRefOid: head, body: '<!-- authored-by-actor: author -->', comments: [], labels: ['review:accepted'] };
const evaluate = (patch = {}, options = {}) => reviewSetLabelPreflight({
  state: { ...state, ...patch }, repo: 'o/r', pr: 7, to: 'accepted', expectedHead: head,
  clearerId: 'reviewer', referralOptions: { readRuns: () => [] }, ...options,
});

describe('review label read-only preflight', () => {
  it('reports the settled acceptance without mutating frozen inputs', () => {
    const input = structuredClone(state);
    Object.freeze(input.labels);
    Object.freeze(input.comments);
    Object.freeze(input);
    const result = evaluate(input);
    expect(result).toMatchObject({ settled: true, decision: { allowed: true } });
    expect(input).toEqual(state);
  });

  it.each(['review:pending', 'review:changes', 'advisory:ruling-needed'])('reports a further change for the full removal set: %s', label => {
    expect(evaluate({ labels: [...state.labels, label] }).settled).toBe(false);
  });

  it('reports an absent acceptance as unsettled', () => {
    expect(evaluate({ labels: [] }).settled).toBe(false);
  });

  it.each(['review:human', 'review:held-mechanical'])('refuses a live %s hold', label => {
    expect(evaluate({ labels: [...state.labels, label] })).toMatchObject({ settled: false, decision: { allowed: false } });
  });

  it('refuses the malformed-referral-record thread even when labels are settled', () => {
    expect(() => evaluate({ comments: [{ author: { login: 'web-everything' }, body: '<!-- mandatory-referrals-v1: truncated' }] }))
      .toThrow(/mandatory referral hold/);
  });

  it('refuses unreadable referral input', () => {
    expect(() => evaluate({ comments: undefined })).toThrow();
  });

  it('propagates a failed guard read without claiming settlement', () => {
    expect(() => evaluate({}, { referralOptions: { readRuns: () => { throw new Error('unreadable runs'); } } }))
      .toThrow('unreadable runs');
  });

  it('refuses a head different from the reviewed head', () => {
    expect(() => evaluate({ headRefOid: 'b'.repeat(40) })).toThrow(/live head differs/);
  });

  it.each(['CLOSED', 'MERGED', undefined])('refuses an inert or unreadable PR state %s', state => {
    expect(() => evaluate({ state })).toThrow();
  });

  it('refuses a proven self-clear', () => {
    expect(() => evaluate({ body: '<!-- authored-by-actor: reviewer -->' })).toThrow(/nothing was changed/);
  });

  it.each([
    ['stamp-lost', { body: '<!-- author-stamp-lost: unrecoverable -->' }],
    ['post-regime missing stamp', { body: '', createdAt: '2026-08-20T00:00:00Z' }],
    ['unknown author', { body: '' }],
  ])('refuses %s even with settled labels', (_name, patch) => {
    expect(() => evaluate(patch)).toThrow(/nothing was changed/);
  });

  it('refuses an unknown clearer', () => {
    expect(() => evaluate({}, { clearerId: '' })).toThrow(/nothing was changed/);
  });

  it('uses the target decision and refuses unknown targets', () => {
    expect(evaluate({ labels: ['review:changes'] }, { to: 'changes' })).toMatchObject({ settled: true });
    expect(() => evaluate({}, { to: 'invalid' })).toThrow(/unknown verdict/);
  });
});
