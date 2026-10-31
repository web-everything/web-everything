import { describe, it, expect, vi } from 'vitest';
import { ciHealOwed } from '../ci-heal-rule.mjs';
import { readRoundHistoryInputs } from '../fix-round-history.mjs';
import { defaultAttemptCardConflictRebase } from '../parked-pr-conflict-watch.mjs';

const head = 'a'.repeat(40);
describe('audit guard regressions', () => {
  it.each(['unknown', 'unchecked', 'pending', undefined])('labels cannot authorize healing with CI %s', ci => {
    expect(ciHealOwed({ ci, labels: ['status:ci-red', 'ci:failed'], phase: 'ci-red' })).toBe(false);
  });
  it('retains live comments after bounded mismatched-head reads', () => {
    const comments = [{ body: 'repeated finding evidence' }];
    const exec = vi.fn(() => JSON.stringify({ number: 1, headRefOid: 'b'.repeat(40), commits: [] }));
    expect(readRoundHistoryInputs({ pr: 1, repoSlug: 'o/r', headSha: head, exec,
      readComments: () => comments, snapshotOptions: { ttlMs: 0 } })?.comments).toEqual(comments);
    expect(exec.mock.calls.length).toBeGreaterThan(1);
    expect(exec.mock.calls.length).toBeLessThanOrEqual(3);
  });
  it('refuses card recovery when the fetched branch moved', () => {
    const run = vi.fn((_cmd, args) => ({ status: 0, stdout: args[0] === 'rev-parse' ? 'b'.repeat(40) : '' }));
    expect(defaultAttemptCardConflictRebase({ pr: { headRefName: 'lane/example', baseRefName: 'main', headRefOid: head }, run }))
      .toMatchObject({ reason: 'branch moved before recovery' });
    expect(run.mock.calls.some(([, args]) => args[0] === 'rebase')).toBe(false);
  });
});
