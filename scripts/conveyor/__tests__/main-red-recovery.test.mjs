/**
 * @file scripts/conveyor/__tests__/main-red-recovery.test.mjs
 * @description Pins we:backlog/x5uqim1-*.md's pure core against the REAL shapes measured live 2026-09-25 off
 *   `web-everything/web-everything`: `main`'s own `gh run list --branch main` history (one genuine red window,
 *   01:30:55Z–02:31:25Z, closed by PR #2638) and the six PRs whose `test` run's own `attempts/1` completion
 *   timestamp falls inside it — five already manually refreshed onto main by the operator (`ahead_by: 0`,
 *   still red — a genuine own-failure now) and one never refreshed (PR #2635, `ahead_by: 33`) — plus one PR
 *   (#2636) whose failure completed hours after `main` recovered, its own. See the module's own file header for
 *   the mid-build correction from `gh run rerun` (measured NOT to work) to a branch refresh onto `main`.
 */
import { describe, it, expect } from 'vitest';
import {
  MAIN_RED_CONCLUSIONS, computeMainRedWindows, isWithinRedWindow, isMainCurrentlyRed,
  classifyCiFailureAttribution, isPrCiFailureOwedRerun, planMainRedRebases,
  // landing-freeze fix (2026-09-27)
  latestCompletedMainRun, collapseMainCheckRunsToLatestPerName, isMainLatestCheckGreen,
  DEFAULT_HUNG_THRESHOLD_MS, DEFAULT_MAX_HUNG_RETRIES_PER_SHA,
  runIdFromDetailsUrl, isRunHung, buildHungCandidates, planHungCiRecoveries,
  DEFAULT_MAX_REBASE_RETRIES_PER_SHA, REBASE_ONTO_MAIN_COMMENT_MARKER,
  countRebaseOntoMainComments, buildRebaseOntoMainComment,
  DEFAULT_MISSING_RUN_THRESHOLD_MS, DEFAULT_MAX_MISSING_RUN_RETRIES_PER_SHA, MISSING_RUN_COMMENT_MARKER,
  buildMissingRunCandidates, isMissingRunOverdue, planMissingRunRecoveries,
  countMissingRunComments, buildMissingRunComment,
} from '../main-red-recovery.mjs';

// ── fixtures — measured off web-everything/web-everything, 2026-09-25 ────────────────────────────────────────────────
const run = (createdAt, updatedAt, conclusion, status = 'completed') => ({ createdAt, updatedAt, conclusion, status, workflowName: 'CI' });

/** A slice of `main`'s own real run history: one closed red window (the live incident), bracketed by green. */
const MAIN_RUNS = [
  run('2026-09-25T01:01:19Z', '2026-09-25T01:09:21Z', 'success'),
  run('2026-09-25T01:19:41Z', '2026-09-25T01:21:51Z', 'cancelled'), // superseded by the next push — NOT red
  run('2026-09-25T01:21:30Z', '2026-09-25T01:30:55Z', 'failure'),   // window opens HERE
  run('2026-09-25T01:37:41Z', '2026-09-25T01:45:31Z', 'cancelled'),
  run('2026-09-25T01:45:27Z', '2026-09-25T01:54:46Z', 'failure'),   // still red — window does not re-open, stays open
  run('2026-09-25T02:01:01Z', '2026-09-25T02:09:36Z', 'failure'),
  run('2026-09-25T02:23:29Z', '2026-09-25T02:31:25Z', 'success'),   // window closes HERE (PR #2638 landed 02:23:27Z)
  run('2026-09-25T03:26:33Z', '2026-09-25T03:36:11Z', 'failure'),   // a SECOND, later red window
  run('2026-09-25T03:40:56Z', '2026-09-25T03:50:15Z', 'success'),
];

/** An open-ended real history — the tail failure never got a later green run in the sample. */
const MAIN_RUNS_STILL_RED = [
  run('2026-09-25T02:23:29Z', '2026-09-25T02:31:25Z', 'success'),
  run('2026-09-25T03:26:33Z', '2026-09-25T03:36:11Z', 'failure'),
];

describe('main-red-recovery — computeMainRedWindows / isWithinRedWindow / isMainCurrentlyRed', () => {
  it('opens a window at the completing red run, closes it at the completing green run, and ignores cancelled runs', () => {
    const windows = computeMainRedWindows(MAIN_RUNS);
    expect(windows).toEqual([
      { start: '2026-09-25T01:30:55Z', end: '2026-09-25T02:31:25Z' },
      { start: '2026-09-25T03:36:11Z', end: '2026-09-25T03:50:15Z' },
    ]);
  });

  it('leaves the last window OPEN when no later green run has completed yet', () => {
    const windows = computeMainRedWindows(MAIN_RUNS_STILL_RED);
    expect(windows).toEqual([{ start: '2026-09-25T03:36:11Z', end: null }]);
    expect(isMainCurrentlyRed(windows)).toBe(true);
  });

  it('a fully-green history produces no windows, and main reads as not currently red', () => {
    const windows = computeMainRedWindows([run('2026-09-25T00:00:00Z', '2026-09-25T00:05:00Z', 'success')]);
    expect(windows).toEqual([]);
    expect(isMainCurrentlyRed(windows)).toBe(false);
  });

  it('skips a run that has not completed yet — an in-flight run tells us nothing about what main concluded', () => {
    const windows = computeMainRedWindows([
      run('2026-09-25T01:00:00Z', null, null, 'in_progress'),
      run('2026-09-25T01:00:00Z', '2026-09-25T01:05:00Z', 'success'),
    ]);
    expect(windows).toEqual([]);
  });

  it('isWithinRedWindow: a timestamp inside the closed live-incident window reads true; just outside reads false', () => {
    const windows = computeMainRedWindows(MAIN_RUNS);
    expect(isWithinRedWindow(Date.parse('2026-09-25T02:02:29Z'), windows)).toBe(true); // PR #2596's real attempt-1 completion
    expect(isWithinRedWindow(Date.parse('2026-09-25T01:30:55Z'), windows)).toBe(true); // the window's own start, inclusive
    expect(isWithinRedWindow(Date.parse('2026-09-25T02:31:25Z'), windows)).toBe(true); // the window's own end, inclusive
    expect(isWithinRedWindow(Date.parse('2026-09-25T02:31:26Z'), windows)).toBe(false); // one second after — main is green again
    expect(isWithinRedWindow(Date.parse('2026-09-25T08:03:45Z'), windows)).toBe(false); // PR #2636's real failure — hours later
  });

  it('an unparseable/NaN timestamp never matches any window', () => {
    expect(isWithinRedWindow(NaN, computeMainRedWindows(MAIN_RUNS))).toBe(false);
  });
});

describe('main-red-recovery — classifyCiFailureAttribution', () => {
  const windows = computeMainRedWindows(MAIN_RUNS);
  it('main-red for a completion timestamp inside a red window', () => {
    expect(classifyCiFailureAttribution({ failureCompletedAt: '2026-09-25T02:02:29Z', mainRedWindows: windows })).toBe('main-red');
  });
  it('own-failure for a completion timestamp outside every red window', () => {
    expect(classifyCiFailureAttribution({ failureCompletedAt: '2026-09-25T08:03:45Z', mainRedWindows: windows })).toBe('own-failure');
  });
  it('unknown for a missing/malformed timestamp — never guessed as either real answer', () => {
    expect(classifyCiFailureAttribution({ failureCompletedAt: null, mainRedWindows: windows })).toBe('unknown');
    expect(classifyCiFailureAttribution({ failureCompletedAt: 'not-a-date', mainRedWindows: windows })).toBe('unknown');
  });
});

