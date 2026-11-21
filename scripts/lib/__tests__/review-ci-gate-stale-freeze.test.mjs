import { describe, it, expect, vi } from 'vitest';
import { readReviewCiGate } from '../review-ci-gate-io.mjs';
import { GATE_IDS } from '../merge-gate-inventory.mjs';

// The live review caller must reach the stale-freeze branch: a merge-gate red whose only blocking row is an
// automatic red-main-freeze, with main CI green after the verdict, is not a CI failure that refuses review.
const sha = 'b'.repeat(40);
const repo = 'owner/repo';
const failedGate = { name: 'merge-gate', status: 'completed', conclusion: 'failure', head_sha: sha,
  details_url: 'https://github.com/owner/repo/actions/runs/100/job/123' };
const verdict = { num: 7266, head_sha: sha, ok: false, completed_at: '2026-11-18T10:00:00Z', run_id: 100, run_attempt: 1,
  evaluatorOnlyFailure: true,
  results: GATE_IDS.map(id => id === 'red-main-freeze'
    ? { id, status: 'hold', reason: `main is RED (freeze: main CI red since ${sha})` } : { id, status: 'pass', reason: 'ok' }) };
const green = { status: 'completed', conclusion: 'success', completed_at: '2026-11-18T11:00:00Z' };
const gate = (extra = {}) => readReviewCiGate({ repo, pr: 7266,
  readHead: () => sha, readLabels: () => [{ name: 'review:pending' }], readChecks: () => [failedGate],
  readRequired: () => ({ source: 'live', checks: ['merge-gate'] }), readMergeGateVerdict: () => verdict,
  readFreeze: () => ({ frozen: false }), mergeGateSetting: 'on', ...extra });

describe('readReviewCiGate stale automatic main freeze', () => {
  const merge = out => out.checks.find(c => c.name === 'merge-gate');
  it('reaches the stale-freeze branch through the live caller path (annotation rides the returned checks)', () => {
    const readMainCi = vi.fn(() => green);
    const out = gate({ readMainCi });
    expect(readMainCi).toHaveBeenCalledWith({ repo });
    expect(merge(out)).toMatchObject({ conclusion: 'failure', mergeGateReviewHold: { holds: ['red-main-freeze'] },
      mergeGateStaleFreeze: { run: 100, head: sha } });
  });
  it('never annotates when main CI is red or unreadable', () => {
    for (const main of [{ ...green, conclusion: 'failure' }, { error: 'offline' }]) {
      const row = merge(gate({ readMainCi: () => main }));
      expect(row.mergeGateStaleFreeze).toBeUndefined();
      expect(row.mergeGateReviewHold).toBeUndefined();
    }
  });
});
