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

it('keeps label-carrying PRs unchanged on missing merge-base and unreadable diff', () => {
  const original = pr({ mergeable: 'CONFLICTING' }, 'main', [{ name: 'merge-status:conflicting' }]);
  for (const [, failure] of failures.slice(0, 2)) {
    expect(enrichPrsWithAlreadyLandedFacts([original], { ...reads, ...failure })[0]).toBe(original);
  }
});

it('still dispatches conflicting-rebase when readable content is not landed', () => {
  const prs = enrichPrsWithAlreadyLandedFacts([pr({ mergeable: 'CONFLICTING' }, 'main')], reads);
  expect(planReconcile({ prs, agents: [] }).dispatch).toMatchObject([{ mode: 'conflicting-rebase' }]);
});
