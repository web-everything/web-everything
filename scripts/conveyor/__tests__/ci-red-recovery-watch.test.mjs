/**
 * @file scripts/conveyor/__tests__/ci-red-recovery-watch.test.mjs
 * @description we:backlog/x5uqim1-*.md (#4075/#3383) — the IO shell over `main-red-recovery.mjs`'s pure planner.
 *   Fixtures are the REAL shapes measured 2026-09-25 off `web-everything/web-everything`: PR #2635 (33 commits behind
 *   main, never refreshed, inside main's real red window) is the one this pass should actually refresh; PR
 *   #2596 (`ahead_by: 0` from the operator's own manual branch refresh, still red) is the one it must report
 *   ALREADY HANDLED. CORRECTED mid-build from an earlier `gh run rerun` design — see `main-red-recovery.mjs`'s
 *   own file header for why a rebase onto `main`, not a rerun of the same stale commit, is the real mechanism.
 */
import { describe, it, expect, vi } from 'vitest';
import { homedir } from 'node:os';
import { REPO_ROOT } from '../../operations/dispatch-lane-io.mjs';
import {
  buildCandidates, sweepCiRedRecovery, refreshOntoMain, formatReport, defaultPostRebaseComment,
  HUNG_CI_COMMENT_MARKER, buildHungCiComment, countHungCiComments, countHungCiCommentsByJob, bodyHasExactLine,
  cancelAndRerunHungRun, cancelHungRun, defaultReadRunAttempt, describeExecError, isRunNotFoundError, redactTokenShapes, sweepHungCiRecovery, formatHungReport,
  defaultReadRequiredContexts, defaultReadAttributedRequiredChecks, defaultReadHeadCommittedAt, triggerCiForPr, clearStaleCheckingLabel,
  sweepMissingRunRecovery as sweepMissingRunRecoveryWithIo, formatMissingRunReport, reconcileAcceptanceAfterRebase, defaultReadPrLabels, detectMainTransition, recordMainState,
  resolveApplyBudgetMs, resolveMaxApplyPerTick, createFileApplyLedger, normalizeApplyLedger, main,
  mergeApplyLedgers, pruneApplyLedger, APPLY_LEDGER_TTL_MS, APPLY_LEDGER_MAX_ENTRIES, APPLY_LEDGER_SEQ_REBASE,
} from '../ci-red-recovery-watch.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { restampAcceptance } from '../../merge-ai-prs.mjs';
import { spawnCiHealRearm } from '../ci-heal-mark.mjs';
import { REVIEW_LABELS } from '../../lib/review-escalation.mjs';

const sweepMissingRunRecovery = (options) => sweepMissingRunRecoveryWithIo({
  readAttributedRequiredChecks: () => null,
  ...options,
});