// CORRECTED mid-build (see main-red-recovery.mjs's own file header): the real recovery mechanism is refreshing
// a PR's branch onto current `main` (`ahead_by` from GitHub's own `compare` endpoint), never rerunning the same
// stale commit in place — `gh run rerun --failed` was live-measured to fail again for the identical reason.
describe('main-red-recovery — isPrCiFailureOwedRerun', () => {
  const windows = computeMainRedWindows(MAIN_RUNS);
  it('true for a main-red failure whose head is still behind main (PR #2635\'s real shape: 33 commits behind)', () => {
    expect(isPrCiFailureOwedRerun({ requiredCheckCompletedAt: '2026-09-25T01:57:47Z', aheadBy: 33, mainRedWindows: windows })).toBe(true);
  });
  it('false once the head already contains main\'s current tip (PR #2596\'s real shape post-refresh: ahead_by 0, still red)', () => {
    expect(isPrCiFailureOwedRerun({ requiredCheckCompletedAt: '2026-09-25T02:02:29Z', aheadBy: 0, mainRedWindows: windows })).toBe(false);
  });
  it('false for a failure outside any red window (PR #2636\'s real shape), whatever aheadBy is', () => {
    expect(isPrCiFailureOwedRerun({ requiredCheckCompletedAt: '2026-09-25T08:03:45Z', aheadBy: 33, mainRedWindows: windows })).toBe(false);
  });
  it('an UNKNOWN aheadBy is treated as "not yet refreshed" — the safe direction against misdiagnosing main-red as a code defect', () => {
    expect(isPrCiFailureOwedRerun({ requiredCheckCompletedAt: '2026-09-25T02:02:29Z', aheadBy: null, mainRedWindows: windows })).toBe(true);
  });
  it('an UNKNOWN completion timestamp never grants owed-ci-rerun — falls through to the existing ci-heal path', () => {
    expect(isPrCiFailureOwedRerun({ requiredCheckCompletedAt: null, aheadBy: 33, mainRedWindows: windows })).toBe(false);
  });
});

// landing-freeze fix (2026-09-27) — LIVE INCIDENT: PR #2790 fixed a `daemon-soak` regression that had sat on
// `main` unseen (the job was `pull_request`-only before it, so `main`'s own CI runs stayed `success` right
// through the regression — no red window EVER opened to attribute #2748/#2783/#2784/#2788/#2789 against,
// retroactively, however genuinely main-caused the breakage was). See this file's own "LANDING-FREEZE FIX"
// section header for the full incident.
describe('main-red-recovery — isMainLatestCheckGreen / collapseMainCheckRunsToLatestPerName / latestCompletedMainRun', () => {
  const checkRun = (name, conclusion, completedAt, status = 'completed') => ({ name, conclusion, status, completed_at: completedAt });

  it('true when the named check concluded success on the given check-runs list', () => {
    const runs = [checkRun('test', 'success', '2026-09-27T04:00:10Z'), checkRun('daemon-soak', 'success', '2026-09-27T03:56:55Z')];
    expect(isMainLatestCheckGreen({ failingCheckName: 'daemon-soak', mainLatestCheckRuns: runs })).toBe(true);
  });

  it('false when the named check is present but not green', () => {
    const runs = [checkRun('daemon-soak', 'failure', '2026-09-27T03:56:55Z')];
    expect(isMainLatestCheckGreen({ failingCheckName: 'daemon-soak', mainLatestCheckRuns: runs })).toBe(false);
  });

  it('false when the named check never reported at all — never a guess', () => {
    expect(isMainLatestCheckGreen({ failingCheckName: 'daemon-soak', mainLatestCheckRuns: [checkRun('test', 'success', '2026-09-27T04:00:10Z')] })).toBe(false);
  });

  it('false with no failingCheckName, or no mainLatestCheckRuns at all — byte-identical to before this existed', () => {
    expect(isMainLatestCheckGreen({})).toBe(false);
    expect(isMainLatestCheckGreen({ failingCheckName: 'daemon-soak' })).toBe(false);
    expect(isMainLatestCheckGreen({ failingCheckName: 'daemon-soak', mainLatestCheckRuns: [] })).toBe(false);
  });

  it('collapses to the LATEST completed entry per name — an earlier failed attempt does not shadow a later success', () => {
    const runs = [
      checkRun('daemon-soak', 'failure', '2026-09-27T01:00:00Z'),
      checkRun('daemon-soak', 'success', '2026-09-27T03:56:55Z'),
    ];
    expect(isMainLatestCheckGreen({ failingCheckName: 'daemon-soak', mainLatestCheckRuns: runs })).toBe(true);
  });

  it('latestCompletedMainRun picks the newest status:completed entry by updatedAt, ignoring in-flight ones', () => {
    const runs = [
      { status: 'completed', updatedAt: '2026-09-27T01:00:00Z', headSha: 'old' },
      { status: 'in_progress', updatedAt: '2026-09-27T05:00:00Z', headSha: 'inflight' },
      { status: 'completed', updatedAt: '2026-09-27T03:00:00Z', headSha: 'new' },
    ];
    expect(latestCompletedMainRun(runs)).toMatchObject({ headSha: 'new' });
    expect(latestCompletedMainRun([])).toBeNull();
    expect(latestCompletedMainRun(null)).toBeNull();
  });
});

