/**
 * @file scripts/conveyor/health-smells/__tests__/draft-not-promoted.test.mjs
 * @description Draft-first PRs (operator-approved 2026-09-27) — the PURE `evaluate()` of the
 *   `draft-not-promoted` smell: a draft PR whose required checks read all-green for over 15 minutes with
 *   nothing having promoted it.
 */
import { describe, it, expect } from 'vitest';
import smell from '../draft-not-promoted.mjs';
import { MINUTE } from '../../health-watch-core.mjs';

const NOW = Date.parse('2026-09-27T18:00:00Z');

// CheckRun shape (`status`/`conclusion`) — the shape a real GitHub Actions check reads as through
// `reduceCheckState` (see `probePrs`'s own comment on why `status` rides alongside `state`).
const greenRollup = (completedAt) => [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt }];
const pendingRollup = [{ name: 'test', status: 'IN_PROGRESS', conclusion: null, completedAt: null }];
const redRollup = (completedAt) => [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', completedAt }];

describe('draft-not-promoted — evaluate', () => {
  it('breaches: a draft PR green for 20 minutes (past the 15-minute bound) with nothing promoting it', () => {
    const pr = {
      repo: 'web-everything/web-everything', number: 2813, title: 'draft-first PRs', isDraft: true,
      statusCheckRollup: greenRollup(new Date(NOW - 20 * MINUTE).toISOString()), updatedAt: new Date(NOW - 20 * MINUTE).toISOString(),
    };
    const out = smell.evaluate({ prs: [pr] }, { now: NOW });
    const r = out.find((x) => x.subject === 'web-everything/web-everything#2813');
    expect(r.breach).toBe(true);
    expect(r.measure.greenForMin).toBe(20);
    expect(r.summary).toMatch(/draft PR/);
    expect(r.recommendation).toMatch(/promote-draft-pr-dispatch/);
    expect(r.recommendation).toMatch(/gh pr ready 2813 --repo web-everything\/web-everything/);
  });

  it('does not breach yet: a draft PR green for only 5 minutes', () => {
    const pr = {
      repo: 'web-everything/web-everything', number: 2814, title: 'x', isDraft: true,
      statusCheckRollup: greenRollup(new Date(NOW - 5 * MINUTE).toISOString()),
    };
    const out = smell.evaluate({ prs: [pr] }, { now: NOW });
    expect(out.find((x) => x.subject === 'web-everything/web-everything#2814').breach).toBe(false);
  });

  it('a non-draft PR is never a candidate at all, however long it has been green', () => {
    const pr = {
      repo: 'web-everything/web-everything', number: 2815, title: 'x', isDraft: false,
      statusCheckRollup: greenRollup(new Date(NOW - 60 * MINUTE).toISOString()),
    };
    const out = smell.evaluate({ prs: [pr] }, { now: NOW });
    expect(out.find((x) => x.subject === 'web-everything/web-everything#2815')).toBeUndefined();
  });

  it('a draft PR whose checks are still pending is never a candidate — only a genuinely green draft can be stuck-unpromoted', () => {
    const pr = { repo: 'web-everything/web-everything', number: 2816, title: 'x', isDraft: true, statusCheckRollup: pendingRollup };
    const out = smell.evaluate({ prs: [pr] }, { now: NOW });
    expect(out.find((x) => x.subject === 'web-everything/web-everything#2816')).toBeUndefined();
  });

  it('a draft PR with a red required check is never a candidate — that is ci-heal\'s job, not promotion', () => {
    const pr = {
      repo: 'web-everything/web-everything', number: 2817, title: 'x', isDraft: true,
      statusCheckRollup: redRollup(new Date(NOW - 60 * MINUTE).toISOString()),
    };
    const out = smell.evaluate({ prs: [pr] }, { now: NOW });
    expect(out.find((x) => x.subject === 'web-everything/web-everything#2817')).toBeUndefined();
  });

  it('falls back to updatedAt when no check carries a readable completedAt, never fabricating a bound off missing data', () => {
    const pr = {
      repo: 'web-everything/web-everything', number: 2818, title: 'x', isDraft: true,
      statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: null }],
      updatedAt: new Date(NOW - 30 * MINUTE).toISOString(),
    };
    const out = smell.evaluate({ prs: [pr] }, { now: NOW });
    const r = out.find((x) => x.subject === 'web-everything/web-everything#2818');
    expect(r.breach).toBe(true);
    expect(r.measure.greenForMin).toBe(30);
  });
});
