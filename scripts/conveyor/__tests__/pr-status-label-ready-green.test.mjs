// status:ready-to-merge needs every required check SUCCESS at the live head and a clear red team.
import { describe, it, expect } from 'vitest';
import { derivePrStatusLabel } from '../pr-status-label.mjs';

const HEAD = 'a'.repeat(40);
const REQUIRED = ['test', 'smoke'];
const ok = (name, extra = {}) => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS', ...extra });
const pending = (name) => ({ name, status: 'IN_PROGRESS', conclusion: null });
const pr = (labels, rollup, over = {}) => ({
  number: 7, headRefOid: HEAD, baseRefName: 'main', mergeStateStatus: 'CLEAN',
  labels: ['review:accepted', ...labels].map((name) => ({ name })), comments: [], statusCheckRollup: rollup, ...over,
});
const derive = (p, extra = {}) => derivePrStatusLabel({ pr: p, humanAt: 99, requiredChecks: REQUIRED, ...extra });

describe('ready-to-merge needs green checks and a clear red team', () => {
  it('ready-to-merge requires every required check SUCCESS at the live head', () => {
    expect(derive(pr([], [ok('test'), pending('smoke')]))).toBe('awaiting-ci');
    expect(derive(pr([], [ok('test')]))).toBe('awaiting-ci');
  });
  it('red-team not clear on head blocks ready-to-merge', () => {
    expect(derive(pr(['red-team:pending'], [ok('test'), ok('smoke')]))).toBe('red-team');
    expect(derive(pr(['red-team:blocked'], [ok('test'), ok('smoke')]))).toBe('sent-back-red-team');
  });
  it('an unknown required-check list is not ready', () => {
    expect(derive(pr([], [ok('test'), ok('smoke')]), { requiredChecks: null })).not.toBe('ready-to-merge');
  });
  it('checks from another head are not ready', () => {
    const other = 'b'.repeat(40);
    expect(derive(pr([], [ok('test', { headSha: other }), ok('smoke', { headSha: other })]))).not.toBe('ready-to-merge');
  });
  it('an older success never masks a newer pending rerun, and sparse lists fail closed', () => {
    expect(derive(pr([], [ok('test'), pending('test'), ok('smoke')]))).toBe('awaiting-ci');
    expect(derive(pr([], [ok('test')]), { requiredChecks: [, 'test'] })).not.toBe('ready-to-merge');
  });
  it('all green with a clear red team is still ready-to-merge', () => {
    expect(derive(pr(['red-team:clear'], [ok('test', { headSha: HEAD }), ok('smoke')]))).toBe('ready-to-merge');
  });
});