describe('main-red-recovery — isPrCiFailureOwedRerun, the landing-freeze-fix green-check path', () => {
  const mainLatestCheckRuns = [
    { name: 'test', conclusion: 'success', status: 'completed', completed_at: '2026-09-27T04:00:10Z' },
    { name: 'daemon-soak', conclusion: 'success', status: 'completed', completed_at: '2026-09-27T03:56:55Z' },
  ];

  it('true for a daemon-soak failure outside every red window, when daemon-soak is green on main\'s own latest run and the PR is behind (PR #2748\'s real shape)', () => {
    // #2748's base never ran daemon-soak on `main` at all (the job was pull_request-only) — no result there.
    expect(isPrCiFailureOwedRerun({
      requiredCheckCompletedAt: '2026-09-27T02:36:03Z', aheadBy: 5, mainRedWindows: [],
      failingCheckName: 'daemon-soak', mainLatestCheckRuns, prContainsMainGreenSha: false, mergeBaseCheckRuns: [],
      mergeBaseRunConclusion: 'success',
    })).toBe(true);
  });

  it('false once the head already contains main\'s current tip (ahead_by 0) — even with main green, still red is a real own-failure', () => {
    expect(isPrCiFailureOwedRerun({
      requiredCheckCompletedAt: '2026-09-27T02:36:03Z', aheadBy: 0, mainRedWindows: [],
      failingCheckName: 'daemon-soak', mainLatestCheckRuns,
    })).toBe(false);
  });

  it('false when main\'s latest run never reported the failing check at all — never a guess', () => {
    expect(isPrCiFailureOwedRerun({
      requiredCheckCompletedAt: '2026-09-27T02:36:03Z', aheadBy: 5, mainRedWindows: [],
      failingCheckName: 'daemon-soak', mainLatestCheckRuns: [{ name: 'test', conclusion: 'success', status: 'completed', completed_at: 'x' }],
    })).toBe(false);
  });

  it('omitting failingCheckName/mainLatestCheckRuns entirely never grants this path — byte-identical to before it existed', () => {
    expect(isPrCiFailureOwedRerun({ requiredCheckCompletedAt: '2026-09-27T02:36:03Z', aheadBy: 5, mainRedWindows: [] })).toBe(false);
  });

  // PR #2793 review (correctness, CONFIRMED): "main's latest run is green for this check" is the ordinary state
  // of a healthy `main`, not proof `main` caused this failure. The green-check path must NOT fire for a plain
  // PR-owned failure — a PR whose own base commit already had this check green, i.e. `main` was never broken for
  // it from this PR's point of view.
  it('false for a plain PR-owned failure: no red window, main green, and the check was ALREADY green at the PR\'s merge base', () => {
    expect(isPrCiFailureOwedRerun({
      requiredCheckCompletedAt: '2026-01-01T00:00:00Z', aheadBy: 3, mainRedWindows: [],
      failingCheckName: 'test', mainLatestCheckRuns: [{ name: 'test', conclusion: 'success', status: 'completed', completed_at: '2026-09-27T04:00:10Z', head_sha: 'green' }],
      prContainsMainGreenSha: false,
      mergeBaseCheckRuns: [{ name: 'test', conclusion: 'success', status: 'completed', completed_at: '2025-12-31T00:00:00Z' }],
    })).toBe(false);
  });

  it('false with the reviewer\'s exact shape (no merge-base / containment evidence at all) — absence of evidence never excuses', () => {
    expect(isPrCiFailureOwedRerun({
      requiredCheckCompletedAt: '2026-01-01T00:00:00Z', aheadBy: 3, mainRedWindows: [],
      failingCheckName: 'test', mainLatestCheckRuns: [{ name: 'test', conclusion: 'success', status: 'completed', completed_at: '2026-09-27T04:00:10Z', head_sha: 'green' }],
    })).toBe(false);
  });

  // PR #2793 review (codex-correctness, CONFIRMED): `aheadBy` is measured against main's CURRENT tip, which can
  // be newer (CI still pending) than the commit main's latest GREEN run built. A PR that already contains that
  // green commit has already received main's fix — still red is its own failure.
  it('does not excuse a PR containing the green run SHA when main has newer pending commits', () => {
    expect(isPrCiFailureOwedRerun({
      requiredCheckCompletedAt: '2026-09-27T02:36:03Z', aheadBy: 2, mainRedWindows: [],
      failingCheckName: 'daemon-soak', mainLatestCheckRuns,
      prContainsMainGreenSha: true, mergeBaseCheckRuns: null,
    })).toBe(false);
  });

  it('false when whether the PR contains the green SHA is unknown (the compare read failed) — never a guess', () => {
    expect(isPrCiFailureOwedRerun({
      requiredCheckCompletedAt: '2026-09-27T02:36:03Z', aheadBy: 5, mainRedWindows: [],
      failingCheckName: 'daemon-soak', mainLatestCheckRuns, prContainsMainGreenSha: null, mergeBaseCheckRuns: [],
      mergeBaseRunConclusion: 'success',
    })).toBe(false);
  });

  // Repair self-review (HIGH): main's CI cancels superseded runs (`cancel-in-progress`), so a cancelled / in-
  // progress / neutral result at the merge base is routine — never proof main was broken.
  it.each([
    ['cancelled check at the base', [{ name: 'daemon-soak', conclusion: 'cancelled', status: 'completed', completed_at: 'x' }], 'cancelled'],
    ['in-progress check at the base', [{ name: 'daemon-soak', conclusion: null, status: 'in_progress', completed_at: null }], null],
    ['neutral check at the base', [{ name: 'daemon-soak', conclusion: 'neutral', status: 'completed', completed_at: 'x' }], 'success'],
    ['skipped check, base CI run cancelled', [{ name: 'daemon-soak', conclusion: 'skipped', status: 'completed', completed_at: 'x' }], 'cancelled'],
    ['absent check, base CI run never completed', [], null],
  ])('false for %s — no evidence main was broken', (_label, mergeBaseCheckRuns, mergeBaseRunConclusion) => {
    expect(isPrCiFailureOwedRerun({
      requiredCheckCompletedAt: '2026-09-27T02:36:03Z', aheadBy: 5, mainRedWindows: [],
      failingCheckName: 'daemon-soak', mainLatestCheckRuns, prContainsMainGreenSha: false,
      mergeBaseCheckRuns, mergeBaseRunConclusion,
    })).toBe(false);
  });

  it('true for a skipped check at the base when the base\'s CI push run FINISHED (the live pre-#2790 shape)', () => {
    expect(isPrCiFailureOwedRerun({
      requiredCheckCompletedAt: '2026-09-27T02:36:03Z', aheadBy: 5, mainRedWindows: [],
      failingCheckName: 'daemon-soak', mainLatestCheckRuns, prContainsMainGreenSha: false,
      mergeBaseCheckRuns: [{ name: 'daemon-soak', conclusion: 'skipped', status: 'completed', completed_at: 'x' }],
      mergeBaseRunConclusion: 'success',
    })).toBe(true);
  });

  it('true when the check was RED at the PR\'s merge base (main ran it and it failed there), and is green on main now', () => {
    expect(isPrCiFailureOwedRerun({
      requiredCheckCompletedAt: '2026-09-27T02:36:03Z', aheadBy: 5, mainRedWindows: [],
      failingCheckName: 'daemon-soak', mainLatestCheckRuns, prContainsMainGreenSha: false,
      mergeBaseCheckRuns: [{ name: 'daemon-soak', conclusion: 'failure', status: 'completed', completed_at: '2026-09-27T01:00:00Z' }],
    })).toBe(true);
  });
});

describe('main-red-recovery — planMainRedRebases', () => {
  const windows = computeMainRedWindows(MAIN_RUNS);

  it('every candidate yields a dispatch or a refusal — never neither', () => {
    const candidates = [
      { prNumber: 2635, headRefName: 'lane/xdzl6mb', aheadBy: 33, failureCompletedAt: '2026-09-25T01:57:47Z' },
      { prNumber: 2596, headRefName: 'lane/batch-...-3901', aheadBy: 0, failureCompletedAt: '2026-09-25T02:02:29Z' },
      { prNumber: 2636, headRefName: 'lane/batch-...-3915', aheadBy: 33, failureCompletedAt: '2026-09-25T08:03:45Z' },
    ];
    const plan = planMainRedRebases({ candidates, mainRedWindows: windows });
    expect(plan.dispatch.length + plan.refusals.length).toBe(candidates.length);
  });

  it('dispatches a real rebase-onto-main for a main-red failure whose head is still behind (PR #2635)', () => {
    const plan = planMainRedRebases({
      candidates: [{ prNumber: 2635, headRefName: 'lane/xdzl6mb', aheadBy: 33, failureCompletedAt: '2026-09-25T01:57:47Z' }],
      mainRedWindows: windows,
    });
    expect(plan.dispatch).toEqual([expect.objectContaining({ prNumber: 2635, kind: 'rebase-onto-main', aheadBy: 33 })]);
    expect(plan.refusals).toEqual([]);
  });

  it('refuses already-current for a main-red failure whose head already contains main\'s tip (PR #2596, ahead_by 0, still red)', () => {
    const plan = planMainRedRebases({
      candidates: [{ prNumber: 2596, aheadBy: 0, failureCompletedAt: '2026-09-25T02:02:29Z' }],
      mainRedWindows: windows,
    });
    expect(plan.refusals).toEqual([expect.objectContaining({ prNumber: 2596, kind: 'already-current' })]);
    expect(plan.dispatch).toEqual([]);
  });

  it('refuses own-failure for a failure outside every red window (PR #2636) — never this pass\'s job', () => {
    const plan = planMainRedRebases({
      candidates: [{ prNumber: 2636, aheadBy: 33, failureCompletedAt: '2026-09-25T08:03:45Z' }],
      mainRedWindows: windows,
    });
    expect(plan.refusals).toEqual([expect.objectContaining({ prNumber: 2636, kind: 'own-failure' })]);
  });

  it('refuses main-still-red when the failure is main-red-attributable but main has not recovered yet', () => {
    const stillRedWindows = computeMainRedWindows(MAIN_RUNS_STILL_RED);
    const plan = planMainRedRebases({
      candidates: [{ prNumber: 9001, aheadBy: 5, failureCompletedAt: '2026-09-25T03:40:00Z' }],
      mainRedWindows: stillRedWindows,
    });
    expect(plan.refusals).toEqual([expect.objectContaining({ prNumber: 9001, kind: 'main-still-red' })]);
  });

  it('refuses unknown-ahead-by when the compare read could not be resolved', () => {
    const plan = planMainRedRebases({
      candidates: [{ prNumber: 9002, aheadBy: null, failureCompletedAt: '2026-09-25T02:02:29Z' }],
      mainRedWindows: windows,
    });
    expect(plan.refusals).toEqual([expect.objectContaining({ prNumber: 9002, kind: 'unknown-ahead-by' })]);
  });

  it('MAIN_RED_CONCLUSIONS deliberately excludes cancelled — the ordinary drain-traffic case', () => {
    expect(MAIN_RED_CONCLUSIONS).not.toContain('cancelled');
  });
});

