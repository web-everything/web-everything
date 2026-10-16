/**
 * @file scripts/conveyor/__tests__/ci-heal-attempts.test.mjs
 * @description The ci-heal attempt budget, on the shape of live PR #4631 (2026-10-10 22:11 ET). The fixer pushed a
 *   real fix (`9ae95c851`, fix-end 22:06 ET); five minutes later the fix daemon posted "ci-heal attempts exhausted
 *   (3/3) … Last failure: merge-gate, merge-gate, review-gate, merge-gate, test-shard (1) …". Two gaps:
 *   1. the failure list named NON-required checks (`merge-gate` is red by design until #4715 lands). Only required
 *      checks are healed and counted; a non-required red is reported, never healed;
 *   2. the three heals were all spent BEFORE that fix push. A new non-mechanical head (a fixer's push) starts a new
 *      heal budget.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ciHealFloorFromComments } from '../tick-core.mjs';
import { planReconcile, resolveCiHealBudget, ciHealBudgetResetAt, CI_HEAL_ROUND_CAP } from '../reconcile-core.mjs';
import { buildCiHealComment } from '../ci-heal-mark.mjs';
import { buildFixBeginComment, buildFixEndComment } from '../fix-procedure.mjs';

const NOW = Date.parse('2026-10-11T02:11:00Z');
const BOT = { login: 'web-everything' };
const STRANGER = { login: 'someone-else' };
const REQUIRED = ['test', 'smoke', 'daemon-soak', 'soak-replay-gate'];
const HEAD = '9ae95c8515c514a99fc708683d8faeb33f8f916c';
const lbl = (...names) => names.map((name) => ({ name }));
const run = (name, conclusion, completedAt = '2026-10-11T01:50:00Z') => ({ name, status: 'COMPLETED', conclusion, completedAt });

/** #4631's live rollup on head 9ae95c851: `test` (required) is red via test-shard (1); merge-gate/review-gate are not required. */
const rollup4631 = () => [
  run('merge-gate', 'FAILURE', '2026-10-11T01:42:37Z'), run('merge-gate', 'FAILURE', '2026-10-11T02:02:34Z'),
  run('merge-gate', 'FAILURE', '2026-10-11T02:07:37Z'), run('merge-gate', 'FAILURE', '2026-10-11T02:16:47Z'),
  run('review-gate', 'FAILURE', '2026-10-11T01:42:30Z'),
  run('soak-replay-gate', 'SUCCESS'), run('smoke', 'SUCCESS'), run('daemon-soak', 'SUCCESS'),
  run('test-shard (1)', 'FAILURE'), run('test-shard (2)', 'SUCCESS'), run('integration', 'SUCCESS'),
  run('test', 'FAILURE', '2026-10-11T01:52:47Z'),
];

const heal = (createdAt, author = BOT) => ({ body: buildCiHealComment({ reason: 'red-ci' }), author, createdAt });
const begin = (who, sha, createdAt, author = BOT) => ({
  body: buildFixBeginComment({ who, why: 'conveyor fix: address review on PR #4631', branch: 'lane/accept-carry-forward', headSha: sha, ttlMinutes: 60 }),
  author, createdAt,
});
const end = (who, sha, createdAt, author = BOT) => ({ body: buildFixEndComment({ who, headSha: sha }), author, createdAt });

/** Three heals, the last at 2026-10-10 21:48Z — all before the fixer's 9ae95c851 push. */
const threeHeals = () => [
  heal('2026-10-09T16:42:49Z'), heal('2026-10-09T19:02:11Z'), heal('2026-10-10T21:48:28Z'),
];
const fixPushAfterHeals = () => [
  begin('fix-4631', 'e2dc4ed68', '2026-10-11T00:35:09Z'), end('fix-4631', '9ae95c851', '2026-10-11T02:06:48Z'),
];

const pr4631 = (comments, rollup = rollup4631()) => ({
  number: 4631, state: 'OPEN', headRefName: 'lane/accept-carry-forward', headRefOid: HEAD,
  labels: lbl('review:human', 'merge-status:conflicting', 'review-round:8'), mergeStateStatus: 'DIRTY',
  statusCheckRollup: rollup, comments,
});

const plan = (pr, extra = {}) => planReconcile({ prs: [pr], agents: [], now: NOW, requiredChecks: REQUIRED, ...extra });
const heals = (p) => p.dispatch.filter((d) => d.kind === 'ci-heal');
const exhausted = (p) => p.notes.filter((n) => n.kind === 'ci-heal-exhausted');

