import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { newRunRecord, writeRun } from '../../operations/run-store.mjs';
import * as admission from '../review-red-team-on-skip.mjs';

const repo = 'web-everything/web-everything', pr = 7116, head = 'a'.repeat(40);
const record = () => ({ id: 'custom-dead', op: 'review-pr', input: { repo, pr }, effects: [], pending: null,
  verdict: { verdict: 'accept' }, findings: { read: { netBasis: { rev: head } } } });
const tombstone = { probes: { owner: 'dead', recordVersion: 'v1' } };
const context = (run, patch = {}) => ({ repo, pr, head, now: 1000, bounds: { completeHeadRead: true },
  rawPr: { headRefOid: head, labels: [], reviews: [], comments: [] },
  readHead: () => head, readRecordVersion: () => 'v1', readAbandonment: () => tombstone,
  isRunAbandoned: () => true, readReviewInventory: () => [run], ...patch });
const allowed = (r, t, ctx) => admission.freshReviewAllowed(r, t, ctx).ok;

describe('one freshReviewAllowed authority', () => {
  it('allows a bound dead owner with complete safe evidence', () => {
    const r = record();
    expect(allowed(r, tombstone, context(r))).toBe(true);
  });
  it.each([
    ['unknown write', r => { r.effects = [{ status: 'pending', idempotent: false, unknownAttempts: 1 }]; }],
    ['failed unknown write', r => { r.effects = [{ status: 'failed', idempotent: false, unknownAttempts: 1 }]; }],
    ['confirm', r => { r.pending = { kind: 'confirm' }; }],
    ['mandatory referral ruling', r => { r.pending = { step: 'mandatoryReferrals' }; }],
    ['changes verdict', r => { r.verdict = { verdict: 'changes' }; }],
    ['saved verdict referral shape', r => { r.resumeOf = { verdict: { verdict: 'accept', pendingReferrals: {} } }; }],
    ['referral verdict shape', r => { r.findings.referralVerdict = { verdict: 'accept', pendingReferrals: [null] }; }],
    ['outstanding referrals', r => { r.verdict.pendingReferrals = ['finding']; }],
  ])('%s refuses for the blocker and every other same-head custom run', (_name, mutate) => {
    const r = record(); mutate(r);
    expect(allowed(r, tombstone, context(r))).toBe(false);
    const blocker = record(); r.id = 'another-custom-id';
    expect(allowed(blocker, tombstone, context(blocker, { isRunAbandoned: id => id === blocker.id,
      readReviewInventory: () => [blocker, r] }))).toBe(false);
  });
  it.each([
    ['unbound legacy', { probes: { owner: 'dead' } }],
    ['UNBOUND legacy without death', { probes: { recordVersion: 'UNBOUND' } }],
    ['no death proof', { probes: { recordVersion: 'v1' } }],
    ['stale binding', { probes: { owner: 'dead', recordVersion: 'v0' } }],
  ])('%s refuses', (_name, sidecar) => {
    const r = record(); expect(allowed(r, sidecar, context(r))).toBe(false);
  });
  it.each([
    ['two dead owners', r => ({ readReviewInventory: () => [r, { ...record(), id: 'second-custom' }] })],
    ['inventory throws', () => ({ readReviewInventory: () => { throw Error('IO'); } })],
    ['head moves', () => ({ readHead: () => 'b'.repeat(40) })],
    ['unread boundary', () => ({ bounds: { completeHeadRead: true, unreadBoundaryAt: 0 } })],
    ['blocked scan', () => ({ bounds: { completeHeadRead: () => ({ complete: true, blocked: true }) } })],
    ['incomplete scan', () => ({ bounds: {} })],
    ['oversized inventory', r => ({ readReviewInventory: () => Array(401).fill(r) })],
    ['formal hold', () => ({ rawPr: { headRefOid: head, labels: [], comments: [], reviews: [{ state: 'CHANGES_REQUESTED' }] } })],
    ['unreadable PR', () => ({ rawPr: null })],
  ])('%s refuses', (_name, patch) => {
    const r = record(); expect(allowed(r, tombstone, context(r, patch(r)))).toBe(false);
  });
  it('default inventory discovers custom operation IDs with holds', () => {
    const dir = mkdtempSync(join(process.env.TMPDIR, 'fresh-review-inventory-'));
    try {
      const r = record(), other = { ...record(), id: 'operator-selected-id', verdict: { verdict: 'changes' } };
      for (const row of [r, other]) writeRun({ ...newRunRecord(row), ...row }, dir);
      const ctx = context(r, { runsDir: dir, isRunAbandoned: id => id === r.id });
      delete ctx.readReviewInventory;
      expect(allowed(r, tombstone, ctx)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