// landing-freeze fix (2026-09-27) — the ACTING pass: `owed-ci-rerun` alone (above) is a refusal, never a
// repair; this is what must actually dispatch the mechanical rebase for a PR the red-window path alone can
// never see (main's own regression window ran no red window at all — see this file's own header).
describe('main-red-recovery — planMainRedRebases, the landing-freeze-fix green-check path', () => {
  const mainLatestCheckRuns = [
    { name: 'test', conclusion: 'success', status: 'completed', completed_at: '2026-09-27T04:00:10Z' },
    { name: 'daemon-soak', conclusion: 'success', status: 'completed', completed_at: '2026-09-27T03:56:55Z' },
  ];
  const candidate2748 = {
    prNumber: 2748, headRefName: 'lane/xg790dh-ci-lifecycle-drain-bookkeeping-commits', headSha: 'dfb57d0',
    aheadBy: 5, failureCompletedAt: '2026-09-27T02:36:03Z', failingCheckName: 'daemon-soak',
    prContainsMainGreenSha: false, mergeBaseCheckRuns: [], mergeBaseRunConclusion: 'success',
  };

  // PR #2793 review — the acting pass must not rebase a plain PR-owned failure either.
  it('refuses own-failure when the check was already green at the PR\'s merge base (a plain PR-owned failure behind a healthy main)', () => {
    const plan = planMainRedRebases({
      candidates: [{ ...candidate2748, mergeBaseCheckRuns: [{ name: 'daemon-soak', conclusion: 'success', status: 'completed', completed_at: '2026-09-26T00:00:00Z' }] }],
      mainRedWindows: [], mainLatestCheckRuns,
    });
    expect(plan.refusals).toEqual([expect.objectContaining({ prNumber: 2748, kind: 'own-failure' })]);
    expect(plan.dispatch).toEqual([]);
  });

  it('refuses own-failure when the PR already contains main\'s green run sha', () => {
    const plan = planMainRedRebases({
      candidates: [{ ...candidate2748, prContainsMainGreenSha: true, mergeBaseCheckRuns: null }], mainRedWindows: [], mainLatestCheckRuns,
    });
    expect(plan.refusals).toEqual([expect.objectContaining({ prNumber: 2748, kind: 'own-failure' })]);
  });

  it('dispatches rebase-onto-main for a daemon-soak failure with NO red window at all, once main\'s own latest run shows it green (PR #2748\'s real shape)', () => {
    const plan = planMainRedRebases({ candidates: [candidate2748], mainRedWindows: [], mainLatestCheckRuns });
    expect(plan.dispatch).toEqual([expect.objectContaining({ prNumber: 2748, kind: 'rebase-onto-main', aheadBy: 5 })]);
    expect(plan.refusals).toEqual([]);
  });

  it('still refuses main-still-red when a DIFFERENT required check is still failing on main\'s own latest run, whatever this one check says', () => {
    const stillRedWindows = [{ start: '2026-09-27T02:00:00Z', end: null }]; // main's own `smoke` (say) still red right now
    const plan = planMainRedRebases({ candidates: [candidate2748], mainRedWindows: stillRedWindows, mainLatestCheckRuns });
    expect(plan.refusals).toEqual([expect.objectContaining({ prNumber: 2748, kind: 'main-still-red' })]);
    expect(plan.dispatch).toEqual([]);
  });

  it('refuses own-failure when main\'s latest run never reported the failing check at all — never a guess', () => {
    const plan = planMainRedRebases({ candidates: [candidate2748], mainRedWindows: [], mainLatestCheckRuns: [] });
    expect(plan.refusals).toEqual([expect.objectContaining({ prNumber: 2748, kind: 'own-failure' })]);
  });

  it('omitting mainLatestCheckRuns entirely never grants this path — byte-identical to before it existed', () => {
    const plan = planMainRedRebases({ candidates: [candidate2748], mainRedWindows: [] });
    expect(plan.refusals).toEqual([expect.objectContaining({ prNumber: 2748, kind: 'own-failure' })]);
  });
});

// ── OWED-CI-RERUN MECHANICAL-REBASE RETRY CAP (x5uqim1 follow-up, #4075/#3383) ─────────────────────────────────
describe('main-red-recovery — countRebaseOntoMainComments / buildRebaseOntoMainComment', () => {
  const AUTOMATION = { login: 'web-everything' };

  it('counts a trusted marker scoped to the given head sha, ignoring an unrelated sha', () => {
    const comments = [
      { body: buildRebaseOntoMainComment({ headSha: 'sha-a', ok: true, action: 'rebased' }), author: AUTOMATION },
      { body: buildRebaseOntoMainComment({ headSha: 'sha-b', ok: true, action: 'rebased' }), author: AUTOMATION },
    ];
    expect(countRebaseOntoMainComments(comments, 'sha-a')).toBe(1);
    expect(countRebaseOntoMainComments(comments, 'sha-b')).toBe(1);
    expect(countRebaseOntoMainComments(comments, 'sha-c')).toBe(0);
  });

  it('counts EVERY attempt regardless of outcome — a persistently failing refresh must still trip the cap', () => {
    const comments = [
      { body: buildRebaseOntoMainComment({ headSha: 'sha-a', ok: false, action: 'error', error: 'push rejected' }), author: AUTOMATION },
      { body: buildRebaseOntoMainComment({ headSha: 'sha-a', ok: false, action: 'error', error: 'push rejected' }), author: AUTOMATION },
    ];
    expect(countRebaseOntoMainComments(comments, 'sha-a')).toBe(2);
  });

  it('never counts a forged marker from an untrusted login', () => {
    const comments = [
      { body: buildRebaseOntoMainComment({ headSha: 'sha-a' }), author: { login: 'some-rando' } },
    ];
    expect(countRebaseOntoMainComments(comments, 'sha-a')).toBe(0);
  });

  it('non-array input is 0, never throws', () => {
    expect(countRebaseOntoMainComments(null)).toBe(0);
    expect(countRebaseOntoMainComments(undefined)).toBe(0);
  });

  it('the built comment always leads with the stable marker, whatever the outcome', () => {
    expect(buildRebaseOntoMainComment({ headRefName: 'lane/x', headSha: 'sha-a', ok: true, action: 'rebased' }))
      .toMatch(new RegExp(`^${REBASE_ONTO_MAIN_COMMENT_MARKER.replace(/[()]/g, '\\$&')}`));
    expect(buildRebaseOntoMainComment({ ok: false, action: 'error', error: 'boom' })).toContain('boom');
  });
});

