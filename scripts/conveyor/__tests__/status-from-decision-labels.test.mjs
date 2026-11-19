/**
 * @file scripts/conveyor/__tests__/status-from-decision-labels.test.mjs
 * @description The status tagger lifts an accepted, red-team-clear PR to `status:ready-to-merge` + `ready-to-merge`
 *   from its CURRENT decision labels on the live head, replacing any stale `status:*`; it fails closed otherwise.
 *   Label sets are the live ones from #7103 and #7028.
 */
import { describe, it, expect } from 'vitest';
import { tagReviewStatus } from '../review-status-tag.mjs';
import { readyFromDecisionLabels } from '../pr-status-label.mjs';

const HEAD = 'c1f2b695540f266880d13a2113475c2d4cd92012';
const OLD = 'a'.repeat(40);
const bot = { login: 'web-everything' };
const advisory = (head) => ({ author: bot, createdAt: '2026-11-18T20:00:00Z',
  body: `**Verdict:** accept\n**Advisory outcome:** accept\nNet basis: \`${OLD.slice(0, 12)}..${head}\`` });
const gate = (head) => ({ author: bot, createdAt: '2026-11-18T20:01:00Z', body: `<!-- we:red-team-gate pr=1 rev=${head} outcome=clear -->` });
const checks = [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }, { name: 'review-gate', status: 'COMPLETED', conclusion: 'FAILURE' }];
const snapshot = (extra = {}) => ({ number: 1, headRefOid: HEAD, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
  statusCheckRollup: checks, comments: [advisory(HEAD), gate(HEAD)], ...extra });

const LIVE = {
  7103: ['review:accepted', 'review-round:1', 'status:sent-back-review', 'red-team:clear'],
  7028: ['review:accepted', 'review-round:7', 'status:at-round-limit', 'red-team:clear', 'size:over-cap'],
};

function run(labels, prState) {
  const writes = [];
  const provider = { readLabels: () => labels, ensureLabel() {}, setLabels: (_r, _p, d) => writes.push(d) };
  const result = tagReviewStatus({ pr: 1, repo: 'web-everything/web-everything', provider, agents: [], prState,
    signalFix: () => {}, readRequiredChecks: () => ({ source: 'live', checks: ['build', 'review-gate', 'merge-gate'] }),
    loadStatusSettings: () => { throw new Error('unavailable'); } });
  return { writes, result };
}

describe('status from decision labels', () => {
  for (const [pr, labels] of Object.entries(LIVE)) {
    it(`#${pr}: standalone tagger replaces the stale status and adds ready-to-merge`, () => {
      const { writes } = run(labels, snapshot());
      const removed = writes.flatMap((w) => w.remove ?? []);
      const added = writes.map((w) => w.add).filter(Boolean);
      expect(added).toEqual(['status:ready-to-merge', 'ready-to-merge']);
      expect(removed).toEqual(labels.filter((l) => /^status:(sent-back-review|at-round-limit)$/.test(l)));
    });

    it(`#${pr}: daemon path with planner rows reaches the same labels`, () => {
      const writes = [];
      const provider = { readLabels: () => labels, ensureLabel() {}, setLabels: (_r, _p, d) => writes.push(d) };
      tagReviewStatus({ pr: 1, repo: 'web-everything/web-everything', provider, agents: [], prState: snapshot(),
        planRows: [{ kind: 'cap-exhausted', prNumber: 1 }], signalFix: () => {},
        readRequiredChecks: () => ({ source: 'live', checks: ['build'] }), loadStatusSettings: () => { throw new Error('x'); } });
      expect(writes.map((w) => w.add).filter(Boolean)).toContain('ready-to-merge');
    });
  }

  it('fails closed when the head moved since the accept', () => {
    const { writes } = run(LIVE[7103], snapshot({ headRefOid: 'd'.repeat(40) }));
    expect(writes).toEqual([]);
  });

  it('fails closed when red-team evidence for the head is missing', () => {
    expect(readyFromDecisionLabels({ pr: snapshot({ comments: [advisory(HEAD), gate(OLD)] }), labels: LIVE[7103] }).reason)
      .toBe('no-head-red-team-evidence');
  });

  it('fails closed on conflicting labels, review:human, or a red required check', () => {
    for (const extra of ['review:changes', 'red-team:blocked', 'review:human']) {
      expect(readyFromDecisionLabels({ pr: snapshot(), labels: [...LIVE[7103], extra] }).ready).toBe(false);
    }
    const red = snapshot({ statusCheckRollup: [{ name: 'build', status: 'COMPLETED', conclusion: 'FAILURE' }] });
    expect(readyFromDecisionLabels({ pr: red, labels: LIVE[7103], requiredChecks: ['build'] }).reason).toBe('required-check-red');
  });

  it('ignores a failing review-gate and merge-gate', () => {
    const gates = snapshot({ statusCheckRollup: [{ name: 'merge-gate', status: 'COMPLETED', conclusion: 'FAILURE' }, ...checks] });
    expect(readyFromDecisionLabels({ pr: gates, labels: LIVE[7028], requiredChecks: ['build', 'merge-gate', 'review-gate'] }).ready).toBe(true);
  });
});
