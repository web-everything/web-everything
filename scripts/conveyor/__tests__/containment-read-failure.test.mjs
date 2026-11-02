import { it, expect } from 'vitest';
import { enrichPrsWithAlreadyLandedFacts, defaultFindMatchingMainCommit } from '../reconcile-pass.mjs';
import { planReconcile, REFUSAL_KINDS } from '../reconcile-core.mjs';

const head = 'a'.repeat(40);
const change = { status: 'A', path: 'a.txt', dstMode: '100644', dstBlob: 'b'.repeat(40) };
const reads = {
  fetchRef: () => {}, readMergeBase: () => 'c'.repeat(40), readChanges: () => [change],
  findMatchingCommit: () => null, readPulls: () => [],
};
const pr = (conflict, defaultBranch, labels = []) => ({
  number: 6193, state: 'OPEN', headRefOid: head, headRefName: 'lane/6193',
  baseRefName: defaultBranch, labels, comments: [], statusCheckRollup: [],
  mergeStateStatus: 'UNKNOWN', ...conflict,
});
const failures = [
  ['missing merge-base', { readMergeBase: () => null }],
  ['unreadable diff', { readChanges: () => [] }],
  ['throwing read', { readMergeBase: () => { throw new Error('unreadable'); } }],
  ['throwing diff', { readChanges: () => { throw new Error('unreadable'); } }],
  ['unreadable file history', { findMatchingCommit: (c, options) => defaultFindMatchingMainCommit(c, {
    ...options, readEntryAt: () => { throw new Error('unreadable'); },
  }) }],
];

it.each(failures)('refuses unlabelled conflicting-rebase after %s', (_name, failure) => {
  for (const defaultBranch of ['main', 'trunk']) {
    for (const conflict of [{ mergeable: 'CONFLICTING' }, { mergeStateStatus: 'DIRTY' }]) {
      const prs = enrichPrsWithAlreadyLandedFacts([pr(conflict, defaultBranch)], { ...reads, ...failure, defaultBranch });
      const plan = planReconcile({ prs, agents: [], defaultBranch });
      expect(plan.dispatch).toEqual([]);
      expect(plan.refusals).toMatchObject([{ kind: 'containment-unreadable' }]);
      expect(plan.refusals[0].why).toMatch(/retry|person/i);
    }
  }
  expect(REFUSAL_KINDS).toContain('containment-unreadable');
});

it.each(failures)('holds labelled never-bounced conflicting-rebase after %s', (_name, failure) => {
  for (const defaultBranch of ['main', 'trunk']) {
    for (const conflict of [{ mergeable: 'CONFLICTING' }, { mergeStateStatus: 'DIRTY' }]) {
      const original = pr(conflict, defaultBranch, [{ name: 'merge-status:conflicting' }]);
      const prs = enrichPrsWithAlreadyLandedFacts([original], { ...reads, ...failure, defaultBranch });
      expect(prs[0].containmentUnreadable).toBe(true);
      const plan = planReconcile({ prs, agents: [], defaultBranch });
      expect(plan.dispatch).toEqual([]);
      expect(plan.refusals).toMatchObject([{ kind: 'containment-unreadable' }]);
      expect(plan.refusals[0].why).toMatch(/retry|person/i);
    }
  }
});

const bounced = () => ({
  ...pr({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }, 'main',
    [{ name: 'review:changes' }, { name: 'merge-status:conflicting' }]),
  comments: [{ body: '🔁 human review — changes requested\n\nResolve the conflict.' }],
});

it('still dispatches a labelled BOUNCED PR with the unreadable containment flag', () => {
  const plan = planReconcile({ prs: [{ ...bounced(), containmentUnreadable: true }], agents: [] });
  expect(plan.refusals).toEqual([]);
  expect(plan.dispatch).toMatchObject([{ kind: 'fix', phase: 'bounced', isConflict: true }]);
  expect(plan.dispatch[0].mode).not.toBe('conflicting-rebase');
});

it.each(failures)('still dispatches a labelled BOUNCED PR after enrichment encounters %s', (_name, failure) => {
  const prs = enrichPrsWithAlreadyLandedFacts([bounced()], { ...reads, ...failure });
  expect(prs[0].containmentUnreadable).toBe(true);
  const plan = planReconcile({ prs, agents: [] });
  expect(plan.refusals).toEqual([]);
  expect(plan.dispatch).toMatchObject([{ kind: 'fix', phase: 'bounced', isConflict: true }]);
  expect(plan.dispatch[0].mode).not.toBe('conflicting-rebase');
});

it('still dispatches conflicting-rebase when readable content is not landed', () => {
  const prs = enrichPrsWithAlreadyLandedFacts([pr({ mergeable: 'CONFLICTING' }, 'main')], reads);
  expect(planReconcile({ prs, agents: [] }).dispatch).toMatchObject([{ mode: 'conflicting-rebase' }]);
});