describe('ci-heal budget resets on a new non-mechanical head (#4631)', () => {
  it('BEFORE the fix push: 3 heals spent → exhausted, naming only the REQUIRED failure', () => {
    const p = plan(pr4631(threeHeals()));
    expect(heals(p)).toEqual([]);
    const [note] = exhausted(p);
    expect(note).toMatchObject({ prNumber: 4631, attempts: 3, cap: CI_HEAL_ROUND_CAP, lastFailureReason: 'test' });
    expect(note.text).toContain('Last failure: test (not required, reported only: merge-gate, review-gate, test-shard (1))');
    expect(note.text).not.toContain('merge-gate, merge-gate');
    // a non-required red is reported, never healed
    expect(note.nonRequiredRed).toEqual(['merge-gate', 'review-gate', 'test-shard (1)']);
  });

  it('AFTER the fixer pushed a real fix: the budget restarts and the real required failure gets a heal', () => {
    const p = plan(pr4631([...threeHeals(), ...fixPushAfterHeals()]));
    expect(exhausted(p)).toEqual([]);
    const [row] = heals(p);
    expect(row).toMatchObject({ prNumber: 4631, attempts: 0, failingRequiredChecks: ['test'] });
    expect(row.nonRequiredRed).toEqual(['merge-gate', 'review-gate', 'test-shard (1)']);
    expect(row.ciHealBudget).toMatchObject({
      cap: CI_HEAL_ROUND_CAP, capSource: 'standard', resetOnFixHead: true, resetSource: 'standard',
      resetAt: '2026-10-11T02:06:48Z', resetBy: 'fix-4631', spentBeforeReset: 3,
    });
  });

  it('heals spent AFTER the fix push still count against the new budget', () => {
    const comments = [...threeHeals(), ...fixPushAfterHeals(),
      heal('2026-10-11T03:00:00Z'), heal('2026-10-11T04:00:00Z'), heal('2026-10-11T05:00:00Z')];
    const p = plan(pr4631(comments));
    expect(heals(p)).toEqual([]);
    expect(exhausted(p)[0]).toMatchObject({ attempts: 3 });
  });

  it('a fix turn that did not move the head is not a new head', () => {
    const comments = [...threeHeals(), begin('fix-4631', 'e2dc4ed68', '2026-10-11T00:35:09Z'), end('fix-4631', 'e2dc4ed68', '2026-10-11T02:06:48Z')];
    expect(exhausted(plan(pr4631(comments)))[0]).toMatchObject({ attempts: 3 });
  });

  it("a ci-heal session's own push is mechanical — it never refunds the heal budget", () => {
    const comments = [...threeHeals(), begin('ci-heal-4631', 'e2dc4ed68', '2026-10-11T00:35:09Z'), end('ci-heal-4631', '9ae95c851', '2026-10-11T02:06:48Z')];
    expect(exhausted(plan(pr4631(comments)))[0]).toMatchObject({ attempts: 3 });
  });

  it('a fix-end from an untrusted author is not evidence of a new head', () => {
    const comments = [...threeHeals(), begin('fix-4631', 'e2dc4ed68', '2026-10-11T00:35:09Z', STRANGER), end('fix-4631', '9ae95c851', '2026-10-11T02:06:48Z', STRANGER)];
    expect(exhausted(plan(pr4631(comments)))[0]).toMatchObject({ attempts: 3 });
  });

  it('the reset is a setting: env WE_CI_HEAL_RESET_ON_FIX_HEAD=0 turns it off, and the source is logged', () => {
    const ciHealBudget = resolveCiHealBudget({ env: { WE_CI_HEAL_RESET_ON_FIX_HEAD: '0' } });
    expect(ciHealBudget).toMatchObject({ resetOnFixHead: false, resetSource: 'env', cap: CI_HEAL_ROUND_CAP, capSource: 'standard' });
    const p = plan(pr4631([...threeHeals(), ...fixPushAfterHeals()]), { ciHealBudget });
    expect(exhausted(p)[0]).toMatchObject({ attempts: 3, ciHealBudget: expect.objectContaining({ resetSource: 'env', resetAt: null }) });
  });
});

describe('ci-heal heals only REQUIRED checks', () => {
  it('a PR whose only red is non-required (merge-gate) is never healed and never "exhausted"', () => {
    const rollup = rollup4631().map((r) => (r.name === 'test' || r.name === 'test-shard (1)' ? { ...r, conclusion: 'SUCCESS' } : r));
    const p = plan(pr4631(threeHeals(), rollup));
    expect(heals(p)).toEqual([]);
    expect(exhausted(p)).toEqual([]);
  });

  it('ciHealBudgetResetAt reads the latest trusted fixer push', () => {
    expect(ciHealBudgetResetAt([...threeHeals(), ...fixPushAfterHeals()])).toEqual({ at: '2026-10-11T02:06:48Z', by: 'fix-4631', sha: '9ae95c851' });
    expect(ciHealBudgetResetAt(threeHeals())).toBeNull();
  });
});