describe('main-red-recovery — planMainRedRebases, the rebase-onto-main retry cap', () => {
  const windows = computeMainRedWindows(MAIN_RUNS);
  const candidate = (over = {}) => ({
    prNumber: 2685, headRefName: 'lane/xgqz204', headSha: 'deadbeef2685',
    aheadBy: 33, failureCompletedAt: '2026-09-25T01:57:47Z', ...over,
  });

  it('dispatches rebase-onto-main with attempts:0 for a fresh candidate (no prior attempts counted)', () => {
    const plan = planMainRedRebases({ candidates: [candidate()], mainRedWindows: windows });
    expect(plan.dispatch).toEqual([expect.objectContaining({ prNumber: 2685, kind: 'rebase-onto-main', attempts: 0 })]);
    expect(plan.refusals).toEqual([]);
  });

  it('refuses rebase-cap-exhausted once this head sha already burned its retry budget — never retries forever', () => {
    const plan = planMainRedRebases({
      candidates: [candidate({ rebaseAttemptsForSha: DEFAULT_MAX_REBASE_RETRIES_PER_SHA })],
      mainRedWindows: windows,
    });
    expect(plan.dispatch).toEqual([]);
    expect(plan.refusals).toEqual([expect.objectContaining({ prNumber: 2685, kind: 'rebase-cap-exhausted' })]);
  });

  it('a candidate the caller never counted (rebaseAttemptsForSha omitted) defaults to 0 — a fresh candidate, never pre-exhausted', () => {
    const plan = planMainRedRebases({ candidates: [candidate()], mainRedWindows: windows });
    expect(plan.dispatch).toEqual([expect.objectContaining({ attempts: 0 })]);
  });
});

// ── HUNG-CI-RUN RECOVERY (xd1sfms, #4075/#3383) ─────────────────────────────────────────────────────────────
// Fixtures mirror PR #2636's REAL statusCheckRollup shape, read live 2026-09-25 off run 36161558017: shard 1
// stuck `IN_PROGRESS` since 16:34:28Z while shards 2-4 and `smoke` had already completed — and the required
// `test` check had NO entry at all yet (it `needs: test-shard`, which had not finished).
const runningCheck = (name, startedAt, detailsUrl) => ({
  __typename: 'CheckRun', name, workflowName: 'CI', status: 'IN_PROGRESS', conclusion: '', startedAt, detailsUrl,
});
const doneCheck = (name, startedAt, completedAt, detailsUrl) => ({
  __typename: 'CheckRun', name, workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt, completedAt, detailsUrl,
});
const RUN_URL = (job) => `https://github.com/web-everything/web-everything/actions/runs/36161558017/job/${job}`;

const PR_2636_HUNG = {
  number: 2636,
  headRefName: 'lane/batch-...-3915',
  headRefOid: 'deadbeef2636',
  statusCheckRollup: [
    runningCheck('test-shard (1)', '2026-09-25T16:34:28Z', RUN_URL('108159093983')),
    doneCheck('test-shard (2)', '2026-09-25T16:33:54Z', '2026-09-25T16:35:34Z', RUN_URL('108159093444')),
    doneCheck('test-shard (3)', '2026-09-25T16:33:54Z', '2026-09-25T16:36:33Z', RUN_URL('108159093969')),
    doneCheck('test-shard (4)', '2026-09-25T16:33:55Z', '2026-09-25T16:35:42Z', RUN_URL('108159093890')),
    doneCheck('smoke', '2026-09-25T16:33:56Z', '2026-09-25T16:36:27Z', RUN_URL('108159094044')),
    // the required `test` check itself has NO entry — it `needs: test-shard` and never started.
  ],
};

const PR_QUIET_CI = {
  number: 4001,
  headRefName: 'lane/quiet',
  headRefOid: 'cafe4001',
  statusCheckRollup: [doneCheck('test', '2026-09-25T10:00:00Z', '2026-09-25T10:05:00Z', RUN_URL('1'))],
};

const NOW = Date.parse('2026-09-25T20:10:00Z'); // ~3h36m after shard 1 started — well past any real threshold.

describe('main-red-recovery — runIdFromDetailsUrl', () => {
  it('pulls the numeric run id out of a real detailsUrl', () => {
    expect(runIdFromDetailsUrl(RUN_URL('108159093983'))).toBe(36161558017);
  });
  it('returns null for a missing/unparseable url', () => {
    expect(runIdFromDetailsUrl(null)).toBeNull();
    expect(runIdFromDetailsUrl('not-a-url')).toBeNull();
  });
});

describe('main-red-recovery — isRunHung', () => {
  it('true once a run has been open past the threshold', () => {
    expect(isRunHung({ startedAt: '2026-09-25T16:34:28Z', now: NOW, thresholdMs: DEFAULT_HUNG_THRESHOLD_MS })).toBe(true);
  });
  it('false for a run well inside the threshold (a genuine, ordinary-length run)', () => {
    expect(isRunHung({ startedAt: '2026-09-25T16:34:28Z', now: Date.parse('2026-09-25T16:40:00Z'), thresholdMs: DEFAULT_HUNG_THRESHOLD_MS })).toBe(false);
  });
  it('false for an unparseable startedAt — never guessed hung', () => {
    expect(isRunHung({ startedAt: null, now: NOW })).toBe(false);
  });
});

describe('main-red-recovery — buildHungCandidates', () => {
  it("builds PR #2636's real candidate: the run id + the EARLIEST startedAt among its still-open checks (shard 1)", () => {
    const candidates = buildHungCandidates([PR_2636_HUNG]);
    expect(candidates).toEqual([{
      prNumber: 2636, headRefName: 'lane/batch-...-3915', headSha: 'deadbeef2636',
      runId: 36161558017, startedAt: '2026-09-25T16:34:28.000Z', jobName: 'test-shard (1)',
    }]);
  });

  it('never builds a candidate once the required check has itself concluded — settled, not this pass\'s job', () => {
    expect(buildHungCandidates([PR_QUIET_CI])).toEqual([]);
  });

  it('never builds a candidate for a head with no CI run at all yet', () => {
    expect(buildHungCandidates([{ number: 1, statusCheckRollup: [] }])).toEqual([]);
  });
});

