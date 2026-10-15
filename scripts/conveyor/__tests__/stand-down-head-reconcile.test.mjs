import { describe, expect, it, vi } from 'vitest';
import { planReconcile } from '../reconcile-core.mjs';
import { buildStandDownComment, resolveStandDownHoldsAcrossHeads } from '../stand-down.mjs';
import { enrichStandDownHeadChange } from '../pr-comments-complete.mjs';
import { standDownRow } from '../../operations/operator-queue.mjs';
import { standDownOf } from '../health-smells/stood-down-prs.mjs';

const old = '7eee9db73f8b111de10559fdb629d6ccbbee6472';
const head = '5dd818e6c' + 'a'.repeat(31);
const at = '2026-10-13T22:52:00Z';
const held = (options = {}) => ({ author: { login: 'web-everything' }, createdAt: at,
  body: buildStandDownComment({ reason: 'fix-loop-exhausted', ...options }) });
const pr = (comment, extra = {}) => ({ number: 5195, title: 'Repair', state: 'OPEN',
  headRefOid: head, headRefName: 'lane/repair', mergeStateStatus: 'DIRTY', mergeable: 'CONFLICTING',
  labels: [{ name: 'review:changes' }, { name: 'merge-status:conflicting' }],
  statusCheckRollup: [{ name: 'gate', status: 'completed', conclusion: 'success' }],
  comments: [{ body: '🔁 human review — changes requested\n\nRepair the conflict.' }, comment], ...extra });
const plan = (snapshot, extra = {}) => planReconcile({ prs: [snapshot], agents: [], requiredChecks: ['gate'], ...extra });
const dispatches = (snapshot) => {
  const result = plan(snapshot);
  expect(result.refusals).toEqual([]);
  expect(result.dispatch).toEqual([expect.objectContaining({ kind: 'fix', prNumber: 5195, isConflict: true })]);
};

describe('stand-downs belong to their head (#5195)', () => {
  it.each([{ head: old }, { detail: `Head: ${old}.` }, { detail: `Head: ${old.slice(0, 9)}.` }])('dispatches a new conflicting head after %j', options => {
    const snapshot = pr(held(options));
    dispatches(snapshot);
    expect(standDownRow('o/n', snapshot)).toBeNull();
    expect(standDownOf(snapshot)).toBeNull();
  });

  it.each([{ head }, { detail: `Head: ${head.slice(0, 9)}.` }])('keeps a stand-down on the current head terminal (%j)', options => {
    const snapshot = pr(held(options));
    expect(plan(snapshot).dispatch).toEqual([]);
    expect(plan(snapshot).refusals).toEqual([expect.objectContaining({ kind: 'stood-down' })]);
    expect(standDownRow('o/n', snapshot)).not.toBeNull();
    expect(standDownOf(snapshot)).not.toBeNull();
  });

  it('dispatches past a legacy unbound hold when the current head was committed later', () => {
    const snapshot = pr(held(), { commits: [{ oid: head, committedDate: '2026-10-15T13:00:00Z' }] });
    dispatches(snapshot);
    expect(standDownRow('o/n', snapshot)).toBeNull();
    expect(standDownOf(snapshot)).toBeNull();
  });

  it.each([at, '2026-10-12T13:00:00Z', 'invalid'])('retains an unbound hold without a proven later head (%s)', committedDate => {
    const snapshot = pr(held(), { updatedAt: '2026-10-15T14:00:00Z', commits: [{ oid: head, committedDate }] });
    expect(plan(snapshot).refusals).toContainEqual(expect.objectContaining({ kind: 'stood-down' }));
  });

  it('can preserve the hold across heads with the cascade override', () => {
    expect(plan(pr(held({ head: old })), { standDownHoldsAcrossHeads: { value: true, source: 'tool' } }).refusals)
      .toContainEqual(expect.objectContaining({ kind: 'stood-down' }));
  });

  it('reads legacy head-change evidence per PR, never treating a different commit as the current head', () => {
    const snapshot = pr(held());
    const exec = vi.fn(() => JSON.stringify({ commits: [{ oid: head, committedDate: '2026-10-15T13:00:00Z' }] }));
    dispatches(enrichStandDownHeadChange(snapshot, { repo: 'o/n', exec }));
    expect(exec.mock.calls[0][1]).toEqual(['pr', 'view', '5195', '--json', 'commits', '--repo', 'o/n']);
    const wrongCommit = enrichStandDownHeadChange(snapshot, { exec: () => JSON.stringify({ commits: [{ oid: old, committedDate: '2026-10-15T13:00:00Z' }] }) });
    expect(plan(wrongCommit).refusals).toContainEqual(expect.objectContaining({ kind: 'stood-down' }));
    const noRead = vi.fn();
    enrichStandDownHeadChange(pr(held({ head: old })), { exec: noRead });
    expect(noRead).not.toHaveBeenCalled();
  });

  it('resolves and logs the setting through standard, platform, tool and env layers', () => {
    const resolve = (env, platform, fix = {}) => resolveStandDownHoldsAcrossHeads({ env, platform,
      read: () => JSON.stringify({ fix }) });
    expect(resolve({}, {})).toEqual({ value: false, source: 'standard' });
    expect(resolve({}, { standDownHoldsAcrossHeads: true })).toEqual({ value: true, source: 'platform' });
    expect(resolve({}, { standDownHoldsAcrossHeads: true }, { standDownHoldsAcrossHeads: false })).toEqual({ value: false, source: 'tool' });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(resolve({ WE_FIX_STAND_DOWN_HOLDS_ACROSS_HEADS: 'true', WE_POLICY_CASCADE_LOG: '1' }, {}, { standDownHoldsAcrossHeads: false }))
        .toEqual({ value: true, source: 'env' });
      expect(log).toHaveBeenCalledWith(expect.stringContaining('standDownHoldsAcrossHeads=true (env)'));
    } finally { log.mockRestore(); }
  });
});