// #5968 — a heal whose time cannot be established is never refunded by the fix-head reset.
describe('ci-heal budget reset fails closed on malformed times (#5968)', () => {
  const undated = (createdAt) => ({ ...heal('2026-10-09T00:00:00Z'), createdAt });
  const withFix = (...extra) => [...threeHeals(), ...extra, ...fixPushAfterHeals()];

  it('three dated heals + one undated before the reset: the undated one stays charged (1 of 3)', () => {
    for (const bad of [undefined, null, 'not-a-date', '']) {
      const p = plan(pr4631(withFix(undated(bad))));
      expect(exhausted(p)).toEqual([]);
      expect(heals(p)[0]).toMatchObject({ attempts: 1, ciHealBudget: expect.objectContaining({ spentBeforeReset: 3, resetBy: 'fix-4631' }) });
    }
  });
  it('three undated heals before the reset exhaust the budget despite a proven reset', () => {
    const p = plan(pr4631([undated(undefined), undated('x'), undated(null), ...fixPushAfterHeals()]));
    expect(heals(p)).toEqual([]);
    expect(exhausted(p)[0]).toMatchObject({ attempts: 3, cap: CI_HEAL_ROUND_CAP });
  });
  it('reset disabled: every heal is charged, malformed or not', () => {
    const ciHealBudget = resolveCiHealBudget({ env: { WE_CI_HEAL_RESET_ON_FIX_HEAD: '0' } });
    expect(exhausted(plan(pr4631(withFix(undated(undefined))), { ciHealBudget }))[0]).toMatchObject({ attempts: 4 });
  });
  it('a fix-end with no matching begin, an unchanged sha, or a ci-heal session is never a reset', () => {
    const noBegin = [...threeHeals(), end('fix-4631', '9ae95c851', '2026-10-11T02:06:48Z')];
    const unchanged = [...threeHeals(), begin('fix-4631', '9ae95c851', '2026-10-11T00:35:09Z'), end('fix-4631', '9ae95c851', '2026-10-11T02:06:48Z')];
    const ciHealSession = [...threeHeals(), begin('ci-heal-4631', 'e2dc4ed68', '2026-10-11T00:35:09Z'), end('ci-heal-4631', '9ae95c851', '2026-10-11T02:06:48Z')];
    for (const comments of [noBegin, unchanged, ciHealSession]) expect(exhausted(plan(pr4631(comments)))[0]).toMatchObject({ attempts: 3 });
  });
  it('alternating real fixer heads and heals: only the LATEST fixer push resets, so one heal is charged', () => {
    // The fix-round cap (reconcile-core.test.mjs) is what bounds the alternation; the heal budget just restarts.
    const rounds = [];
    for (let i = 0; i < 6; i += 1) {
      const t = (m) => `2026-10-11T0${i}:${m}:00Z`;
      rounds.push(begin(`fix-${i}`, `aaaaaaa${i}`, t('00')), end(`fix-${i}`, `bbbbbbb${i}`, t('10')), heal(t('20')));
    }
    const p = plan(pr4631(rounds));
    expect(exhausted(p)).toEqual([]);
    expect(heals(p)[0]).toMatchObject({ attempts: 1 });
  });
});

// Review finding (#5968, converge): production reconcile defaults its policy to the environment layer, and so do tick
// and landing. This pins the env layer only (the platform/repo layers are not passed to any of the three in production;
// landing's env default is pinned in land-advance-io.test.mjs).
describe('reconcile, tick and landing share the environment reset policy (#5968)', () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  const comments = () => [...threeHeals(), ...fixPushAfterHeals()];
  it('default (reset on): all three refund the three heals before the fixer push', () => {
    expect(heals(plan(pr4631(comments())))[0]).toMatchObject({ attempts: 0 });
    expect(ciHealFloorFromComments(comments())).toEqual({ count: 0, refunded: 3 });
  });
  it('WE_CI_HEAL_RESET_ON_FIX_HEAD=0: all three charge every heal', () => {
    vi.stubEnv('WE_CI_HEAL_RESET_ON_FIX_HEAD', '0');
    expect(exhausted(plan(pr4631(comments())))[0]).toMatchObject({ attempts: 3 });
    expect(ciHealFloorFromComments(comments())).toEqual({ count: 3, refunded: 0 });
  });
});

describe('resolveCiHealBudget cascade', () => {
  it('standard → platform → repo → env, each layer named', () => {
    expect(resolveCiHealBudget()).toEqual({ cap: CI_HEAL_ROUND_CAP, capSource: 'standard', resetOnFixHead: true, resetSource: 'standard' });
    expect(resolveCiHealBudget({ platform: { ciHeal: { attemptCap: 4 } } })).toMatchObject({ cap: 4, capSource: 'platform' });
    expect(resolveCiHealBudget({ platform: { ciHeal: { attemptCap: 4 } }, repo: { attemptCap: 5, resetOnFixHead: false } }))
      .toMatchObject({ cap: 5, capSource: 'repo', resetOnFixHead: false, resetSource: 'repo' });
    expect(resolveCiHealBudget({ repo: { attemptCap: 5 }, env: { WE_CI_HEAL_ATTEMPT_CAP: '2' } })).toMatchObject({ cap: 2, capSource: 'env' });
    expect(resolveCiHealBudget({ repo: { attemptCap: 'lots' } })).toMatchObject({ cap: CI_HEAL_ROUND_CAP, capSource: 'standard' });
  });
});