describe('main-red-recovery — planHungCiRecoveries', () => {
  it('every candidate yields a dispatch or a refusal — never neither', () => {
    const candidates = buildHungCandidates([PR_2636_HUNG]);
    const plan = planHungCiRecoveries({ candidates, now: NOW });
    expect(plan.dispatch.length + plan.refusals.length).toBe(candidates.length);
  });

  it('dispatches hung-cancel-rerun for #2636\'s real shape, attempt 1/N, once past the threshold', () => {
    const candidates = buildHungCandidates([PR_2636_HUNG]);
    const plan = planHungCiRecoveries({ candidates, now: NOW, maxRetriesPerSha: DEFAULT_MAX_HUNG_RETRIES_PER_SHA });
    expect(plan.dispatch).toEqual([expect.objectContaining({
      prNumber: 2636, runId: 36161558017, headSha: 'deadbeef2636', kind: 'hung-cancel-rerun', attempts: 0,
    })]);
    expect(plan.refusals).toEqual([]);
  });

  it('refuses not-hung for a run still well inside the threshold', () => {
    const candidates = buildHungCandidates([PR_2636_HUNG]);
    const plan = planHungCiRecoveries({ candidates, now: Date.parse('2026-09-25T16:40:00Z') });
    expect(plan.refusals).toEqual([expect.objectContaining({ prNumber: 2636, kind: 'not-hung' })]);
    expect(plan.dispatch).toEqual([]);
  });

  // 2026-09-25 18:55 ET correction (#4075/#3383): once the GitHub App token got `actions:write`, a cap-hit run
  // is no longer left for GitHub's own job timeout-minutes (PR #2636's own branch predates that fix and has no
  // timeout-minutes set) — it is now cancelled (never re-run) and handed to ci-heal, the SAME shape `repeat-hang`
  // already uses.
  it('dispatches hung-cap-escalate (cancel only, never rerun) once a head sha has already used up its cap — never a third blind retry', () => {
    const candidates = [{
      prNumber: 2636, headRefName: 'lane/x', headSha: 'deadbeef2636', runId: 36161558017,
      startedAt: '2026-09-25T16:34:28Z', hungAttemptsForSha: 2,
    }];
    const plan = planHungCiRecoveries({ candidates, now: NOW, maxRetriesPerSha: 2 });
    expect(plan.dispatch).toEqual([expect.objectContaining({
      prNumber: 2636, runId: 36161558017, kind: 'hung-cap-escalate', attempts: 2,
    })]);
    expect(plan.refusals).toEqual([]);
  });

  it('a candidate the caller never counted (hungAttemptsForSha omitted) defaults to 0 — a fresh candidate, never pre-exhausted', () => {
    const candidates = [{ prNumber: 9, headSha: 'x', runId: 1, startedAt: '2026-09-25T16:00:00Z' }];
    const plan = planHungCiRecoveries({ candidates, now: NOW });
    expect(plan.dispatch).toEqual([expect.objectContaining({ prNumber: 9, attempts: 0 })]);
  });

  it('DEFAULT_HUNG_THRESHOLD_MS is well above every real p95 measured 2026-09-25 (test-shard 249s, test 380s, smoke 146s)', () => {
    expect(DEFAULT_HUNG_THRESHOLD_MS).toBeGreaterThan(380 * 1000 * 3);
  });

  // LIVE 2026-09-25, orchestrator-flagged: #2636's `test-shard (1)` hung on run 36161558017, then hung AGAIN
  // on run 36187480460 after the PR's head was refreshed onto a NEW sha. A repeat hang on the SAME job across
  // different shas is evidence of a real hang in that shard's own tests, not one-off infra — this dispatches
  // `repeat-hang` (cancel only, never rerun) instead of burning another blind retry.
  it('dispatches repeat-hang (cancel only, never rerun) when the SAME job has hung before on a DIFFERENT sha', () => {
    const candidates = [{
      prNumber: 2636, headRefName: 'lane/x', headSha: 'a-new-sha-after-refresh', runId: 36187480460,
      startedAt: '2026-09-25T20:43:42Z', jobName: 'test-shard (1)', hungAttemptsForSha: 0, hungAttemptsForJob: 1,
    }];
    const plan = planHungCiRecoveries({ candidates, now: Date.parse('2026-09-25T21:40:00Z') });
    expect(plan.dispatch).toEqual([expect.objectContaining({
      prNumber: 2636, runId: 36187480460, jobName: 'test-shard (1)', kind: 'repeat-hang',
    })]);
    expect(plan.refusals).toEqual([]);
  });

  it('repeat-hang fires on a fresh sha (0 sha-attempts) with budget left, even with a large prior job-hang count', () => {
    const candidates = [{
      prNumber: 2636, headSha: 'brand-new-sha', runId: 1, startedAt: '2026-09-25T19:00:00Z',
      jobName: 'test-shard (1)', hungAttemptsForSha: 0, hungAttemptsForJob: 3,
    }];
    const plan = planHungCiRecoveries({ candidates, now: NOW, maxRetriesPerSha: 2 });
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'repeat-hang' })]);
  });

  // LIVE 2026-09-25, second finding (confirmed against #2636's own run 36187480460): the SAME permission gap
  // that makes an ordinary cancel fail also makes a repeat-hang cancel fail, and a repeat-hang attempt posts
  // its OWN marker against the current sha — so without capping repeat-hang by the SAME per-sha budget, a
  // permanently-failing repeat-hang candidate would re-dispatch `repeat-hang` every tick forever. The per-sha
  // cap is now checked BEFORE the repeat-hang classification, so it closes this for both kinds at once.
  it('the per-sha cap takes priority over repeat-hang once THIS sha has already burned its attempts — hung-cap-escalate, never repeat-hang', () => {
    const candidates = [{
      prNumber: 2636, headSha: 'a-sha-that-keeps-failing-to-cancel', runId: 36187480460, startedAt: '2026-09-25T19:00:00Z',
      jobName: 'test-shard (1)', hungAttemptsForSha: 2, hungAttemptsForJob: 1,
    }];
    const plan = planHungCiRecoveries({ candidates, now: NOW, maxRetriesPerSha: 2 });
    expect(plan.dispatch).toEqual([expect.objectContaining({ prNumber: 2636, kind: 'hung-cap-escalate' })]);
    expect(plan.refusals).toEqual([]);
  });

  it('a job that has never hung before (hungAttemptsForJob 0/omitted) takes the ordinary hung-cancel-rerun path, not repeat-hang', () => {
    const candidates = buildHungCandidates([PR_2636_HUNG]); // hungAttemptsForJob omitted — first time this job is seen hung
    const plan = planHungCiRecoveries({ candidates, now: NOW });
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'hung-cancel-rerun' })]);
  });

  it('no jobName resolved (defensive) never crashes into repeat-hang — falls through to the ordinary path', () => {
    const candidates = [{ prNumber: 5, headSha: 'x', runId: 1, startedAt: '2026-09-25T16:00:00Z', jobName: null, hungAttemptsForJob: 5 }];
    const plan = planHungCiRecoveries({ candidates, now: NOW });
    expect(plan.dispatch).toEqual([expect.objectContaining({ kind: 'hung-cancel-rerun' })]);
  });
});