const failingCheck = (completedAt) => ({ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', completedAt });
const greenCheck = { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '2026-09-25T01:00:00Z' };

const PR_2635 = { number: 2635, headRefName: 'lane/xdzl6mb', headRefOid: 'ab9985630d90019a07b94e946bc75f8de7a6161f', statusCheckRollup: [failingCheck('2026-09-25T01:57:47Z')] };
const PR_2596 = { number: 2596, headRefName: 'lane/batch-...-3901', headRefOid: 'b5275541aebe374f5d9e96af3943bb4c282227aa', statusCheckRollup: [failingCheck('2026-09-25T02:02:29Z')] };
const PR_2636 = { number: 2636, headRefName: 'lane/batch-...-3915', headRefOid: 'deadbeef', statusCheckRollup: [failingCheck('2026-09-25T08:03:45Z')] };
const PR_QUIET = { number: 1, headRefName: 'lane/quiet', headRefOid: 'cafe', statusCheckRollup: [greenCheck] };

const MAIN_RUNS = [
  { status: 'completed', conclusion: 'failure', updatedAt: '2026-09-25T01:30:55Z', workflowName: 'CI' },
  { status: 'completed', conclusion: 'success', updatedAt: '2026-09-25T02:31:25Z', workflowName: 'CI' },
];

describe('ci-red-recovery-watch — production apply bounds', () => {
  it('defaults the apply budget to 170000 ms when the environment setting is absent', () => {
    expect(resolveApplyBudgetMs({})).toBe(170000);
  });

  it.each(['', ' ', '0', '-1', 'NaN', 'Infinity', '-Infinity', 'invalid'])(
    'rejects invalid apply budget environment value %j with the 170000 ms fallback', (value) => {
      expect(resolveApplyBudgetMs({ WE_RECOVERY_APPLY_BUDGET_MS: value })).toBe(170000);
    },
  );

  it('accepts a positive finite apply budget environment override', () => {
    expect(resolveApplyBudgetMs({ WE_RECOVERY_APPLY_BUDGET_MS: '2500' })).toBe(2500);
  });

  it('defaults the per-tick apply cap to 8 when the environment setting is absent', () => {
    expect(resolveMaxApplyPerTick({})).toBe(8);
  });

  it.each(['', ' ', '0', '-1', '1.5', 'NaN', 'Infinity', '-Infinity', 'invalid'])(
    'rejects invalid per-tick apply cap environment value %j with the 8 PR fallback', (value) => {
      expect(resolveMaxApplyPerTick({ WE_RECOVERY_MAX_APPLY_PER_TICK: value })).toBe(8);
    },
  );

  it('accepts a positive integer per-tick apply cap environment override', () => {
    expect(resolveMaxApplyPerTick({ WE_RECOVERY_MAX_APPLY_PER_TICK: '3' })).toBe(3);
  });
});

describe('ci-red-recovery-watch — buildCandidates', () => {
  it('only builds a candidate for a PR whose required check is currently failing, resolving how far behind main it is', () => {
    const readAheadBy = vi.fn(() => 33);
    const candidates = buildCandidates([PR_QUIET, PR_2635], { readAheadBy });
    expect(candidates).toEqual([
      {
        prNumber: 2635, headRefName: 'lane/xdzl6mb', headSha: 'ab9985630d90019a07b94e946bc75f8de7a6161f',
        aheadBy: 33, failureCompletedAt: '2026-09-25T01:57:47Z', failingCheckName: 'test', detailsUrl: null, needsHuman: false,
      },
    ]);
    expect(readAheadBy).toHaveBeenCalledTimes(1);
    expect(readAheadBy).toHaveBeenCalledWith('ab9985630d90019a07b94e946bc75f8de7a6161f', { repo: null, base: 'main' });
  });

  it('never calls readAheadBy for a PR with nothing failing', () => {
    const readAheadBy = vi.fn();
    buildCandidates([PR_QUIET], { readAheadBy });
    expect(readAheadBy).not.toHaveBeenCalled();
  });
});

describe('ci-red-recovery-watch — a daemon-soak-only red PR (soak-main-red)', () => {
  const soakRed = {
    number: 2783, headRefName: 'lane/x', headRefOid: 'cec3090b', statusCheckRollup: [
      { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '2026-09-25T01:20:00Z' },
      { __typename: 'CheckRun', name: 'daemon-soak', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: '2026-09-25T01:57:47Z' },
    ],
  };
  it('is a candidate, judged on its daemon-soak failure, and is refreshed onto main once main recovers', () => {
    const result = sweepCiRedRecovery({
      readOpenPrs: () => [soakRed], readMainRuns: () => MAIN_RUNS, readAheadBy: () => 5, readComments: () => [],
      readRequiredContexts: () => ['test', 'smoke', 'daemon-soak'], refresh: vi.fn(),
    });
    expect(result.dispatch).toEqual([expect.objectContaining({ prNumber: 2783, kind: 'rebase-onto-main', aheadBy: 5 })]);
  });
  it('uses the live required-context list: a check branch protection does not require is ignored', () => {
    const readRequiredContexts = vi.fn(() => ['test']);
    const result = sweepCiRedRecovery({
      readOpenPrs: () => [soakRed], readMainRuns: () => MAIN_RUNS, readAheadBy: () => 5, readComments: () => [],
      readRequiredContexts, refresh: vi.fn(),
    });
    expect(readRequiredContexts).toHaveBeenCalledTimes(1);
    expect(result.dispatch).toEqual([]);
  });
});

describe('ci-red-recovery-watch — ruleset-only merge-gate failure (#5079/#5055)', () => {
  it('plans rebase-onto-main after main recovers when merge-gate is the only failing required check', () => {
    const pr = {
      number: 5079, headRefName: 'lane/merge-gate-recovery', headRefOid: 'stale-head',
      statusCheckRollup: [
        { ...greenCheck, completedAt: '2026-09-25T01:57:47Z' },
        { ...failingCheck('2026-09-25T01:57:47Z'), name: 'merge-gate' },
      ],
    };
    const readAttributedRequiredChecks = vi.fn(() => ['test', 'smoke', 'daemon-soak', 'soak-replay-gate', 'merge-gate']);
    const refresh = vi.fn();
    const result = sweepCiRedRecovery({
      repo: 'web-everything/web-everything', readOpenPrs: () => [pr], readMainRuns: () => MAIN_RUNS,
      readAheadBy: () => 5, readComments: () => [], readAttributedRequiredChecks,
      readMainLatestCheckRuns: () => [{
        name: 'merge-gate', status: 'completed', conclusion: 'success',
        completed_at: '2026-09-25T02:31:25Z', head_sha: 'green-main',
      }],
      refresh,
    });
    expect(readAttributedRequiredChecks).toHaveBeenCalledWith({ repo: 'web-everything/web-everything', branch: 'main' });
    expect(result.dispatch).toEqual([expect.objectContaining({
      prNumber: 5079, kind: 'rebase-onto-main', aheadBy: 5, failingCheckName: 'merge-gate',
    })]);
    expect(refresh).not.toHaveBeenCalled();
  });
});

// landing-freeze fix (2026-09-27) — LIVE INCIDENT: PR #2790 fixed a `daemon-soak` regression that had sat on
// `main` unseen because the job never ran on a PUSH to `main` at all before it — so `main`'s own run history
// shows straight `success` right through the whole regression window, no red window EVER opens, and the
// `soak-main-red` fix above (judged purely against `mainRedWindows`) stays permanently blind to it. This is
// the ACTING pass that must dispatch the mechanical rebase anyway, once `main`'s own LATEST run proves the
// exact same check now passes. See `main-red-recovery.mjs`'s own "LANDING-FREEZE FIX" section header.
describe('ci-red-recovery-watch — a daemon-soak-only red PR with NO red window at all (landing-freeze fix)', () => {
  const stuckPr = {
    number: 2748, headRefName: 'lane/xg790dh-ci-lifecycle-drain-bookkeeping-commits', headRefOid: 'dfb57d0', statusCheckRollup: [
      { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '2026-09-27T02:32:41Z' },
      { __typename: 'CheckRun', name: 'daemon-soak', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: '2026-09-27T02:36:03Z' },
    ],
  };
  const mainLatestCheckRuns = [{ name: 'daemon-soak', conclusion: 'success', status: 'completed', completed_at: '2026-09-27T03:56:55Z', head_sha: 'green-sha' }];
  // #2748's merge base never ran daemon-soak on `main` (pull_request-only job) and lacks main's green commit.
  const noSoakAtBase = () => ({ prContainsMainGreenSha: false, mergeBaseCheckRuns: [], mergeBaseRunConclusion: 'success' });

  it('dispatches rebase-onto-main even with an EMPTY mainRedWindows history, once main\'s own latest run shows daemon-soak green', () => {
    const readMainGreenFixFacts = vi.fn(noSoakAtBase);
    const result = sweepCiRedRecovery({
      readOpenPrs: () => [stuckPr], readMainRuns: () => [], readAheadBy: () => 5, readComments: () => [],
      readRequiredContexts: () => ['test', 'smoke', 'daemon-soak'], readMainLatestCheckRuns: () => mainLatestCheckRuns,
      readMainGreenFixFacts, refresh: vi.fn(),
    });
    expect(result.dispatch).toEqual([expect.objectContaining({ prNumber: 2748, kind: 'rebase-onto-main', aheadBy: 5 })]);
    expect(readMainGreenFixFacts).toHaveBeenCalledWith('dfb57d0', expect.objectContaining({ greenSha: 'green-sha', checkName: 'daemon-soak' }));
  });

  // PR #2793 review — the acting pass must not rebase a plain PR-owned failure behind a healthy main.
  it('refuses own-failure (no rebase; comments ARE read so a recorded main-defect escalation could be seen, xh3ghy1) when daemon-soak was already green at the PR\'s merge base', () => {
    const readComments = vi.fn(() => []);
    const result = sweepCiRedRecovery({
      readOpenPrs: () => [stuckPr], readMainRuns: () => [], readAheadBy: () => 5, readComments,
      readRequiredContexts: () => ['test', 'smoke', 'daemon-soak'], readMainLatestCheckRuns: () => mainLatestCheckRuns,
      readMainGreenFixFacts: () => ({
        prContainsMainGreenSha: false,
        mergeBaseCheckRuns: [{ name: 'daemon-soak', conclusion: 'success', status: 'completed', completed_at: '2026-09-26T00:00:00Z' }],
      }),
      refresh: vi.fn(),
    });
    expect(result.refusals).toEqual([expect.objectContaining({ prNumber: 2748, kind: 'own-failure' })]);
    expect(result.dispatch).toEqual([]);
    expect(readComments).toHaveBeenCalled();
  });

  it('reads main\'s run list ONCE and hands it to readMainLatestCheckRuns (no second gh run list)', () => {
    const readMainRuns = vi.fn(() => []);
    const readMainLatestCheckRuns = vi.fn(() => mainLatestCheckRuns);
    sweepCiRedRecovery({
      readOpenPrs: () => [stuckPr], readMainRuns, readAheadBy: () => 5, readComments: () => [],
      readRequiredContexts: () => ['test', 'smoke', 'daemon-soak'], readMainLatestCheckRuns,
      readMainGreenFixFacts: noSoakAtBase, refresh: vi.fn(),
    });
    expect(readMainRuns).toHaveBeenCalledTimes(1);
    expect(readMainLatestCheckRuns).toHaveBeenCalledWith(expect.objectContaining({ mainRuns: [] }));
  });

  it('still refuses own-failure when main\'s own latest run never reported daemon-soak at all — never a guess', () => {
    const result = sweepCiRedRecovery({
      readOpenPrs: () => [stuckPr], readMainRuns: () => [], readAheadBy: () => 5, readComments: () => [],
      readRequiredContexts: () => ['test', 'smoke', 'daemon-soak'], readMainLatestCheckRuns: () => [],
      refresh: vi.fn(),
    });
    expect(result.refusals).toEqual([expect.objectContaining({ prNumber: 2748, kind: 'own-failure' })]);
    expect(result.dispatch).toEqual([]);
  });

  it('never reads mainLatestCheckRuns at all when nothing is currently failing — the zero-cost path', () => {
    const readMainLatestCheckRuns = vi.fn();
    const result = sweepCiRedRecovery({ readOpenPrs: () => [PR_QUIET], readMainRuns: vi.fn(), readMainLatestCheckRuns });
    expect(readMainLatestCheckRuns).not.toHaveBeenCalled();
    expect(result.dispatch).toEqual([]);
  });
});

describe('ci-red-recovery-watch — sweepCiRedRecovery (dry run, apply: false by default)', () => {
  it('plans a real rebase-onto-main for PR #2635 (never yet refreshed, inside the real red window) and never touches git without --apply', () => {
    const readOpenPrs = () => [PR_2635, PR_QUIET];
    const readMainRuns = vi.fn(() => MAIN_RUNS);
    const readAheadBy = () => 33;
    const readComments = () => [];
    const refresh = vi.fn();
    const result = sweepCiRedRecovery({ readOpenPrs, readMainRuns, readAheadBy, readComments, refresh });
    expect(result.dispatch).toEqual([expect.objectContaining({ prNumber: 2635, kind: 'rebase-onto-main', aheadBy: 33 })]);
    expect(result.applied).toEqual([]);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('applies exactly one refresh per dispatched candidate when apply: true, and posts the durable rebase marker', () => {
    const readOpenPrs = () => [PR_2635];
    const readMainRuns = () => MAIN_RUNS;
    const readAheadBy = () => 33;
    const readComments = vi.fn(() => []); // no prior rebase-onto-main attempts on this sha — under cap
    const refresh = vi.fn(() => ({ ok: true, action: 'rebased' }));
    const postComment = vi.fn();
    const result = sweepCiRedRecovery({
      readOpenPrs, readMainRuns, readAheadBy, readComments, refresh, postComment, apply: true,
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    // `root` defaults to WE's own checkout (no `repo` given) — see this pass's own multi-repo docblock.
    expect(refresh).toHaveBeenCalledWith('lane/xdzl6mb', expect.objectContaining({ base: 'origin/main' }));
    // #2811 — `acceptance` is always present (the restamp-or-rearm outcome), but this fake `refresh` returns no
    // `newCommit`, so nothing was attempted (there is no authoritative new head to reconcile against yet).
    expect(result.applied).toEqual([{
      prNumber: 2635, headRefName: 'lane/xdzl6mb', ok: true, action: 'rebased',
      acceptance: { attempted: false, restamped: false, rearmed: false },
    }]);
    expect(postComment).toHaveBeenCalledWith(2635, expect.objectContaining({
      headRefName: 'lane/xdzl6mb', ok: true, action: 'rebased',
    }));
  });

  // 2026-11-03 live: after main went green the first apply tick refreshed PRs one by one until the 300 s pass
  // deadline SIGTERMed it mid-batch. The apply loop must stop STARTING refreshes once its time budget is spent
  // (or the per-tick batch cap is hit) and leave the rest for the next tick, without posting a rebase comment
  // (a comment burns the per-sha cap) for the ones it deferred.
  it('stops starting refreshes once the tick time budget is spent, deferring the rest without burning their cap', () => {
    const prs = [2635, 2636, 2637].map((number) => ({ ...PR_2635, number, headRefName: `lane/b${number}` }));
    let t = 0;
    const refresh = vi.fn(() => { t += 100; return { ok: true, action: 'rebased' }; });
    const postComment = vi.fn();
    const result = sweepCiRedRecovery({
      readOpenPrs: () => prs, readMainRuns: () => MAIN_RUNS, readAheadBy: () => 33, readComments: () => [],
      refresh, postComment, apply: true, now: () => t, applyBudgetMs: 150, maxApplyPerTick: 10,
    });
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(postComment).toHaveBeenCalledTimes(2);
    expect(result.applied.map((a) => [a.prNumber, a.action])).toEqual([[2635, 'rebased'], [2636, 'rebased'], [2637, 'deferred']]);
    expect(result.applied[2]).toMatchObject({ deferred: true, ok: false, budgetExhausted: true });
  });

  // Review of #6340: with a slow discovery phase (per-PR comment reads) the budget was already spent before the
  // loop began, so every tick deferred everything and the queue never drained. The first refresh always starts.
  it('still starts exactly one refresh when discovery alone exhausted the tick apply budget (no starvation)', () => {
    const prs = [2635, 2636, 2637].map((number) => ({ ...PR_2635, number, headRefName: `lane/d${number}` }));
    let t = 0;
    const refresh = vi.fn(() => ({ ok: true, action: 'rebased' }));
    const postComment = vi.fn();
    const result = sweepCiRedRecovery({
      readOpenPrs: () => { t += 200; return prs; },
      readMainRuns: () => MAIN_RUNS, readAheadBy: () => 33, readComments: () => [],
      refresh, postComment, apply: true, now: () => t, applyBudgetMs: 150, maxApplyPerTick: 10,
    });
    expect(result.dispatch.map((d) => d.prNumber)).toEqual([2635, 2636, 2637]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(postComment).toHaveBeenCalledTimes(1);
    expect(result.applied.map((a) => [a.prNumber, a.action])).toEqual([[2635, 'rebased'], [2636, 'deferred'], [2637, 'deferred']]);
    expect(result.applied[1]).toMatchObject({ deferred: true, ok: false, budgetExhausted: true });
  });

  // Review round 2 of #6340: `started` was bumped before the refresh ran, so a refresh that came back deferred
  // (no work done) still spent the floor and the cap, and every later PR in the tick was starved.
  it.each([
    ['refresh reports deferred', () => ({ deferred: true, ok: false, error: 'cross-repository PR' })],
  ])('a free deferral (%s) first in line spends neither the progress floor nor the per-tick cap', (_name, firstResult) => {
    const prs = [2635, 2636].map((number) => ({ ...PR_2635, number, headRefName: `lane/g${number}` }));
    let t = 0;
    const refresh = vi.fn((branch) => (branch === 'lane/g2635' ? firstResult() : { ok: true, action: 'rebased' }));
    const postComment = vi.fn();
    const result = sweepCiRedRecovery({
      readOpenPrs: () => { t += 200; return prs; }, readMainRuns: () => MAIN_RUNS, readAheadBy: () => 33, readComments: () => [],
      refresh, postComment, apply: true, now: () => t, applyBudgetMs: 150, maxApplyPerTick: 1,
    });
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(postComment).toHaveBeenCalledTimes(1);
    expect(result.applied.map((a) => [a.prNumber, a.action])).toEqual([[2635, 'deferred'], [2636, 'rebased']]);
  });

  // Review round 3 of #6340: deferrals do no writes but their verification calls cost real time. 12 PRs whose
  // refresh each takes 35 s then defers must stop at the 170 s budget, not run until the 300 s pass deadline.
  it('slow deferred refreshes still honour the time budget (no run past the pass deadline)', () => {
    const prs = Array.from({ length: 12 }, (_, i) => ({ ...PR_2635, number: 2700 + i, headRefName: `lane/s${i}` }));
    let t = 0;
    const refresh = vi.fn(() => { t += 35_000; return { deferred: true, ok: false, error: 'verification failed' }; });
    const postComment = vi.fn();
    const result = sweepCiRedRecovery({
      readOpenPrs: () => prs, readMainRuns: () => MAIN_RUNS, readAheadBy: () => 33, readComments: () => [],
      refresh, postComment, apply: true, now: () => t, applyBudgetMs: 170_000, maxApplyPerTick: 8,
    });
    expect(refresh).toHaveBeenCalledTimes(5);
    expect(t).toBeLessThanOrEqual(175_000);
    expect(postComment).not.toHaveBeenCalled();
    expect(result.applied).toHaveLength(12);
    expect(result.applied.slice(5).every((a) => a.budgetExhausted && a.deferred)).toBe(true);
  });

  it('slow discovery plus slow deferrals only gets a bounded grace to find one refresh that does work', () => {
    const prs = Array.from({ length: 6 }, (_, i) => ({ ...PR_2635, number: 2750 + i, headRefName: `lane/q${i}` }));
    let t = 0;
    const refresh = vi.fn(() => { t += 35_000; return { deferred: true, ok: false, error: 'verification failed' }; });
    sweepCiRedRecovery({
      readOpenPrs: () => { t += 200_000; return prs; }, readMainRuns: () => MAIN_RUNS, readAheadBy: () => 33, readComments: () => [],
      refresh, postComment: vi.fn(), apply: true, now: () => t, applyBudgetMs: 170_000, maxApplyPerTick: 8,
    });
    expect(refresh).toHaveBeenCalledTimes(2); // 60 s grace: attempts at +0 s and +35 s, stopped at +70 s
  });

  // Self-review of the round-3 repair: a count cap on deferrals let a stable run of instant (free) deferrers at the
  // head of the queue starve every later PR on every tick. Instant deferrals cost no time, so they are never capped.
  it('a long run of instant deferrals at the head of the queue never starves the refreshable PR behind them', () => {
    const prs = Array.from({ length: 21 }, (_, i) => ({ ...PR_2635, number: 2800 + i, headRefName: `lane/a${i}` }));
    const refresh = vi.fn((branch) => (branch === 'lane/a20' ? { ok: true, action: 'rebased' } : { deferred: true, ok: false, error: 'not same-repo' }));
    const postComment = vi.fn();
    const result = sweepCiRedRecovery({
      readOpenPrs: () => prs, readMainRuns: () => MAIN_RUNS, readAheadBy: () => 33, readComments: () => [],
      refresh, postComment, apply: true, maxApplyPerTick: 2,
    });
    expect(refresh).toHaveBeenCalledTimes(21);
    expect(postComment).toHaveBeenCalledTimes(1);
    expect(result.applied.at(-1)).toMatchObject({ prNumber: 2820, ok: true, action: 'rebased' });
    expect(result.applied.some((a) => a.budgetExhausted)).toBe(false);
  });

  // Review round 4 of #6340: ticks used to be stateless, so five slow free deferrals at the front of a stable queue
  // spent every tick's whole budget and the refreshable sixth PR was never tried (three ticks, same result).
  const memoryLedger = () => {
    let state = null;
    return { read: () => state, write: vi.fn((s) => { state = JSON.parse(JSON.stringify(s)); }) };
  };
  const slowQueueTick = ({ prs, ledger, refreshable }) => {
    let t = 0;
    const tried = [];
    const refresh = vi.fn((branch) => {
      tried.push(branch);
      if (branch === refreshable) return { ok: true, action: 'rebased' };
      t += 35_000;
      return { deferred: true, ok: false, error: 'verification unknown' };
    });
    const result = sweepCiRedRecovery({
      readOpenPrs: () => prs, readMainRuns: () => MAIN_RUNS, readAheadBy: () => 33, readComments: () => [],
      refresh, postComment: vi.fn(), apply: true, now: () => t, applyBudgetMs: 170_000, maxApplyPerTick: 8, applyLedger: ledger,
    });
    return { tried, result };
  };

  it('slow free deferrals at the queue head cannot starve the refreshable PR behind them on later ticks', () => {
    const prs = Array.from({ length: 6 }, (_, i) => ({ ...PR_2635, number: 7100 + i, headRefName: `lane/h${i}` }));
    const ledger = memoryLedger();
    const first = slowQueueTick({ prs, ledger, refreshable: 'lane/h5' });
    expect(first.tried).toEqual(['lane/h0', 'lane/h1', 'lane/h2', 'lane/h3', 'lane/h4']); // 175 s, h5 budget-deferred untried
    expect(first.result.applied.at(-1)).toMatchObject({ prNumber: 7105, deferred: true, budgetExhausted: true });
    const second = slowQueueTick({ prs, ledger, refreshable: 'lane/h5' });
    expect(second.tried[0]).toBe('lane/h5'); // never-attempted leads
    expect(second.result.applied.find((a) => a.prNumber === 7105)).toMatchObject({ ok: true, action: 'rebased' });
  });

  it('with no ledger the plan order is unchanged (the reviewer\'s scenario starves, which is why the CLI wires one)', () => {
    const prs = Array.from({ length: 6 }, (_, i) => ({ ...PR_2635, number: 7100 + i, headRefName: `lane/h${i}` }));
    const first = slowQueueTick({ prs, ledger: null, refreshable: 'lane/h5' });
    const second = slowQueueTick({ prs, ledger: null, refreshable: 'lane/h5' });
    expect(second.tried).toEqual(first.tried);
    expect(second.tried).not.toContain('lane/h5');
  });

  it('when every PR is a slow deferrer the queue still rotates: each PR is tried within ceil(n/k) ticks', () => {
    const prs = Array.from({ length: 12 }, (_, i) => ({ ...PR_2635, number: 7200 + i, headRefName: `lane/r${i}` }));
    const ledger = memoryLedger();
    const seen = new Set();
    for (let tick = 0; tick < 3; tick += 1) slowQueueTick({ prs, ledger, refreshable: null }).tried.forEach((b) => seen.add(b));
    expect(seen.size).toBe(12); // 5 + 5 + 2 across three ticks
  });

  // Self-review of the round-4 repair: pruning to the current queue (and keying on the head sha) reset a slow
  // deferrer's place whenever it dropped out for one tick or its head moved, re-creating the head-of-line burn.
  it('a PR that drops out of the plan for a tick, or whose head moves, keeps its place in the rotation', () => {
    const ledger = memoryLedger();
    const prs = Array.from({ length: 6 }, (_, i) => ({ ...PR_2635, number: 7400 + i, headRefName: `lane/m${i}` }));
    slowQueueTick({ prs, ledger, refreshable: 'lane/m5' }); // m0..m4 tried, m5 untried
    const flapped = [...prs.slice(0, 2), ...prs.slice(3)]; // m2 missing this tick (transient read failure)
    const moved = flapped.map((p) => (p.number === 7400 ? { ...p, headRefOid: 'f'.repeat(40) } : p)); // m0's head moved
    const tick = slowQueueTick({ prs: moved, ledger, refreshable: 'lane/m5' });
    expect(tick.tried[0]).toBe('lane/m5'); // m0's moved head did not make it "never attempted" again (it would lead m5)
    expect(ledger.read().at['7402']).toBe(3); // m2 was absent this tick and kept its tick-1 stamp
    const third = slowQueueTick({ prs, ledger, refreshable: null }); // m2 is back and is now the least recently tried
    expect(third.tried[0]).toBe('lane/m2');
  });

  it('entries expire only after the TTL, and the file stays bounded by it', () => {
    const ledger = memoryLedger();
    const a = [{ ...PR_2635, number: 7500, headRefName: 'lane/t0' }, { ...PR_2635, number: 7501, headRefName: 'lane/t1' }];
    slowQueueTick({ prs: a, ledger, refreshable: null });
    expect(Object.keys(ledger.read().at).sort()).toEqual(['7500', '7501']);
    const t = APPLY_LEDGER_TTL_MS + 100_000;
    sweepCiRedRecovery({
      readOpenPrs: () => [a[0]], readMainRuns: () => MAIN_RUNS, readAheadBy: () => 33, readComments: () => [],
      refresh: () => ({ deferred: true, ok: false, error: 'x' }), postComment: vi.fn(), apply: true, now: () => t, applyLedger: ledger,
    });
    expect(Object.keys(ledger.read().at)).toEqual(['7500']); // 7501's record was older than the TTL
  });

  it('overlapping sweeps merge: a stamp another writer added while this tick ran is not lost', () => {
    const ledger = memoryLedger();
    const prs = [{ ...PR_2635, number: 7600, headRefName: 'lane/w0' }, { ...PR_2635, number: 7601, headRefName: 'lane/w1' }];
    sweepCiRedRecovery({
      readOpenPrs: () => prs, readMainRuns: () => MAIN_RUNS, readAheadBy: () => 33, readComments: () => [],
      refresh: (branch) => {
        if (branch === 'lane/w0') { // a concurrent sweep stamps PR 7999 (and a higher seq) while w0 refreshes
          const cur = ledger.read();
          ledger.write({ seq: cur.seq + 5, at: { ...cur.at, 7999: cur.seq + 5 }, ts: { ...cur.ts, 7999: 1 } });
        }
        return { ok: true, action: 'rebased' };
      },
      postComment: vi.fn(), apply: true, now: () => 1, applyLedger: ledger,
    });
    const end = ledger.read();
    expect(end.at['7999']).toBeDefined();
    expect(end.at['7601']).toBeGreaterThan(end.at['7999']); // seq kept advancing past the other writer's
  });

  it('the attempt is recorded BEFORE the refresh runs, so a sweep killed mid-refresh still rotates the PR back', () => {
    const prs = [2635, 2636].map((number) => ({ ...PR_2635, number, headRefName: `lane/x${number}` }));
    const ledger = memoryLedger();
    const kill = () => sweepCiRedRecovery({
      readOpenPrs: () => prs, readMainRuns: () => MAIN_RUNS, readAheadBy: () => 33, readComments: () => [],
      refresh: () => { throw new Error('SIGTERM at the pass deadline'); }, postComment: vi.fn(), apply: true, applyLedger: ledger,
    });
    expect(kill).toThrow('SIGTERM');
    const tried = [];
    sweepCiRedRecovery({
      readOpenPrs: () => prs, readMainRuns: () => MAIN_RUNS, readAheadBy: () => 33, readComments: () => [],
      refresh: (b) => { tried.push(b); return { ok: true, action: 'rebased' }; }, postComment: vi.fn(), apply: true, applyLedger: ledger,
    });
    expect(tried).toEqual(['lane/x2636', 'lane/x2635']);
  });

  it('a claim-held PR is not recorded as attempted (it cost nothing)', () => {
    const prs = [2635, 2636].map((number) => ({ ...PR_2635, number, headRefName: `lane/c${number}` }));
    const ledger = memoryLedger();
    sweepCiRedRecovery({
      readOpenPrs: () => prs, readMainRuns: () => MAIN_RUNS, readAheadBy: () => 33, readComments: () => [],
      refresh: () => ({ ok: true, action: 'rebased' }), postComment: vi.fn(), apply: true, applyLedger: ledger,
      checkClaim: ({ branch }) => (branch === 'lane/c2635' ? { message: 'held' } : null),
    });
    expect(Object.keys(ledger.read().at)).toHaveLength(1);
  });

  it.each([
    ['read', { read: () => { throw new Error('EACCES'); }, write: vi.fn() }],
    ['write', { read: () => null, write: () => { throw new Error('ENOSPC'); } }],
  ])('a failing ledger %s never stops the sweep; it is reported as applyLedgerError', (kind, ledger) => {
    const prs = [{ ...PR_2635, number: 2635, headRefName: 'lane/e1' }];
    const refresh = vi.fn(() => ({ ok: true, action: 'rebased' }));
    const result = sweepCiRedRecovery({
      readOpenPrs: () => prs, readMainRuns: () => MAIN_RUNS, readAheadBy: () => 33, readComments: () => [],
      refresh, postComment: vi.fn(), apply: true, applyLedger: ledger,
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(result.applyLedgerError).toMatch(new RegExp(`^${kind}:`));
  });

  it('without --apply the ledger is neither read nor written', () => {
    const ledger = { read: vi.fn(), write: vi.fn() };
    sweepCiRedRecovery({ readOpenPrs: () => [PR_2635], readMainRuns: () => MAIN_RUNS, readAheadBy: () => 33, readComments: () => [], apply: false, applyLedger: ledger });
    expect(ledger.read).not.toHaveBeenCalled();
    expect(ledger.write).not.toHaveBeenCalled();
  });

  it.each([[['sweep', '--apply'], true], [['sweep'], false]])('main(%j) wires a file-backed apply ledger into the main-red sweep only with --apply', async (argv, wired) => {
    const seen = [];
    const empty = () => ({ dispatch: [], refusals: [], applied: [] });
    const prevExit = process.exitCode;
    await main(argv, {
      sweepOptions: { exhaustedRetrySettings: {} },
      sweepMainRed: (args) => { seen.push(args.applyLedger); return { ...empty(), mainGreen: null }; },
      sweepExhausted: empty, sweepHung: empty, sweepMissingRun: empty, sweepMainCancelled: empty,
      writeLine: () => {}, writeAll: () => {},
    });
    process.exitCode = prevExit;
    expect(seen).toHaveLength(1);
    if (wired) expect(seen[0]).toEqual({ read: expect.any(Function), write: expect.any(Function) });
    else expect(seen[0]).toBeNull();
  });

  describe('apply ledger file + normalization', () => {
    it.each([
      ['null', null], ['string', 'x'], ['array at', { at: [1] }], ['bad stamps', { seq: 'a', at: { 11: -1, 12: 1.5, 13: '4' } }],
      ['__proto__ key', JSON.parse('{"at":{"__proto__":7}}')],
    ])('a malformed ledger (%s) normalizes to empty', (_n, raw) => {
      expect(normalizeApplyLedger(raw)).toEqual({ seq: 0, at: {}, ts: {} });
    });

    it('keeps valid stamps and never lets seq fall below the highest stamp', () => {
      expect(normalizeApplyLedger({ seq: 1, at: { 11: 5, 12: 3 }, ts: { 11: 100 } })).toEqual({ seq: 5, at: { 11: 5, 12: 3 }, ts: { 11: 100, 12: 0 } });
    });

    it('caps the ledger at APPLY_LEDGER_MAX_ENTRIES, keeping the most recently stamped', () => {
      const at = Object.fromEntries(Array.from({ length: APPLY_LEDGER_MAX_ENTRIES + 20 }, (_, i) => [String(i + 1), i + 1]));
      const n = normalizeApplyLedger({ seq: APPLY_LEDGER_MAX_ENTRIES + 20, at });
      expect(Object.keys(n.at)).toHaveLength(APPLY_LEDGER_MAX_ENTRIES);
      expect(n.at['1']).toBeUndefined();
      expect(n.at[String(APPLY_LEDGER_MAX_ENTRIES + 20)]).toBe(APPLY_LEDGER_MAX_ENTRIES + 20);
    });

    it('re-ranks a near-saturated sequence so new stamps keep advancing (no permanent ties)', () => {
      const big = APPLY_LEDGER_SEQ_REBASE + 5;
      const n = normalizeApplyLedger({ seq: big, at: { 1: big, 2: big - 1, 3: big - 2 } });
      expect(n).toMatchObject({ seq: 3, at: { 1: 3, 2: 2, 3: 1 } });
    });

    it('merge keeps the max stamp per PR from both writers; prune drops only entries past the TTL', () => {
      const a = normalizeApplyLedger({ seq: 4, at: { 1: 4, 2: 1 }, ts: { 1: 1000, 2: 1000 } });
      const b = normalizeApplyLedger({ seq: 6, at: { 1: 2, 2: 6, 3: 5 }, ts: { 1: 900, 2: 2000, 3: 2000 } });
      const m = mergeApplyLedgers(a, b);
      expect(m).toMatchObject({ seq: 6, at: { 1: 4, 2: 6, 3: 5 }, ts: { 1: 1000, 2: 2000, 3: 2000 } });
      const p = pruneApplyLedger(m, 2000 + APPLY_LEDGER_TTL_MS, APPLY_LEDGER_TTL_MS);
      expect(Object.keys(p.at).sort()).toEqual(['2', '3']);
    });

    it('round-trips through a file; a missing or corrupt file reads as nothing', () => {
      const dir = mkdtempSync(join(tmpdir(), 'apply-ledger-'));
      try {
        const path = join(dir, 'ledger.json');
        const ledger = createFileApplyLedger({ path });
        expect(ledger.read()).toBeNull();
        ledger.write({ seq: 2, at: { 11: 2 }, ts: { 11: 50 } });
        expect(normalizeApplyLedger(ledger.read())).toEqual({ seq: 2, at: { 11: 2 }, ts: { 11: 50 } });
        writeFileSync(path, '{not json');
        expect(ledger.read()).toBeNull();
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it('is hermetic inside a test run unless given a path: it never touches the live handoff record', () => {
      const ledger = createFileApplyLedger({ repo: null });
      ledger.write({ seq: 9, at: { '1:a': 9 } });
      expect(ledger.read()).toEqual({ seq: 0, at: {} });
    });
  });

  it('a failed refresh whose claim is found held afterwards is a free deferral too', () => {
    const prs = [2635, 2636].map((number) => ({ ...PR_2635, number, headRefName: `lane/k${number}` }));
    let t = 0;
    const refresh = vi.fn((branch) => (branch === 'lane/k2635' ? { ok: false, error: 'push rejected' } : { ok: true, action: 'rebased' }));
    let reads = 0;
    const checkClaim = vi.fn(({ branch }) => (branch === 'lane/k2635' && ++reads === 2 ? { message: 'held' } : null));
    const result = sweepCiRedRecovery({
      readOpenPrs: () => { t += 200; return prs; }, readMainRuns: () => MAIN_RUNS, readAheadBy: () => 33, readComments: () => [],
      refresh, postComment: vi.fn(), apply: true, now: () => t, applyBudgetMs: 150, maxApplyPerTick: 1, checkClaim,
    });
    expect(result.applied.map((a) => [a.prNumber, a.action])).toEqual([[2635, 'deferred'], [2636, 'rebased']]);
  });

  it('a claim-held PR first in line does not use up the progress floor', () => {
    const prs = [2635, 2636].map((number) => ({ ...PR_2635, number, headRefName: `lane/f${number}` }));
    let t = 0;
    const refresh = vi.fn(() => ({ ok: true, action: 'rebased' }));
    const checkClaim = vi.fn(({ branch }) => (branch === 'lane/f2635' ? { message: 'held' } : null));
    sweepCiRedRecovery({
      readOpenPrs: () => { t += 200; return prs; }, readMainRuns: () => MAIN_RUNS, readAheadBy: () => 33, readComments: () => [],
      refresh, postComment: vi.fn(), apply: true, now: () => t, applyBudgetMs: 150, maxApplyPerTick: 10, checkClaim,
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith('lane/f2636', expect.anything());
  });

  it('never refreshes more than maxApplyPerTick PRs in one tick (post-green storm bound)', () => {
    const prs = [2635, 2636, 2637].map((number) => ({ ...PR_2635, number, headRefName: `lane/c${number}` }));
    const refresh = vi.fn(() => ({ ok: true, action: 'rebased' }));
    const result = sweepCiRedRecovery({
      readOpenPrs: () => prs, readMainRuns: () => MAIN_RUNS, readAheadBy: () => 33, readComments: () => [],
      refresh, postComment: vi.fn(), apply: true, maxApplyPerTick: 1,
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(result.applied.filter((a) => a.budgetExhausted).map((a) => a.prNumber)).toEqual([2636, 2637]);
  });

  it('persists main state across ticks and reports the transition exactly once', async () => {
    const { mkdtempSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = `${mkdtempSync(`${tmpdir()}/rr-`)}/state.json`;
    expect(recordMainState({ mainGreen: false, path })).toBe(false);
    expect(JSON.parse(readFileSync(path, 'utf8')).green).toBe(false);
    expect(recordMainState({ mainGreen: true, path })).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8')).green).toBe(true);
    expect(recordMainState({ mainGreen: true, path })).toBe(false);
  });

  it('held PRs do not consume the per-tick apply cap, and a failed state write never reports a transition', async () => {
    const prs = [2635, 2636].map((number) => ({ ...PR_2635, number, headRefName: `lane/h${number}` }));
    const refresh = vi.fn(() => ({ ok: true, action: 'rebased' }));
    const checkClaim = vi.fn(({ branch }) => (branch === 'lane/h2635' ? { message: 'held' } : null));
    const result = sweepCiRedRecovery({
      readOpenPrs: () => prs, readMainRuns: () => MAIN_RUNS, readAheadBy: () => 33, readComments: () => [],
      refresh, postComment: vi.fn(), apply: true, maxApplyPerTick: 1, checkClaim,
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith('lane/h2636', expect.anything());
    expect(result.applied.find((a) => a.prNumber === 2635)).toMatchObject({ deferred: true });
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(`${tmpdir()}/rr-`);
    writeFileSync(`${dir}/state.json`, JSON.stringify({ green: false }));
    expect(recordMainState({ mainGreen: true, path: `${dir}/state.json/nope/x.json` })).toBe(false);
  });

  it('detects the main red→green transition from the persisted previous state', () => {
    expect(detectMainTransition({ prevGreen: false, mainGreen: true })).toBe(true);
    expect(detectMainTransition({ prevGreen: true, mainGreen: true })).toBe(false);
    expect(detectMainTransition({ prevGreen: null, mainGreen: true })).toBe(false);
    expect(detectMainTransition({ prevGreen: false, mainGreen: false })).toBe(false);
  });

  // x5uqim1 follow-up (#4075/#3383) part (c) — "check the owed-ci-rerun path for frontierui/plateau-app too":
  // `rebaseDropManifest` needs a REAL LOCAL checkout of the repo being rebased. Left at WE's own `REPO_ROOT`
  // unconditionally, this would have run every mechanical rebase in the WRONG local git repo for those two.
  it('resolves the frontierui sibling checkout as `root` when repo is frontierui, never WE\'s own REPO_ROOT', () => {
    const readOpenPrs = () => [PR_2635];
    const readMainRuns = () => MAIN_RUNS;
    const readAheadBy = () => 33;
    const readComments = () => [];
    const refresh = vi.fn(() => ({ ok: true, action: 'rebased' }));
    sweepCiRedRecovery({
      repo: 'frontier-ui/frontierui', readOpenPrs, readMainRuns, readAheadBy, readComments, refresh,
      postComment: vi.fn(), apply: true,
    });
    expect(refresh).toHaveBeenCalledWith('lane/xdzl6mb', expect.objectContaining({
      root: `${homedir()}/workspace/frontierui`,
    }));
  });

  it('defaults `root` to REPO_ROOT (WE\'s own checkout) when no repo is given', () => {
    const readOpenPrs = () => [PR_2635];
    const readMainRuns = () => MAIN_RUNS;
    const readAheadBy = () => 33;
    const readComments = () => [];
    const refresh = vi.fn(() => ({ ok: true, action: 'rebased' }));
    sweepCiRedRecovery({
      readOpenPrs, readMainRuns, readAheadBy, readComments, refresh, postComment: vi.fn(), apply: true,
    });
    expect(refresh).toHaveBeenCalledWith('lane/xdzl6mb', expect.objectContaining({ root: REPO_ROOT }));
  });

  it('PR #2596 (operator already refreshed it by hand, ahead_by 0, still red) is reported already-current, never re-applied', () => {
    const readOpenPrs = () => [PR_2596];
    const readMainRuns = () => MAIN_RUNS;
    const readAheadBy = () => 0; // GitHub's own compare result, post operator-refresh
    const refresh = vi.fn();
    const result = sweepCiRedRecovery({ readOpenPrs, readMainRuns, readAheadBy, refresh, apply: true });
    expect(result.dispatch).toEqual([]);
    expect(result.refusals).toEqual([expect.objectContaining({ prNumber: 2596, kind: 'already-current' })]);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('PR #2636 (failed hours after main recovered — its own failure) is refused own-failure, never refreshed', () => {
    const readOpenPrs = () => [PR_2636];
    const readMainRuns = () => MAIN_RUNS;
    const readAheadBy = () => 33;
    const result = sweepCiRedRecovery({ readOpenPrs, readMainRuns, readAheadBy, refresh: vi.fn() });
    expect(result.refusals).toEqual([expect.objectContaining({ prNumber: 2636, kind: 'own-failure' })]);
  });

  it('never reads main\'s own run history at all when nothing is currently failing — the zero-cost path', () => {
    const readMainRuns = vi.fn();
    const result = sweepCiRedRecovery({ readOpenPrs: () => [PR_QUIET], readMainRuns });
    expect(readMainRuns).not.toHaveBeenCalled();
    expect(result.dispatch).toEqual([]);
    expect(result.refusals).toEqual([]);
  });

  it('a mid-sweep read of ALL current candidates at once yields the exact live before/after: #2635 owed, #2596/#2636 handled', () => {
    // The live 2026-09-25 snapshot this item was built against, in one sweep.
    const readOpenPrs = () => [PR_2635, PR_2596, PR_2636];
    const readMainRuns = () => MAIN_RUNS;
    const readAheadBy = (headSha) => (headSha === PR_2635.headRefOid ? 33 : 0);
    const readComments = () => []; // #2635 is the only candidate that ever reaches this read (aheadBy > 0, main-red)
    const result = sweepCiRedRecovery({
      readOpenPrs, readMainRuns, readAheadBy, readComments, refresh: vi.fn(),
    });
    expect(result.dispatch.map((d) => d.prNumber)).toEqual([2635]);
    expect(result.refusals.map((r) => ({ pr: r.prNumber, kind: r.kind }))).toEqual([
      { pr: 2596, kind: 'already-current' },
      { pr: 2636, kind: 'own-failure' },
    ]);
  });
});

describe('ci-red-recovery-watch — refreshOntoMain', () => {
  it('delegates to rebaseDropManifest and reports its action verbatim on success', () => {
    const rebase = vi.fn(() => ({ action: 'rebased', newCommit: 'abc123' }));
    // #2811 — `newCommit` now threaded through verbatim (the apply loop's own re-verify/re-arm step needs it).
    expect(refreshOntoMain('lane/xdzl6mb', { root: '/repo', base: 'origin/main', rebase })).toEqual({ ok: true, action: 'rebased', newCommit: 'abc123' });
    expect(rebase).toHaveBeenCalledWith({ laneRef: 'lane/xdzl6mb', base: 'origin/main', cwd: '/repo' });
  });

  it('reports action:"current" as ok — rebaseDropManifest\'s own idempotency short-circuit, not a failure', () => {
    const rebase = vi.fn(() => ({ action: 'current', newCommit: 'abc123' }));
    expect(refreshOntoMain('lane/x', { rebase })).toEqual({ ok: true, action: 'current', newCommit: 'abc123' });
  });

  it('surfaces a real conflict (action:"skip") and a hard failure (action:"error") as not-ok, never force-resolved', () => {
    expect(refreshOntoMain('lane/x', { rebase: () => ({ action: 'skip', reason: 'real conflict beyond .lane-manifest.json' }) }))
      .toEqual({ ok: false, action: 'skip', error: 'real conflict beyond .lane-manifest.json' });
    expect(refreshOntoMain('lane/x', { rebase: () => ({ action: 'error', reason: 'push failed' }) }))
      .toEqual({ ok: false, action: 'error', error: 'push failed' });
  });
});

// #2811 (web-everything/web-everything PR #2811 live incident) — this watcher's own mechanical rebase moves the head
// exactly like a ci-heal's re-push does, so a live `review:accepted` it finds is stale for the same reason.
describe('ci-red-recovery-watch — reconcileAcceptanceAfterRebase (#2811)', () => {
  const readLabels = (labels) => () => labels;

  it('does nothing at all when the PR carries no review:accepted — no restamp, no rearm, no gh write', () => {
    const restamp = vi.fn();
    const rearm = vi.fn();
    const out = reconcileAcceptanceAfterRebase({
      prNumber: 2635, newHead: 'abc123', repo: null, root: '/repo',
      readLabels: readLabels([{ name: 'review:pending' }]), restamp, rearm,
    });
    expect(out).toEqual({ attempted: false, restamped: false, rearmed: false });
    expect(restamp).not.toHaveBeenCalled();
    expect(rearm).not.toHaveBeenCalled();
  });

  it('a content-preserving rebase RESTAMPS (carries the acceptance forward) and never also rearms', () => {
    const restamp = vi.fn(() => ({ ok: true }));
    const rearm = vi.fn();
    const out = reconcileAcceptanceAfterRebase({
      prNumber: 2635, newHead: 'a19e50b56', repo: 'web-everything/web-everything', root: '/repo',
      readLabels: readLabels([{ name: REVIEW_LABELS.accepted }]), restamp, rearm,
    });
    expect(out).toEqual({ attempted: true, restamped: true, rearmed: false });
    expect(restamp).toHaveBeenCalledWith({ pr: 2635, repo: 'web-everything/web-everything', newHead: 'a19e50b56', cwd: '/repo' });
    expect(rearm).not.toHaveBeenCalled(); // THE LOAD-BEARING GUARD: a successful restamp is never followed by a rearm.
  });

  it('a REFUSED restamp (content genuinely changed) falls back to rearm, reverting to review:pending', () => {
    const restamp = vi.fn(() => ({ ok: false, reason: 'reviewed diff no longer matches' }));
    const rearm = vi.fn(() => ({ ok: true }));
    const out = reconcileAcceptanceAfterRebase({
      prNumber: 2811, newHead: 'a19e50b56', repo: 'web-everything/web-everything', root: '/repo',
      readLabels: readLabels([{ name: REVIEW_LABELS.accepted }]), restamp, rearm,
    });
    expect(out).toEqual({ attempted: true, restamped: false, rearmed: true });
    expect(rearm).toHaveBeenCalledWith(expect.objectContaining({ pr: 2811, repo: 'web-everything/web-everything', cwd: '/repo' }));
  });

  it('reconcileAcceptanceAfterRebase — real restamp/rearm children never receive a literal null repo', () => {
    const argvs = [];
    const fakeSpawn = (cmd, argv) => { argvs.push(argv); return { status: 1, stdout: 'refused', stderr: '' }; };
    const out = reconcileAcceptanceAfterRebase({
      prNumber: 2826, newHead: 'a19e50b56', repo: null, root: '/repo',
      readLabels: readLabels([{ name: REVIEW_LABELS.accepted }]),
      // `/repo` is not a git checkout, so the local slug is injected (a null repo now resolves the local repo).
      restamp: (a) => restampAcceptance({ ...a, spawn: fakeSpawn, localRepo: () => 'owner/local' }),
      rearm: (a) => spawnCiHealRearm({ ...a, spawn: fakeSpawn }),
    });
    expect(out.attempted).toBe(true);
    expect(argvs).toHaveLength(2); // restamp child, then rearm child (restamp refused)
    for (const argv of argvs) {
      for (const el of argv) {
        expect(String(el)).not.toMatch(/^--repo=(null|undefined)$/);
        expect(el).not.toBe('null');
      }
    }
  });

  it('defaultReadPrLabels asks gh pr view --json labels for the exact PR, --repo included when given', () => {
    const calls = [];
    const exec = (bin, argv) => { calls.push(argv); return '{"labels":[{"name":"review:accepted"}]}'; };
    expect(defaultReadPrLabels(2811, { exec, repo: 'web-everything/web-everything' })).toEqual([{ name: 'review:accepted' }]);
    expect(calls[0]).toEqual(['pr', 'view', '2811', '--json', 'labels', '--repo', 'web-everything/web-everything']);
  });

  it('never throws — a label-read failure reports attempted:false rather than sinking the pass', () => {
    const out = reconcileAcceptanceAfterRebase({
      prNumber: 2635, newHead: 'x', readLabels: () => { throw new Error('gh rate limited'); },
      restamp: vi.fn(), rearm: vi.fn(),
    });
    expect(out).toEqual({ attempted: false, restamped: false, rearmed: false });
  });
});

describe('ci-red-recovery-watch — sweepCiRedRecovery wires reconcileAcceptanceAfterRebase (#2811)', () => {
  it('calls it once per successfully-rebased PR that minted a new head, and reports its outcome on the applied row', () => {
    const readOpenPrs = () => [PR_2635];
    const readMainRuns = () => MAIN_RUNS;
    const readAheadBy = () => 33;
    const readComments = () => [];
    const refresh = vi.fn(() => ({ ok: true, action: 'rebased', newCommit: 'a19e50b56' }));
    const reconcileAcceptance = vi.fn(() => ({ attempted: true, restamped: false, rearmed: true }));
    const result = sweepCiRedRecovery({
      readOpenPrs, readMainRuns, readAheadBy, readComments, refresh, postComment: vi.fn(),
      reconcileAcceptance, apply: true,
    });
    expect(reconcileAcceptance).toHaveBeenCalledTimes(1);
    expect(reconcileAcceptance).toHaveBeenCalledWith(expect.objectContaining({ prNumber: 2635, newHead: 'a19e50b56' }));
    expect(result.applied).toEqual([expect.objectContaining({
      prNumber: 2635, action: 'rebased', acceptance: { attempted: true, restamped: false, rearmed: true },
    })]);
  });

  it('never calls it when the rebase reports action:"current" — nothing new was minted to reconcile against', () => {
    const readOpenPrs = () => [PR_2635];
    const readMainRuns = () => MAIN_RUNS;
    const readAheadBy = () => 33;
    const readComments = () => [];
    const refresh = vi.fn(() => ({ ok: true, action: 'current', newCommit: 'already-there' }));
    const reconcileAcceptance = vi.fn();
    sweepCiRedRecovery({
      readOpenPrs, readMainRuns, readAheadBy, readComments, refresh, postComment: vi.fn(),
      reconcileAcceptance, apply: true,
    });
    expect(reconcileAcceptance).not.toHaveBeenCalled();
  });
});

describe('ci-red-recovery-watch — formatReport', () => {
  it('prints one line per dispatch/refusal/applied — silence is the defect this pass exists to avoid', () => {
    const report = formatReport({
      dispatch: [{ prNumber: 2635, headRefName: 'lane/xdzl6mb', why: 'x' }],
      refusals: [{ prNumber: 2596, kind: 'already-current', why: 'y' }],
      applied: [{ prNumber: 2635, headRefName: 'lane/xdzl6mb', ok: true, action: 'rebased' }],
    });
    expect(report).toContain('rebase-onto-main PR #2635 (lane/xdzl6mb)');
    expect(report).toContain('already-current PR #2596');
    expect(report).toContain('applied: rebased lane/xdzl6mb onto main (PR #2635)');
  });
});

// ── HUNG-CI-RUN RECOVERY (xd1sfms, #4075/#3383) ─────────────────────────────────────────────────────────────
// Same #2636/run-36161558017 real shape as `main-red-recovery.test.mjs`'s own hung-run fixtures — this half
// proves the IO shell: durable per-sha marker counting, the cancel-then-rerun write, and the sweep's own
// "pay for the comments read only when actually hung" discipline.
const runningCheck = (name, startedAt, detailsUrl) => ({
  __typename: 'CheckRun', name, workflowName: 'CI', status: 'IN_PROGRESS', conclusion: '', startedAt, detailsUrl,
});
const RUN_URL = (job) => `https://github.com/web-everything/web-everything/actions/runs/36161558017/job/${job}`;
const PR_2636_HUNG = {
  number: 2636, headRefName: 'lane/batch-...-3915', headRefOid: 'deadbeef2636',
  statusCheckRollup: [runningCheck('test-shard (1)', '2026-09-25T16:34:28Z', RUN_URL('108159093983'))],
};
const NOW = Date.parse('2026-09-25T20:10:00Z');

describe('ci-red-recovery-watch — buildHungCiComment / countHungCiComments', () => {
  it('the built comment starts with the marker and embeds the exact head sha', () => {
    const body = buildHungCiComment({ runId: 36161558017, headSha: 'deadbeef2636' });
    expect(body.startsWith(HUNG_CI_COMMENT_MARKER)).toBe(true);
    expect(body).toContain('sha: deadbeef2636');
    expect(bodyHasExactLine(body, 'run: 36161558017')).toBe(true);
  });

  it('counts only a trusted marker comment naming THIS head sha', () => {
    const comments = [
      { body: buildHungCiComment({ headSha: 'deadbeef2636' }), author: { login: 'web-everything' } },
      { body: buildHungCiComment({ headSha: 'deadbeef2636' }), author: { login: 'web-everything' } },
      { body: buildHungCiComment({ headSha: 'a-different-sha' }), author: { login: 'web-everything' } }, // a stale attempt against an OLD sha — must not count
      { body: buildHungCiComment({ headSha: 'deadbeef2636' }), author: { login: 'some-random-user' } }, // untrusted author — a forged marker
      { body: 'unrelated comment' },
    ];
    expect(countHungCiComments(comments, 'deadbeef2636')).toBe(2);
  });

  it('a non-array/empty input counts zero', () => {
    expect(countHungCiComments(null)).toBe(0);
    expect(countHungCiComments([])).toBe(0);
  });
});

describe('ci-red-recovery-watch — cancelAndRerunHungRun', () => {
  it('cancels, sleeps once, then reruns the WHOLE run (never --failed against its own fresh cancel)', () => {
    const calls = [];
    const exec = vi.fn((file, args) => { calls.push(args); return ''; });
    const sleepSync = vi.fn();
    const result = cancelAndRerunHungRun(36161558017, { repo: 'web-everything/web-everything', exec, sleepSync });
    expect(result).toEqual({ ok: true, action: 'cancelled-and-rerun' });
    expect(calls[0]).toEqual(['api', '-X', 'POST', 'repos/web-everything/web-everything/actions/runs/36161558017/cancel']);
    expect(calls[1]).toEqual(['api', '-X', 'POST', 'repos/web-everything/web-everything/actions/runs/36161558017/rerun']);
    expect(exec.mock.calls.map(([file]) => file)).toEqual(['gh', 'gh']);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(calls[1]).not.toContain('--failed');
    expect(sleepSync).toHaveBeenCalledTimes(1);
  });

  it.each([null, 'frontier-ui/frontierui'])('uses REST cancel and rerun endpoints with repo %s (null defaults to WE)', (repo) => {
    const exec = vi.fn(() => '');
    const slug = repo ?? 'web-everything/web-everything';
    expect(cancelAndRerunHungRun(123, { repo, exec, sleepSync: vi.fn() }))
      .toEqual({ ok: true, action: 'cancelled-and-rerun' });
    expect(exec.mock.calls.map(([file, args]) => [file, args])).toEqual([
      ['gh', ['api', '-X', 'POST', `repos/${slug}/actions/runs/123/cancel`]],
      ['gh', ['api', '-X', 'POST', `repos/${slug}/actions/runs/123/rerun`]],
    ]);
  });

  it('reports a failed cancel without ever attempting the rerun', () => {
    const exec = vi.fn(() => { throw new Error('gh: run not found'); });
    const result = cancelAndRerunHungRun(1, { exec, sleepSync: vi.fn() });
    expect(result).toEqual({ ok: false, action: 'cancel-failed', error: 'gh: run not found' });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  const completed409 = (conclusion, jobs = 'cancelled\nsuccess\nskipped\n') => {
    const calls = [];
    const exec = vi.fn((file, args) => {
      calls.push(args);
      if (args[args.length - 1].endsWith('/cancel')) throw new Error('gh: Cannot cancel a workflow run that is completed. (HTTP 409)');
      if (args.some((a) => /\/jobs\?per_page=100$/.test(String(a)))) {
        if (typeof jobs === 'function') return jobs(args);
        return jobs;
      }
      if (typeof conclusion === 'function') return conclusion(args);
      if (args.includes('--jq')) return `${conclusion}\n`;
      return '';
    });
    return { calls, exec };
  };
  const jobsRead = (calls) => calls.filter((a) => a.some((x) => /\/jobs\?per_page=100$/.test(String(x))));
  const rerunWrites = (calls) => calls.filter((a) => a.some((x) => /rerun/.test(String(x))));

  it.each(['cancelled', 'timed_out'])('409 completed + conclusion %s: reads the conclusion, then re-runs only the failed jobs', (conclusion) => {
    const { calls, exec } = completed409(conclusion);
    const sleepSync = vi.fn();
    const result = cancelAndRerunHungRun(43093913029, { repo: 'web-everything/web-everything', exec, sleepSync });
    expect(result).toEqual({ ok: true, action: 'rerun-failed-jobs-after-completed' });
    expect(calls[1]).toEqual(['api', 'repos/web-everything/web-everything/actions/runs/43093913029', '--jq', '.conclusion']);
    expect(calls[2]).toEqual(['api', '--paginate', 'repos/web-everything/web-everything/actions/runs/43093913029/jobs?per_page=100', '--jq', '.jobs[].conclusion']);
    expect(calls[3]).toEqual(['api', '-X', 'POST', 'repos/web-everything/web-everything/actions/runs/43093913029/rerun-failed-jobs']);
    expect(exec).toHaveBeenCalledTimes(4);
    expect(sleepSync).not.toHaveBeenCalled();
  });

  it.each(['cancelled', 'timed_out'])('409 completed + conclusion %s but one job genuinely FAILED: never re-runs, hands to ci-red/ci-heal', (conclusion) => {
    const { calls, exec } = completed409(conclusion, 'success\nfailure\ncancelled\n');
    expect(cancelAndRerunHungRun(1, { exec, sleepSync: vi.fn() })).toEqual({ ok: true, action: 'already-completed' });
    expect(jobsRead(calls)).toHaveLength(1);
    expect(rerunWrites(calls)).toEqual([]);
  });

  it.each([
    ['empty job list', () => ''],
    ['whitespace-only job list', () => '\n \n'],
  ])('409 completed + cancelled + %s: fails closed with no rerun write', (_name, jobs) => {
    const { calls, exec } = completed409('cancelled', jobs);
    expect(cancelAndRerunHungRun(1, { exec, sleepSync: vi.fn() })).toMatchObject({ ok: false, action: 'jobs-unreadable' });
    expect(rerunWrites(calls)).toEqual([]);
  });

  it('409 completed + cancelled + job-list read throws: fails closed with no rerun write', () => {
    const { calls, exec } = completed409('cancelled', () => { throw new Error('gh: HTTP 502'); });
    expect(cancelAndRerunHungRun(1, { exec, sleepSync: vi.fn() })).toEqual({ ok: false, action: 'jobs-unreadable', error: 'gh: HTTP 502' });
    expect(rerunWrites(calls)).toEqual([]);
  });

  it.each(['failure', 'success', 'skipped', 'startup_failure'])('409 completed + conclusion %s: never re-runs, hands to ci-red/ci-heal', (conclusion) => {
    const { calls, exec } = completed409(conclusion);
    expect(cancelAndRerunHungRun(1, { exec, sleepSync: vi.fn() })).toEqual({ ok: true, action: 'already-completed' });
    expect(calls.some((a) => a.some((x) => /rerun/.test(String(x))))).toBe(false);
  });

  it.each(['', 'null', 'surprise'])('409 completed + unreadable conclusion %j: fails closed with no rerun write', (conclusion) => {
    const { calls, exec } = completed409(conclusion);
    const result = cancelAndRerunHungRun(1, { exec, sleepSync: vi.fn() });
    expect(result).toMatchObject({ ok: false, action: 'conclusion-unreadable' });
    expect(calls.some((a) => a.some((x) => /rerun/.test(String(x))))).toBe(false);
  });

  it('409 completed + conclusion read throws: fails closed with no rerun write', () => {
    const { calls, exec } = completed409(() => { throw new Error('gh: HTTP 502'); });
    const result = cancelAndRerunHungRun(1, { exec, sleepSync: vi.fn() });
    expect(result).toEqual({ ok: false, action: 'conclusion-unreadable', error: 'gh: HTTP 502' });
    expect(calls).toHaveLength(2);
  });

  it('does not treat any other 409 cancel refusal as completed', () => {
    const exec = vi.fn(() => { throw new Error('gh: Conflict (HTTP 409)'); });
    const result = cancelAndRerunHungRun(1, { exec, sleepSync: vi.fn() });
    expect(result.action).toBe('cancel-failed');
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('reports a failed rerun distinctly from a failed cancel', () => {
    let n = 0;
    const exec = vi.fn(() => { n += 1; if (n === 2) throw new Error('gh: rerun rejected'); return ''; });
    const result = cancelAndRerunHungRun(1, { exec, sleepSync: vi.fn() });
    expect(result).toEqual({ ok: false, action: 'rerun-failed', error: 'gh: rerun rejected' });
  });
});

describe('ci-red-recovery-watch — sweepHungCiRecovery', () => {
  it("plans a real cancel+rerun for PR #2636's real shape, never touching gh without --apply", () => {
    const readOpenPrs = () => [PR_2636_HUNG];
    const readComments = vi.fn(() => []);
    const cancelAndRerun = vi.fn();
    const result = sweepHungCiRecovery({ readOpenPrs, readComments, cancelAndRerun, now: NOW });
    expect(result.dispatch).toEqual([expect.objectContaining({ prNumber: 2636, runId: 36161558017, kind: 'hung-cancel-rerun' })]);
    expect(result.applied).toEqual([]);
    expect(cancelAndRerun).not.toHaveBeenCalled();
  });

  it('never reads comments for a PR that is not yet hung — pay for it only when needed', () => {
    const readComments = vi.fn();
    const result = sweepHungCiRecovery({
      readOpenPrs: () => [PR_2636_HUNG], readComments, now: Date.parse('2026-09-25T16:40:00Z'),
    });
    expect(readComments).not.toHaveBeenCalled();
    expect(result.dispatch).toEqual([]);
  });

  it('applies exactly one cancel+rerun and posts the durable marker comment, when apply: true', () => {
    const readOpenPrs = () => [PR_2636_HUNG];
    const readComments = vi.fn(() => []);
    const cancelAndRerun = vi.fn(() => ({ ok: true, action: 'cancelled-and-rerun' }));
    const postComment = vi.fn();
    const trigger = vi.fn();
    const result = sweepHungCiRecovery({
      readOpenPrs, readComments, cancelAndRerun, trigger, postComment, now: NOW, apply: true,
    });
    expect(trigger).not.toHaveBeenCalled();
    expect(postComment).toHaveBeenCalledTimes(1);
    expect(cancelAndRerun).toHaveBeenCalledTimes(1);
    expect(cancelAndRerun).toHaveBeenCalledWith(36161558017, { repo: null });
    expect(postComment).toHaveBeenCalledWith(2636, {
      repo: null, runId: 36161558017, headSha: 'deadbeef2636', jobName: 'test-shard (1)',
      kind: 'hung-cancel-rerun', ok: true, action: 'cancelled-and-rerun', error: null,
    });
    expect(result.applied).toEqual([expect.objectContaining({ prNumber: 2636, runId: 36161558017, ok: true, action: 'cancelled-and-rerun' })]);
  });

  // LIVE 2026-09-25, orchestrator-flagged: the ORIGINAL version of this pass only posted (and therefore only
  // COUNTED) a SUCCESSFUL cancel+rerun. Live against #2636, the GitHub App token lacked `actions:write`, so
  // `gh run cancel` failed on EVERY tick, the marker was never posted, the durable per-sha count stayed 0
  // forever, and this pass would have retried the identical doomed call every 2 minutes indefinitely. Fixed:
  // the marker (and therefore the count) is posted on EVERY attempt, success or failure.
  it('POSTS the marker comment even when the cancel+rerun itself FAILED — a failed attempt still counts toward the cap', () => {
    const cancelAndRerun = vi.fn(() => ({ ok: false, action: 'cancel-failed', error: 'boom' }));
    const postComment = vi.fn();
    const trigger = vi.fn();
    const result = sweepHungCiRecovery({
      readOpenPrs: () => [PR_2636_HUNG], readComments: () => [], cancelAndRerun, trigger, postComment, now: NOW, apply: true,
    });
    expect(trigger).not.toHaveBeenCalled();
    expect(postComment).toHaveBeenCalledWith(2636, expect.objectContaining({ ok: false, action: 'cancel-failed', error: 'boom' }));
    expect(result.applied).toEqual([expect.objectContaining({ prNumber: 2636, ok: false, action: 'cancel-failed', error: 'boom' })]);
  });

  // 2026-09-25 18:55 ET correction (#4075/#3383): once the GitHub App token got `actions:write`, a cap-hit run
  // is no longer left refusing forever — it is cancelled (never re-run, via `cancelOnly`, the SAME primitive
  // `repeat-hang` already uses) and handed to ci-heal instead.
  it('a run whose cancel+rerun keeps FAILING still trips the cap after maxRetriesPerSha attempts, then escalates via cancelOnly — never hammers gh with another rerun', () => {
    // Simulates tick N+1 reading back the durable failure markers ticks 1..maxRetriesPerSha posted.
    const readComments = () => [
      { body: buildHungCiComment({ headSha: 'deadbeef2636', jobName: 'test-shard (1)', ok: false, action: 'cancel-failed', error: 'permission denied' }), author: { login: 'web-everything' } },
      { body: buildHungCiComment({ headSha: 'deadbeef2636', jobName: 'test-shard (1)', ok: false, action: 'cancel-failed', error: 'permission denied' }), author: { login: 'web-everything' } },
    ];
    const cancelAndRerun = vi.fn();
    const cancelOnly = vi.fn(() => ({ ok: true, action: 'cancelled-no-rerun' }));
    const postComment = vi.fn();
    const result = sweepHungCiRecovery({
      readOpenPrs: () => [PR_2636_HUNG], readComments, cancelAndRerun, cancelOnly, postComment, now: NOW, apply: true, maxRetriesPerSha: 2,
    });
    expect(result.dispatch).toEqual([expect.objectContaining({ prNumber: 2636, kind: 'hung-cap-escalate' })]);
    expect(result.refusals).toEqual([]);
    expect(cancelAndRerun).not.toHaveBeenCalled();
    expect(cancelOnly).toHaveBeenCalledWith(36161558017, expect.objectContaining({ repo: null }));
    expect(postComment).toHaveBeenCalled();
  });

  it('dispatches hung-cap-escalate (cancelOnly, never cancelAndRerun) once the durable per-sha comment count already hit the cap', () => {
    const readComments = () => [
      { body: buildHungCiComment({ headSha: 'deadbeef2636' }), author: { login: 'web-everything' } },
      { body: buildHungCiComment({ headSha: 'deadbeef2636' }), author: { login: 'web-everything' } },
    ];
    const cancelAndRerun = vi.fn();
    const cancelOnly = vi.fn(() => ({ ok: true, action: 'cancelled-no-rerun' }));
    const postComment = vi.fn();
    const result = sweepHungCiRecovery({
      readOpenPrs: () => [PR_2636_HUNG], readComments, cancelAndRerun, cancelOnly, postComment, now: NOW, apply: true, maxRetriesPerSha: 2,
    });
    expect(result.dispatch).toEqual([expect.objectContaining({ prNumber: 2636, kind: 'hung-cap-escalate' })]);
    expect(result.refusals).toEqual([]);
    expect(cancelAndRerun).not.toHaveBeenCalled();
    expect(cancelOnly).toHaveBeenCalledTimes(1);
    expect(postComment).toHaveBeenCalled();
  });

  it('a NEW push (different head sha) starts the SHA cap fresh — the old sha\'s exhausted count never carries over', () => {
    const readComments = () => [
      { body: buildHungCiComment({ headSha: 'an-old-sha', jobName: 'some-other-job' }), author: { login: 'web-everything' } },
      { body: buildHungCiComment({ headSha: 'an-old-sha', jobName: 'some-other-job' }), author: { login: 'web-everything' } },
    ];
    const cancelAndRerun = vi.fn(() => ({ ok: true, action: 'cancelled-and-rerun' }));
    const result = sweepHungCiRecovery({
      readOpenPrs: () => [PR_2636_HUNG], readComments, cancelAndRerun, postComment: vi.fn(), now: NOW, apply: true, maxRetriesPerSha: 2,
    });
    expect(result.dispatch).toEqual([expect.objectContaining({ prNumber: 2636, attempts: 0, kind: 'hung-cancel-rerun' })]);
    expect(cancelAndRerun).toHaveBeenCalledTimes(1);
  });

  // LIVE 2026-09-25, orchestrator-flagged: #2636's `test-shard (1)` hung twice across two different shas.
  it('routes a repeat-hang dispatch to cancelOnly, never cancelAndRerun, and posts the escalation marker', () => {
    const readComments = () => [
      // a PRIOR attempt on this SAME job, against a DIFFERENT (now-superseded) sha — the repeat-hang signal.
      { body: buildHungCiComment({ headSha: 'an-old-sha', jobName: 'test-shard (1)' }), author: { login: 'web-everything' } },
    ];
    const cancelAndRerun = vi.fn();
    const cancelOnly = vi.fn(() => ({ ok: true, action: 'cancelled-no-rerun' }));
    const postComment = vi.fn();
    const result = sweepHungCiRecovery({
      readOpenPrs: () => [PR_2636_HUNG], readComments, cancelAndRerun, cancelOnly, postComment, now: NOW, apply: true,
    });
    expect(result.dispatch).toEqual([expect.objectContaining({ prNumber: 2636, kind: 'repeat-hang' })]);
    expect(cancelOnly).toHaveBeenCalledWith(36161558017, { repo: null });
    expect(cancelAndRerun).not.toHaveBeenCalled();
    expect(postComment).toHaveBeenCalledWith(2636, expect.objectContaining({ kind: 'repeat-hang', ok: true, action: 'cancelled-no-rerun' }));
    expect(result.applied).toEqual([expect.objectContaining({ kind: 'repeat-hang', ok: true, action: 'cancelled-no-rerun' })]);
  });
});

describe('ci-red-recovery-watch — run-not-found retrigger acceptance', () => {
  const reason = 'run-not-found-retrigger';
  const missingRun = { ok: false, action: 'cancel-failed', error: 'gh: Not Found (HTTP 404)' };
  const triggered = { ok: true, action: 'pull-request-push' };

  it.each([
    ['Could not find any workflow run with ID 123', false],
    ['artifact not foundry', false],
    ['gh: Not Found (HTTP 404)', true],
    ['HTTP 4040', false],
    ['HTTP 403: forbidden', false],
    ['HTTP 404: missing', true],
    ['permission denied', false],
    ['HTTP 503: service unavailable', false],
    ['boom', false],
    [undefined, false],
    [null, false],
    ['', false],
  ])('isRunNotFoundError(%s) returns %s', (error, expected) => {
    expect(isRunNotFoundError(error)).toBe(expected);
  });

  function fixture(kind, outcome = triggered, repo = null) {
    const comments = [];
    if (kind === 'repeat-hang' || kind === 'hung-cap-escalate') {
      const body = buildHungCiComment({
        headSha: kind === 'repeat-hang' ? 'old-head' : PR_2636_HUNG.headRefOid,
        jobName: 'test-shard (1)',
      });
      comments.push({ body, author: { login: 'web-everything' } });
      if (kind === 'hung-cap-escalate') comments.push({ body, author: { login: 'web-everything' } });
    }
    const cancelAndRerun = vi.fn(() => missingRun);
    const cancelOnly = vi.fn(() => missingRun);
    const trigger = vi.fn(() => outcome);
    // Read back the actual production builder output on the next tick, as GitHub would.
    const postComment = vi.fn((_pr, options) => {
      comments.push({ body: buildHungCiComment(options), author: { login: 'web-everything' } });
    });
    // The workflow run's current attempt, as GitHub reports it; a re-run keeps the run id and head sha and bumps it.
    const state = { attempt: 1 };
    const readRunAttempt = vi.fn(() => state.attempt);
    const options = {
      repo, defaultBranch: 'trunk', apply: true, now: NOW, maxRetriesPerSha: 2,
      readOpenPrs: () => [PR_2636_HUNG], readComments: () => [...comments],
      cancelAndRerun, cancelOnly, trigger, postComment, readRunAttempt,
    };
    return { options, comments, cancelAndRerun, cancelOnly, trigger, postComment, state, readRunAttempt };
  }

  it.each([
    ['hung-cancel-rerun', null],
  ])('%s: failed cancel retriggers the CURRENT PR head once, records one outcome, and the next tick is a no-op', (kind, repo) => {
    const f = fixture(kind, triggered, repo);
    const result = sweepHungCiRecovery(f.options);
    expect(result.dispatch).toEqual([expect.objectContaining({ kind })]);
    expect(f.cancelAndRerun.mock.calls.length + f.cancelOnly.mock.calls.length).toBe(1);
    expect(f.trigger).toHaveBeenCalledWith(expect.objectContaining({
      prNumber: PR_2636_HUNG.number, headSha: PR_2636_HUNG.headRefOid, headRefName: PR_2636_HUNG.headRefName,
    }), { repo: repo ?? 'web-everything/web-everything', defaultBranch: 'trunk' });
    expect(f.postComment).toHaveBeenCalledWith(2636, expect.objectContaining({
      headSha: PR_2636_HUNG.headRefOid, reason, ...triggered,
    }));
    const body = f.comments.at(-1).body;
    expect(bodyHasExactLine(body, `sha: ${PR_2636_HUNG.headRefOid}`)).toBe(true);
    expect(bodyHasExactLine(body, 'run: 36161558017')).toBe(true);
    expect(bodyHasExactLine(body, `reason: ${reason}`)).toBe(true);
    expect(body).toContain(triggered.action);
    expect(body).toContain(missingRun.error);
    expect(result.applied).toEqual([expect.objectContaining({ prNumber: 2636, ...triggered })]);

    const again = sweepHungCiRecovery(f.options);
    expect(again.applied).toEqual([]);
    expect(again.refusals).toEqual([expect.objectContaining({
      kind: 'run-not-found-retriggered', why: expect.stringContaining('recorded retrigger outcome'),
    })]);
    expect(formatHungReport(again)).toContain('run-not-found-retriggered PR #2636');
    expect(formatHungReport(again)).toContain('recorded retrigger outcome');
    expect(f.cancelAndRerun.mock.calls.length + f.cancelOnly.mock.calls.length).toBe(1);
    expect(f.trigger).toHaveBeenCalledTimes(1);
    expect(f.postComment).toHaveBeenCalledTimes(1);
  });

  it('hung-cap-escalate: an already-completed run is recorded as handled for that head and is not re-selected next tick', () => {
    const f = fixture('hung-cap-escalate');
    f.cancelOnly.mockReturnValue({ ok: true, action: 'already-completed' });
    const result = sweepHungCiRecovery(f.options);
    expect(result.applied).toEqual([expect.objectContaining({ prNumber: 2636, action: 'already-completed' })]);
    const body = f.comments.at(-1).body;
    expect(bodyHasExactLine(body, 'reason: run-already-completed')).toBe(true);
    expect(bodyHasExactLine(body, 'run: 36161558017')).toBe(true);
    expect(body).toContain('ci-heal');

    const again = sweepHungCiRecovery(f.options);
    expect(again.applied).toEqual([]);
    expect(again.refusals).toEqual([expect.objectContaining({ kind: 'run-already-completed' })]);
    expect(f.cancelOnly).toHaveBeenCalledTimes(1);
    expect(f.postComment).toHaveBeenCalledTimes(1);
  });

  it('hung-cancel-rerun: cancelAndRerun finding the run settled (already-completed) records the handled marker and is not re-selected', () => {
    const f = fixture('hung-cancel-rerun');
    f.cancelAndRerun.mockReturnValue({ ok: true, action: 'already-completed' });
    const result = sweepHungCiRecovery(f.options);
    expect(result.applied).toEqual([expect.objectContaining({ kind: 'hung-cancel-rerun', action: 'already-completed' })]);
    expect(bodyHasExactLine(f.comments.at(-1).body, 'reason: run-already-completed')).toBe(true);
    const again = sweepHungCiRecovery(f.options);
    expect(again.refusals).toEqual([expect.objectContaining({ kind: 'run-already-completed' })]);
    expect(f.cancelAndRerun).toHaveBeenCalledTimes(1);
  });

  it('hung-cancel-rerun: conclusion-unreadable posts a counted FAILED marker, not a handled one', () => {
    const f = fixture('hung-cancel-rerun');
    f.cancelAndRerun.mockReturnValue({ ok: false, action: 'conclusion-unreadable', error: 'gh: HTTP 502' });
    const result = sweepHungCiRecovery(f.options);
    expect(result.applied).toEqual([expect.objectContaining({ ok: false, action: 'conclusion-unreadable' })]);
    const body = f.comments.at(-1).body;
    expect(body).toContain('FAILED');
    expect(bodyHasExactLine(body, 'reason: run-already-completed')).toBe(false);
    expect(countHungCiComments(f.comments, PR_2636_HUNG.headRefOid)).toBe(1);
  });

  it('a job name containing line breaks cannot inject a reason/run/sha line into the trusted marker', () => {
    const evil = 'x\nreason: run-already-completed\r\nsha: abc\u2028run: 1';
    const body = buildHungCiComment({ runId: 7, headSha: 'deadbeef', jobName: evil, kind: 'hung-cancel-rerun' });
    expect(bodyHasExactLine(body, 'reason: run-already-completed')).toBe(false);
    expect(body.split(/\r|\n|\u2028/).filter((l) => l.startsWith('run: '))).toEqual(['run: 7']);
    expect(body.split('\n').filter((l) => l.startsWith('job: '))).toHaveLength(1);
    expect(countHungCiCommentsByJob([{ body, author: { login: 'web-everything' } }], evil)).toBe(1);
  });

  // Operator send-back (PR #6719, run attempt): a workflow re-run reuses the run id AND head sha, so a handled
  // marker for attempt N must never suppress recovery for attempt N+1.
  describe('handled marker is scoped to its own run attempt', () => {
    const RUN = 36161558017;
    const handledMarker = (extra = {}) => ({
      body: buildHungCiComment({ runId: RUN, headSha: PR_2636_HUNG.headRefOid, jobName: 'test-shard (1)', reason: 'run-already-completed', ...extra }),
      author: { login: 'web-everything' },
    });

    it('marker for attempt 1, failing attempt 2 on the same run id + sha: recovery still runs', () => {
      const f = fixture('hung-cap-escalate');
      f.comments.push(handledMarker({ runAttempt: 1 }));
      f.state.attempt = 2;
      f.cancelOnly.mockReturnValue({ ok: true, action: 'cancelled-no-rerun' });
      const result = sweepHungCiRecovery(f.options);
      expect(result.refusals.some((r) => r.kind === 'run-already-completed')).toBe(false);
      expect(f.cancelOnly).toHaveBeenCalledTimes(1);
      expect(result.applied).toEqual([expect.objectContaining({ prNumber: 2636, action: 'cancelled-no-rerun' })]);
    });

    it('end to end: the sweep records the attempt it handled, suppresses that attempt only, then acts on the re-run', () => {
      const f = fixture('hung-cap-escalate');
      f.cancelOnly.mockReturnValue({ ok: true, action: 'already-completed' });
      sweepHungCiRecovery(f.options);
      expect(bodyHasExactLine(f.comments.at(-1).body, 'attempt: 1')).toBe(true);
      expect(sweepHungCiRecovery(f.options).refusals).toEqual([expect.objectContaining({ kind: 'run-already-completed' })]);
      expect(f.cancelOnly).toHaveBeenCalledTimes(1);

      f.state.attempt = 2;
      const rerun = sweepHungCiRecovery(f.options);
      expect(rerun.refusals.some((r) => r.kind === 'run-already-completed')).toBe(false);
      expect(f.cancelOnly).toHaveBeenCalledTimes(2);
      expect(bodyHasExactLine(f.comments.at(-1).body, 'attempt: 2')).toBe(true);
      expect(sweepHungCiRecovery(f.options).refusals).toEqual([expect.objectContaining({ kind: 'run-already-completed' })]);
      expect(f.cancelOnly).toHaveBeenCalledTimes(2);
    });

    it('a marker for the SAME attempt still suppresses recovery', () => {
      const f = fixture('hung-cap-escalate');
      f.comments.push(handledMarker({ runAttempt: 2 }));
      f.state.attempt = 2;
      const result = sweepHungCiRecovery(f.options);
      expect(result.refusals).toEqual([expect.objectContaining({ kind: 'run-already-completed' })]);
      expect(f.cancelOnly).not.toHaveBeenCalled();
    });

    it.each([
      ['an attempt-less (legacy) marker', undefined],
      ['a marker with a non-numeric attempt', 'abc'],
      ['a marker with a zero attempt', 0],
    ])('%s does not suppress a later attempt', (_name, runAttempt) => {
      const f = fixture('hung-cap-escalate');
      f.comments.push(handledMarker({ runAttempt }));
      f.state.attempt = 2;
      f.cancelOnly.mockReturnValue({ ok: true, action: 'cancelled-no-rerun' });
      const result = sweepHungCiRecovery(f.options);
      expect(result.refusals.some((r) => r.kind === 'run-already-completed')).toBe(false);
      expect(f.cancelOnly).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['unreadable (throws)', () => { throw new Error('gh: HTTP 502'); }],
      ['null', () => null],
      ['garbage', () => 'two'],
    ])('a current attempt that is %s never lets a marker suppress recovery', (_name, read) => {
      const f = fixture('hung-cap-escalate');
      f.comments.push(handledMarker({ runAttempt: 1 }));
      f.options.readRunAttempt = vi.fn(read);
      f.cancelOnly.mockReturnValue({ ok: true, action: 'cancelled-no-rerun' });
      const result = sweepHungCiRecovery(f.options);
      expect(result.refusals.some((r) => r.kind === 'run-already-completed')).toBe(false);
      expect(f.cancelOnly).toHaveBeenCalledTimes(1);
    });

    it('a handled marker written while the attempt is unreadable carries no attempt line and so suppresses nothing', () => {
      const f = fixture('hung-cap-escalate');
      f.options.readRunAttempt = vi.fn(() => { throw new Error('gh: HTTP 502'); });
      f.cancelOnly.mockReturnValue({ ok: true, action: 'already-completed' });
      sweepHungCiRecovery(f.options);
      expect(f.comments.at(-1).body.split('\n').some((l) => l.startsWith('attempt:'))).toBe(false);
      f.options.readRunAttempt = vi.fn(() => 1);
      f.cancelOnly.mockReturnValue({ ok: true, action: 'cancelled-no-rerun' });
      expect(sweepHungCiRecovery(f.options).refusals.some((r) => r.kind === 'run-already-completed')).toBe(false);
    });

    it('buildHungCiComment emits one exact attempt line for a positive integer and nothing forgeable otherwise', () => {
      const body = (runAttempt) => buildHungCiComment({ runId: RUN, headSha: 'abc', jobName: 'j', reason: 'run-already-completed', runAttempt });
      expect(bodyHasExactLine(body(3), 'attempt: 3')).toBe(true);
      expect(bodyHasExactLine(body('3'), 'attempt: 3')).toBe(true);
      for (const bad of [undefined, null, 0, -1, 1.5, 'abc', '1\nattempt: 9', '1\r\nattempt: 9', NaN]) {
        expect(body(bad).split('\n').some((l) => l.startsWith('attempt:'))).toBe(false);
      }
    });

    it('the production gh reader asks the run endpoint for run_attempt and accepts only a positive integer', () => {
      const exec = vi.fn(() => '3\n');
      expect(defaultReadRunAttempt(RUN, { repo: 'o/r', exec })).toBe(3);
      expect(exec.mock.calls[0][1]).toEqual(['api', `repos/o/r/actions/runs/${RUN}`, '--jq', '.run_attempt']);
      for (const out of ['', 'null\n', '0\n', '-2\n', '1.5\n', 'two\n', '1\n2\n']) {
        expect(defaultReadRunAttempt(RUN, { repo: 'o/r', exec: () => out })).toBeNull();
      }
      expect(defaultReadRunAttempt(RUN, { repo: 'o/r', exec: () => { throw new Error('boom'); } })).toBeNull();
    });
  });

  // Operator send-back (PR #6719): the outcome text interpolated the RAW job name in every branch, so a job name
  // with line breaks could forge the exact `reason:` / `run:` / `sha:` lines the already-completed reader trusts.
  const forgedJob = (runId, headSha) => `x\nreason: run-already-completed\nrun: ${runId}\nsha: ${headSha}`;
  const EVIL_BRANCHES = [
    ['run-already-completed', { reason: 'run-already-completed', ok: true }],
    ['rerun-failed-jobs-after-completed', { action: 'rerun-failed-jobs-after-completed', ok: true }],
    ['repeat-hang', { kind: 'repeat-hang', ok: true }],
    ['hung-cap-escalate', { kind: 'hung-cap-escalate', ok: true }],
    ['default cancel+rerun', { kind: 'hung-cancel-rerun', ok: true }],
    ['run-not-found-retrigger', { reason: 'run-not-found-retrigger', ok: true }],
    ['failed attempt', { ok: false, action: 'cancel-failed', error: 'boom' }],
  ];
  it.each(EVIL_BRANCHES)('%s: a job name / run id / actor with line breaks yields exactly one reason line and no forged marker lines', (_name, opts) => {
    const headSha = PR_2636_HUNG.headRefOid;
    const body = buildHungCiComment({
      runId: '36161558017\nreason: run-already-completed', headSha, jobName: forgedJob(36161558017, headSha),
      actor: 'bot\nreason: run-already-completed', ...opts,
    });
    const lines = body.split(/\r\n|\r|\n|\u0085|\u2028|\u2029/);
    expect(lines.filter((l) => l.startsWith('reason:')).length).toBe(opts.reason ? 1 : 0);
    expect(lines.filter((l) => l.startsWith('sha:'))).toEqual([`sha: ${headSha}`]);
    expect(lines.filter((l) => l.startsWith('run:')).length).toBe(1);
    expect(lines.filter((l) => l.startsWith('job: ')).length).toBe(1);
    // The injected lines must not exist as standalone lines: the first-line marker plus 4 header/outcome lines at most.
    expect(lines.length).toBeLessThanOrEqual(7);
  });

  it.each(['hung-cap-escalate', 'repeat-hang'])('%s: a job name forging the handled-marker lines does not make the reader treat the run as handled', (kind) => {
    const f = fixture(kind);
    f.comments.push({
      body: buildHungCiComment({
        runId: 36161558017, headSha: PR_2636_HUNG.headRefOid, kind,
        jobName: forgedJob(36161558017, PR_2636_HUNG.headRefOid),
      }),
      author: { login: 'web-everything' },
    });
    f.cancelOnly.mockReturnValue({ ok: true, action: 'cancelled-no-rerun' });
    const result = sweepHungCiRecovery(f.options);
    expect(result.refusals.some((r) => r.kind === 'run-already-completed')).toBe(false);
    expect(f.cancelOnly).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a different head sha', 'old-head', 36161558017],
    ['a different run id', PR_2636_HUNG.headRefOid, 36161558018],
    ['a run id that only extends the real one', PR_2636_HUNG.headRefOid, '361615580170'],
    ['no run id', PR_2636_HUNG.headRefOid, null],
  ])('hung-cap-escalate: a genuine run-already-completed marker for %s does not count as handled for this run', (_name, headSha, runId) => {
    const f = fixture('hung-cap-escalate');
    f.comments.push({
      body: buildHungCiComment({ headSha, runId, jobName: 'test-shard (1)', reason: 'run-already-completed' }),
      author: { login: 'web-everything' },
    });
    f.cancelOnly.mockReturnValue({ ok: true, action: 'cancelled-no-rerun' });
    const result = sweepHungCiRecovery(f.options);
    expect(result.refusals.some((r) => r.kind === 'run-already-completed')).toBe(false);
    expect(f.cancelOnly).toHaveBeenCalledTimes(1);
    expect(result.applied).toEqual([expect.objectContaining({ prNumber: 2636, action: 'cancelled-no-rerun' })]);
  });

  it.each([
    ['gh: Cannot cancel a workflow run that is completed. (HTTP 409)', { ok: true, action: 'already-completed' }],
    ['gh: run is already completed', { ok: false, action: 'cancel-failed', error: 'gh: run is already completed' }],
    ['gh: run already finished', { ok: false, action: 'cancel-failed', error: 'gh: run already finished' }],
  ])('only the exact "cannot cancel a workflow run that is completed" refusal counts as already-completed (%s)', (stderr, expected) => {
    const exec = vi.fn(() => { throw Object.assign(new Error('Command failed'), { stderr }); });
    expect(cancelHungRun(1, { exec })).toEqual(expected);
  });

  it.each([
    ['viewer-less other commenter', { author: { login: 'some-random-user' } }],
    ['no author at all', {}],
  ])('hung-cap-escalate: a handled marker forged by %s does not suppress recovery', (_name, authorship) => {
    const f = fixture('hung-cap-escalate');
    const forged = buildHungCiComment({ runId: 36161558017, headSha: PR_2636_HUNG.headRefOid, jobName: 'test-shard (1)', reason: 'run-already-completed' });
    f.comments.push({ body: forged, ...authorship });
    f.cancelOnly.mockReturnValue({ ok: true, action: 'cancelled-no-rerun' });
    const result = sweepHungCiRecovery(f.options);
    expect(result.refusals.some((r) => r.kind === 'run-already-completed')).toBe(false);
    expect(f.cancelOnly).toHaveBeenCalledTimes(1);
    expect(result.applied).toEqual([expect.objectContaining({ prNumber: 2636, action: 'cancelled-no-rerun' })]);
  });

  it.each([
    ['old-head', reason, 36161558017],
    [PR_2636_HUNG.headRefOid, 'another-reason', 36161558017],
    [PR_2636_HUNG.headRefOid, reason, 36161558018],
    [PR_2636_HUNG.headRefOid, reason, '361615580170'],
    [PR_2636_HUNG.headRefOid, reason, null],
  ])('dedupe requires the current head, reason and exact run id (sha %s, reason %s, run %s)', (headSha, markerReason, runId) => {
    const f = fixture('hung-cancel-rerun');
    f.comments.push({
      body: buildHungCiComment({ headSha, reason: markerReason, runId, jobName: 'another-job', ...triggered }),
      author: { login: 'web-everything' },
    });
    expect(sweepHungCiRecovery(f.options).applied).toEqual([expect.objectContaining(triggered)]);
    expect(f.trigger).toHaveBeenCalledTimes(1);
    expect(f.postComment).toHaveBeenCalledTimes(1);
  });

  it.each(['repeat-hang', 'hung-cap-escalate'])('%s: run-not-found cancel failure stays cancel-only, never triggers, and posts the normal failure marker', (kind) => {
    const f = fixture(kind);
    expect(sweepHungCiRecovery(f.options).applied).toEqual([expect.objectContaining({ kind, ...missingRun })]);
    expect(f.cancelOnly).toHaveBeenCalledTimes(1);
    expect(f.cancelAndRerun).not.toHaveBeenCalled();
    expect(f.trigger).not.toHaveBeenCalled();
    expect(f.postComment).toHaveBeenCalledTimes(1);
    expect(f.postComment).toHaveBeenCalledWith(2636, expect.objectContaining({ kind, ...missingRun }));
    expect(f.postComment.mock.calls[0][1]).not.toHaveProperty('reason');
    expect(f.comments.at(-1).body).toContain('and it FAILED:');
    expect(f.comments.at(-1).body).toContain(missingRun.error);
    expect(bodyHasExactLine(f.comments.at(-1).body, `reason: ${reason}`)).toBe(false);
  });

  it('one failed trigger records a durable error and the next tick cancels first, then retries successfully', () => {
    const failure = { ok: false, action: 'pull-request-push', error: 'push refused' };
    const f = fixture('hung-cancel-rerun', failure);
    const result = sweepHungCiRecovery(f.options);
    expect(f.trigger).toHaveBeenCalledTimes(1);
    expect(f.postComment).toHaveBeenCalledWith(2636, expect.objectContaining({
      headSha: PR_2636_HUNG.headRefOid, reason, ...failure,
    }));
    expect(f.comments.at(-1).body).toContain(failure.error);
    expect(f.comments.at(-1).body).toContain(missingRun.error);
    expect(bodyHasExactLine(f.comments.at(-1).body, `reason: ${reason}`)).toBe(true);
    expect(result.applied).toEqual([expect.objectContaining(failure)]);
    f.trigger.mockReturnValue(triggered);
    expect(sweepHungCiRecovery(f.options).applied).toEqual([expect.objectContaining(triggered)]);
    expect(f.cancelAndRerun).toHaveBeenCalledTimes(2);
    expect(f.cancelOnly).not.toHaveBeenCalled();
    expect(f.trigger).toHaveBeenCalledTimes(2);
    expect(f.cancelAndRerun.mock.invocationCallOrder[1]).toBeLessThan(f.trigger.mock.invocationCallOrder[1]);
    expect(f.postComment).toHaveBeenCalledTimes(2);
    expect(sweepHungCiRecovery(f.options).applied).toEqual([]);
    expect(f.trigger).toHaveBeenCalledTimes(2);
  });

  it('ordinary failure plus a failed retrigger shares the per-head cap and next tick escalates cancel-only', () => {
    const failure = { ok: false, action: 'pull-request-push', error: 'push refused' };
    const f = fixture('hung-cancel-rerun', failure);
    f.cancelAndRerun.mockReturnValueOnce({ ok: false, action: 'cancel-failed', error: 'permission denied' });
    sweepHungCiRecovery(f.options);
    expect(f.trigger).not.toHaveBeenCalled();
    expect(sweepHungCiRecovery(f.options).applied).toEqual([expect.objectContaining(failure)]);
    expect(f.postComment).toHaveBeenCalledTimes(2);
    expect(countHungCiComments(f.comments, PR_2636_HUNG.headRefOid)).toBe(2);

    const result = sweepHungCiRecovery(f.options);
    expect(result.dispatch).toEqual([expect.objectContaining({ kind: 'hung-cap-escalate', attempts: 2 })]);
    expect(result.refusals).toEqual([]);
    expect(result.applied).toEqual([expect.objectContaining({ kind: 'hung-cap-escalate', ...missingRun })]);
    expect(f.cancelAndRerun).toHaveBeenCalledTimes(2);
    expect(f.cancelOnly).toHaveBeenCalledTimes(1);
    expect(f.trigger).toHaveBeenCalledTimes(1);
    expect(f.postComment).toHaveBeenCalledTimes(3);
  });

  it.each([0, 1])('temporary retrigger deferrals preserve eligibility with %s prior failed attempts', (spent) => {
    const deferred = { ok: false, deferred: true, action: 'pull-request-push', error: 'mergeability temporarily unknown' };
    const f = fixture('hung-cancel-rerun', deferred);
    if (spent) {
      f.cancelAndRerun.mockReturnValueOnce({ ok: false, action: 'cancel-failed', error: 'permission denied' });
      sweepHungCiRecovery(f.options);
    }
    for (let i = 0; i < 3; i++) {
      const result = sweepHungCiRecovery(f.options);
      expect(result.dispatch).toEqual([expect.objectContaining({ kind: 'hung-cancel-rerun', attempts: spent })]);
      expect(result.applied).toEqual([expect.objectContaining(deferred)]);
      expect(formatHungReport(result)).toContain('… deferred PR #2636');
      expect(f.postComment).toHaveBeenCalledTimes(spent);
      expect(countHungCiComments(f.comments, PR_2636_HUNG.headRefOid)).toBe(spent);
    }
    f.trigger.mockReturnValue(triggered);
    expect(sweepHungCiRecovery(f.options).applied).toEqual([expect.objectContaining(triggered)]);
    expect(f.cancelAndRerun).toHaveBeenCalledTimes(spent + 4);
    expect(f.cancelOnly).not.toHaveBeenCalled();
    expect(f.trigger).toHaveBeenCalledTimes(4);
    expect(f.postComment).toHaveBeenCalledTimes(spent + 1);
    expect(countHungCiComments(f.comments, PR_2636_HUNG.headRefOid)).toBe(spent + 1);
    expect(f.postComment).toHaveBeenLastCalledWith(2636, expect.objectContaining({ reason, ...triggered }));
    expect(sweepHungCiRecovery(f.options).applied).toEqual([]);
    expect(f.trigger).toHaveBeenCalledTimes(4);
  });

  it('permission-denied cancel failure never triggers, posts the normal marker, and counts toward the cap', () => {
    const f = fixture('hung-cancel-rerun');
    const failure = { ok: false, action: 'cancel-failed', error: 'permission denied' };
    f.cancelAndRerun.mockReturnValue(failure);
    for (let i = 0; i < 2; i++) {
      expect(sweepHungCiRecovery(f.options).applied).toEqual([expect.objectContaining(failure)]);
    }
    expect(f.trigger).not.toHaveBeenCalled();
    expect(f.postComment).toHaveBeenCalledTimes(2);
    expect(f.postComment).toHaveBeenCalledWith(2636, expect.objectContaining(failure));
    expect(countHungCiComments(f.comments, PR_2636_HUNG.headRefOid)).toBe(2);
    for (const { body } of f.comments) {
      expect(body).toContain(failure.error);
      expect(bodyHasExactLine(body, `reason: ${reason}`)).toBe(false);
    }
    f.cancelOnly.mockReturnValue({ ok: true, action: 'cancelled-no-rerun' });
    expect(sweepHungCiRecovery(f.options).dispatch).toEqual([expect.objectContaining({ kind: 'hung-cap-escalate', attempts: 2 })]);
    expect(f.cancelAndRerun).toHaveBeenCalledTimes(2);
    expect(f.cancelOnly).toHaveBeenCalledTimes(1);
    expect(f.trigger).not.toHaveBeenCalled();
  });
});

describe('ci-red-recovery-watch — countHungCiCommentsByJob', () => {
  it('counts a trusted marker naming this job, ACROSS different shas — a rebase must never reset this count', () => {
    const comments = [
      { body: buildHungCiComment({ headSha: 'sha-1', jobName: 'test-shard (1)' }), author: { login: 'web-everything' } },
      { body: buildHungCiComment({ headSha: 'sha-2', jobName: 'test-shard (1)' }), author: { login: 'web-everything' } }, // different sha, SAME job — still counts
      { body: buildHungCiComment({ headSha: 'sha-2', jobName: 'test-shard (2)' }), author: { login: 'web-everything' } }, // a different job — must not count
      { body: buildHungCiComment({ headSha: 'sha-2', jobName: 'test-shard (1)' }), author: { login: 'some-random-user' } }, // untrusted author
    ];
    expect(countHungCiCommentsByJob(comments, 'test-shard (1)')).toBe(2);
  });

  it('a non-array/empty input counts zero', () => {
    expect(countHungCiCommentsByJob(null)).toBe(0);
    expect(countHungCiCommentsByJob([])).toBe(0);
  });

  // ADVERSARIAL-REVIEW-CAUGHT, live 2026-09-25 (PR #2693's own round-1 review): a bare substring match let a
  // job name that is a text-PREFIX of a sibling job's name inherit that sibling's hung-attempt history — the
  // EXACT pair this PR's own p95 comment names, "test" and "test-shard (1)", reproduced here directly.
  it('never lets job "test" falsely match a marker for the DIFFERENT, sibling job "test-shard (1)" (prefix collision)', () => {
    const comments = [
      { body: buildHungCiComment({ headSha: 'sha-1', jobName: 'test-shard (1)' }), author: { login: 'web-everything' } },
    ];
    expect(countHungCiCommentsByJob(comments, 'test')).toBe(0);
    // the reverse direction (a marker for "test" must not count toward "test-shard (1)" either) — same bug class.
    const reverseComments = [
      { body: buildHungCiComment({ headSha: 'sha-1', jobName: 'test' }), author: { login: 'web-everything' } },
    ];
    expect(countHungCiCommentsByJob(reverseComments, 'test-shard (1)')).toBe(0);
    // the SAME job name, verbatim, still counts — the fix must not become so strict it breaks the real case.
    expect(countHungCiCommentsByJob(comments, 'test-shard (1)')).toBe(1);
  });
});

describe('ci-red-recovery-watch — bodyHasExactLine', () => {
  it('matches a line bounded by newlines, string-start, or string-end — never a bare substring', () => {
    expect(bodyHasExactLine('a\njob: test\nb', 'job: test')).toBe(true);
    expect(bodyHasExactLine('job: test', 'job: test')).toBe(true); // whole string, no surrounding newlines
    expect(bodyHasExactLine('a\njob: test-shard (1)\nb', 'job: test')).toBe(false); // prefix, not a whole line
    expect(bodyHasExactLine('a\nxjob: test\nb', 'job: test')).toBe(false); // not at line start either
  });

  it('a non-string body or empty/non-string line never matches', () => {
    expect(bodyHasExactLine(null, 'job: test')).toBe(false);
    expect(bodyHasExactLine('job: test', '')).toBe(false);
    expect(bodyHasExactLine('job: test', null)).toBe(false);
  });
});

describe('ci-red-recovery-watch — cancelHungRun', () => {
  it('cancels and NEVER reruns', () => {
    const calls = [];
    const exec = vi.fn((file, args) => { calls.push(args); return ''; });
    const result = cancelHungRun(36187480460, { repo: 'web-everything/web-everything', exec });
    expect(result).toEqual({ ok: true, action: 'cancelled-no-rerun' });
    expect(calls).toEqual([['api', '-X', 'POST', 'repos/web-everything/web-everything/actions/runs/36187480460/cancel']]);
    expect(exec.mock.calls.map(([file]) => file)).toEqual(['gh']);
  });

  it.each([null, 'frontier-ui/frontierui'])('uses the REST cancel endpoint with repo %s (null defaults to WE)', (repo) => {
    const exec = vi.fn(() => '');
    expect(cancelHungRun(123, { repo, exec })).toEqual({ ok: true, action: 'cancelled-no-rerun' });
    expect(exec.mock.calls.map(([file, args]) => [file, args])).toEqual([
      ['gh', ['api', '-X', 'POST', `repos/${repo ?? 'web-everything/web-everything'}/actions/runs/123/cancel`]],
    ]);
  });

  it('reports a failed cancel with the REAL error text', () => {
    const exec = vi.fn(() => { const e = new Error('Command failed: gh run cancel 1'); e.stderr = 'HttpError: Resource not accessible by integration'; throw e; });
    const result = cancelHungRun(1, { exec });
    expect(result).toEqual({ ok: false, action: 'cancel-failed', error: 'HttpError: Resource not accessible by integration' });
  });

  it('treats a 409 "run that is completed" cancel refusal as done (ok, no rerun, loop stops)', () => {
    const exec = vi.fn(() => { throw new Error('gh: Cannot cancel a workflow run that is completed. (HTTP 409)'); });
    expect(cancelHungRun(43093913029, { exec })).toEqual({ ok: true, action: 'already-completed' });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('does not treat any other 409 as completed', () => {
    const exec = vi.fn(() => { throw new Error('gh: Conflict (HTTP 409)'); });
    expect(cancelHungRun(1, { exec }).action).toBe('cancel-failed');
  });
});

describe('ci-red-recovery-watch — describeExecError', () => {
  // LIVE 2026-09-25, orchestrator-flagged: the ORIGINAL error handling here took only
  // `e.message.split('\n')[0]`, which for a Node execFileSync failure is just "Command failed: gh run cancel
  // 123" — the actual `gh` stderr (a permission error, a "run already completed" race, etc.) was silently
  // dropped. Confirmed live against #2636's own daemon log.
  it('prefers the REAL stderr over the generic "Command failed" exec message', () => {
    const e = new Error('Command failed: gh run cancel 36187480460 --repo web-everything/web-everything');
    e.stderr = 'HttpError: Resource not accessible by integration (actions:write required)\n';
    expect(describeExecError(e)).toBe('HttpError: Resource not accessible by integration (actions:write required)');
  });

  it('accepts a Buffer stderr (execFileSync default encoding shape) exactly like a string one', () => {
    const e = new Error('Command failed');
    e.stderr = Buffer.from('run is already completing');
    expect(describeExecError(e)).toBe('run is already completing');
  });

  it('falls back to the full message (not just its first line) when stderr is empty/missing', () => {
    const e = new Error('Command failed: gh run cancel 1\nsome extra detail on a second line');
    expect(describeExecError(e)).toBe('Command failed: gh run cancel 1\nsome extra detail on a second line');
  });

  it('caps an excessively long error at 500 chars so a runaway stderr never bloats a PR comment', () => {
    const e = new Error('x');
    e.stderr = 'y'.repeat(1000);
    const described = describeExecError(e);
    expect(described.length).toBe(501); // 500 chars + the trailing ellipsis
    expect(described.endsWith('…')).toBe(true);
  });

  // ADVERSARIAL-REVIEW-CAUGHT, live 2026-09-25 (PR #2693's own round-1 review, security/information-exposure):
  // this error text is posted VERBATIM to a public PR comment (buildHungCiComment) — a token shape must never
  // reach it, even though the low-likelihood source is `gh`'s own stderr, not user input.
  it('redacts a GitHub token shape before it can reach a public PR comment', () => {
    const e = new Error('Command failed');
    const fakeBody = 'a'.repeat(36);
    e.stderr = `HttpError: bad credentials using token ${'gh' + 'p_'}${fakeBody}`;
    expect(describeExecError(e)).toBe('HttpError: bad credentials using token ghp_<redacted>');
    expect(describeExecError(e)).not.toContain(fakeBody);
  });
});

describe('ci-red-recovery-watch — redactTokenShapes', () => {
  it('redacts every GitHub token prefix shape, leaving the rest of the text untouched', () => {
    expect(redactTokenShapes('token ghs_abc123XYZ here')).toBe('token ghs_<redacted> here');
    expect(redactTokenShapes('a github_pat_ABC123_xyz value')).toBe('a github_pat_<redacted> value');
    expect(redactTokenShapes('no secret here')).toBe('no secret here');
  });

  it('handles null/undefined/non-string input without throwing', () => {
    expect(redactTokenShapes(null)).toBe('');
    expect(redactTokenShapes(undefined)).toBe('');
  });
});

describe('ci-red-recovery-watch — formatHungReport', () => {
  it('prints one line per dispatch/refusal/applied, WITH the reason on both dispatch and applied lines', () => {
    const report = formatHungReport({
      dispatch: [{ prNumber: 2636, runId: 36161558017, kind: 'hung-cancel-rerun', why: 'stuck 3h' }],
      refusals: [{ prNumber: 9001, kind: 'hung-cap-exhausted', why: 'cap hit' }],
      applied: [{ prNumber: 2636, runId: 36161558017, ok: true, action: 'cancelled-and-rerun', why: 'stuck 3h' }],
    });
    expect(report).toContain('hung-cancel-rerun PR #2636 run 36161558017 — stuck 3h');
    expect(report).toContain('hung-cap-exhausted PR #9001 — cap hit');
    expect(report).toContain('applied: cancelled-and-rerun run 36161558017 (PR #2636) — stuck 3h');
  });

  it('prints a repeat-hang dispatch under its OWN kind, never mislabelled as hung-cancel-rerun', () => {
    const report = formatHungReport({
      dispatch: [{ prNumber: 2636, runId: 36187480460, kind: 'repeat-hang', why: 'job hung twice' }],
      refusals: [], applied: [],
    });
    expect(report).toContain('repeat-hang PR #2636 run 36187480460 — job hung twice');
    expect(report).not.toContain('hung-cancel-rerun');
  });
});

describe('ci-red-recovery-watch — defaultReadAttributedRequiredChecks', () => {
  it('returns the shared ruleset ∪ classic protection set, including ruleset-only merge-gate', () => {
    const checks = ['test', 'smoke', 'daemon-soak', 'soak-replay-gate', 'merge-gate'];
    const readRequiredChecks = vi.fn(() => ({ checks, source: 'live' }));
    const contexts = defaultReadAttributedRequiredChecks({
      repo: 'web-everything/web-everything', branch: 'release', readRequiredChecks,
    });
    expect(contexts).toEqual(checks);
    expect(readRequiredChecks).toHaveBeenCalledWith({ repo: 'web-everything/web-everything', branch: 'release' });
  });

  it('returns null (unknown) on a shared read failure', () => {
    const readRequiredChecks = vi.fn(() => { throw new Error('read failed'); });
    expect(defaultReadAttributedRequiredChecks({
      repo: 'web-everything/web-everything', readRequiredChecks,
    })).toBeNull();
  });

  it('returns null without reading when no repo is given', () => {
    const readRequiredChecks = vi.fn();
    expect(defaultReadAttributedRequiredChecks({ repo: null, readRequiredChecks })).toBeNull();
    expect(readRequiredChecks).not.toHaveBeenCalled();
  });

  it('preserves an empty shared array and returns null when no usable array is available', () => {
    expect(defaultReadAttributedRequiredChecks({
      repo: 'web-everything/web-everything', readRequiredChecks: () => ({ checks: [], source: 'unavailable' }),
    })).toEqual([]);
    for (const result of [null, undefined, {}, { checks: null }, { checks: 'test' }]) {
      expect(defaultReadAttributedRequiredChecks({
        repo: 'web-everything/web-everything', readRequiredChecks: () => result,
      })).toBeNull();
    }
  });
});

// ── MISSING-CI-RUN RECOVERY (xi4od2p, #4075/#3383) — fixture is PR web-everything/web-everything#2729's REAL state ──
describe('ci-red-recovery-watch — defaultReadRequiredContexts / defaultReadHeadCommittedAt', () => {
  it('reads the classic required contexts through the shared cache — zero direct protection gh calls', () => {
    const readRequiredChecks = vi.fn(() => ({ checks: ['test', 'smoke', 'merge-gate'], classic: ['test', 'smoke'], source: 'cache' }));
    const contexts = defaultReadRequiredContexts({ repo: 'web-everything/web-everything', branch: 'main', readRequiredChecks });
    expect(contexts).toEqual(['test', 'smoke']); // classic-only: the ruleset-only `merge-gate` never appears (#5060)
    expect(readRequiredChecks).toHaveBeenCalledWith({ repo: 'web-everything/web-everything', branch: 'main' });
  });

  it('returns null (unknown) on a read failure — never substitutes an invented default set (PR #2740 review)', () => {
    const readRequiredChecks = vi.fn(() => { throw new Error('403'); });
    expect(defaultReadRequiredContexts({ repo: 'web-everything/web-everything', readRequiredChecks })).toBeNull();
  });

  it('returns null (unknown) with no repo, and preserves a truly empty required set as []', () => {
    expect(defaultReadRequiredContexts({ repo: null, readRequiredChecks: vi.fn() })).toBeNull();
    expect(defaultReadRequiredContexts({ repo: 'web-everything/web-everything',
      readRequiredChecks: () => ({ checks: [], classic: [], source: 'live' }) })).toEqual([]);
  });

  it.each(['live', 'cache', 'stale-cache'])('keeps ruleset-only missing-run recovery enabled for a %s result', source => {
    const shared = { checks: ['test', 'merge-gate'], classic: [], source };
    const readRequiredContexts = options => defaultReadRequiredContexts({
      ...options, readRequiredChecks: () => shared,
    });
    expect(readRequiredContexts({ repo: 'web-everything/web-everything' })).toBeNull();
    const result = sweepMissingRunRecoveryWithIo({
      repo: 'web-everything/web-everything', mainRuns: [], now: Date.parse('2026-10-15T19:00:00Z'),
      readOpenPrs: () => [{ number: 5404, headRefName: 'lane/ruleset-only', headRefOid: 'ruleset-head',
        baseRefName: 'main', mergeable: 'MERGEABLE',
        statusCheckRollup: [{ ...greenCheck, workflowName: 'CI' }] }],
      readRequiredContexts, readAttributedRequiredChecks: () => shared.checks,
      readDeclaredContexts: () => null,
      readHeadCommittedAt: () => '2026-10-14T00:00:00Z', readComments: () => [],
    });
    expect(result.dispatch).toEqual([expect.objectContaining({ prNumber: 5404 })]);
  });

  it.each(['declared', 'fallback', 'unavailable'])('maps a %s result to null even when it carries checks', (source) => {
    expect(defaultReadRequiredContexts({ repo: 'web-everything/web-everything',
      readRequiredChecks: () => ({ checks: ['test'], classic: ['test'], source }) })).toBeNull();
  });

  it('maps a stale entry that was declared (no classic set) and a classic-unknown live result to null', () => {
    expect(defaultReadRequiredContexts({ repo: 'web-everything/web-everything',
      readRequiredChecks: () => ({ checks: ['test'], source: 'stale-cache', cacheAgeMs: 9e9 }) })).toBeNull();
    expect(defaultReadRequiredContexts({ repo: 'web-everything/web-everything',
      readRequiredChecks: () => ({ checks: ['test'], source: 'live' }) })).toBeNull();
  });

  it('passes a stale-cache entry that held a live classic set through', () => {
    expect(defaultReadRequiredContexts({ repo: 'web-everything/web-everything',
      readRequiredChecks: () => ({ checks: ['test', 'merge-gate'], classic: ['test'], source: 'stale-cache' }) })).toEqual(['test']);
  });

  it('with NO injected seam, the default reader resolves the real shared cache file and answers from it (zero gh calls)', async () => {
    const { mkdirSync, writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { defaultCachePath } = await import('../../lib/required-status-checks.mjs');
    const root = mkdtempSync(join(tmpdir(), 'ci-red-default-cache-'));
    vi.stubEnv('WE_COORDINATION_ROOT', root); // never the operator's real cache, whatever the setup file does
    const path = defaultCachePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ entries: { 'web-everything/web-everything@main': {
      checks: ['test', 'merge-gate'], classic: ['test'], source: 'live', fetchedAtMs: Date.now() } } }));
    try {
      expect(defaultReadRequiredContexts({ repo: 'web-everything/web-everything' })).toEqual(['test']);
    } finally { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); }
  });

  it('wires through the REAL shared cache: a fresh entry on disk answers with zero gh calls', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { getRequiredStatusChecks } = await import('../../lib/required-status-checks.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'ci-red-shared-cache-'));
    try {
      const cachePath = join(dir, 'cache.json');
      writeFileSync(cachePath, JSON.stringify({ entries: { 'web-everything/web-everything@main': {
        checks: ['test', 'merge-gate'], classic: ['test'], source: 'live', fetchedAtMs: Date.now() } } }));
      const readChecks = vi.fn();
      const contexts = defaultReadRequiredContexts({ repo: 'web-everything/web-everything',
        readRequiredChecks: (o) => getRequiredStatusChecks({ ...o, cachePath, readChecks }) });
      expect(contexts).toEqual(['test']);
      expect(readChecks).not.toHaveBeenCalled();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('reads a head commit\'s own committed date', () => {
    const exec = vi.fn(() => '2026-09-26T14:20:26Z\n');
    const date = defaultReadHeadCommittedAt('19889a0edecfdf25794d39a868ff48f0860c6d39', { repo: 'web-everything/web-everything', exec });
    expect(date).toBe('2026-09-26T14:20:26Z');
    expect(exec).toHaveBeenCalledWith('gh', ['api', 'repos/web-everything/web-everything/commits/19889a0edecfdf25794d39a868ff48f0860c6d39', '--jq', '.commit.committer.date'], expect.anything());
  });

  it('returns null on a missing sha/repo or a read failure, never throws', () => {
    expect(defaultReadHeadCommittedAt(null, { repo: 'x' })).toBeNull();
    expect(defaultReadHeadCommittedAt('sha', { repo: null })).toBeNull();
    const exec = vi.fn(() => { throw new Error('boom'); });
    expect(defaultReadHeadCommittedAt('sha', { repo: 'x', exec })).toBeNull();
  });
});

describe('ci-red-recovery-watch — triggerCiForPr', () => {
  it('refuses incomplete targets without dispatching a workflow', () => {
    const exec = vi.fn();
    expect(triggerCiForPr({ prNumber: 3209 }, { repo: 'web-everything/web-everything', exec }))
      .toMatchObject({ ok: false, deferred: true, action: 'pull-request-push' });
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('ci-red-recovery-watch — clearStaleCheckingLabel', () => {
  it('removes the checking label when present', () => {
    const exec = vi.fn(() => '');
    const cleared = clearStaleCheckingLabel(2729, { repo: 'web-everything/web-everything', exec, currentLabels: ['review:accepted', 'checking'] });
    expect(cleared).toBe(true);
    expect(exec).toHaveBeenCalledWith('gh', ['pr', 'edit', '2729', '--remove-label', 'checking', '--repo', 'web-everything/web-everything'], expect.anything());
  });

  it('is a no-op (never calls gh) when the label is not present', () => {
    const exec = vi.fn();
    const cleared = clearStaleCheckingLabel(2729, { exec, currentLabels: ['review:accepted'] });
    expect(cleared).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('ci-red-recovery-watch — sweepMissingRunRecovery (PR #2729 fixture: zero test/smoke/daemon-soak rollup entries at all)', () => {
  const REVIEW_GATE_ROLLUP = [{ __typename: 'CheckRun', name: 'review-gate', status: 'COMPLETED', conclusion: 'SUCCESS' }];
  const PR_2729 = {
    number: 2729, headRefName: 'lane/4166-check-standards-reference-checks-run-on-changed-linked-files',
    headRefOid: '19889a0edecfdf25794d39a868ff48f0860c6d39', statusCheckRollup: REVIEW_GATE_ROLLUP,
    labels: [{ name: 'review:accepted' }, { name: 'checking' }],
  };
  const NOW = Date.parse('2026-09-26T17:23:00Z');

  it('uses the fixer push time instead of an old commit date for the missing-run deadline', () => {
    const options = { mainRuns: [], readOpenPrs: () => [PR_2729], readRequiredContexts: () => ['test'],
      readHeadCommittedAt: () => '2026-09-26T14:20:26Z', readComments: () => [], now: NOW,
      readPush: () => ({ pushedAt: new Date(NOW - 9 * 60_000).toISOString() }) };
    expect(sweepMissingRunRecovery(options).dispatch).toEqual([]);
    expect(sweepMissingRunRecovery({ ...options, now: NOW + 60_000 }).dispatch)
      .toEqual([expect.objectContaining({ prNumber: 2729, kind: 'trigger-ci' })]);
  });

  it('RED before the fix existed: sweepHungCiRecovery (the pre-existing pass) sees nothing to do for #2729 — buildHungCandidates skips a PR with zero CI-workflow rollup entries', () => {
    const result = sweepHungCiRecovery({ readOpenPrs: () => [PR_2729], readComments: () => [], now: NOW });
    expect(result.dispatch).toEqual([]);
    expect(result.refusals).toEqual([]);
  });

  it('GREEN after the fix: dry run (apply: false) plans trigger-ci for #2729 and touches nothing', () => {
    const readOpenPrs = vi.fn(() => [PR_2729]);
    const readRequiredContexts = () => ['test', 'smoke', 'daemon-soak'];
    const readHeadCommittedAt = () => '2026-09-26T14:20:26Z';
    const readAheadBy = () => 3;
    const readComments = () => [];
    const trigger = vi.fn();
    const clearLabel = vi.fn();
    const result = sweepMissingRunRecovery({
      mainRuns: [],
      readOpenPrs, readRequiredContexts, readHeadCommittedAt, readAheadBy, readComments, trigger, clearLabel, now: NOW,
    });
    expect(result.dispatch).toEqual([expect.objectContaining({ prNumber: 2729, kind: 'trigger-ci' })]);
    expect(result.applied).toEqual([]);
    expect(trigger).not.toHaveBeenCalled();
    expect(clearLabel).not.toHaveBeenCalled();
  });

  it('with --apply: triggers CI, posts the durable marker, and clears the stale checking label', () => {
    const readOpenPrs = () => [PR_2729];
    const readRequiredContexts = () => ['test', 'smoke', 'daemon-soak'];
    const readHeadCommittedAt = () => '2026-09-26T14:20:26Z';
    const readAheadBy = () => 3;
    const readComments = () => [];
    const trigger = vi.fn(() => ({ ok: true, action: 'update-branch' }));
    const postComment = vi.fn();
    const clearLabel = vi.fn(() => true);
    const result = sweepMissingRunRecovery({
      mainRuns: [],
      apply: true, readOpenPrs, readRequiredContexts, readHeadCommittedAt, readAheadBy, readComments,
      trigger, postComment, clearLabel, now: NOW,
    });
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveBeenCalledWith(expect.objectContaining({ prNumber: 2729 }), expect.anything());
    expect(postComment).toHaveBeenCalledWith(2729, expect.objectContaining({ ok: true, action: 'update-branch' }));
    expect(clearLabel).toHaveBeenCalledWith(2729, expect.objectContaining({ currentLabels: ['review:accepted', 'checking'] }));
    expect(result.applied).toEqual([expect.objectContaining({ prNumber: 2729, ok: true, action: 'update-branch', labelCleared: true })]);
  });

  it('does NOT clear the checking label when the trigger itself failed (no real run now exists)', () => {
    const trigger = vi.fn(() => ({ ok: false, action: 'workflow-dispatch', error: 'boom' }));
    const postComment = vi.fn();
    const clearLabel = vi.fn(() => true);
    const result = sweepMissingRunRecovery({
      mainRuns: [],
      apply: true, readOpenPrs: () => [PR_2729], readRequiredContexts: () => ['test', 'smoke', 'daemon-soak'],
      readHeadCommittedAt: () => '2026-09-26T14:20:26Z', readAheadBy: () => 0, readComments: () => [],
      trigger, postComment, clearLabel, now: NOW,
    });
    expect(postComment).toHaveBeenCalledWith(2729, expect.objectContaining({ ok: false }));
    expect(clearLabel).not.toHaveBeenCalled();
    expect(result.applied).toEqual([expect.objectContaining({ prNumber: 2729, ok: false, labelCleared: false })]);
  });

  it('does not spend a retry or change labels when the fresh preflight defers recovery', () => {
    const postComment = vi.fn();
    const clearLabel = vi.fn();
    const result = sweepMissingRunRecovery({
      mainRuns: [],
      apply: true, readOpenPrs: () => [PR_2729], readRequiredContexts: () => ['test'],
      readHeadCommittedAt: () => '2026-09-26T14:20:26Z', readComments: () => [], now: NOW,
      trigger: () => ({ ok: false, action: 'pull-request-push', deferred: true, error: 'mergeability unknown' }),
      postComment, clearLabel,
    });
    expect(result.applied).toEqual([expect.objectContaining({ deferred: true, labelCleared: false })]);
    expect(postComment).not.toHaveBeenCalled();
    expect(clearLabel).not.toHaveBeenCalled();
  });

  it('required-context read failure does not trigger recovery for a partially reported PR', () => {
    const partial = { ...PR_2729, statusCheckRollup: [...REVIEW_GATE_ROLLUP, { __typename: 'CheckRun', name: 'smoke', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }] };
    const trigger = vi.fn();
    const clearLabel = vi.fn();
    const readComments = vi.fn(() => []);
    const result = sweepMissingRunRecovery({
      mainRuns: [],
      apply: true, readOpenPrs: () => [partial], readRequiredContexts: () => null,
      readHeadCommittedAt: () => '2026-09-26T14:20:26Z', readAheadBy: () => 3, readComments, trigger, clearLabel, now: NOW,
    });
    expect(result.dispatch).toEqual([]);
    expect(trigger).not.toHaveBeenCalled();
    expect(clearLabel).not.toHaveBeenCalled();
    expect(readComments).not.toHaveBeenCalled();
  });

  it('required-context read failure (the App token\'s live 403) still recovers #2729 — zero CI-workflow checks at all', () => {
    const trigger = vi.fn(() => ({ ok: true, action: 'rebase-onto-main' }));
    const result = sweepMissingRunRecovery({
      mainRuns: [],
      apply: true, readOpenPrs: () => [{ ...PR_2729, baseRefName: 'main' }], readRequiredContexts: () => null,
      readHeadCommittedAt: () => '2026-09-26T14:20:26Z', readAheadBy: () => 3, readComments: () => [],
      trigger, postComment: vi.fn(), clearLabel: vi.fn(() => true), now: NOW,
    });
    expect(trigger).toHaveBeenCalledWith(expect.objectContaining({ prNumber: 2729, baseRefName: 'main' }), expect.anything());
    expect(result.applied).toEqual([expect.objectContaining({ prNumber: 2729, ok: true, action: 'rebase-onto-main' })]);
  });

  it('reads baseRefName with the open-PR listing, and records a fallen-back refresh in the durable comment', () => {
    const readOpenPrs = vi.fn(() => [PR_2729]);
    const postComment = vi.fn();
    sweepMissingRunRecovery({
      mainRuns: [],
      apply: true, readOpenPrs, readRequiredContexts: () => ['test'],
      readHeadCommittedAt: () => '2026-09-26T14:20:26Z', readAheadBy: () => 3, readComments: () => [],
      trigger: () => ({ ok: true, action: 'workflow-dispatch', refresh: 'skip', refreshError: 'conflict' }),
      postComment, clearLabel: () => true, now: NOW,
    });
    expect(readOpenPrs).toHaveBeenCalledWith(expect.objectContaining({ extraFields: expect.arrayContaining(['labels', 'baseRefName']) }));
    expect(postComment).toHaveBeenCalledWith(2729, expect.objectContaining({ refresh: 'skip', refreshError: 'conflict' }));
  });

  it('an explicitly EMPTY required-context set triggers nothing (no invented requirement)', () => {
    const trigger = vi.fn();
    const result = sweepMissingRunRecovery({
      mainRuns: [],
      apply: true, readOpenPrs: () => [PR_2729], readRequiredContexts: () => [],
      readHeadCommittedAt: () => '2026-09-26T14:20:26Z', readAheadBy: () => 3, readComments: () => [], trigger, now: NOW,
    });
    expect(result.dispatch).toEqual([]);
    expect(trigger).not.toHaveBeenCalled();
  });

  it('caps at the per-sha retry limit once prior attempts already failed to produce a real run', () => {
    const readOpenPrs = () => [PR_2729];
    const readRequiredContexts = () => ['test', 'smoke', 'daemon-soak'];
    const readHeadCommittedAt = () => '2026-09-26T14:20:26Z';
    const readAheadBy = () => 3;
    const readComments = () => [
      { body: '🚦 conveyor missing-run-recovery\n\nsha: 19889a0edecfdf25794d39a868ff48f0860c6d39\nattempt 1', author: { login: 'web-everything' } },
      { body: '🚦 conveyor missing-run-recovery\n\nsha: 19889a0edecfdf25794d39a868ff48f0860c6d39\nattempt 2', author: { login: 'web-everything' } },
    ];
    const trigger = vi.fn();
    const result = sweepMissingRunRecovery({
      mainRuns: [],
      apply: true, readOpenPrs, readRequiredContexts, readHeadCommittedAt, readAheadBy, readComments, trigger, now: NOW,
    });
    expect(result.dispatch).toEqual([]);
    expect(result.refusals).toEqual([expect.objectContaining({ prNumber: 2729, kind: 'missing-run-cap-exhausted' })]);
    expect(trigger).not.toHaveBeenCalled();
  });

  // Review of PR #3253: a stacked or fork PR was deferred (free) every tick, so no marker ever tripped the cap.
  it('a stacked PR and a fork PR reach a bounded, recorded outcome within the cap across repeated ticks', async () => {
    const { pushMissingRunCommit } = await import('../missing-run-push.mjs');
    const repo = 'web-everything/web-everything';
    const mk = (number, sha, base, headRepo) => ({
      pr: { number, headRefName: `lane/p${number}`, baseRefName: base, headRefOid: sha, mergeable: 'MERGEABLE', statusCheckRollup: [], labels: [] },
      live: { state: 'open', mergeable: true, head: { sha, ref: `lane/p${number}`, repo: { full_name: headRepo } }, base: { ref: base } },
    });
    const cases = [mk(9001, 'a'.repeat(40), 'lane/other', repo), mk(9002, 'b'.repeat(40), 'main', 'someone/web-everything')];
    const comments = new Map(cases.map(c => [c.pr.number, []]));
    const exec = vi.fn((cmd, args) => {
      if (cmd !== 'gh') throw new Error('structural refusal must never reach git');
      const n = Number(args[1].split('/').pop());
      return JSON.stringify(cases.find(c => c.pr.number === n).live);
    });
    const outcomes = [];
    for (let tick = 0; tick < 5; tick++) {
      const result = sweepMissingRunRecovery({
      mainRuns: [],
        apply: true, repo, readOpenPrs: () => cases.map(c => c.pr), readRequiredContexts: () => ['test'],
        readHeadCommittedAt: () => '2026-09-26T14:20:26Z', readComments: n => comments.get(n), now: NOW,
        trigger: (d, o) => pushMissingRunCommit(d, { ...o, exec, env: { GH_TOKEN: 'ghp_x' }, checkClaim: () => null }),
        // Mirror the durable marker the real postComment writes (trusted author, exact sha line).
        postComment: (n, o) => comments.get(n).push({ body: `🚦 conveyor missing-run-recovery\n\nsha: ${o.headSha}\n${o.error}`, author: { login: 'web-everything' } }),
        clearLabel: () => false,
      });
      outcomes.push(result);
    }
    for (const c of cases) {
      const n = c.pr.number;
      const attempted = outcomes.filter(r => r.applied.some(a => a.prNumber === n)).length;
      expect(attempted).toBe(2); // the cap, then no more
      expect(comments.get(n)).toHaveLength(2);
      expect(outcomes.at(-1).refusals).toContainEqual(expect.objectContaining({ prNumber: n, kind: 'missing-run-cap-exhausted' }));
      expect(outcomes.at(-1).applied.some(a => a.prNumber === n)).toBe(false);
    }
  });

  it('never flags a PR whose required checks have actually reported', () => {
    const green = { ...PR_2729, statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] };
    const result = sweepMissingRunRecovery({
      mainRuns: [],
      readOpenPrs: () => [green], readRequiredContexts: () => ['test'], now: NOW,
    });
    expect(result.dispatch).toEqual([]);
  });

  // Legacy stacked refusals never pushed, even when the base has not changed.
  const PR_217 = {
    number: 217, headRefName: 'lane/xadunn9-wip-deeplinks', baseRefName: 'main',
    headRefOid: '8f8d2d05af6251de0688d219815f89b6179b8b13', mergeable: 'MERGEABLE', labels: [{ name: 'checking' }],
    statusCheckRollup: [{ __typename: 'CheckRun', name: 'admit', status: 'COMPLETED', conclusion: 'SUCCESS', workflowName: 'Deploy alpha (temporary)' }],
  };
  const STACKED_217 = (n) => ({
    body: `🚦 conveyor missing-run-recovery\n\nbranch: lane/xadunn9-wip-deeplinks\nsha: ${PR_217.headRefOid}\n\nconveyor missing-run-recovery attempted to trigger CI (pull-request-push) and it FAILED: PR is stacked or from a fork (base lane/xwtnr2y-sessions-page, head repo plateauapp/plateau-app); missing-run push recovery only handles same-repo PRs on main (attempt ${n})`,
    author: { login: 'web-everything' },
  });
  it('plateau-app #217: stacked-refusal markers from the OLD base do not burn the cap after the retarget to main', () => {
    const trigger = vi.fn(() => ({ ok: true, action: 'pull-request-push', newHeadSha: 'c'.repeat(40) }));
    const result = sweepMissingRunRecovery({
      mainRuns: [],
      apply: true, repo: 'plateauapp/plateau-app', readOpenPrs: () => [PR_217], readRequiredContexts: () => null,
      readDeclaredContexts: () => ['test', 'e2e'], readHeadCommittedAt: () => '2026-10-08T09:27:50Z',
      readComments: () => [STACKED_217(1), STACKED_217(2)], trigger, postComment: vi.fn(), clearLabel: vi.fn(() => true),
      now: Date.parse('2026-10-08T12:30:00Z'),
    });
    expect(result.refusals.filter((r) => r.kind === 'missing-run-cap-exhausted')).toEqual([]);
    expect(result.dispatch.map((d) => d.prNumber)).toEqual([217]);
    expect(trigger).toHaveBeenCalledTimes(1);
  });
  it('plateau-app #217: stacked refusal markers never spend the cap, including the same base', () => {
    const result = sweepMissingRunRecovery({
      mainRuns: [],
      apply: true, repo: 'plateauapp/plateau-app', readOpenPrs: () => [{ ...PR_217, baseRefName: 'lane/xwtnr2y-sessions-page' }],
      readRequiredContexts: () => null, readDeclaredContexts: () => ['test', 'e2e'], readHeadCommittedAt: () => '2026-10-08T09:27:50Z',
      readComments: () => [STACKED_217(1), STACKED_217(2)], trigger: vi.fn(), postComment: vi.fn(),
      restack: () => ({ ok: false, action: 'stack-restack', deferred: true, error: 'claim held' }), now: Date.parse('2026-10-08T12:30:00Z'),
    });
    expect(result.refusals).toEqual([]);
    expect(result.dispatch).toHaveLength(1);
  });
  // Punctuation and unknown bases do not turn a legacy refusal into an attempt.
  it.each([
    ['comma in the base, still stacked on it', 'lane/a,b', 'lane/a,b', false],
    ['close paren in the base, still stacked on it', 'lane/a)b', 'lane/a)b', false],
    ['current base is a PREFIX of the marker base (lane/a vs lane/a,b)', 'lane/a', 'lane/a,b', false],
    ['marker base is a PREFIX of the current base (lane/a,b vs lane/a)', 'lane/a,b', 'lane/a', false],
    ['marker base unknown (`?`) cannot be proven stale', 'main', '?', false],
    ['current base unknown (null) cannot prove staleness', null, 'lane/old-base', false],
    ['retargeted to main after the old base landed', 'main', 'lane/old-base', false],
  ])('stacked-refusal marker: %s', (_name, currentBase, markerBase, counts) => {
    const marker = (n) => ({
      body: `🚦 conveyor missing-run-recovery\n\nbranch: ${PR_217.headRefName}\nsha: ${PR_217.headRefOid}\n\nconveyor missing-run-recovery attempted to trigger CI (pull-request-push) and it FAILED: PR is stacked or from a fork (base ${markerBase}, head repo plateauapp/plateau-app); missing-run push recovery only handles same-repo PRs on main (attempt ${n})`,
      author: { login: 'web-everything' },
    });
    const trigger = vi.fn(() => ({ ok: true, action: 'pull-request-push', newHeadSha: 'c'.repeat(40) }));
    const restack = vi.fn(() => ({ ok: true, action: 'stack-restack', newHeadSha: 'd'.repeat(40) }));
    const result = sweepMissingRunRecovery({
      mainRuns: [],
      apply: true, repo: 'plateauapp/plateau-app', readOpenPrs: () => [{ ...PR_217, baseRefName: currentBase }],
      readRequiredContexts: () => null, readDeclaredContexts: () => ['test', 'e2e'], readHeadCommittedAt: () => '2026-10-08T09:27:50Z',
      readComments: () => [marker(1), marker(2)], trigger, restack, postComment: vi.fn(), clearLabel: vi.fn(() => true),
      now: Date.parse('2026-10-08T12:30:00Z'),
    });
    const capped = result.refusals.some((r) => r.prNumber === 217 && r.kind === 'missing-run-cap-exhausted');
    expect(capped).toBe(counts);
    // A still-stacked PR is restacked (2026-10-10); a PR on main gets the empty-commit trigger.
    const stacked = currentBase && currentBase !== 'main';
    expect(trigger).toHaveBeenCalledTimes(counts || stacked ? 0 : 1);
    expect(restack).toHaveBeenCalledTimes(!counts && stacked ? 1 : 0);
  });

  // Live incident, web-everything/web-everything#2793 (landing freeze, 2026-09-27) — real `gh pr view` shape: base
  // `main`, `mergeable: CONFLICTING`, `mergeStateStatus: DIRTY`, empty rollup, head sha
  // 8be3bce0e51990837b7f9c016b407ec0f1657a1c already carrying 2 prior missing-run trigger-attempt comments.
  // Before the fix this sweep triggered CI a third time (or, having already spent 2 attempts, refused
  // `missing-run-cap-exhausted`) on a PR that can never produce a `pull_request` run at all — see
  // `main-red-recovery.mjs#buildMissingRunCandidates`'s own docblock. After the fix it is not this pass's
  // population at all: no dispatch, no refusal, `trigger` never called.
  const PR_2793 = {
    number: 2793, headRefName: 'lane/rerun-after-main-fix', baseRefName: 'main',
    headRefOid: '8be3bce0e51990837b7f9c016b407ec0f1657a1c', mergeable: 'CONFLICTING', statusCheckRollup: [],
    labels: [{ name: 'review:pending' }, { name: 'merge-status:conflicting' }],
  };
  const PR_2793_PRIOR_ATTEMPTS = [
    { body: '🚦 conveyor missing-run-recovery\n\nsha: 8be3bce0e51990837b7f9c016b407ec0f1657a1c\nattempt 1', author: { login: 'web-everything' } },
    { body: '🚦 conveyor missing-run-recovery\n\nsha: 8be3bce0e51990837b7f9c016b407ec0f1657a1c\nattempt 2', author: { login: 'web-everything' } },
  ];

  it('RED before the fix: #2793\'s real shape (mergeable CONFLICTING, empty rollup, 2 prior attempts) refuses missing-run-cap-exhausted', () => {
    const { mergeable, ...withoutMergeable } = PR_2793; // reproduces the pre-fix read (no `mergeable` in extraFields)
    const trigger = vi.fn();
    const result = sweepMissingRunRecovery({
      mainRuns: [],
      apply: true, readOpenPrs: () => [withoutMergeable], readRequiredContexts: () => ['test'],
      readHeadCommittedAt: () => '2026-09-27T01:00:00Z', readAheadBy: () => 0, readComments: () => PR_2793_PRIOR_ATTEMPTS,
      trigger, now: Date.parse('2026-09-27T05:50:00Z'),
    });
    expect(result.refusals).toEqual([expect.objectContaining({ prNumber: 2793, kind: 'missing-run-cap-exhausted' })]);
    expect(trigger).not.toHaveBeenCalled();
  });

  it('GREEN after the fix: #2793\'s real conflicting shape is excluded outright — no dispatch, no refusal, never triggered', () => {
    const trigger = vi.fn();
    const result = sweepMissingRunRecovery({
      mainRuns: [],
      apply: true, readOpenPrs: () => [PR_2793], readRequiredContexts: () => ['test'],
      readHeadCommittedAt: () => '2026-09-27T01:00:00Z', readAheadBy: () => 0, readComments: () => PR_2793_PRIOR_ATTEMPTS,
      trigger, now: Date.parse('2026-09-27T05:50:00Z'),
    });
    expect(result.dispatch).toEqual([]);
    expect(result.refusals).toEqual([]);
    expect(trigger).not.toHaveBeenCalled();
  });
});

describe('ci-red-recovery-watch — formatMissingRunReport', () => {
  it('prints one line per dispatch/refusal/applied, with the label-cleared note when relevant', () => {
    const report = formatMissingRunReport({
      dispatch: [{ prNumber: 2729, headRefName: 'lane/x', why: 'no run at all' }],
      refusals: [{ prNumber: 9001, kind: 'missing-run-cap-exhausted', why: 'cap hit' }],
      applied: [{ prNumber: 2729, ok: true, action: 'update-branch', labelCleared: true, why: 'no run at all' }],
    });
    expect(report).toContain('trigger-ci PR #2729 (lane/x) — no run at all');
    expect(report).toContain('missing-run-cap-exhausted PR #9001 — cap hit');
    expect(report).toContain('applied: update-branch PR #2729 (cleared stale checking label) — no run at all');
  });
});

describe('ci-red-recovery-watch — sweepMissingRunRecovery, partial rollup with unreadable protection (draft PR #3850)', () => {
  const done = (name, conclusion = 'SUCCESS') => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion });
  const PR_3850 = {
    number: 3850, headRefName: 'lane/prepare-org-move-xvgqv8h', headRefOid: '967fee6791e10673214fa811ecac29837db15950', mergeable: 'MERGEABLE', isDraft: true,
    statusCheckRollup: [done('smoke'), done('daemon-soak'), done('test-shard (1)'), done('test-shard (2)', 'CANCELLED')], labels: [{ name: 'review:pending' }],
  };
  const NOW = Date.parse('2026-10-04T11:50:00Z');
  it('plans trigger-ci via the declared required set when the App token cannot read protection (null)', () => {
    const result = sweepMissingRunRecovery({
      mainRuns: [],
      repo: 'web-everything/web-everything', readOpenPrs: () => [PR_3850], readRequiredContexts: () => null,
      readHeadCommittedAt: () => '2026-10-03T20:50:00Z', readComments: () => [], now: NOW,
    });
    expect(result.dispatch).toEqual([expect.objectContaining({ prNumber: 3850, kind: 'trigger-ci' })]);
  });
  it('an undeclared repo with unreadable protection still plans nothing (never a guessed set)', () => {
    const result = sweepMissingRunRecovery({
      mainRuns: [],
      repo: 'someone/else', readOpenPrs: () => [{ ...PR_3850, statusCheckRollup: PR_3850.statusCheckRollup.map((c) => ({ ...c, workflowName: 'CI' })) }], readRequiredContexts: () => null,
      readHeadCommittedAt: () => '2026-10-03T20:50:00Z', readComments: () => [], now: NOW,
    });
    expect(result.dispatch).toEqual([]);
  });
});

// #3794 live case, 2026-10-04.
it('sweeps a main-fixed signature and posts durable refund evidence', () => {
  const facts = { signatures: [{ emitterFiles: ['gate.mjs'], fixCommits: ['e5c22481e'] }],
    bugIntroducedAt: '2026-10-05T00:00:00Z', fixedAt: '2026-10-05T01:44:46Z' };
  const detailsUrl = 'https://github.com/web-everything/web-everything/actions/runs/1/job/42';
  const readMainFixedSignatureFacts = vi.fn(() => facts);
  const exec = vi.fn();
  const options = { apply: true, repo: 'web-everything/web-everything', requiredCheck: 'test',
    readOpenPrs: () => [{ ...PR_2635, statusCheckRollup: [{ ...failingCheck('2026-10-05T00:54:36Z'), detailsUrl }] }],
    readAheadBy: () => 3, readMainRuns: () => [], readMainLatestCheckRuns: () => [], readComments: () => [],
    readMainFixedSignatureFacts, refresh: () => ({ ok: true, action: 'rebased' }),
    postComment: (pr, opts) => defaultPostRebaseComment(pr, { ...opts, exec }),
  };
  expect(sweepCiRedRecovery(options).dispatch[0].attribution).toBe('main-fixed-signature');
  expect(readMainFixedSignatureFacts).toHaveBeenCalledWith(expect.objectContaining({ detailsUrl, failureCompletedAt: '2026-10-05T00:54:36Z' }));
  expect(exec.mock.calls[0][1][4]).toContain(`attribution: main-fixed-signature\nattributed-window: ${facts.bugIntroducedAt} ${facts.fixedAt}`);
  readMainFixedSignatureFacts.mockClear();
  sweepCiRedRecovery({ ...options, readAheadBy: () => 0 });
  expect(readMainFixedSignatureFacts).not.toHaveBeenCalled();
});

// xd3dkzx — live replay 2026-10-08: main's CI workflow red on `daemon-soak` only; PRs failed `test` in that window.
describe('ci-red-recovery-watch — check-scoped recovery (xd3dkzx live replay)', async () => {
  const { readFileSync } = await import('node:fs');
  const fixture = JSON.parse(readFileSync(`${process.cwd()}/scripts/conveyor/__tests__/fixtures/owed-ci-rerun-check-scoped.json`, 'utf8'));
  const prs = fixture.candidates.map((c) => ({
    number: c.prNumber, headRefName: c.headRefName, headRefOid: c.headSha,
    statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: c.failureCompletedAt }],
  }));
  const commonReaders = {
    readOpenPrs: () => prs, readMainRuns: () => fixture.mainRuns, readAheadBy: () => 7,
    readRequiredContexts: () => ['test', 'smoke', 'daemon-soak'], readMainLatestCheckRuns: () => [],
  };

  it('applies one refresh per head and records it (the marker comment), instead of main-still-red forever', () => {
    const refresh = vi.fn(() => ({ ok: true, action: 'rebased', newCommit: 'n' }));
    const postComment = vi.fn();
    const result = sweepCiRedRecovery({
      ...commonReaders, apply: true, readComments: () => [], refresh, postComment, reconcileAcceptance: () => ({}),
    });
    expect(result.refusals).toEqual([]);
    expect(refresh.mock.calls.map((c) => c[0])).toEqual(fixture.candidates.map((c) => c.headRefName));
    expect(postComment.mock.calls.map((c) => [c[0], c[1].headSha])).toEqual(fixture.candidates.map((c) => [c.prNumber, c.headSha]));
  });

  it('a head that already used its recorded attempts (marker comments for that sha) is not refreshed again', async () => {
    const { buildRebaseOntoMainComment, DEFAULT_MAX_REBASE_RETRIES_PER_SHA } = await import('../main-red-recovery.mjs');
    const readComments = (n) => {
      const c = fixture.candidates.find((x) => x.prNumber === n);
      const body = buildRebaseOntoMainComment({ headRefName: c.headRefName, headSha: c.headSha, ok: false, action: 'error', error: 'push failed' });
      return Array.from({ length: DEFAULT_MAX_REBASE_RETRIES_PER_SHA }, () => ({ body, viewerDidAuthor: true }));
    };
    const refresh = vi.fn();
    const result = sweepCiRedRecovery({ ...commonReaders, apply: true, readComments, refresh, postComment: vi.fn() });
    expect(refresh).not.toHaveBeenCalled();
    expect(result.refusals.map((r) => r.kind)).toEqual(['rebase-cap-exhausted', 'rebase-cap-exhausted', 'rebase-cap-exhausted']);
  });
  // PR #4825 round 4: a refresh dispatched while main is still red (here `test` is green on main again) is a real
  // attempt — its marker says `main-state: red`, and it must still burn the per-sha cap.
  it('bounds a permanently failing check-scoped refresh across many ticks while main stays red on another check', async () => {
    const { buildRebaseOntoMainComment } = await import('../main-red-recovery.mjs');
    const comments = new Map();
    const refresh = vi.fn(() => ({ ok: false, action: 'error', error: 'push to lane/x failed (remote rejected)' }));
    const postComment = vi.fn((n, o) => comments.set(n, [...(comments.get(n) ?? []),
      { viewerDidAuthor: true, createdAt: '2026-10-08T22:10:00Z', body: buildRebaseOntoMainComment(o) }]));
    for (let tick = 0; tick < 6; tick += 1) {
      sweepCiRedRecovery({ ...commonReaders, apply: true, readComments: (n) => comments.get(n) ?? [], readPriority: () => null,
        checkClaim: () => null, refresh, postComment });
    }
    expect(refresh).toHaveBeenCalledTimes(2 * fixture.candidates.length);
    expect([...comments.values()].map((c) => c.length)).toEqual(fixture.candidates.map(() => 2));
    expect(comments.get(fixture.candidates[0].prNumber)[0].body).toContain('main-state: red');
  });
});

// 2026-10-10 live: #4784 claim-held refusals burned the cap.
describe('2026-10-10 recovery caps and stacked missing runs', async () => {
  const core = await import('../main-red-recovery.mjs');
  const watch = await import('../ci-red-recovery-watch.mjs');
  const sha = '354218fb8b3389b7f8e9553e9c4ee90f5a2f1f91';
  const green = { red: false, sha: 'd8c694315', at: '2026-10-10T20:13:19Z' };
  const windows = [{ start: '2026-10-10T18:44:00Z', end: green.at }];
  const runs = [
    { status: 'completed', conclusion: 'success', updatedAt: green.at, headSha: green.sha, databaseId: 38082134845 },
    { status: 'completed', conclusion: 'failure', updatedAt: '2026-10-10T19:16:56Z' },
    { status: 'completed', conclusion: 'cancelled', updatedAt: '2026-10-10T20:20:37Z' },
    { status: 'in_progress', updatedAt: '2026-10-10T20:21:00Z' },
  ];
  const refusal = 'push to lane/human-clearance-carry refused: fix-4784 holds the fix claim on PR #4784 (we) — conveyor fix: address review on PR #4784. Only the claim holder may push while it is live. Wait for its `fix-end`, or coordinate with fix-4784. See we:scripts/conveyor/fix-procedure.mjs.';
  const marker = (extra = '', createdAt) => ({ viewerDidAuthor: true, createdAt,
    body: `🔀 conveyor rebase-onto-main\n\nsha: ${sha}\n${extra}` });
  const stack = [
    { number: 4756, headRefName: 'lane/fixer-history-takeover', baseRefName: 'main' },
    { number: 4759, headRefName: 'lane/takeover-review-attempt', baseRefName: 'lane/fixer-history-takeover', headRefOid: sha, statusCheckRollup: [], isDraft: true },
  ];
  it('refunds both exact claim refusals even with no options', () => {
    const comments = ['2026-10-10T20:14:54Z', '2026-10-10T20:16:29Z'].map(at => marker(refusal, at));
    expect(core.countRebaseOntoMainComments(comments, sha)).toBe(0);
    const legacy = marker(`conveyor rebase-onto-main attempted to refresh this branch onto main and it FAILED: ${refusal}`);
    expect(core.countRebaseOntoMainComments([legacy], sha)).toBe(0);
  });
  // PR #4825 round 4: a legacy failure that merely QUOTES the phrase (not the refusal's own shape) is still counted.
  it('counts a legacy marker whose failure text only quotes the claim phrase', () => {
    const quoted = marker(`conveyor rebase-onto-main attempted to refresh this branch onto main and it FAILED: push to lane/x failed (remote: ${refusal})`);
    expect(core.countRebaseOntoMainComments([quoted], sha)).toBe(1);
    expect(core.countRebaseOntoMainComments([marker('hook said: fix-1 holds the fix claim on PR #1')], sha)).toBe(1);
  });
  it('refunds legacy red-window attempts, explicit red state, and stale green attempts', () => {
    const count = (comments, opts) => core.countRebaseOntoMainComments(comments, sha, opts);
    expect(count([marker('', '2026-10-10T19:16:56Z')], { mainRedWindows: windows })).toBe(0);
    expect(count([marker('', '2026-10-10T20:14:54Z')], { mainRedWindows: windows })).toBe(1);
    // PR #4825 round 4: with no main state (reconcile-core's cap check) a red-era attempt counts, as it does in the sweep.
    expect(count([marker('main-state: red')])).toBe(1);
    expect(count([marker('main-state: red')], { mainRedWindows: windows })).toBe(0);
    const comments = [marker(`main-state: green\nmain-green-sha: ${green.sha}\npush failed`), marker(`main-green-sha: ${green.sha}\npush failed`)];
    expect(count(comments, { mainGreen: green })).toBe(2);
    expect(count(comments, { mainGreen: { ...green, sha: 'new-green' } })).toBe(0);
    expect(count([marker('', '2026-10-10T19:16:56Z')], { mainGreen: green })).toBe(0);
    expect(count([marker('', 'invalid')], { mainGreen: green, mainRedWindows: windows })).toBe(1);
  });
  it('identifies the newest decisive main run', () => {
    expect(core.currentMainGreen(runs)).toEqual(green);
    expect(core.currentMainGreen([])).toBeNull();
    expect(core.currentMainGreen([runs[1]])).toEqual({ red: true, sha: null, at: null });
    expect(core.currentMainGreen([...runs, { status: 'completed', conclusion: 'failure', updatedAt: '2026-10-10T20:30:00Z', infraCancelledOnly: true }])).toEqual(green);
  });
  it('resolves standard caps and valid env overrides', () => {
    const file = '/tmp/nonexistent-ci-red-recovery-4784.json';
    expect(core.resolveRecoveryCaps({ env: {}, file })).toEqual({ rebaseRetriesPerSha: 2, missingRunRetriesPerSha: 2, mainDefectRebasesPerSha: 1,
      sources: { rebaseRetriesPerSha: 'standard', missingRunRetriesPerSha: 'standard', mainDefectRebasesPerSha: 'standard' } });
    expect(core.resolveRecoveryCaps({ env: { WE_REBASE_RETRIES_PER_SHA: '5' }, file })).toMatchObject({ rebaseRetriesPerSha: 5, sources: { rebaseRetriesPerSha: 'env' } });
    expect(core.resolveRecoveryCaps({ env: { WE_REBASE_RETRIES_PER_SHA: '-1' }, file }).rebaseRetriesPerSha).toBe(2);
  });
  // PR #4825 review: an empty or whitespace-only env value is "layer not set" — it must never become cap 0 (recovery disabled).
  it.each(['', '   ', '\t'])('an empty or whitespace env value (%j) never becomes cap 0 for any cap variable', value => {
    const file = '/tmp/nonexistent-ci-red-recovery-4784.json';
    const caps = core.resolveRecoveryCaps({ env: { WE_REBASE_RETRIES_PER_SHA: value, WE_MISSING_RUN_RETRIES_PER_SHA: value, WE_MAIN_DEFECT_REBASES_PER_SHA: value }, file });
    expect(caps).toEqual({ rebaseRetriesPerSha: 2, missingRunRetriesPerSha: 2, mainDefectRebasesPerSha: 1,
      sources: { rebaseRetriesPerSha: 'standard', missingRunRetriesPerSha: 'standard', mainDefectRebasesPerSha: 'standard' } });
  });
  it.each(['rebase', 'missing'])('adds main identity without altering legacy %s bodies', kind => {
    const build = kind === 'rebase' ? core.buildRebaseOntoMainComment : core.buildMissingRunComment;
    const old = build({ headSha: sha });
    expect(build({ headSha: sha, mainGreen: green })).toBe(old.replace(`sha: ${sha}`, `sha: ${sha}\nmain-state: green\nmain-green-sha: ${green.sha}`));
    expect(build({ headSha: sha, mainGreen: { red: true, sha: null } })).toContain('main-state: red\nmain-green-sha: none');
  });
  it.each([false, true])('defers claim holds before refresh or at the push race (%s)', race => {
    // The race: the claim is taken after the pre-check, so the push is refused and the claim store now holds it.
    let claimed = !race;
    const refresh = vi.fn(() => { claimed = true; return { ok: false, error: refusal }; });
    const postComment = vi.fn();
    const result = sweepCiRedRecovery({ apply: true, repo: 'web-everything/web-everything', requiredCheck: 'test',
      readOpenPrs: () => [{ number: 4784, headRefName: 'lane/human-clearance-carry', headRefOid: sha, statusCheckRollup: [failingCheck('2026-10-10T19:30:00Z')] }],
      readMainRuns: () => runs, readMainLatestCheckRuns: () => [], readAheadBy: () => 3, readComments: () => [],
      checkClaim: () => claimed ? { message: refusal } : null, refresh, postComment });
    expect(refresh).toHaveBeenCalledTimes(race ? 1 : 0);
    expect(postComment).not.toHaveBeenCalled();
    expect(result.applied[0]).toMatchObject({ prNumber: 4784, action: 'deferred', deferred: true, error: refusal });
    expect(result.mainRuns).toEqual(runs);
    expect(formatReport(result)).toContain('  … deferred PR #4784 lane/human-clearance-carry');
  });
  // PR #4825 round 4: the deferral is decided by the claim store, never by the failure text.
  it('a refresh failure that merely quotes the claim phrase is still counted when no claim is live', () => {
    const refresh = vi.fn(() => ({ ok: false, action: 'error', error: `push to lane/human-clearance-carry failed (remote: ${refusal})` }));
    const postComment = vi.fn();
    const result = sweepCiRedRecovery({ apply: true, repo: 'web-everything/web-everything', requiredCheck: 'test',
      readOpenPrs: () => [{ number: 4784, headRefName: 'lane/human-clearance-carry', headRefOid: sha, statusCheckRollup: [failingCheck('2026-10-10T19:30:00Z')] }],
      readMainRuns: () => runs, readMainLatestCheckRuns: () => [], readAheadBy: () => 3, readComments: () => [],
      checkClaim: () => null, refresh, postComment });
    expect(postComment).toHaveBeenCalledTimes(1);
    expect(result.applied[0].deferred).toBeUndefined();
  });
  it('bounds a permanently failing red-main fix PR refresh across many ticks while main stays red', () => {
    const comments = [];
    const redRuns = [
      { status: 'completed', conclusion: 'success', updatedAt: '2026-10-10T18:00:00Z', headSha: 'g0' },
      { status: 'completed', conclusion: 'failure', updatedAt: '2026-10-10T18:44:00Z' },
    ];
    const refresh = vi.fn(() => ({ ok: false, action: 'error', error: 'push to lane/red-main-fix failed (remote rejected)' }));
    const postComment = vi.fn((n, o) => comments.push({ viewerDidAuthor: true, createdAt: '2026-10-10T21:00:00Z', body: core.buildRebaseOntoMainComment(o) }));
    for (let tick = 0; tick < 6; tick += 1) {
      sweepCiRedRecovery({ apply: true, repo: 'web-everything/web-everything', requiredCheck: 'test',
        readOpenPrs: () => [{ number: 4522, headRefName: 'lane/red-main-fix', headRefOid: sha, statusCheckRollup: [failingCheck('2026-10-10T19:30:00Z')] }],
        readMainRuns: () => redRuns, readMainLatestCheckRuns: () => [], readAheadBy: () => 3, readComments: () => comments,
        readPriority: () => ({ repo: 'we', prs: [4522] }), checkClaim: () => null, refresh, postComment });
    }
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(comments.length).toBe(2);
    expect(comments[0].body).toContain('main-state: red');
  });
  it('refunds #4759 stacked refusal markers on the same base', () => {
    const comments = ['13:12:00', '18:43:00'].map(t => ({ viewerDidAuthor: true, createdAt: `2026-10-10T${t}Z`,
      body: `🚦 conveyor missing-run-recovery\n\nsha: ${sha}\nPR is stacked or from a fork (base lane/fixer-history-takeover, head repo web-everything/web-everything); missing-run push recovery only handles same-repo PRs on main` }));
    expect(core.countMissingRunComments(comments, sha, { baseRefName: stack[1].baseRefName })).toBe(0);
  });
  it('restacks #4759 root first, fetching its refreshed base before the child', () => {
    const calls = [];
    const result = watch.restackStackedPr({ ...stack[1], prNumber: 4759 }, { prs: stack, repo: 'web-everything/web-everything', root: '/tmp/repo', checkClaim: () => null, readIsCrossRepository: () => false,
      fetchRef: (ref) => { calls.push(['fetch', ref]); return { ok: true }; },
      refresh: (ref, opts) => { calls.push([ref, opts.base]); return { ok: true, action: 'rebased', newCommit: ref }; } });
    expect(calls).toEqual([[stack[0].headRefName, 'origin/main'], ['fetch', stack[0].headRefName], [stack[1].headRefName, `origin/${stack[0].headRefName}`]]);
    expect(result).toMatchObject({ ok: true, action: 'stack-restack', newHeadSha: stack[1].headRefName, steps: [{ prNumber: 4756 }, { prNumber: 4759 }] });
  });
  it('checks the entire chain before mutation and rejects unknown parents', () => {
    const refresh = vi.fn();
    expect(watch.restackStackedPr(stack[1], { prs: stack, checkClaim: () => ({ message: refusal }), readIsCrossRepository: () => false, refresh })).toMatchObject({ deferred: true, error: refusal });
    expect(refresh).not.toHaveBeenCalled();
    expect(watch.restackStackedPr(stack[1], { prs: [stack[1]], refresh })).toMatchObject({ ok: false, error: 'stack base lane/fixer-history-takeover is not an open PR head; cannot restack' });
  });
  it.each([false, true])('routes stacked triggers through restack, deferring without a marker (%s)', deferred => {
    const restack = vi.fn(() => deferred ? { ok: false, action: 'stack-restack', deferred: true, error: refusal } : { ok: true, action: 'stack-restack', newHeadSha: 'child-new' });
    const postComment = vi.fn();
    const readMainRuns = vi.fn(() => runs);
    // Only the stacked child lacks checks here (#4756 has its own run), so only #4759 is a candidate.
    const prs = [{ ...stack[0], statusCheckRollup: [greenCheck] }, stack[1]];
    const result = sweepMissingRunRecovery({ apply: true, repo: 'web-everything/web-everything', readOpenPrs: () => prs,
      readRequiredContexts: () => ['test'], readHeadCommittedAt: () => '2026-10-10T12:00:00Z', readComments: () => [], readMainRuns,
      now: Date.parse('2026-10-10T21:00:00Z'), trigger: () => ({ ok: false, stacked: true, action: 'stack-restack' }), restack, postComment, clearLabel: () => false });
    expect(restack).toHaveBeenCalledWith(expect.objectContaining({ prNumber: 4759 }), expect.objectContaining({ prs }));
    expect(readMainRuns).toHaveBeenCalledTimes(1);
    if (deferred) {
      expect(postComment).not.toHaveBeenCalled();
      expect(formatMissingRunReport(result)).toContain('  … deferred PR #4759');
    } else expect(postComment).toHaveBeenCalledWith(4759, expect.objectContaining({ action: 'stack-restack', newHeadSha: 'child-new', mainGreen: green }));
  });
  it.each(['claim', 'red', 'window', 'stale', 'legacy'])('refunds missing-run %s attempts', kind => {
    const extras = { claim: refusal, red: 'main-state: red', window: '', stale: 'main-green-sha: older', legacy: '' };
    const comment = marker(extras[kind], '2026-10-10T19:30:00Z');
    comment.body = comment.body.replace('🔀 conveyor rebase-onto-main', '🚦 conveyor missing-run-recovery');
    expect(core.countMissingRunComments([comment], sha, { mainRedWindows: windows, mainGreen: green })).toBe(0);
  });
  // PR #4825 round 3: missing-run attempts do not depend on main's state, so a red main must never refund them.
  // PR #4825 round 4: rebases are dispatched while main is red too (a red-main fix PR, a check green on main again), so a
  // red-era rebase marker counts while main is STILL red; it is refunded only once main goes green on a new sha.
  it('does not refund a missing-run or rebase attempt marked main-state: red while main is still red', () => {
    const redNow = { red: true, sha: null, at: null };
    const openWindow = [{ start: '2026-10-10T18:44:00Z', end: null }];
    const missing = marker('main-state: red\nmain-green-sha: none', '2026-10-10T19:30:00Z');
    missing.body = missing.body.replace('🔀 conveyor rebase-onto-main', '🚦 conveyor missing-run-recovery');
    expect(core.countMissingRunComments([missing], sha, { mainRedWindows: openWindow, mainGreen: redNow })).toBe(1);
    const rebase = marker('main-state: red\nmain-green-sha: none', '2026-10-10T19:30:00Z');
    expect(core.countRebaseOntoMainComments([rebase], sha, { mainRedWindows: openWindow, mainGreen: redNow })).toBe(1);
    expect(core.countRebaseOntoMainComments([marker('', '2026-10-10T19:30:00Z')], sha, { mainRedWindows: openWindow, mainGreen: redNow })).toBe(1);
    // Red by either reading is red now: an open window outweighs a green latest run (and vice versa).
    expect(core.countRebaseOntoMainComments([rebase], sha, { mainRedWindows: openWindow, mainGreen: green })).toBe(1);
    expect(core.countRebaseOntoMainComments([rebase], sha, { mainRedWindows: windows, mainGreen: green })).toBe(0);
    expect(core.countRebaseOntoMainComments([marker('', '2026-10-10T19:30:00Z')], sha, { mainRedWindows: windows, mainGreen: redNow })).toBe(1);
  });
  // PR #4825 round 4 self-review: the sweep and reconcile-core's no-options cap check must agree while main is red, or
  // the sweep refuses `rebase-cap-exhausted` (owed a ci-heal) while reconcile still reads `owed-ci-rerun` — a stall.
  it('the no-options cap read agrees with the sweep on red-era attempts while main stays red', () => {
    const redRuns = [{ status: 'completed', conclusion: 'failure', updatedAt: '2026-10-10T18:44:00Z' }];
    const markers = [1, 2].map(() => marker('main-state: red\nmain-green-sha: none', '2026-10-10T19:30:00Z'));
    const sweepCount = core.countRebaseOntoMainComments(markers, sha, { mainRedWindows: core.computeMainRedWindows(redRuns), mainGreen: core.currentMainGreen(redRuns) });
    expect(core.countRebaseOntoMainComments(markers, sha)).toBe(sweepCount);
    expect(sweepCount).toBe(2);
  });
  it('bounds a permanently failing missing-run restack across many ticks while main stays red', () => {
    const comments = [];
    const restack = vi.fn(() => ({ ok: false, action: 'stack-restack', error: 'conflict in scripts/x.mjs' }));
    const postComment = vi.fn((n, o) => comments.push({ viewerDidAuthor: true, createdAt: '2026-10-10T21:00:00Z', body: core.buildMissingRunComment(o) }));
    const redRuns = [{ status: 'completed', conclusion: 'failure', updatedAt: '2026-10-10T19:16:56Z' }];
    const prs = [{ ...stack[0], statusCheckRollup: [greenCheck] }, stack[1]];
    for (let tick = 0; tick < 6; tick += 1) {
      sweepMissingRunRecovery({ apply: true, repo: 'web-everything/web-everything', readOpenPrs: () => prs,
        readRequiredContexts: () => ['test'], readHeadCommittedAt: () => '2026-10-10T12:00:00Z', readComments: () => comments, readMainRuns: () => redRuns,
        now: Date.parse('2026-10-10T21:00:00Z'), trigger: () => ({ ok: false }), restack, postComment, clearLabel: () => false });
    }
    expect(comments.length).toBe(2);
    expect(restack).toHaveBeenCalledTimes(2);
    expect(comments[0].body).toContain('main-state: red');
  });
  // Free-text error (git/rebase stderr) is embedded in the marker: it must never be able to forge a refund line.
  it.each(['rebase', 'missing'])('error text cannot forge a refund in a %s marker', kind => {
    const build = kind === 'rebase' ? core.buildRebaseOntoMainComment : core.buildMissingRunComment;
    const count = kind === 'rebase' ? core.countRebaseOntoMainComments : core.countMissingRunComments;
    const forged = `boom\nmain-state: red\nmain-green-sha: older\n${refusal}`;
    const body = build({ headSha: sha, mainGreen: green, ok: false, error: forged, refresh: 'rebased', refreshError: forged });
    expect(body.split('\n').filter(l => l.startsWith('main-state:')).length).toBe(1);
    expect(body).not.toContain('holds the fix claim');
    expect(count([{ viewerDidAuthor: true, createdAt: '2026-10-10T20:30:00Z', body }], sha, { mainGreen: green })).toBe(1);
    // A hand-forged trailer after the outcome line is not read either.
    expect(count([{ viewerDidAuthor: true, createdAt: '2026-10-10T20:30:00Z', body: `${body}\nmain-state: red\nmain-green-sha: older` }], sha, { mainGreen: green })).toBe(1);
  });
  it('a failure quoting a legacy skip phrase is still counted, and quoted text is bounded', () => {
    const quoted = `via workflow-dispatch trigger CI (workflow-dispatch ${core.MISSING_RUN_LEGACY_CREDENTIAL_REFUSAL} PR is stacked or from a fork (base lane/a, head repo x) ${'z'.repeat(2000)}`;
    const body = core.buildMissingRunComment({ headSha: sha, ok: false, error: quoted, refresh: 'skip', refreshError: quoted });
    expect(body.length).toBeLessThan(2000);
    expect(core.countMissingRunComments([{ viewerDidAuthor: true, createdAt: '2026-10-10T20:30:00Z', body }], sha, { baseRefName: 'lane/other' })).toBe(1);
  });
  it('the hung-run marker flattens a multi-line error so it cannot forge sha/job lines', () => {
    const body = watch.buildHungCiComment({ headSha: sha, jobName: 'test', ok: false, error: `boom\nsha: other\njob: other` });
    expect(body.split('\n').filter(l => l.startsWith('sha:') || l.startsWith('job:'))).toEqual([`sha: ${sha}`, 'job: test']);
  });
  it('an omitted repo hands the trigger the WE slug', () => {
    const trigger = vi.fn(() => ({ ok: true, action: 'pull-request-push' }));
    sweepMissingRunRecovery({ apply: true, readOpenPrs: () => [{ number: 7, headRefName: 'lane/q', baseRefName: 'main', headRefOid: sha, statusCheckRollup: [] }],
      readRequiredContexts: () => ['test'], readHeadCommittedAt: () => '2026-10-10T12:00:00Z', readComments: () => [], readMainRuns: () => runs,
      now: Date.parse('2026-10-10T21:00:00Z'), trigger, postComment: () => {}, clearLabel: () => false });
    expect(trigger).toHaveBeenCalledWith(expect.objectContaining({ prNumber: 7 }), expect.objectContaining({ repo: 'web-everything/web-everything' }));
  });
  describe('same-repo guard with the repo argument omitted', () => {
    it('infers the WE slug for the default reader', () => {
      const exec = vi.fn(() => 'false\n');
      expect(watch.defaultReadIsCrossRepository(4825, { exec })).toBe(false);
      expect(exec.mock.calls[0][1]).toContain('web-everything/web-everything');
      expect(watch.defaultReadIsCrossRepository(4825, { repo: 'we', exec })).toBe(false);
      expect(exec.mock.calls[1][1]).toContain('web-everything/web-everything');
    });
    it('recovers a same-repository PR when repo is omitted', () => {
      const exec = vi.fn(() => 'false\n');
      const rebase = vi.fn(() => ({ action: 'rebased', newCommit: 'abc' }));
      const result = watch.refreshOntoMain('lane/x', { prNumber: 4825, rebase, readIsCrossRepository: (n, o) => watch.defaultReadIsCrossRepository(n, { ...o, exec }) });
      expect(rebase).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ ok: true, action: 'rebased' });
    });
  });
  it.each(['current', 'fetch-error', 'refresh-error', 'race', 'quoted', 'cycle', 'depth'])('bounds restack failure: %s', kind => {
    // 'race': the claim is taken during the push. 'quoted': the failure text quotes the claim phrase, but no claim is live.
    let claimed = false;
    const refresh = vi.fn(() => {
      if (kind === 'race') claimed = true;
      return kind === 'refresh-error' || kind === 'race' || kind === 'quoted'
        ? { ok: false, error: kind === 'refresh-error' ? 'conflict' : refusal }
        : { ok: true, action: kind === 'current' ? 'current' : 'rebased', newCommit: 'new' };
    });
    const fetchRef = vi.fn(() => ({ ok: false, error: 'fetch failed' }));
    let prs = stack;
    let d = stack[1];
    if (kind === 'cycle') prs = [{ ...stack[0], baseRefName: stack[1].headRefName }, stack[1]];
    if (kind === 'depth') {
      prs = Array.from({ length: 11 }, (_, i) => ({ number: i, headRefName: `lane/depth-${i}`, baseRefName: i === 10 ? 'main' : `lane/depth-${i + 1}` }));
      d = prs[0];
    }
    const result = watch.restackStackedPr(d, { prs, checkClaim: () => claimed ? { message: refusal } : null, readIsCrossRepository: () => false, refresh,
      fetchRef: kind === 'fetch-error' ? fetchRef : () => ({ ok: true }) });
    expect(result.ok).toBe(false);
    expect(result.deferred === true).toBe(kind === 'race');
    if (kind === 'quoted') expect(refresh).toHaveBeenCalledTimes(1);
    if (kind === 'current') expect(result.error).toBe('stack already current with main; CI still absent — needs a human look');
    if (kind === 'fetch-error') { expect(result.error).toBe('fetch failed'); expect(refresh).toHaveBeenCalledTimes(1); }
    if (kind === 'refresh-error') { expect(result.error).toBe('conflict'); expect(refresh).toHaveBeenCalledTimes(1); }
    if (kind === 'cycle' || kind === 'depth') expect(refresh).not.toHaveBeenCalled();
  });
  it.each(['supplied', 'empty', 'throws'])('reads main only when necessary (%s)', kind => {
    const readMainRuns = vi.fn(() => { throw new Error('unreadable'); });
    const result = sweepMissingRunRecovery({ mainRuns: kind === 'supplied' ? runs : null, readMainRuns,
      readOpenPrs: () => kind === 'empty' ? [] : [stack[1]], readRequiredContexts: () => ['test'],
      readHeadCommittedAt: () => '2026-10-10T12:00:00Z', readComments: () => [], now: Date.parse('2026-10-10T21:00:00Z') });
    expect(readMainRuns).toHaveBeenCalledTimes(kind === 'throws' ? 1 : 0);
    expect(result.dispatch).toHaveLength(kind === 'empty' ? 0 : 1);
  });
  it('forwards main identity through both real marker writers', () => {
    for (const post of [watch.defaultPostRebaseComment, watch.defaultPostMissingRunComment]) {
      const exec = vi.fn();
      post(4784, { exec, headSha: sha, mainGreen: green });
      expect(exec.mock.calls[0][1][4]).toContain(`sha: ${sha}\nmain-state: green\nmain-green-sha: ${green.sha}`);
    }
  });
  it('a stacked candidate never reaches the empty-commit trigger; a fork-on-main refusal still counts', () => {
    const trigger = vi.fn();
    const restack = vi.fn(() => ({ ok: false, action: 'stack-restack', deferred: true, error: refusal }));
    sweepMissingRunRecovery({ apply: true, repo: 'web-everything/web-everything', readOpenPrs: () => [stack[1]], mainRuns: runs,
      readRequiredContexts: () => ['test'], readHeadCommittedAt: () => '2026-10-10T12:00:00Z', readComments: () => [],
      now: Date.parse('2026-10-10T21:00:00Z'), trigger, restack, postComment: vi.fn(), clearLabel: () => false });
    expect(trigger).not.toHaveBeenCalled();
    expect(restack).toHaveBeenCalledTimes(1);
    const fork = { viewerDidAuthor: true, body: `🚦 conveyor missing-run-recovery\n\nsha: ${sha}\nPR is stacked or from a fork (base main, head repo someone/web-everything); missing-run push recovery only handles same-repo PRs on main` };
    expect(core.countMissingRunComments([fork], sha)).toBe(1);
  });

  // PR #4825 review: a stacked fork PR (or a fork PR whose head name shadows a lane in the chain) must never be rebased/force-pushed.
  describe('restack refuses fork or unverifiable chain links before any mutation', () => {
    const repo = 'web-everything/web-everything';
    const same = () => false;
    it.each([
      ['the candidate itself is a fork', (n) => n === 4759, false],
      ['a base link is a fork', (n) => n === 4756, false],
      // An unreadable answer is transient: a free deferral, never a burned cap attempt.
      ['a link repo cannot be verified (null)', () => null, true],
      ['a link repo read throws', () => { throw new Error('gh down'); }, true],
    ])('%s', (_name, readIsCrossRepository, deferred) => {
      const refresh = vi.fn(() => ({ ok: true, action: 'rebased', newCommit: 'new' }));
      const fetchRef = vi.fn(() => ({ ok: true }));
      const result = watch.restackStackedPr({ ...stack[1], prNumber: 4759 }, { prs: stack, repo, checkClaim: () => null, readIsCrossRepository, refresh, fetchRef });
      expect(result).toMatchObject({ ok: false, action: 'stack-restack' });
      expect(result.deferred === true).toBe(deferred);
      expect(result.error).toMatch(/fork|verified/);
      expect(refresh).not.toHaveBeenCalled();
      expect(fetchRef).not.toHaveBeenCalled();
      // A fork refusal is a counted marker (cap-bounded); the sweep posts none for a deferral.
      if (!deferred) expect(core.countMissingRunComments([{ viewerDidAuthor: true, body: `🚦 conveyor missing-run-recovery\n\nsha: ${sha}\n${result.error}` }], sha, { baseRefName: stack[1].baseRefName })).toBe(1);
    });
    it('main-red refresh: a fork PR is never rebased; an unverifiable one defers without a marker', () => {
      for (const [reader, expectDeferred] of [[() => true, false], [() => null, true]]) {
        const rebase = vi.fn(() => ({ action: 'rebased', newCommit: 'n' }));
        const postComment = vi.fn();
        const result = sweepCiRedRecovery({ apply: true, readOpenPrs: () => [PR_2635], readMainRuns: () => MAIN_RUNS, readAheadBy: () => 33,
          readComments: () => [], checkClaim: () => null,
          readIsCrossRepository: reader, refresh: (ref, o) => refreshOntoMain(ref, { ...o, rebase }), postComment });
        expect(result.dispatch).toHaveLength(1);
        expect(rebase).not.toHaveBeenCalled();
        expect(result.applied[0]).toMatchObject({ ok: false });
        expect(result.applied[0].deferred === true).toBe(expectDeferred);
        expect(postComment).toHaveBeenCalledTimes(expectDeferred ? 0 : 1);
      }
    });
    it('a same-repo chain still restacks, reading each link once', () => {
      const read = vi.fn(same);
      const refresh = vi.fn(() => ({ ok: true, action: 'rebased', newCommit: 'new' }));
      expect(watch.restackStackedPr({ ...stack[1], prNumber: 4759 }, { prs: stack, repo, checkClaim: () => null, readIsCrossRepository: read, refresh, fetchRef: () => ({ ok: true }) }).ok).toBe(true);
      expect(read.mock.calls.map(c => c[0])).toEqual([4759, 4756]);
    });
    // PR #4825 red team: a fork PR sharing the parent's head name, listed first, must not block the same-repo parent.
    describe('parent resolution skips a fork PR that shadows the parent head name', () => {
      const parent = { number: 10, headRefName: 'lane/parent', baseRefName: 'main' };
      const forkTwin = { number: 30, headRefName: 'lane/parent', baseRefName: 'main' };
      const child = { number: 20, headRefName: 'lane/child', baseRefName: 'lane/parent', headRefOid: sha, statusCheckRollup: [] };
      it.each([
        ['fork listed before the same-repo parent', [forkTwin, parent, child]],
        ['fork listed after the same-repo parent', [parent, forkTwin, child]],
      ])('%s', (_name, prs) => {
        const refresh = vi.fn(() => ({ ok: true, action: 'rebased', newCommit: 'new' }));
        const result = watch.restackStackedPr({ ...child, prNumber: 20 }, { prs, repo, checkClaim: () => null,
          readIsCrossRepository: (n) => n === 30, refresh, fetchRef: () => ({ ok: true }) });
        expect(result).toMatchObject({ ok: true, action: 'stack-restack' });
        expect(refresh.mock.calls.map(c => [c[0], c[1].base])).toEqual([['lane/parent', 'origin/main'], ['lane/child', 'origin/lane/parent']]);
      });
      it('a fork-only parent name is still a counted refusal; an unverifiable twin defers', () => {
        const refresh = vi.fn();
        const opts = { repo, checkClaim: () => null, refresh, fetchRef: () => ({ ok: true }) };
        const forkOnly = watch.restackStackedPr({ ...child, prNumber: 20 }, { ...opts, prs: [forkTwin, child], readIsCrossRepository: (n) => n === 30 });
        expect(forkOnly).toMatchObject({ ok: false, error: expect.stringMatching(/fork/) });
        expect(forkOnly.deferred).toBeUndefined();
        const unknown = watch.restackStackedPr({ ...child, prNumber: 20 }, { ...opts, prs: [forkTwin, { ...parent, number: 11 }, child],
          readIsCrossRepository: (n) => (n === 30 ? true : n === 11 ? null : false) });
        expect(unknown).toMatchObject({ ok: false, deferred: true });
        // A verified same-repo parent beside an unverifiable twin is no license to guess: the twin may be a second parent.
        const mixed = watch.restackStackedPr({ ...child, prNumber: 20 }, { ...opts, prs: [parent, { ...parent, number: 11, baseRefName: 'lane/other' }, child],
          readIsCrossRepository: (n) => (n === 11 ? null : false) });
        expect(mixed).toMatchObject({ ok: false, deferred: true });
        expect(refresh).not.toHaveBeenCalled();
      });
      it('two same-repo PRs from the parent head with different bases are an ambiguous stack, never a guess', () => {
        const refresh = vi.fn();
        const result = watch.restackStackedPr({ ...child, prNumber: 20 }, { prs: [parent, { number: 12, headRefName: 'lane/parent', baseRefName: 'lane/other' }, child],
          repo, checkClaim: () => null, readIsCrossRepository: () => false, refresh, fetchRef: () => ({ ok: true }) });
        expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/ambiguous/) });
        expect(refresh).not.toHaveBeenCalled();
      });
      it('sweep: the shadowing fork posts no marker and the stack refreshes', () => {
        const refresh = vi.fn(() => ({ ok: true, action: 'rebased', newCommit: 'new' }));
        const postComment = vi.fn();
        sweepMissingRunRecovery({ apply: true, repo, readOpenPrs: () => [{ ...forkTwin, statusCheckRollup: [greenCheck] }, { ...parent, statusCheckRollup: [greenCheck] }, child],
          mainRuns: runs, readRequiredContexts: () => ['test'], readHeadCommittedAt: () => '2026-10-10T12:00:00Z', readComments: () => [],
          now: Date.parse('2026-10-10T21:00:00Z'),
          restack: (d, o) => watch.restackStackedPr(d, { ...o, checkClaim: () => null, readIsCrossRepository: (n) => n === 30, refresh, fetchRef: () => ({ ok: true }) }),
          trigger: vi.fn(), postComment, clearLabel: () => false });
        expect(refresh).toHaveBeenCalledTimes(2);
        expect(postComment).toHaveBeenCalledWith(20, expect.objectContaining({ ok: true, action: 'stack-restack' }));
      });
    });
    it('sweep: a stacked fork candidate reaches no refresh and posts a counted failure marker', () => {
      const refresh = vi.fn();
      const postComment = vi.fn();
      const prs = [{ ...stack[0], statusCheckRollup: [greenCheck] }, stack[1]];
      sweepMissingRunRecovery({ apply: true, repo, readOpenPrs: () => prs, mainRuns: runs, readRequiredContexts: () => ['test'],
        readHeadCommittedAt: () => '2026-10-10T12:00:00Z', readComments: () => [], now: Date.parse('2026-10-10T21:00:00Z'),
        restack: (d, o) => watch.restackStackedPr(d, { ...o, checkClaim: () => null, readIsCrossRepository: (n) => n === 4759, refresh }),
        trigger: vi.fn(), postComment, clearLabel: () => false });
      expect(refresh).not.toHaveBeenCalled();
      expect(postComment).toHaveBeenCalledWith(4759, expect.objectContaining({ ok: false, action: 'stack-restack' }));
    });
  });

  it('sweep honours a non-main defaultBranch when counting fork refusals (PR #3253 loop)', () => {
    const forkRefusal = { viewerDidAuthor: true, body: `🚦 conveyor missing-run-recovery\n\nsha: ${sha}\nPR is stacked or from a fork (base master, head repo someone/web-everything); missing-run push recovery only handles same-repo PRs on master` };
    const result = sweepMissingRunRecovery({ repo: 'web-everything/web-everything', defaultBranch: 'master', maxRetriesPerSha: 1,
      readOpenPrs: () => [{ number: 7, headRefName: 'lane/fork-on-master', baseRefName: 'master', headRefOid: sha, statusCheckRollup: [] }],
      mainRuns: runs, readRequiredContexts: () => ['test'], readHeadCommittedAt: () => '2026-10-10T12:00:00Z',
      readComments: () => [forkRefusal], now: Date.parse('2026-10-10T21:00:00Z') });
    expect(result.refusals).toEqual([expect.objectContaining({ prNumber: 7, kind: 'missing-run-cap-exhausted', attempts: 1 })]);
  });

});