// ── MISSING-CI-RUN RECOVERY (xi4od2p, #4075/#3383) ──────────────────────────────────────────────────────────
// Fixture is PR web-everything/web-everything#2729's REAL, live-measured state, 2026-09-26: `gh pr view 2729 --json
// statusCheckRollup` carries ONLY three `review-gate` CheckRun entries (all `SUCCESS`) — zero entries for
// `test`/`smoke`/`daemon-soak`, its repo's real required contexts (`gh api repos/.../branches/main/protection
// --jq '.required_status_checks.contexts'` → `["test","smoke","daemon-soak"]`). Its head
// 19889a0edecfdf25794d39a868ff48f0860c6d39's own commit committedDate is 2026-09-26T14:20:26Z (`gh pr view 2729
// --json commits`).
describe('main-red-recovery — buildMissingRunCandidates / isMissingRunOverdue / planMissingRunRecoveries (PR #2729 fixture)', () => {
  const REVIEW_GATE_ROLLUP = [
    { __typename: 'CheckRun', name: 'review-gate', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-09-26T15:30:26Z' },
    { __typename: 'CheckRun', name: 'review-gate', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-09-26T15:30:27Z' },
    { __typename: 'CheckRun', name: 'review-gate', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-09-26T15:40:20Z' },
  ];
  const PR_2729 = {
    number: 2729,
    headRefName: 'lane/4166-check-standards-reference-checks-run-on-changed-linked-files',
    headRefOid: '19889a0edecfdf25794d39a868ff48f0860c6d39',
    statusCheckRollup: REVIEW_GATE_ROLLUP,
  };
  const REQUIRED_CONTEXTS = ['test', 'smoke', 'daemon-soak'];
  const HEAD_COMMITTED_AT = '2026-09-26T14:20:26Z';
  const NOW = Date.parse('2026-09-26T17:23:00Z'); // ~13:23 ET (EDT, UTC-4) — well past the 10min threshold

  it('RED before the fix existed: buildHungCandidates (the pre-existing pass) skips #2729 entirely — zero rollup entries for the CI workflow at all', () => {
    expect(buildHungCandidates([PR_2729], { requiredCheck: 'test', workflowName: 'CI' })).toEqual([]);
  });

  it('defers UNKNOWN mergeability without burning a recovery attempt', () => {
    expect(buildMissingRunCandidates([{ ...PR_2729, mergeable: 'UNKNOWN' }], { requiredContexts: REQUIRED_CONTEXTS })).toEqual([]);
  });

  it('a PR with zero rollup entries for EVERY required context is a candidate', () => {
    const candidates = buildMissingRunCandidates([PR_2729], { requiredContexts: REQUIRED_CONTEXTS });
    expect(candidates).toEqual([{
      prNumber: 2729, headRefName: PR_2729.headRefName, headSha: PR_2729.headRefOid, baseRefName: null,
    }]);
  });

  it('a PR that has reported for even ONE required context is NOT a candidate — that population belongs to the other passes', () => {
    const partiallyReported = {
      ...PR_2729,
      statusCheckRollup: [...REVIEW_GATE_ROLLUP, { __typename: 'CheckRun', name: 'test', status: 'IN_PROGRESS' }],
    };
    expect(buildMissingRunCandidates([partiallyReported], { requiredContexts: REQUIRED_CONTEXTS })).toEqual([]);
  });

  it('a PR whose required checks HAVE reported is never a candidate, whatever their outcome', () => {
    const green = { ...PR_2729, statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] };
    expect(buildMissingRunCandidates([green], { requiredContexts: ['test'] })).toEqual([]);
  });

  it('an explicitly EMPTY required-context set yields no candidates — never substitutes the default (PR #2740 review)', () => {
    expect(buildMissingRunCandidates([PR_2729], { requiredContexts: [] })).toEqual([]);
  });

  it('UNKNOWN required contexts (null) flags only a PR with no CI-workflow check at all — never a partially reported one', () => {
    const ciSmoke = { __typename: 'CheckRun', name: 'smoke', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' };
    expect(buildMissingRunCandidates([{ ...PR_2729, statusCheckRollup: [ciSmoke] }], { requiredContexts: null })).toEqual([]);
    expect(buildMissingRunCandidates([PR_2729], { requiredContexts: null })).toEqual([expect.objectContaining({ prNumber: 2729 })]);
  });

  // Live incident, web-everything/web-everything#2793 (landing freeze, 2026-09-27): real `gh pr view` shape —
  // `mergeable: CONFLICTING`, `mergeStateStatus: DIRTY`, empty `statusCheckRollup` (GitHub creates no merge ref
  // for a conflicting PR, so no `pull_request`-triggered check can ever start). Before the fix this read as an
  // ordinary missing-run candidate and got retriggered every sweep until the cap burned — a permanent
  // false-positive with nothing to do with "GitHub hasn't noticed the push yet".
  const PR_2793_CONFLICTING = {
    number: 2793,
    headRefName: 'lane/rerun-after-main-fix',
    headRefOid: '8be3bce0e51990837b7f9c016b407ec0f1657a1c',
    mergeable: 'CONFLICTING',
    statusCheckRollup: [],
  };

  it('RED before the fix: a real merge conflict (mergeable CONFLICTING, empty rollup) reads as an ordinary missing-run candidate', () => {
    // Reproduces the pre-fix shape by ignoring `mergeable` — pinned so a future regression that stops passing
    // `mergeable` through silently re-opens the #2793 cap-burn.
    const { mergeable, ...withoutMergeable } = PR_2793_CONFLICTING;
    expect(buildMissingRunCandidates([withoutMergeable], { requiredContexts: REQUIRED_CONTEXTS })).toEqual([
      expect.objectContaining({ prNumber: 2793 }),
    ]);
  });

  it('GREEN after the fix: a real merge conflict (mergeable CONFLICTING) is NEVER a missing-run candidate, whatever its rollup — #2793', () => {
    expect(buildMissingRunCandidates([PR_2793_CONFLICTING], { requiredContexts: REQUIRED_CONTEXTS })).toEqual([]);
    // Case-insensitive, and inert (unchanged behaviour) when `mergeable` is absent entirely.
    expect(buildMissingRunCandidates([{ ...PR_2793_CONFLICTING, mergeable: 'conflicting' }], { requiredContexts: REQUIRED_CONTEXTS })).toEqual([]);
    expect(buildMissingRunCandidates([PR_2729], { requiredContexts: REQUIRED_CONTEXTS })).toEqual([
      expect.objectContaining({ prNumber: 2729 }),
    ]);
  });

  it('the missing-run marker records a fallen-back refresh outcome', () => {
    expect(buildMissingRunComment({ headSha: 'sha-a', ok: true, action: 'workflow-dispatch', refresh: 'skip', refreshError: 'conflict' }))
      .toContain('requested CI via workflow-dispatch; PR checks must still be observed (refresh onto main first: skip — conflict)');
  });

  it('isMissingRunOverdue: false before the threshold, true past it, false on an unreadable timestamp', () => {
    expect(isMissingRunOverdue({ headCommittedAt: HEAD_COMMITTED_AT, now: NOW, thresholdMs: DEFAULT_MISSING_RUN_THRESHOLD_MS })).toBe(true);
    expect(isMissingRunOverdue({ headCommittedAt: '2026-09-26T17:20:00Z', now: NOW, thresholdMs: DEFAULT_MISSING_RUN_THRESHOLD_MS })).toBe(false);
    expect(isMissingRunOverdue({ headCommittedAt: 'not-a-date', now: NOW })).toBe(false);
  });

  it('plans a PR-event recovery for an overdue head even when it is behind main', () => {
    const candidates = buildMissingRunCandidates([PR_2729], { requiredContexts: REQUIRED_CONTEXTS })
      .map((c) => ({ ...c, headCommittedAt: HEAD_COMMITTED_AT, aheadBy: 3, triggerAttemptsForSha: 0 }));
    const plan = planMissingRunRecoveries({ candidates, now: NOW });
    expect(plan.dispatch).toEqual([expect.objectContaining({
      prNumber: 2729, kind: 'trigger-ci',
    })]);
    expect(plan.refusals).toEqual([]);
  });

  it('requests a PR-event recovery once the PR already has main\'s tip (aheadBy: 0)', () => {
    const candidates = buildMissingRunCandidates([PR_2729], { requiredContexts: REQUIRED_CONTEXTS })
      .map((c) => ({ ...c, headCommittedAt: HEAD_COMMITTED_AT, aheadBy: 0, triggerAttemptsForSha: 0 }));
    const plan = planMissingRunRecoveries({ candidates, now: NOW });
    expect(plan.dispatch).toEqual([expect.objectContaining({ prNumber: 2729, kind: 'trigger-ci' })]);
  });

  it('refuses not-overdue for a head committed just now', () => {
    const candidates = [{ prNumber: 1, headSha: 's', headCommittedAt: '2026-09-26T17:22:00Z' }];
    const plan = planMissingRunRecoveries({ candidates, now: NOW });
    expect(plan.refusals).toEqual([expect.objectContaining({ prNumber: 1, kind: 'not-overdue' })]);
  });

  it('refuses unknown-committed-at rather than guessing when the head commit date could not be read', () => {
    const candidates = [{ prNumber: 1, headSha: 's', headCommittedAt: null }];
    const plan = planMissingRunRecoveries({ candidates, now: NOW });
    expect(plan.refusals).toEqual([expect.objectContaining({ prNumber: 1, kind: 'unknown-committed-at' })]);
  });

  it('caps at DEFAULT_MAX_MISSING_RUN_RETRIES_PER_SHA — a head sha that keeps failing to produce a real run is handed to a human/ci-heal, not retried forever', () => {
    const candidates = [{
      prNumber: 2729, headSha: PR_2729.headRefOid, headCommittedAt: HEAD_COMMITTED_AT,
      triggerAttemptsForSha: DEFAULT_MAX_MISSING_RUN_RETRIES_PER_SHA,
    }];
    const plan = planMissingRunRecoveries({ candidates, now: NOW });
    expect(plan.dispatch).toEqual([]);
    expect(plan.refusals).toEqual([expect.objectContaining({ prNumber: 2729, kind: 'missing-run-cap-exhausted' })]);
  });
});

describe('main-red-recovery — countMissingRunComments / buildMissingRunComment', () => {
  const AUTOMATION = { login: 'web-everything' };

  it('counts a trusted marker scoped to the given head sha, ignoring an unrelated sha', () => {
    const comments = [
      { body: buildMissingRunComment({ headSha: 'sha-a', ok: true, action: 'update-branch' }), author: AUTOMATION },
      { body: buildMissingRunComment({ headSha: 'sha-b', ok: true, action: 'pull-request-push' }), author: AUTOMATION },
    ];
    expect(countMissingRunComments(comments, 'sha-a')).toBe(1);
    expect(countMissingRunComments(comments, 'sha-b')).toBe(1);
    expect(countMissingRunComments(comments, 'sha-c')).toBe(0);
  });

  it('counts EVERY attempt regardless of outcome — a persistently failing trigger must still trip the cap', () => {
    const comments = [
      { body: buildMissingRunComment({ headSha: 'sha-a', ok: false, action: 'pull-request-push', error: 'workflow not found' }), author: AUTOMATION },
      { body: buildMissingRunComment({ headSha: 'sha-a', ok: false, action: 'pull-request-push', error: 'workflow not found' }), author: AUTOMATION },
    ];
    expect(countMissingRunComments(comments, 'sha-a')).toBe(2);
  });

  it('never counts a forged marker from an untrusted login', () => {
    const comments = [{ body: buildMissingRunComment({ headSha: 'sha-a' }), author: { login: 'some-rando' } }];
    expect(countMissingRunComments(comments, 'sha-a')).toBe(0);
  });

  it('non-array input is 0, never throws', () => {
    expect(countMissingRunComments(null)).toBe(0);
    expect(countMissingRunComments(undefined)).toBe(0);
  });

  it('the built comment always leads with the stable marker, whatever the outcome', () => {
    expect(buildMissingRunComment({ headRefName: 'lane/x', headSha: 'sha-a', ok: true, action: 'update-branch' }))
      .toMatch(new RegExp(`^${MISSING_RUN_COMMENT_MARKER.replace(/[()]/g, '\\$&')}`));
    expect(buildMissingRunComment({ ok: false, action: 'pull-request-push', error: 'boom' })).toContain('boom');
  });
});

// soak-main-red (2026-09-26): a PR red only on `daemon-soak` while main's own soak was red must be attributable
// to main exactly like a `test`-red one — it used to be judged on `test` alone, so it read as the PR's own.
describe('failingRequiredCheckForAttribution — every required check, not test alone', async () => {
  const { failingRequiredCheckForAttribution, isAnyRequiredCheckFailed, DEFAULT_MAIN_RED_ATTRIBUTED_CHECKS } = await import('../main-red-recovery.mjs');
  const WINDOWS = [{ start: '2026-09-27T02:00:00Z', end: null }];
  const row = (name, conclusion, completedAt) => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion, completedAt });
  const pr = (...rows) => ({ number: 2783, statusCheckRollup: rows });

  it('defaults to the required contexts test / smoke / daemon-soak', () => {
    expect(DEFAULT_MAIN_RED_ATTRIBUTED_CHECKS).toEqual(['test', 'smoke', 'daemon-soak']);
  });

  it('DEFAULT_MAIN_RED_ATTRIBUTED_CHECKS is the SAME binding as required-status-checks.mjs\'s FALLBACK (#4501 — never a second hardcoded copy)', async () => {
    const { DEFAULT_MAIN_RED_ATTRIBUTED_CHECKS } = await import('../main-red-recovery.mjs');
    const { FALLBACK_REQUIRED_STATUS_CHECKS } = await import('../../lib/required-status-checks.mjs');
    expect(DEFAULT_MAIN_RED_ATTRIBUTED_CHECKS).toBe(FALLBACK_REQUIRED_STATUS_CHECKS);
  });

  it('a daemon-soak-only red PR is failing, and its daemon-soak failure is the one judged', () => {
    const p = pr(row('test', 'SUCCESS', '2026-09-27T02:03:00Z'), row('daemon-soak', 'FAILURE', '2026-09-27T02:11:30Z'));
    expect(isAnyRequiredCheckFailed(p)).toBe(true);
    expect(failingRequiredCheckForAttribution(p, { mainRedWindows: WINDOWS })).toEqual({ name: 'daemon-soak', completedAt: '2026-09-27T02:11:30Z' });
    expect(classifyCiFailureAttribution({ failureCompletedAt: '2026-09-27T02:11:30Z', mainRedWindows: WINDOWS })).toBe('main-red');
  });

  it('a non-required check (soak-shard (2)) failing alone is not a required failure', () => {
    const p = pr(row('soak-shard (2)', 'FAILURE', '2026-09-27T02:11:25Z'), row('daemon-soak', 'SUCCESS', '2026-09-27T02:11:30Z'));
    expect(isAnyRequiredCheckFailed(p)).toBe(false);
    expect(failingRequiredCheckForAttribution(p, { mainRedWindows: WINDOWS })).toBeNull();
  });

  it('with several failing, one failure main cannot explain wins — the PR owns it', () => {
    const p = pr(row('test', 'FAILURE', '2026-09-27T01:00:00Z'), row('daemon-soak', 'FAILURE', '2026-09-27T02:11:30Z'));
    expect(failingRequiredCheckForAttribution(p, { mainRedWindows: WINDOWS })).toEqual({ name: 'test', completedAt: '2026-09-27T01:00:00Z' });
  });

  it('an explicit empty required list means nothing is required, so nothing is failing', () => {
    const p = pr(row('daemon-soak', 'FAILURE', '2026-09-27T02:11:30Z'));
    expect(isAnyRequiredCheckFailed(p, [])).toBe(false);
    expect(failingRequiredCheckForAttribution(p, { requiredChecks: [], mainRedWindows: WINDOWS })).toBeNull();
  });
});
