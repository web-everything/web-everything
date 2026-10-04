import { dispatchReview } from '../../../scripts/operations/review-dispatch.mjs';
import { readReviewCiGate } from '../../../scripts/lib/review-ci-gate-io.mjs';
/**
 * @file skills-src/conveyor/__tests__/review-daemon.test.mjs
 * @description Unit proof of #3876's standalone Review daemon — the pure loop (mirrors #3870's own tests)
 *   and the per-tick sequence, both with every effect injected (no real gh/claude, no real lease/timer).
 */
import { describe, it, expect, vi } from 'vitest';

// Mocked so `defaultReapSessions`'s own describe block below can assert exactly what it passes through
// WITHOUT ever shelling a real `claude agents`/`claude stop`/`gh` call — this repo's own hard rule (never touch
// a real process in a test; inject a fake). `session-reaper.mjs`'s OWN test suite
// (scripts/conveyor/__tests__/session-reaper.test.mjs) already proves `runSessionReaperPass`'s real behavior;
// this file only needs to prove review-daemon.mjs wires it correctly.
const runSessionReaperPassMock = vi.fn(() => ({ scanned: 0, stopped: 0, alreadyGone: 0, failures: 0, anomalies: 0, kept: 0 }));
vi.mock('../../../scripts/conveyor/session-reaper.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, runSessionReaperPass: (...args) => runSessionReaperPassMock(...args) };
});

// #x01u7az — same reasoning: `runReviewTick`'s new `holdReconcile` default (`sweepReviewHoldLabels`) shells a
// real `gh pr list` when not injected. Every `runReviewTick(...)` call below that omits `holdReconcile`
// exercises this mock (a plain no-op), never a real `gh` call; the sweep's own real behavior is proven by its
// OWN test file (scripts/conveyor/__tests__/review-hold-reconcile.test.mjs) and this daemon's wiring of it is
// proven separately below (the dedicated `runReviewTick — the review-hold reconcile sweep` describe block,
// which injects its own fake to assert the wiring).
const sweepReviewHoldLabelsMock = vi.fn(() => []);
vi.mock('../../../scripts/conveyor/review-hold-reconcile.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, sweepReviewHoldLabels: (...args) => sweepReviewHoldLabelsMock(...args) };
});

import {
  runDaemonLoop, runReviewTick, runReviewTickAllRepos, REVIEW_DAEMON_REPOS, buildCliDaemonEffects, realSleep,
  REVIEW_DAEMON_LEASE_KEY, DEFAULT_INTERVAL_MS, defaultReapSessions, hasStaleMainRefusal, defaultAcquirableLaneCount,
  explainPendingNotDispatched, priorityNamesForLiveProcessPrs, runConvertAdvisoryTick, runConvertAdvisoryTickAllRepos,
} from '../review-daemon.mjs';
import { planReviewDispatch } from '../../../scripts/operations/review-dispatch.mjs';
import { tagReviewStatus } from '../../../scripts/conveyor/review-status-tag.mjs';
import { CONSTELLATION_REPOS } from '../../../scripts/lib/constellation-repos.mjs';
import { REPO_ROOT as SESSION_REAPER_REPO_ROOT, DEFAULT_IDLE_REAP_THRESHOLD_MS } from '../../../scripts/conveyor/session-reaper.mjs';
import { assertMainNotStale } from '../../../scripts/lib/main-staleness.mjs';

// #3383 bug 1 — wired into withSelfSync's `hasStaleRefusal` option in main(); tested here in isolation
// (pure, no IO) against the exact shapes `runReviewTickAllRepos` returns (`failed[]` per-PR, `repos[].error`
// whole-repo).
describe('hasStaleMainRefusal', () => {
  const staleMessage = () => {
    let message = null;
    try { assertMainNotStale('/repo', () => ({ action: 'warn', reason: 'diverged', behind: 1, ahead: 5, dirty: false })); }
    catch (e) { message = e.message; }
    return message;
  };
  it('true when a per-PR dispatch failed with the real assertMainNotStale refusal message', () => {
    expect(hasStaleMainRefusal({ failed: [{ prNumber: 42, repo: 'web-everything/web-everything', error: staleMessage() }] })).toBe(true);
  });
  it('true when a WHOLE-REPO tick failed with it (forEachRepo\'s own {repo, error} capture)', () => {
    expect(hasStaleMainRefusal({ repos: [{ repo: 'plateauapp/plateau-app', error: staleMessage() }] })).toBe(true);
  });
  it('false for an ordinary, unrelated failure in either shape', () => {
    expect(hasStaleMainRefusal({ failed: [{ prNumber: 1, error: 'gh: rate limited' }] })).toBe(false);
    expect(hasStaleMainRefusal({ repos: [{ repo: 'x', error: 'ENOTFOUND' }] })).toBe(false);
  });
  it('false with nothing failed, or a missing/malformed result', () => {
    expect(hasStaleMainRefusal({ failed: [], repos: [] })).toBe(false);
    expect(hasStaleMainRefusal({})).toBe(false);
    expect(hasStaleMainRefusal(undefined)).toBe(false);
  });
});

describe('runDaemonLoop — the pure control flow', () => {
  it('requires a tickOnce effect', async () => {
    await expect(runDaemonLoop({})).rejects.toThrow(/requires a tickOnce effect/);
  });

  it('ticks, sleeps between ticks, and stops at maxTicks', async () => {
    const sleep = vi.fn(async () => {});
    const tickOnce = vi.fn(async () => ({ reviewsOwed: 0 }));
    const out = await runDaemonLoop({ tickOnce, sleep, maxTicks: 3 });
    expect(tickOnce).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(out).toEqual({ ticks: 3, stoppedReason: 'max-ticks' });
  });

  it('a failing tick is isolated — reported via onTickError, never fatal', async () => {
    const onTickError = vi.fn();
    let n = 0;
    const tickOnce = vi.fn(async () => { n += 1; if (n === 1) throw new Error('gh hiccup'); return {}; });
    const out = await runDaemonLoop({ tickOnce, sleep: async () => {}, onTickError, maxTicks: 2 });
    expect(onTickError).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ ticks: 2, stoppedReason: 'max-ticks' });
  });

  it('a lost heartbeat stops the loop immediately', async () => {
    let hb = 0;
    const heartbeat = vi.fn(async () => { hb += 1; return hb < 2; });
    const sleep = vi.fn(async () => {});
    const out = await runDaemonLoop({ tickOnce: async () => ({}), sleep, heartbeat, maxTicks: Infinity });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ ticks: 2, stoppedReason: 'lease-lost' });
  });
});

describe('runReviewTick — the per-tick sequence', () => {
  const owedPlan = (entries, refusals = []) => ({ dispatch: entries, refusals });

  it('forwards the PR snapshot escalation and statute paths to the review session launcher', () => {
    const dispatch = vi.fn(() => ({ agentId: 'review-agent' }));
    runReviewTick({
      readAgents: () => [],
      readPrs: () => [{ number: 10, body: '## Escalation reason\n\n- statute',
        files: [{ path: 'docs/agent/platform-decisions.md' }] }],
      reconcile: () => owedPlan([{ kind: 'review', prNumber: 10 }]),
      dispatch, tagRound: vi.fn(), tagStatus: vi.fn(), statusCandidates: () => [],
    });
    expect(dispatch).toHaveBeenCalledWith({ pr: 10, repo: 'web-everything/web-everything',
      escalationReason: ['statute'], scopePaths: ['docs/agent/platform-decisions.md'] });
  });

  it('dispatches every review-kind entry, tags its round, and ignores non-review kinds', () => {
    const reconcile = vi.fn(() => owedPlan([
      { kind: 'review', prNumber: 10, attempts: 1 },
      { kind: 'fix', prNumber: 11 }, // not this daemon's job
    ]));
    const dispatch = vi.fn(({ pr }) => ({ agentId: `agent-${pr}` }));
    const tagRound = vi.fn();
    const tagStatus = vi.fn();
    const out = runReviewTick({ reconcile, dispatch, tagRound, tagStatus, statusCandidates: () => [] });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({ pr: 10, repo: 'web-everything/web-everything', escalationReason: [], scopePaths: [] });
    expect(tagRound).toHaveBeenCalledWith({ pr: 10, repo: expect.any(String), round: 2 }); // attempts+1
    expect(out).toEqual({
      reviewsOwed: 1, dispatched: [{ prNumber: 10, agentId: 'agent-10' }], failed: [], notStarted: [], refusals: 0,
      pendingNotDispatched: [], reconcileError: null, deferredForLanes: 0, deferredForAuth: 0, authPaused: false, authPauseReason: null,
      holdReconcile: [], holdReconcileError: null, liveProcessPrs: [],
    });
  });

  // x26lw6u — the job dispatch: the row carries the mode and the job pid, and a declined start (a live job
  // already on the PR, or the lane cool-off) is reported as skipped with no round tag, never as dispatched.
  // Live-caught 2026-09-25 on the daemon overlay: the first cut named this field `skipped`, which collides with
  // withSelfSync's own `{skipped: true}` whole-tick shape and crashed onTick ("boolean true is not iterable").
  it('onTick survives withSelfSync\'s skipped-tick shape ({skipped: true})', () => {
    const lines = [];
    const fx = buildCliDaemonEffects({ owner: 'o', log: { error: (l) => lines.push(l) }, reapSessions: () => null, runReview: () => ({}) });
    expect(() => fx.onTick({ skipped: true, reason: 'tick-in-progress', repos: [], dispatched: [], failed: [], refusals: [], reconcileFailed: [], reviewsOwed: 0 })).not.toThrow();
  });

  it('a job dispatch records mode + jobPid; a skipped job start gets no round tag and lands in notStarted', () => {
    const reconcile = vi.fn(() => owedPlan([{ kind: 'review', prNumber: 10, attempts: 0 }, { kind: 'review', prNumber: 20, attempts: 0 }]));
    const dispatch = vi.fn(({ pr }) => (pr === 10
      ? { mode: 'job', agentId: null, jobPid: 4242 }
      : { mode: 'job', agentId: null, jobPid: 77, skipped: 'live-job' }));
    const tagRound = vi.fn();
    const out = runReviewTick({ reconcile, dispatch, tagRound, tagStatus: () => {}, statusCandidates: () => [] });
    expect(out.dispatched).toEqual([{ prNumber: 10, agentId: null, mode: 'job', jobPid: 4242 }]);
    expect(out.notStarted).toEqual([{ prNumber: 20, reason: 'live-job' }]);
    expect(tagRound).toHaveBeenCalledTimes(1);
    expect(tagRound).toHaveBeenCalledWith(expect.objectContaining({ pr: 10 }));
  });

  it('a failed dispatch is isolated: no round tag, recorded in failed, does not stop the tick', () => {
    const reconcile = vi.fn(() => owedPlan([{ kind: 'review', prNumber: 10, attempts: 0 }, { kind: 'review', prNumber: 20, attempts: 0 }]));
    const dispatch = vi.fn(({ pr }) => { if (pr === 10) throw new Error('checkout stale'); return { agentId: 'a20' }; });
    const tagRound = vi.fn();
    const out = runReviewTick({ reconcile, dispatch, tagRound, tagStatus: () => {}, statusCandidates: () => [] });
    expect(tagRound).toHaveBeenCalledTimes(1);
    expect(tagRound).toHaveBeenCalledWith(expect.objectContaining({ pr: 20 }));
    expect(out.failed).toEqual([{ prNumber: 10, error: 'checkout stale' }]);
    expect(out.dispatched).toEqual([{ prNumber: 20, agentId: 'a20' }]);
  });

  it('a failing tag (round or status) never fails the tick — cosmetic only', () => {
    const reconcile = vi.fn(() => owedPlan([{ kind: 'review', prNumber: 10, attempts: 0 }]));
    const dispatch = vi.fn(() => ({ agentId: 'a10' }));
    const tagRound = vi.fn(() => { throw new Error('gh label API down'); });
    const tagStatus = vi.fn(() => { throw new Error('gh label API down'); });
    const out = runReviewTick({ reconcile, dispatch, tagRound, tagStatus, statusCandidates: (r) => r });
    expect(out.dispatched).toEqual([{ prNumber: 10, agentId: 'a10' }]);
    expect(out.failed).toEqual([]);
  });

  it('status candidates cover both the reviews owed and non-nothing-owed refusals (via the injected selector)', () => {
    const reviews = [{ kind: 'review', prNumber: 10, attempts: 0 }];
    const refusals = [{ kind: 'needs-human', prNumber: 30 }];
    const reconcile = vi.fn(() => owedPlan(reviews, refusals));
    const statusCandidates = vi.fn((r, ref) => [...r, ...ref]);
    const tagStatus = vi.fn();
    runReviewTick({ reconcile, dispatch: () => ({ agentId: 'a' }), tagRound: () => {}, tagStatus, statusCandidates });
    expect(statusCandidates).toHaveBeenCalledWith(reviews, refusals, [], []);
    expect(tagStatus).toHaveBeenCalledTimes(2);
  });

  // Live-caught 2026-09-22, #xli631k: a PR owed a FIX (not a review) used to never reach statusCandidates at
  // all, so review-status:reviewing sat stale once its review session finished (PR #2472, ~2h stale).
  it('fix-kind dispatch entries reach statusCandidates as its own third argument, not silently dropped', () => {
    const reviews = [{ kind: 'review', prNumber: 10, attempts: 0 }];
    const fixes = [{ kind: 'fix', prNumber: 20, attempts: 1 }];
    const reconcile = vi.fn(() => owedPlan([...reviews, ...fixes], []));
    const statusCandidates = vi.fn(() => []);
    runReviewTick({ reconcile, dispatch: () => ({ agentId: 'a' }), tagRound: () => {}, tagStatus: () => {}, statusCandidates });
    expect(statusCandidates).toHaveBeenCalledWith(reviews, [], fixes, []);
  });

  // Live-caught 2026-09-26, PR #2742, card xg790dh: same shape as the fix-owed miss above — a PR owed a
  // CI-HEAL (not a fix) used to never reach statusCandidates at all either.
  it('ci-heal-kind dispatch entries reach statusCandidates as its own fourth argument, not silently dropped', () => {
    const reviews = [{ kind: 'review', prNumber: 10, attempts: 0 }];
    const ciHeals = [{ kind: 'ci-heal', prNumber: 2742, attempts: 0 }];
    const reconcile = vi.fn(() => owedPlan([...reviews, ...ciHeals], []));
    const statusCandidates = vi.fn(() => []);
    runReviewTick({ reconcile, dispatch: () => ({ agentId: 'a' }), tagRound: () => {}, tagStatus: () => {}, statusCandidates });
    expect(statusCandidates).toHaveBeenCalledWith(reviews, [], [], ciHeals);
  });

  it('an agent id missing from the dispatch result records null, not undefined or a throw', () => {
    const reconcile = vi.fn(() => owedPlan([{ kind: 'review', prNumber: 10, attempts: 0 }]));
    const out = runReviewTick({ reconcile, dispatch: () => ({}), tagRound: () => {}, tagStatus: () => {}, statusCandidates: () => [] });
    expect(out.dispatched).toEqual([{ prNumber: 10, agentId: null }]);
  });

  it('no reviews owed → dispatches nothing, still runs the status sweep', () => {
    const reconcile = vi.fn(() => owedPlan([], [{ kind: 'ci-red', prNumber: 40 }]));
    const tagStatus = vi.fn();
    const out = runReviewTick({ reconcile, dispatch: () => { throw new Error('should not be called'); }, tagRound: () => {}, tagStatus, statusCandidates: (r, ref) => ref });
    expect(out).toMatchObject({ reviewsOwed: 0, dispatched: [], failed: [], refusals: 1 });
    expect(tagStatus).toHaveBeenCalledTimes(1);
  });

  // Live-caught 2026-09-26, PR web-everything/web-everything#2711, card x8who76 — END-TO-END with #2711's REAL label
  // sequence and the REAL `selectStatusCandidates`/`tagReviewStatus` (only the `gh` provider is faked): #2711
  // got `review:accepted` + `ready-to-merge` (phase `queued` → `classifyPr`), which `reconcile-pass.mjs`'s real
  // `runReconcilePass` refuses as `nothing-owed` — NOT a review/fix dispatch entry, and (before this fix)
  // silently dropped by `selectStatusCandidates`'s own `nothing-owed` exclusion. No `review-<pr>`/`fix-<pr>`
  // session or job was live (the review job had already finished; `review-2711.log` was the only thing left in
  // `.operations/review-jobs/`), yet `review-status:reviewing` (added while the review round was still live)
  // sat on the PR uncleared — "accepted AND reviewing" at once. This proves the daemon's real per-tick wiring,
  // not just the pure `selectStatusCandidates`/`tagReviewStatus` units in isolation.
  it('#2711: a PR that just went from review-owed to accepted+ready-to-merge gets review-status:reviewing cleared within one tick', () => {
    const pr2711Labels = [
      { name: 'review:accepted' }, { name: 'ready-to-merge' },
      { name: 'review-round:2' }, { name: 'review-status:reviewing' }, { name: 'checking' },
    ];
    const reconcile = vi.fn(() => ({
      dispatch: [],
      refusals: [{ kind: 'nothing-owed', prNumber: 2711, phase: 'queued' }],
    }));
    const readPrs = () => [{ number: 2711, labels: pr2711Labels }];
    // No `review-2711`/`fix-2711` row at all — the job already finished and its record was already removed
    // (`listAgentsWithReviewJobs`'s own "a dead/absent job must not keep a PR looking busy forever" contract).
    const readAgents = () => [];
    const setLabelsCalls = [];
    const fakeProvider = {
      readLabels: () => { throw new Error('must use the shared currentLabels, never re-read'); },
      ensureLabel: () => {},
      setLabels: (repo, pr, spec) => setLabelsCalls.push({ repo, pr, spec }),
    };
    const tagStatus = (opts) => tagReviewStatus({ ...opts, provider: fakeProvider });
    const out = runReviewTick({
      reconcile, readPrs, readAgents, tagStatus,
      dispatch: () => { throw new Error('nothing should be dispatched — #2711 owes nothing'); },
      tagRound: () => { throw new Error('no round tag on a non-dispatched PR'); },
    });
    expect(out.reviewsOwed).toBe(0);
    expect(out.dispatched).toEqual([]);
    expect(setLabelsCalls).toEqual([
      { repo: 'web-everything/web-everything', pr: 2711, spec: { add: undefined, remove: ['review-status:reviewing'] } },
    ]);
  });

  // Live-caught 2026-09-26, PR web-everything/web-everything#2742, card xg790dh — END-TO-END with #2742's REAL label
  // sequence and the REAL `selectStatusCandidates`/`tagReviewStatus` (only the `gh` provider is faked): #2742's
  // `fix-2742` session finished (`state: 'done'`, idle 11+ min) and its re-push then went CI-red (`ci:failed`),
  // so `reconcile-pass.mjs`'s real `runReconcilePass` now dispatches a `kind:'ci-heal'` entry for it — NOT a
  // review/fix dispatch, and (before this fix) `kind:'ci-heal'` matched neither `reviews` nor `fixes` in
  // `runReviewTick`'s own filters, so it never reached `selectStatusCandidates` at all.
  // `review-status:fixing` (added while the fix was genuinely live) sat stale — the operator read "fixing" on a
  // PR nothing was actually touching.
  it('#2742: a PR that just went from fix-owed to ci-heal-owed gets review-status:fixing cleared (no ci-heal session live yet)', () => {
    const pr2742Labels = [
      { name: 'review:pending' }, { name: 'ci:failed' },
      { name: 'review-round:1' }, { name: 'review-status:fixing' },
    ];
    const reconcile = vi.fn(() => ({
      dispatch: [{ kind: 'ci-heal', prNumber: 2742, attempts: 0 }],
      refusals: [],
    }));
    const readPrs = () => [{ number: 2742, labels: pr2742Labels }];
    // The fix session finished (`state: 'done'`) — not live, and no `ci-heal-2742` session has started yet.
    const readAgents = () => [{ name: 'fix-2742', state: 'done' }];
    const setLabelsCalls = [];
    const fakeProvider = {
      readLabels: () => { throw new Error('must use the shared currentLabels, never re-read'); },
      ensureLabel: () => {},
      setLabels: (repo, pr, spec) => setLabelsCalls.push({ repo, pr, spec }),
    };
    const tagStatus = (opts) => tagReviewStatus({ ...opts, provider: fakeProvider });
    const out = runReviewTick({
      reconcile, readPrs, readAgents, tagStatus,
      dispatch: () => { throw new Error('runReviewTick never dispatches a ci-heal itself'); },
      tagRound: () => { throw new Error('no round tag on a non-review dispatch'); },
    });
    expect(out.reviewsOwed).toBe(0);
    expect(out.dispatched).toEqual([]);
    expect(setLabelsCalls).toEqual([
      { repo: 'web-everything/web-everything', pr: 2742, spec: { add: undefined, remove: ['review-status:fixing'] } },
    ]);
  });

  it('#2742 follow-on: once a live ci-heal-2742 session actually starts, the status flips straight to healing-ci', () => {
    const pr2742Labels = [
      { name: 'review:pending' }, { name: 'ci:failed' },
      { name: 'review-round:1' }, { name: 'review-status:fixing' },
    ];
    const reconcile = vi.fn(() => ({
      dispatch: [{ kind: 'ci-heal', prNumber: 2742, attempts: 0 }],
      refusals: [],
    }));
    const readPrs = () => [{ number: 2742, labels: pr2742Labels }];
    const readAgents = () => [{ name: 'fix-2742', state: 'done' }, { name: 'ci-heal-2742', state: 'working' }];
    const setLabelsCalls = [];
    const fakeProvider = {
      readLabels: () => { throw new Error('must use the shared currentLabels, never re-read'); },
      ensureLabel: () => {},
      setLabels: (repo, pr, spec) => setLabelsCalls.push({ repo, pr, spec }),
    };
    const tagStatus = (opts) => tagReviewStatus({ ...opts, provider: fakeProvider });
    runReviewTick({
      reconcile, readPrs, readAgents, tagStatus,
      dispatch: () => { throw new Error('runReviewTick never dispatches a ci-heal itself'); },
      tagRound: () => { throw new Error('no round tag on a non-review dispatch'); },
    });
    expect(setLabelsCalls).toEqual([
      { repo: 'web-everything/web-everything', pr: 2742, spec: { add: 'review-status:healing-ci', remove: ['review-status:fixing'] } },
    ]);
  });

  // draft-first PRs (operator-approved 2026-09-27) — a draft PR's own `isDraft` field, carried on the SAME
  // `rawPrs` snapshot this tick already reads, must reach `tagStatus` so the operator sees
  // `review-status:awaiting-ci` instead of no label at all. No dispatch happens (reconcile-core.mjs refuses
  // `draft`, not owed a review) — this test pins the LABEL WIRING, not reconcile-core's own dispatch logic
  // (that is `reconcile-core.test.mjs`'s job).
  it('draft-first PRs: a draft PR refused `draft` gets tagged review-status:awaiting-ci, with no gh re-read of isDraft', () => {
    const reconcile = vi.fn(() => ({
      dispatch: [],
      refusals: [{ kind: 'draft', prNumber: 3001 }],
    }));
    const readPrs = () => [{ number: 3001, labels: [{ name: 'review:pending' }], isDraft: true }];
    const readAgents = () => [];
    const setLabelsCalls = [];
    const fakeProvider = {
      readLabels: () => { throw new Error('must use the shared currentLabels, never re-read'); },
      ensureLabel: () => {},
      setLabels: (repo, pr, spec) => setLabelsCalls.push({ repo, pr, spec }),
    };
    const tagStatus = (opts) => tagReviewStatus({ ...opts, provider: fakeProvider });
    const out = runReviewTick({
      reconcile, readPrs, readAgents, tagStatus,
      dispatch: () => { throw new Error('a draft PR is never dispatched a review'); },
      tagRound: () => { throw new Error('no round tag on a non-dispatched PR'); },
    });
    expect(out.dispatched).toEqual([]);
    expect(setLabelsCalls).toEqual([
      { repo: 'web-everything/web-everything', pr: 3001, spec: { add: 'review-status:awaiting-ci', remove: [] } },
    ]);
  });
});

describe('runReviewTick — #3383 bug 3: dispatch is capped by acquirableLanes, never by reviews owed alone', () => {
  const owedPlan = (entries, refusals = []) => ({ dispatch: entries, refusals });
  const reviewsPlan = (n) => owedPlan(Array.from({ length: n }, (_, i) => ({ kind: 'review', prNumber: 100 + i, attempts: 0 })));

  it('defaults to unbounded (Infinity) when acquirableLanes is omitted — every pre-existing caller is unaffected', () => {
    const dispatch = vi.fn(({ pr }) => ({ agentId: `agent-${pr}` }));
    const out = runReviewTick({ reconcile: () => reviewsPlan(5), dispatch, tagRound: () => {}, tagStatus: () => {}, statusCandidates: () => [] });
    expect(dispatch).toHaveBeenCalledTimes(5);
    expect(out.dispatched).toHaveLength(5);
    expect(out.deferredForLanes).toBe(0);
  });

  it('live incident shape (2026-09-24): 5 owed reviews, only 2 lanes acquirable → dispatches exactly 2, defers 3', () => {
    const dispatch = vi.fn(({ pr }) => ({ agentId: `agent-${pr}` }));
    const acquirableLanes = vi.fn(() => 2);
    const out = runReviewTick({
      reconcile: () => reviewsPlan(5), dispatch, tagRound: () => {}, tagStatus: () => {},
      statusCandidates: () => [], acquirableLanes,
    });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenCalledWith({ pr: 100, repo: expect.any(String), escalationReason: [], scopePaths: [] });
    expect(dispatch).toHaveBeenCalledWith({ pr: 101, repo: expect.any(String), escalationReason: [], scopePaths: [] });
    expect(out.reviewsOwed).toBe(5); // still owed — a deferral is not a loss
    expect(out.dispatched).toHaveLength(2);
    expect(out.deferredForLanes).toBe(3);
    expect(acquirableLanes).toHaveBeenCalledWith({ repo: expect.any(String) });
  });

  it('zero acquirable lanes → dispatches nothing this tick, defers everything, never throws', () => {
    const dispatch = vi.fn();
    const out = runReviewTick({
      reconcile: () => reviewsPlan(3), dispatch, tagRound: () => {}, tagStatus: () => {},
      statusCandidates: () => [], acquirableLanes: () => 0,
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(out.deferredForLanes).toBe(3);
    expect(out.reviewsOwed).toBe(3);
  });

  it('more lanes acquirable than reviews owed → dispatches every owed review, defers none', () => {
    const dispatch = vi.fn(({ pr }) => ({ agentId: `agent-${pr}` }));
    const out = runReviewTick({
      reconcile: () => reviewsPlan(2), dispatch, tagRound: () => {}, tagStatus: () => {},
      statusCandidates: () => [], acquirableLanes: () => 10,
    });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(out.deferredForLanes).toBe(0);
  });

  it('a negative/garbage acquirableLanes read fails toward "dispatch nothing", never toward "dispatch more"', () => {
    const dispatch = vi.fn();
    const out = runReviewTick({
      reconcile: () => reviewsPlan(3), dispatch, tagRound: () => {}, tagStatus: () => {},
      statusCandidates: () => [], acquirableLanes: () => -1,
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(out.deferredForLanes).toBe(3);
  });

  it('deferred reviews still feed statusCandidates (the whole owed list, not just what got dispatched)', () => {
    const statusCandidates = vi.fn(() => []);
    runReviewTick({
      reconcile: () => reviewsPlan(4), dispatch: vi.fn(({ pr }) => ({ agentId: `agent-${pr}` })),
      tagRound: () => {}, tagStatus: () => {}, statusCandidates, acquirableLanes: () => 1,
    });
    expect(statusCandidates).toHaveBeenCalledTimes(1);
    expect(statusCandidates.mock.calls[0][0]).toHaveLength(4); // all 4 owed reviews, not just the 1 dispatched
  });
});

// Card x5kagse (epic #4075/#3383) — the follow-up to #2717: while the operator's Claude login is broken, no NEW
// review session is dispatched. Mirrors the acquirableLanes suite just above (`paused` behaves exactly like
// `acquirableLanes: () => 0`, but for a different cause) — see `we:scripts/conveyor/claude-auth-health.mjs`'s
// own file header for the full incident and design.
describe('runReviewTick — the Claude-auth-broken gate skips dispatch outright (card x5kagse)', () => {
  const owedPlan = (entries, refusals = []) => ({ dispatch: entries, refusals });
  const reviewsPlan = (n) => owedPlan(Array.from({ length: n }, (_, i) => ({ kind: 'review', prNumber: 100 + i, attempts: 0 })));

  it('paused: dispatches nothing, defers every owed review under deferredForAuth (never deferredForLanes)', () => {
    const dispatch = vi.fn();
    const out = runReviewTick({
      reconcile: () => reviewsPlan(3), dispatch, tagRound: () => {}, tagStatus: () => {}, statusCandidates: () => [],
      paused: true, pauseReason: 'paused: Claude login expired — run /login',
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(out.reviewsOwed).toBe(3); // still owed — a pause is not a loss
    expect(out.deferredForAuth).toBe(3);
    expect(out.deferredForLanes).toBe(0);
    expect(out.authPaused).toBe(true);
    expect(out.authPauseReason).toBe('paused: Claude login expired — run /login');
  });

  it('paused overrides an otherwise-generous acquirableLanes — the gate is checked first', () => {
    const dispatch = vi.fn();
    const out = runReviewTick({
      reconcile: () => reviewsPlan(2), dispatch, tagRound: () => {}, tagStatus: () => {}, statusCandidates: () => [],
      acquirableLanes: () => 10, paused: true,
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(out.deferredForAuth).toBe(2);
  });

  it('not paused (the default): behaves exactly as every pre-existing test already proves — no authPaused/deferredForAuth cost', () => {
    const dispatch = vi.fn(({ pr }) => ({ agentId: `agent-${pr}` }));
    const out = runReviewTick({ reconcile: () => reviewsPlan(2), dispatch, tagRound: () => {}, tagStatus: () => {}, statusCandidates: () => [] });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(out.authPaused).toBe(false);
    expect(out.deferredForAuth).toBe(0);
    expect(out.authPauseReason).toBeNull();
  });

  it('deferred (paused) reviews still feed statusCandidates — nothing owed is silently dropped', () => {
    const statusCandidates = vi.fn(() => []);
    runReviewTick({
      reconcile: () => reviewsPlan(4), dispatch: vi.fn(), tagRound: () => {}, tagStatus: () => {},
      statusCandidates, paused: true,
    });
    expect(statusCandidates.mock.calls[0][0]).toHaveLength(4);
  });
});

describe('runReviewTickAllRepos — the Claude-auth-broken gate is computed ONCE and forwarded to every repo (card x5kagse)', () => {
  it('paused: no repo\'s tick ever dispatches, and the aggregate reports authPaused/authPauseReason', () => {
    const dispatch = vi.fn();
    const tick = (opts) => runReviewTick({
      reconcile: () => ({ dispatch: [{ kind: 'review', prNumber: 1, attempts: 0 }], refusals: [] }),
      dispatch, tagRound: () => {}, tagStatus: () => {}, statusCandidates: () => [], ...opts,
    });
    const out = runReviewTickAllRepos({
      repos: ['repo-a', 'repo-b'], tick,
      authGateOverride: () => ({ paused: true, reason: 'paused: Claude login expired — run /login' }),
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(out.dispatched).toEqual([]);
    expect(out.deferredForAuth).toBe(2); // one owed review per repo, both deferred
    expect(out.authPaused).toBe(true);
    expect(out.authPauseReason).toBe('paused: Claude login expired — run /login');
  });

  it('not paused via authGateOverride: dispatch proceeds exactly as an unpaused tick would', () => {
    const dispatch = vi.fn(({ pr }) => ({ agentId: `a${pr}` }));
    const tick = (opts) => runReviewTick({
      reconcile: () => ({ dispatch: [{ kind: 'review', prNumber: 1, attempts: 0 }], refusals: [] }),
      dispatch, tagRound: () => {}, tagStatus: () => {}, statusCandidates: () => [], ...opts,
    });
    const out = runReviewTickAllRepos({
      repos: ['repo-a'], tick, authGateOverride: () => ({ paused: false, reason: null }),
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(out.authPaused).toBe(false);
  });

  it('with a fake `tick` (not the real runReviewTick) and no authGateOverride, the gate defaults unpaused rather than shelling out (test hermeticity)', () => {
    const tick = vi.fn(() => ({ reviewsOwed: 0, dispatched: [], failed: [], refusals: 0 }));
    const out = runReviewTickAllRepos({ repos: ['repo-a'], tick });
    expect(out.authPaused).toBe(false);
    expect(tick).toHaveBeenCalledWith({ repo: 'repo-a', paused: false, pauseReason: null });
  });
});

describe('buildCliDaemonEffects.onTick — logs the exact pause line when authPaused (card x5kagse)', () => {
  it('logs the required wording when result.authPaused is true', () => {
    const lines = [];
    const fx = buildCliDaemonEffects({ owner: 'o', log: { error: (l) => lines.push(l) }, reapSessions: () => null, runReview: () => ({}) });
    fx.onTick({
      repos: [{ repo: 'web-everything/web-everything' }], reviewsOwed: 0, dispatched: [], failed: [],
      authPaused: true, authPauseReason: 'paused: Claude login expired — run /login',
    });
    expect(lines).toContain('review-daemon: paused: Claude login expired — run /login');
  });

  it('logs nothing extra when not paused', () => {
    const lines = [];
    const fx = buildCliDaemonEffects({ owner: 'o', log: { error: (l) => lines.push(l) }, reapSessions: () => null, runReview: () => ({}) });
    fx.onTick({ repos: [{ repo: 'web-everything/web-everything' }], reviewsOwed: 0, dispatched: [], failed: [], authPaused: false });
    expect(lines.some((l) => l.includes('paused: Claude login expired'))).toBe(false);
  });
});

describe('runReviewTickAllRepos — #3383 bug 3: deferredForLanes aggregates across repos', () => {
  it('sums each repo tick\'s own deferredForLanes into the combined total', () => {
    const tick = vi.fn()
      .mockReturnValueOnce({ reviewsOwed: 3, dispatched: [], failed: [], refusals: 0, reconcileError: null, deferredForLanes: 2 })
      .mockReturnValueOnce({ reviewsOwed: 1, dispatched: [], failed: [], refusals: 0, reconcileError: null, deferredForLanes: 0 });
    const out = runReviewTickAllRepos({ repos: ['web-everything/web-everything', 'frontier-ui/frontierui'], tick });
    expect(out.deferredForLanes).toBe(2);
  });
});

describe('defaultAcquirableLaneCount — wiring only (never a real lane-pool/git call in this test)', () => {
  it('is exported as a function taking {repo}', () => {
    expect(typeof defaultAcquirableLaneCount).toBe('function');
  });
});

describe('runReviewTick — reconcile itself is isolated (regression, #xvzwiew live-caught 2026-09-23)', () => {
  // Live production evidence (`~/workspace/wev-review-daemon/.conveyor/review-daemon.log`):
  //   review-daemon: frontier-ui/frontierui#? failed (non-fatal): spawnSync claude ENOENT
  //   review-daemon: frontier-ui/frontierui reconcile failed (non-fatal, other repos unaffected): spawnSync claude ENOENT
  // Both lines were ONE underlying failure — `reconcile-pass.mjs`'s own `claude agents --json` read throwing —
  // reported twice and misleadingly: the first line reads as if a SPECIFIC PR's review dispatch failed, but no
  // PR was ever identified (reconcile crashed before `dispatch` could even be reached).
  const throwingClaudeSpawn = () => {
    const err = new Error('spawnSync claude ENOENT');
    err.code = 'ENOENT';
    throw err;
  };

  it('a reconcile throw no longer escapes runReviewTick — it comes back as reconcileError, not a thrown exception', () => {
    const reconcile = vi.fn(() => throwingClaudeSpawn());
    const dispatch = vi.fn();
    expect(() => runReviewTick({ reconcile, dispatch, tagRound: () => {}, tagStatus: () => {}, statusCandidates: () => [] }))
      .not.toThrow();
    const out = runReviewTick({ reconcile, dispatch, tagRound: () => {}, tagStatus: () => {}, statusCandidates: () => [] });
    expect(out).toEqual({
      reviewsOwed: 0, dispatched: [], failed: [], refusals: 0, reconcileError: 'spawnSync claude ENOENT', deferredForLanes: 0,
      holdReconcile: [], holdReconcileError: null,
    });
    expect(dispatch).not.toHaveBeenCalled(); // reconcile crashed before any PR was identified
  });

  it('a successful reconcile still reports reconcileError: null (never undefined)', () => {
    const reconcile = vi.fn(() => ({ dispatch: [], refusals: [] }));
    const out = runReviewTick({ reconcile, dispatch: () => ({}), tagRound: () => {}, tagStatus: () => {}, statusCandidates: () => [] });
    expect(out.reconcileError).toBeNull();
  });
});

describe('runReviewTick — repo reaches reconcile too (regression, #xvyuwtg live-caught 2026-09-22)', () => {
  // plateau-app PR #167 sat `review:pending` with nothing watching it: `repo` reached `dispatch`/`tagRound`/
  // `tagStatus` but `reconcile` was always called as `reconcile({})`, so a tick "for" plateau-app still
  // discovered WE's own PRs. Fixed by passing `{repo}` into `reconcile` too.
  it('reconcile is called with the SAME repo this tick was given, not unconditionally omitted', () => {
    const reconcile = vi.fn(() => ({ dispatch: [], refusals: [] }));
    runReviewTick({ reconcile, dispatch: () => ({}), tagRound: () => {}, tagStatus: () => {}, statusCandidates: () => [], repo: 'plateauapp/plateau-app' });
    // #4133 — also receives `readPrs`/`readAgents` closures now (the tick's own single reads, reused inside
    // reconcile rather than re-fetched); `objectContaining` keeps this assertion about `repo` specifically.
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ repo: 'plateauapp/plateau-app' }));
  });
});

// #4133 (epic #3383/#4075) — audit `we:reports/2026-09-24-daemon-blocking-antipatterns.md` finding R2: one
// `gh pr list` / `claude agents --json` per tick, reused by reconcile AND the tag helpers, never re-fetched
// once per PR.
describe('runReviewTick — #4133 shared reads (opt-in via readPrs/readAgents)', () => {
  it('omitting readPrs/readAgents (the default) is byte-identical to before — reconcile gets no extra keys, tags get no currentLabels/agents', () => {
    const reconcile = vi.fn(() => ({ dispatch: [{ kind: 'review', prNumber: 10, attempts: 0 }], refusals: [] }));
    const tagRound = vi.fn();
    const tagStatus = vi.fn();
    runReviewTick({
      reconcile, dispatch: () => ({ agentId: 'a' }), tagRound, tagStatus,
      statusCandidates: () => [{ prNumber: 10 }],
    });
    expect(reconcile).toHaveBeenCalledWith({ repo: expect.any(String) });
    expect(tagRound).toHaveBeenCalledWith(expect.objectContaining({ currentLabels: undefined }));
    expect(tagStatus).toHaveBeenCalledWith(expect.objectContaining({ agents: undefined, currentLabels: undefined }));
  });

  it('when opted in, readPrs/readAgents are each called ONCE per tick, never once per PR', () => {
    const prs = [{ number: 10, labels: [{ name: 'review:pending' }] }, { number: 20, labels: [{ name: 'review:pending' }] }];
    const agents = [{ name: 'review-10', state: 'working' }];
    const readPrs = vi.fn(() => prs);
    const readAgents = vi.fn(() => agents);
    const reconcile = vi.fn(() => ({
      dispatch: [{ kind: 'review', prNumber: 10, attempts: 0 }, { kind: 'review', prNumber: 20, attempts: 0 }],
      refusals: [],
    }));
    const tagRound = vi.fn();
    const tagStatus = vi.fn();
    runReviewTick({
      reconcile, readPrs, readAgents, dispatch: ({ pr }) => ({ agentId: `a${pr}` }), tagRound, tagStatus,
      statusCandidates: () => [{ prNumber: 10 }, { prNumber: 20 }],
    });
    expect(readPrs).toHaveBeenCalledTimes(1); // NOT once per PR, even though two PRs got tagged
    expect(readAgents).toHaveBeenCalledTimes(1);
  });

  it('reconcile receives readPrs/readAgents closures returning the SAME tick data (no second fetch inside reconcile)', () => {
    const prs = [{ number: 10, labels: [] }];
    const agents = [{ name: 'review-10', state: 'working' }];
    const readPrs = vi.fn(() => prs);
    const readAgents = vi.fn(() => agents);
    let reconcileSawPrs = null;
    let reconcileSawAgents = null;
    const reconcile = vi.fn(({ readPrs: innerReadPrs, readAgents: innerReadAgents }) => {
      reconcileSawPrs = innerReadPrs();
      reconcileSawAgents = innerReadAgents();
      return { dispatch: [], refusals: [] };
    });
    runReviewTick({ reconcile, readPrs, readAgents, dispatch: () => ({}), tagRound: () => {}, tagStatus: () => {}, statusCandidates: () => [] });
    expect(reconcileSawPrs).toBe(prs); // the identical array, not a re-fetched copy
    expect(reconcileSawAgents).toBe(agents);
    expect(readPrs).toHaveBeenCalledTimes(1); // reconcile's own closure call did NOT trigger a second real fetch
    expect(readAgents).toHaveBeenCalledTimes(1);
  });

  it('tagRound/tagStatus receive each PR\'s own already-fetched labels, and tagStatus reuses the tick\'s own agents for a PR NOT dispatched this tick', () => {
    const prs = [{ number: 10, labels: [{ name: 'review-round:1' }] }, { number: 20, labels: [{ name: 'review-status:reviewing' }] }];
    const agents = [{ name: 'review-20', state: 'blocked' }];
    const reconcile = vi.fn(() => ({ dispatch: [{ kind: 'review', prNumber: 10, attempts: 0 }], refusals: [{ prNumber: 20 }] }));
    const tagRound = vi.fn();
    const tagStatus = vi.fn();
    runReviewTick({
      reconcile, readPrs: () => prs, readAgents: () => agents, dispatch: () => ({ agentId: 'a' }), tagRound, tagStatus,
      statusCandidates: () => [{ prNumber: 10 }, { prNumber: 20 }],
    });
    expect(tagRound).toHaveBeenCalledWith(expect.objectContaining({ pr: 10, currentLabels: prs[0].labels }));
    expect(tagStatus).toHaveBeenCalledWith(expect.objectContaining({ pr: 20, agents, currentLabels: prs[1].labels }));
  });

  it('a PR dispatched THIS tick gets NO snapshot agents — its fresh job record postdates the pre-dispatch read, so tagStatus must re-list', () => {
    const prs = [{ number: 10, labels: [{ name: 'review:pending' }] }];
    const agents = []; // read before dispatch: the new review job is not in it yet
    const reconcile = vi.fn(() => ({ dispatch: [{ kind: 'review', prNumber: 10, attempts: 0 }], refusals: [] }));
    const tagStatus = vi.fn();
    runReviewTick({
      reconcile, readPrs: () => prs, readAgents: () => agents, dispatch: () => ({ mode: 'job', jobPid: 123 }), tagRound: () => {}, tagStatus,
      statusCandidates: () => [{ prNumber: 10 }],
    });
    expect(tagStatus).toHaveBeenCalledTimes(1);
    const arg = tagStatus.mock.calls[0][0];
    expect(arg.pr).toBe(10);
    expect(arg.agents).toBeUndefined(); // → tagReviewStatus falls back to its own fresh, job-aware listing
    expect(arg.currentLabels).toBe(prs[0].labels);
  });

  it('a readPrs/readAgents failure is isolated exactly like a reconcile failure — reconcileError, not a throw', () => {
    const readPrs = () => { throw new Error('gh: rate limited'); };
    const out = runReviewTick({ reconcile: () => ({ dispatch: [], refusals: [] }), readPrs, readAgents: () => [], dispatch: () => ({}), tagRound: () => {}, tagStatus: () => {}, statusCandidates: () => [] });
    expect(out.reconcileError).toBe('gh: rate limited');
    expect(out.dispatched).toEqual([]);
  });
});

describe('runReviewTick — real dispatchReview contract (regression, #3876 live-caught)', () => {
  // Live-caught 2026-09-22: `dispatch({ pr, repo: null })` passed the mock's own tests (which mocked
  // `dispatch` entirely) but broke the FIRST real run — `planReviewDispatch` does `String(repo ?? '').trim()`
  // then `repoKeyForSlug(repoStr)`, so `null` becomes `''`, which is not a constellation repo, unlike
  // `reconcile-pass.mjs`/`reconcile-fix-dispatch.mjs`'s OWN convention where `repo: null` defaults to 'we'.
  // This test calls the REAL (pure, no-IO) `planReviewDispatch` with the exact `repo` value `runReviewTick`
  // passes, so a future reintroduction of `repo: null` fails here even if every `dispatch` mock still passes.
  it('the repo value passed to dispatch is one planReviewDispatch actually accepts', () => {
    let capturedRepo;
    const dispatch = ({ repo }) => { capturedRepo = repo; return { agentId: 'a' }; };
    runReviewTick({
      reconcile: () => ({ dispatch: [{ kind: 'review', prNumber: 10, attempts: 0 }], refusals: [] }),
      dispatch, tagRound: () => {}, tagStatus: () => {}, statusCandidates: () => [],
    });
    expect(() => planReviewDispatch({ pr: 10, repo: capturedRepo })).not.toThrow();
  });
});

// #x01u7az — the review-hold reconcile sweep (a stray review:pending beside a live review:human; a stray
// advisory:* once review:human is cleared) is wired into THIS daemon, not only into we:skills-src/conveyor/
// runner.mjs's own retired mechanical-pass dispatcher (see review-daemon.mjs's own import comment for why: this
// daemon is the one that is actually running, with no extra launchd install). These tests prove the wiring — the
// sweep's OWN decision logic is proven in scripts/conveyor/__tests__/review-hold-reconcile.test.mjs.
describe('runReviewTick — the review-hold reconcile sweep (#x01u7az)', () => {
  const noop = () => ({ dispatch: [], refusals: [] });

  it('runs holdReconcile with THIS tick\'s own repo, independent of reconcile\'s plan', () => {
    const holdReconcile = vi.fn(() => []);
    runReviewTick({
      reconcile: noop, dispatch: () => ({}), tagRound: () => {}, tagStatus: () => {}, statusCandidates: () => [],
      holdReconcile, repo: 'plateauapp/plateau-app',
    });
    expect(holdReconcile).toHaveBeenCalledWith({ repo: 'plateauapp/plateau-app' });
  });

  it('folds a real finding onto the tick result under `holdReconcile`', () => {
    const holdReconcile = () => [{ num: 2549, remove: ['review:pending'] }];
    const out = runReviewTick({
      reconcile: noop, dispatch: () => ({}), tagRound: () => {}, tagStatus: () => {}, statusCandidates: () => [],
      holdReconcile,
    });
    expect(out.holdReconcile).toEqual([{ num: 2549, remove: ['review:pending'] }]);
    expect(out.holdReconcileError).toBeNull();
  });

  it('a holdReconcile throw is isolated — reported via holdReconcileError, never escapes the tick', () => {
    const holdReconcile = () => { throw new Error('gh: rate limited'); };
    expect(() => runReviewTick({
      reconcile: noop, dispatch: () => ({}), tagRound: () => {}, tagStatus: () => {}, statusCandidates: () => [],
      holdReconcile,
    })).not.toThrow();
    const out = runReviewTick({
      reconcile: noop, dispatch: () => ({}), tagRound: () => {}, tagStatus: () => {}, statusCandidates: () => [],
      holdReconcile,
    });
    expect(out.holdReconcile).toEqual([]);
    expect(out.holdReconcileError).toBe('gh: rate limited');
    // A holdReconcile failure never blocks the rest of the tick — dispatch/tag still ran.
    expect(out.reconcileError).toBeNull();
  });

  it('runs even when reconcile itself throws — a review-hold label stray has nothing to do with discovery', () => {
    const holdReconcile = vi.fn(() => [{ num: 2578, remove: ['advisory:accepted'] }]);
    const reconcile = () => { throw new Error('spawnSync claude ENOENT'); };
    const out = runReviewTick({
      reconcile, dispatch: () => ({}), tagRound: () => {}, tagStatus: () => {}, statusCandidates: () => [],
      holdReconcile,
    });
    expect(holdReconcile).toHaveBeenCalledTimes(1);
    expect(out.holdReconcile).toEqual([{ num: 2578, remove: ['advisory:accepted'] }]);
    expect(out.reconcileError).toBe('spawnSync claude ENOENT');
  });
});

describe('REVIEW_DAEMON_REPOS', () => {
  it('is every constellation repo\'s real slug, not just WE (live-caught 2026-09-22, #xvyuwtg: plateau-app PR #167 sat unwatched)', () => {
    expect(REVIEW_DAEMON_REPOS.sort()).toEqual(Object.values(CONSTELLATION_REPOS).map((r) => r.slug).sort());
    expect(REVIEW_DAEMON_REPOS).toContain('plateauapp/plateau-app');
    expect(REVIEW_DAEMON_REPOS).toContain('frontier-ui/frontierui');
    expect(REVIEW_DAEMON_REPOS).toContain('web-everything/web-everything');
  });
});

describe('runReviewTickAllRepos — one runReviewTick call per watched repo', () => {
  it('ticks every repo in the list, tagging each dispatched/failed entry with its own repo', () => {
    const tick = vi.fn(({ repo }) => (repo === 'repo-a'
      ? { reviewsOwed: 1, dispatched: [{ prNumber: 10, agentId: 'a10' }], failed: [], refusals: 0 }
      : { reviewsOwed: 1, dispatched: [], failed: [{ prNumber: 20, error: 'boom' }], refusals: 1 }));
    const out = runReviewTickAllRepos({ repos: ['repo-a', 'repo-b'], tick });
    expect(tick).toHaveBeenCalledTimes(2);
    expect(tick).toHaveBeenCalledWith(expect.objectContaining({ repo: 'repo-a' }));
    expect(tick).toHaveBeenCalledWith(expect.objectContaining({ repo: 'repo-b' }));
    expect(out.reviewsOwed).toBe(2);
    expect(out.refusals).toBe(1);
    expect(out.dispatched).toEqual([{ prNumber: 10, agentId: 'a10', repo: 'repo-a' }]);
    expect(out.failed).toEqual([{ prNumber: 20, error: 'boom', repo: 'repo-b' }]);
    expect(out.repos).toEqual([
      { repo: 'repo-a', result: expect.any(Object) },
      { repo: 'repo-b', result: expect.any(Object) },
    ]);
  });

  it('one repo throwing (a gh outage, a rate limit) never stops the others — isolated the same way a bad PR is isolated one level down', () => {
    const tick = vi.fn(({ repo }) => {
      if (repo === 'repo-bad') throw new Error('gh: rate limited');
      return { reviewsOwed: 1, dispatched: [{ prNumber: 1, agentId: 'a1' }], failed: [], refusals: 0 };
    });
    const out = runReviewTickAllRepos({ repos: ['repo-bad', 'repo-good'], tick });
    expect(out.dispatched).toEqual([{ prNumber: 1, agentId: 'a1', repo: 'repo-good' }]);
    expect(out.failed).toEqual([{ prNumber: null, repo: 'repo-bad', error: 'gh: rate limited' }]);
    expect(out.repos[0]).toEqual({ repo: 'repo-bad', error: 'gh: rate limited' });
  });

  it('every non-`repo` option is forwarded to every repo\'s own tick call', () => {
    const tick = vi.fn(() => ({ reviewsOwed: 0, dispatched: [], failed: [], refusals: 0 }));
    const dispatch = () => ({});
    runReviewTickAllRepos({ repos: ['repo-a'], tick, dispatch });
    // card x5kagse — `tick` here is a fake (not the real `runReviewTick`), so the auth gate defaults to
    // not-paused without any real IO; `paused`/`pauseReason` are still forwarded into every call, same as any
    // other shared per-tick fact (`acquirableLanes`, `readPrs`, ...).
    expect(tick).toHaveBeenCalledWith({ dispatch, repo: 'repo-a', paused: false, pauseReason: null });
  });

  // Regression, #xvzwiew live-caught 2026-09-23: a repo whose `runReviewTick` catches its own reconcile
  // failure (see the sibling describe block above) used to have NO way to surface that — before this fix,
  // `runReviewTick` just threw, `forEachRepo` caught it, and this function double-reported it (once as a
  // bogus `prNumber: null` "failed dispatch", once as `repos[].error`). Now `runReviewTick` never throws for
  // a reconcile failure; it returns `reconcileError` instead, and THIS function must fold that into its own
  // `reconcileFailed` bucket — never into `failed` (that would resurrect the exact misleading report this
  // whole fix removes).
  it('a repo whose tick reports reconcileError is folded into reconcileFailed, never into failed', () => {
    const tick = vi.fn(({ repo }) => (repo === 'frontier-ui/frontierui'
      ? { reviewsOwed: 0, dispatched: [], failed: [], refusals: 0, reconcileError: 'spawnSync claude ENOENT' }
      : { reviewsOwed: 1, dispatched: [{ prNumber: 1, agentId: 'a1' }], failed: [], refusals: 0, reconcileError: null }));
    const out = runReviewTickAllRepos({ repos: ['web-everything/web-everything', 'frontier-ui/frontierui'], tick });
    expect(out.failed).toEqual([]); // no bogus `prNumber: null` dispatch failure
    expect(out.reconcileFailed).toEqual([{ repo: 'frontier-ui/frontierui', error: 'spawnSync claude ENOENT' }]);
    expect(out.dispatched).toEqual([{ prNumber: 1, agentId: 'a1', repo: 'web-everything/web-everything' }]);
    expect(out.reviewsOwed).toBe(1); // the healthy repo's own count is untouched by the other repo's reconcile failure
  });

  // #x01u7az — holdReconcile results/errors are aggregated the SAME way as dispatched/failed: tagged with
  // their own repo, folded across every watched repo, one bad repo isolated from the rest.
  it('aggregates holdReconcile findings across repos, each tagged with its own repo', () => {
    const tick = vi.fn(({ repo }) => (repo === 'repo-a'
      ? { reviewsOwed: 0, dispatched: [], failed: [], refusals: 0, reconcileError: null, holdReconcile: [{ num: 2549, remove: ['review:pending'] }], holdReconcileError: null }
      : { reviewsOwed: 0, dispatched: [], failed: [], refusals: 0, reconcileError: null, holdReconcile: [], holdReconcileError: null }));
    const out = runReviewTickAllRepos({ repos: ['repo-a', 'repo-b'], tick });
    expect(out.holdReconcile).toEqual([{ num: 2549, remove: ['review:pending'], repo: 'repo-a' }]);
    expect(out.holdReconcileFailed).toEqual([]);
  });

  it('a repo whose holdReconcile failed is folded into holdReconcileFailed even when its reconcile itself failed too', () => {
    const tick = vi.fn(({ repo }) => (repo === 'repo-a'
      ? { reviewsOwed: 0, dispatched: [], failed: [], refusals: 0, reconcileError: 'spawnSync claude ENOENT', holdReconcile: [], holdReconcileError: 'gh: rate limited' }
      : { reviewsOwed: 1, dispatched: [], failed: [], refusals: 0, reconcileError: null, holdReconcile: [], holdReconcileError: null }));
    const out = runReviewTickAllRepos({ repos: ['repo-a', 'repo-b'], tick });
    expect(out.reconcileFailed).toEqual([{ repo: 'repo-a', error: 'spawnSync claude ENOENT' }]);
    expect(out.holdReconcileFailed).toEqual([{ repo: 'repo-a', error: 'gh: rate limited' }]);
    expect(out.reviewsOwed).toBe(1); // repo-b's own count is untouched
  });

  it('a fake tick that omits holdReconcile entirely (older-shaped mock) never throws — defaults to nothing found', () => {
    const tick = vi.fn(() => ({ reviewsOwed: 0, dispatched: [], failed: [], refusals: 0 }));
    const out = runReviewTickAllRepos({ repos: ['repo-a'], tick });
    expect(out.holdReconcile).toEqual([]);
    expect(out.holdReconcileFailed).toEqual([]);
  });

  it('defaults to REVIEW_DAEMON_REPOS and to the real runReviewTick when nothing is injected', () => {
    // No network call happens here: reconcile-pass.mjs's OWN default readers are what would hit `gh`, and this
    // test injects neither `repos` nor `tick`'s inner effects — it only proves the DEFAULTS are wired, via a
    // spy on `tick` itself so the real runReviewTick's own IO defaults are never reached.
    const tick = vi.fn(() => ({ reviewsOwed: 0, dispatched: [], failed: [], refusals: 0 }));
    const out = runReviewTickAllRepos({ tick });
    expect(tick).toHaveBeenCalledTimes(REVIEW_DAEMON_REPOS.length);
    expect(out.repos.map((r) => r.repo)).toEqual(REVIEW_DAEMON_REPOS);
  });
});

// #xconv1 (web-everything/web-everything#2766/#2767 unblock, epic #3383/#4075) — the mechanical, no-session
// convert-advisory stage: posts the converted advisory note + runs ONE targeted-check judge seat for a
// `kind:'convert-advisory'` dispatch entry. A SEPARATE, ADDITIVE async pipeline from `runReviewTick` (see that
// function's own doc above for why) — every test here injects `convertAdvisory`/`tick`, never the real
// `dispatchConvertAdvisory`/`judgeSpawn`.
describe('runConvertAdvisoryTick', () => {
  const convertPlan = (entries, refusals = []) => ({ dispatch: entries, refusals });
  const entry = (prNumber) => ({ kind: 'convert-advisory', prNumber, headSha: 'a'.repeat(40), escalation: { kind: 'test-gaming' } });

  it('runs the injected convertAdvisory effect for every convert-advisory entry, ignoring other kinds', async () => {
    const reconcile = vi.fn(() => convertPlan([entry(2766), { kind: 'review', prNumber: 10 }, { kind: 'fix', prNumber: 11 }]));
    const convertAdvisory = vi.fn(async () => ({ posted: true, targetedCheckAnswer: { verdict: 'accept' } }));
    const out = await runConvertAdvisoryTick({ reconcile, convertAdvisory });
    expect(convertAdvisory).toHaveBeenCalledTimes(1);
    expect(convertAdvisory).toHaveBeenCalledWith(expect.objectContaining({ prNumber: 2766 }), expect.objectContaining({ repo: expect.any(String) }));
    expect(out).toEqual({ convertAdvisoriesOwed: 1, posted: [{ prNumber: 2766, outcome: 'accept' }], skipped: [], failed: [], reconcileError: null });
  });

  it('a skipped (already-converted) entry lands in `skipped`, not `posted`', async () => {
    const reconcile = vi.fn(() => convertPlan([entry(2766)]));
    const convertAdvisory = vi.fn(async () => ({ skipped: 'already-converted' }));
    const out = await runConvertAdvisoryTick({ reconcile, convertAdvisory });
    expect(out.posted).toEqual([]);
    expect(out.skipped).toEqual([{ prNumber: 2766, reason: 'already-converted' }]);
  });

  it('PR #2781 review — a label repair on an already-converted head is surfaced, never hidden under a bare skip', async () => {
    const reconcile = vi.fn(() => convertPlan([entry(2766)]));
    const convertAdvisory = vi.fn(async () => ({ skipped: 'already-converted', repairedLabels: true }));
    const out = await runConvertAdvisoryTick({ reconcile, convertAdvisory });
    expect(out.skipped).toEqual([{ prNumber: 2766, reason: 'already-converted', repairedLabels: true }]);
  });

  it('PR #2781 review, round 3 — an UNVERIFIED label repair (timeline unreadable) is surfaced too', async () => {
    const reconcile = vi.fn(() => convertPlan([entry(2766)]));
    const convertAdvisory = vi.fn(async () => ({ skipped: 'already-converted', labelRepairUnverified: true }));
    const out = await runConvertAdvisoryTick({ reconcile, convertAdvisory });
    expect(out.skipped).toEqual([{ prNumber: 2766, reason: 'already-converted', labelRepairUnverified: true }]);
  });

  it('one bad entry never aborts the rest — a convertAdvisory throw lands in `failed`, siblings still run', async () => {
    const reconcile = vi.fn(() => convertPlan([entry(1), entry(2)]));
    const convertAdvisory = vi.fn(async ({ prNumber }) => {
      if (prNumber === 1) throw new Error('gh comment failed');
      return { posted: true, targetedCheckAnswer: { verdict: 'changes' } };
    });
    const out = await runConvertAdvisoryTick({ reconcile, convertAdvisory });
    expect(out.failed).toEqual([{ prNumber: 1, error: 'gh comment failed' }]);
    expect(out.posted).toEqual([{ prNumber: 2, outcome: 'changes' }]);
  });

  it('a reconcile failure is caught and reported as `reconcileError`, never thrown', async () => {
    const reconcile = () => { throw new Error('claude agents ENOENT'); };
    const out = await runConvertAdvisoryTick({ reconcile, convertAdvisory: vi.fn() });
    expect(out).toEqual({ convertAdvisoriesOwed: 0, posted: [], skipped: [], failed: [], reconcileError: 'claude agents ENOENT' });
  });

  it('#4133-style shared reads — comments/labels ride the SAME `readPrs` closure into `convertAdvisory`, no second fetch', async () => {
    const rawPrs = [{ number: 2766, comments: ['c1'], labels: ['l1'] }];
    const readPrs = vi.fn(() => rawPrs);
    const readAgents = vi.fn(() => []);
    const reconcile = vi.fn(() => convertPlan([entry(2766)]));
    const convertAdvisory = vi.fn(async () => ({ posted: true, targetedCheckAnswer: { verdict: 'accept' } }));
    await runConvertAdvisoryTick({ reconcile, convertAdvisory, readPrs, readAgents });
    expect(readPrs).toHaveBeenCalledTimes(1);
    expect(convertAdvisory).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ comments: ['c1'], labels: ['l1'] }));
  });
});

describe('runConvertAdvisoryTickAllRepos', () => {
  it('calls `tick` once per watched repo and aggregates posted/skipped/failed across them', async () => {
    const tick = vi.fn(async ({ repo }) => (repo === REVIEW_DAEMON_REPOS[0]
      ? { convertAdvisoriesOwed: 1, posted: [{ prNumber: 1, outcome: 'accept' }], skipped: [], failed: [] }
      : { convertAdvisoriesOwed: 0, posted: [], skipped: [], failed: [] }));
    const out = await runConvertAdvisoryTickAllRepos({ tick });
    expect(tick).toHaveBeenCalledTimes(REVIEW_DAEMON_REPOS.length);
    expect(out.convertAdvisoriesOwed).toBe(1);
    expect(out.posted).toEqual([{ prNumber: 1, outcome: 'accept', repo: REVIEW_DAEMON_REPOS[0] }]);
  });

  it('one repo throwing never aborts the rest — its own `{repo, error}` entry, siblings unaffected', async () => {
    const tick = vi.fn(async ({ repo }) => {
      if (repo === REVIEW_DAEMON_REPOS[0]) throw new Error('gh outage');
      return { convertAdvisoriesOwed: 0, posted: [], skipped: [], failed: [] };
    });
    const out = await runConvertAdvisoryTickAllRepos({ tick });
    expect(out.failed).toEqual([{ prNumber: null, repo: REVIEW_DAEMON_REPOS[0], error: 'gh outage' }]);
    expect(out.repos.find((r) => r.repo === REVIEW_DAEMON_REPOS[0]).error).toBe('gh outage');
  });

  it('a repo whose reconcile itself failed reports through `reconcileFailed`, not `failed`', async () => {
    const tick = vi.fn(async () => ({ convertAdvisoriesOwed: 0, posted: [], skipped: [], failed: [], reconcileError: 'claude agents ENOENT' }));
    const out = await runConvertAdvisoryTickAllRepos({ tick });
    expect(out.reconcileFailed).toHaveLength(REVIEW_DAEMON_REPOS.length);
    expect(out.failed).toEqual([]);
  });
});

describe('buildCliDaemonEffects.tickOnce — folds the convert-advisory stage onto the tick result (#xconv1)', () => {
  const fakeReview = () => ({ repos: [], reviewsOwed: 0, dispatched: [], failed: [] });

  it('PR #2781 review — OFF BY DEFAULT: with no opt-in, the live daemon never runs the convert-advisory stage (no real gh write, no judge spawn)', async () => {
    const saved = process.env.REVIEW_DAEMON_CONVERT_ADVISORY;
    delete process.env.REVIEW_DAEMON_CONVERT_ADVISORY;
    try {
      const runConvertAdvisories = vi.fn(async () => ({ posted: [] }));
      const effects = buildCliDaemonEffects({ owner: 'x', reapSessions: () => null, runReview: fakeReview, runConvertAdvisories });
      const result = await effects.tickOnce();
      expect(runConvertAdvisories).not.toHaveBeenCalled();
      expect(result.convertAdvisory).toBeNull();
      expect(result).toHaveProperty('repos');
    } finally {
      if (saved === undefined) delete process.env.REVIEW_DAEMON_CONVERT_ADVISORY;
      else process.env.REVIEW_DAEMON_CONVERT_ADVISORY = saved;
    }
  });

  it('PR #2781 review — the opt-in is the env flag REVIEW_DAEMON_CONVERT_ADVISORY=1 (anything else stays off)', async () => {
    const saved = process.env.REVIEW_DAEMON_CONVERT_ADVISORY;
    try {
      for (const [value, expected] of [['1', 1], ['0', 0], ['true', 0], ['', 0]]) {
        process.env.REVIEW_DAEMON_CONVERT_ADVISORY = value;
        const runConvertAdvisories = vi.fn(async () => ({ posted: [] }));
        await buildCliDaemonEffects({ owner: 'x', reapSessions: () => null, runReview: fakeReview, runConvertAdvisories }).tickOnce();
        expect(runConvertAdvisories).toHaveBeenCalledTimes(expected);
      }
    } finally {
      if (saved === undefined) delete process.env.REVIEW_DAEMON_CONVERT_ADVISORY;
      else process.env.REVIEW_DAEMON_CONVERT_ADVISORY = saved;
    }
  });

  it('runs runConvertAdvisories AFTER the review stage and folds its result under `convertAdvisory`', async () => {
    const order = [];
    const effects = buildCliDaemonEffects({
      owner: 'x',
      convertAdvisoryEnabled: true,
      reapSessions: () => null,
      runReview: () => { order.push('review'); return fakeReview(); },
      runConvertAdvisories: async () => { order.push('convert-advisory'); return { convertAdvisoriesOwed: 1, posted: [{ prNumber: 2766, outcome: 'accept', repo: 'web-everything/web-everything' }], skipped: [], failed: [] }; },
    });
    const result = await effects.tickOnce();
    expect(order).toEqual(['review', 'convert-advisory']);
    expect(result.convertAdvisory).toEqual({ convertAdvisoriesOwed: 1, posted: [{ prNumber: 2766, outcome: 'accept', repo: 'web-everything/web-everything' }], skipped: [], failed: [] });
    // The review tick's own fields are still present — folding convertAdvisory on never replaces them.
    expect(result).toHaveProperty('repos');
  });

  it('a convert-advisory tick failure is swallowed (logged, non-fatal) — never breaks the review tick', async () => {
    const log = { error: vi.fn() };
    const effects = buildCliDaemonEffects({
      owner: 'x', log, reapSessions: () => null, runReview: fakeReview, convertAdvisoryEnabled: true,
      runConvertAdvisories: () => { throw new Error('gh unreadable'); },
    });
    const result = await effects.tickOnce();
    expect(result.convertAdvisory).toBeNull();
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/convert-advisory tick failed \(non-fatal\)/));
    expect(result).toHaveProperty('repos');
  });

  it('onTick logs posted/skipped/failed/reconcileFailed lines, and is silent when `convertAdvisory` is absent (an older tick shape)', () => {
    const log = { error: vi.fn() };
    const effects = buildCliDaemonEffects({ owner: 'x', log });
    effects.onTick({
      repos: [], reviewsOwed: 0, dispatched: [], failed: [],
      convertAdvisory: {
        posted: [{ prNumber: 2766, outcome: 'accept', repo: 'web-everything/web-everything' }],
        skipped: [{ prNumber: 2767, reason: 'already-converted', repo: 'web-everything/web-everything' }],
        failed: [{ prNumber: 9, error: 'boom', repo: 'web-everything/web-everything' }],
        reconcileFailed: [{ repo: 'frontier-ui/frontierui', error: 'ENOENT' }],
      },
    });
    expect(log.error.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining([
      expect.stringMatching(/web-everything\/web-everything#2766 convert-advisory posted \(targeted check: accept\)/),
      expect.stringMatching(/web-everything\/web-everything#2767 convert-advisory skipped — already-converted/),
      expect.stringMatching(/web-everything\/web-everything#9 convert-advisory failed \(non-fatal\): boom/),
      expect.stringMatching(/frontier-ui\/frontierui convert-advisory reconcile failed \(non-fatal, other repos unaffected\): ENOENT/),
    ]));

    log.error.mockClear();
    // No `convertAdvisory` field at all (a tick shape from before this stage existed, or the daemon's own
    // whole-tick skip shape) — must be silent, never throw on `result.convertAdvisory.posted`.
    expect(() => effects.onTick({ repos: [], reviewsOwed: 0, dispatched: [], failed: [] })).not.toThrow();
    expect(log.error.mock.calls.some((c) => /convert-advisory/.test(c[0]))).toBe(false);
  });
});

describe('REVIEW_DAEMON_LEASE_KEY / DEFAULT_INTERVAL_MS', () => {
  it('is a distinct key, never the Dispatcher default or #3870\'s own key', () => {
    expect(REVIEW_DAEMON_LEASE_KEY).toBe('<conveyor:review-daemon-lease>');
    expect(REVIEW_DAEMON_LEASE_KEY).not.toBe('<conveyor:runner-singleton-lease>');
    expect(REVIEW_DAEMON_LEASE_KEY).not.toBe('<conveyor:reconcile-fix-dispatch-daemon-lease>');
  });

  it('matches the runner\'s own tick cadence', () => {
    expect(DEFAULT_INTERVAL_MS).toBe(120_000);
  });
});

describe('buildCliDaemonEffects — the real-effect factory (heartbeat wiring only)', () => {
  it('exposes the shape runDaemonLoop needs', () => {
    const effects = buildCliDaemonEffects({ owner: 'x' });
    expect(effects.intervalMs).toBe(DEFAULT_INTERVAL_MS);
    expect(typeof effects.tickOnce).toBe('function');
    expect(typeof effects.sleep).toBe('function');
    expect(typeof effects.heartbeat).toBe('function');
    expect(typeof effects.onTick).toBe('function');
    expect(typeof effects.onTickError).toBe('function');
  });
});

// ── epic #3383: this daemon now ALSO ticks the session reaper (we:scripts/conveyor/session-reaper.mjs), the
//    pass that used to live only inside the retired runner.mjs dispatcher. See review-daemon.mjs's own file
//    header ("THE SESSION REAPER LIVES HERE TOO") for the ownership decision and its justification. ──────────

describe('buildCliDaemonEffects.tickOnce — now also runs a session-reap pass each tick (epic #3383)', () => {
  // `runReview` is injected here too (a fake, never the real `runReviewTickAllRepos`) — this describe block
  // proves the FOLD of `reapSessions()` onto the tick result, not the review tick itself (that is
  // `runReviewTickAllRepos`'s own describe block, above), and must never shell a real `gh`/`claude` call.
  const fakeReview = () => ({ repos: [], reviewsOwed: 1, dispatched: [], failed: [] });
  // #xconv1 — likewise: `runConvertAdvisories` defaults to the real `runConvertAdvisoryTickAllRepos` (real
  // `gh`/judge IO), same discipline as `runReview` above.
  const fakeConvertAdvisories = () => null;

  it('folds the injected reapSessions() result onto the review tick result, under `sessionReap`', async () => {
    const reapSessions = vi.fn(() => ({ scanned: 3, stopped: 1, alreadyGone: 0, failures: 0, anomalies: 0, kept: 2 }));
    const effects = buildCliDaemonEffects({ owner: 'x', reapSessions, runReview: fakeReview, runConvertAdvisories: fakeConvertAdvisories });
    const result = await effects.tickOnce();
    expect(reapSessions).toHaveBeenCalledTimes(1);
    expect(result.sessionReap).toEqual({ scanned: 3, stopped: 1, alreadyGone: 0, failures: 0, anomalies: 0, kept: 2 });
    // The review tick's own fields are still present — folding sessionReap on never replaces them.
    expect(result).toHaveProperty('repos');
    expect(result.reviewsOwed).toBe(1);
  });

  it('a session-reap failure is swallowed (logged, non-fatal) — never breaks the review tick', async () => {
    const reapSessions = () => { throw new Error('claude agents unreadable'); };
    const log = { error: vi.fn() };
    const effects = buildCliDaemonEffects({ owner: 'x', reapSessions, runReview: fakeReview, runConvertAdvisories: fakeConvertAdvisories, log });
    const result = await effects.tickOnce();
    expect(result.sessionReap).toBeNull();
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/session-reap failed \(non-fatal\)/));
    expect(result).toHaveProperty('repos'); // the review tick itself still ran to completion
  });

  it('onTick logs the session-reap summary line when one is present, and skips it when `unreadable`', () => {
    const log = { error: vi.fn() };
    const effects = buildCliDaemonEffects({ owner: 'x', log });
    effects.onTick({ repos: [], reviewsOwed: 0, dispatched: [], failed: [], sessionReap: { scanned: 5, stopped: 2, alreadyGone: 1, failures: 0, anomalies: 0, kept: 2 } });
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/session-reap — 5 scanned, 2 stopped, 1 already gone, 2 kept/));

    log.error.mockClear();
    effects.onTick({ repos: [], reviewsOwed: 0, dispatched: [], failed: [], sessionReap: { unreadable: true } });
    expect(log.error.mock.calls.some((c) => /session-reap —/.test(c[0]))).toBe(false);

    log.error.mockClear();
    effects.onTick({ repos: [], reviewsOwed: 0, dispatched: [], failed: [], sessionReap: null });
    expect(log.error.mock.calls.some((c) => /session-reap —/.test(c[0]))).toBe(false);
  });

  // #3383 follow-up (live-caught 2026-09-26) — onTick surfaces a non-zero `deferred` (this pass's reap
  // budget was hit, and some genuine reap candidates carried to the next tick) so an operator reading the
  // log sees it, never a silent gap between `scanned` and `stopped`.
  it('onTick logs the deferred-to-next-tick count and budget when the reap pass hit its budget', () => {
    const log = { error: vi.fn() };
    const effects = buildCliDaemonEffects({ owner: 'x', log });
    effects.onTick({
      repos: [], reviewsOwed: 0, dispatched: [], failed: [],
      sessionReap: {
        scanned: 1500, stopped: 150, alreadyGone: 0, failures: 0, anomalies: 0, kept: 0, deferred: 1350,
        reapBudget: { maxStops: 150, maxDurationMs: 45_000, exhausted: true },
      },
    });
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/1350 deferred to next tick \(reap budget: 150 stops \/ 45000ms, #3383\)/));
  });
});

describe('priorityNamesForLiveProcessPrs — #3383 follow-up: which session names a budget-bounded reap should clear first', () => {
  it('mints every role\'s session name (review/fix/ci-heal) for each live-process-blocked PR', () => {
    const names = priorityNamesForLiveProcessPrs([{ repo: 'web-everything/web-everything', prNumber: 2771 }]);
    expect(names).toEqual(new Set(['review-2771', 'fix-2771', 'ci-heal-2771']));
  });

  it('tags a non-WE repo\'s session names correctly (never bare numbers for a sibling repo)', () => {
    const names = priorityNamesForLiveProcessPrs([{ repo: 'plateauapp/plateau-app', prNumber: 55 }]);
    expect(names).toEqual(new Set(['review-pa-55', 'fix-pa-55', 'ci-heal-pa-55']));
  });

  it('skips an unresolvable repo rather than throwing, and handles an empty/missing list', () => {
    expect(priorityNamesForLiveProcessPrs([{ repo: 'not/a-repo', prNumber: 1 }])).toEqual(new Set());
    expect(priorityNamesForLiveProcessPrs([])).toEqual(new Set());
    expect(priorityNamesForLiveProcessPrs(undefined)).toEqual(new Set());
  });
});

describe('runReviewTick — liveProcessPrs (#3383 follow-up): the PR numbers reconcile refused `live-process` this tick', () => {
  it('collects prNumber from every live-process refusal, ignoring every other refusal kind', () => {
    const reconcile = vi.fn(() => ({
      dispatch: [],
      refusals: [
        { kind: 'live-process', prNumber: 2771 },
        { kind: 'nothing-owed', prNumber: 99 },
        { kind: 'live-process', prNumber: 2772 },
      ],
    }));
    const out = runReviewTick({ reconcile, dispatch: vi.fn(), tagRound: vi.fn(), tagStatus: vi.fn(), statusCandidates: () => [] });
    expect(out.liveProcessPrs).toEqual([2771, 2772]);
  });

  it('empty when nothing was refused live-process this tick', () => {
    const reconcile = vi.fn(() => ({ dispatch: [], refusals: [{ kind: 'nothing-owed', prNumber: 1 }] }));
    const out = runReviewTick({ reconcile, dispatch: vi.fn(), tagRound: vi.fn(), tagStatus: vi.fn(), statusCandidates: () => [] });
    expect(out.liveProcessPrs).toEqual([]);
  });
});

describe('runReviewTickAllRepos — liveProcessPrs (#3383 follow-up): aggregated across repos, repo-tagged', () => {
  it('tags each entry with the repo it came from', () => {
    const tick = vi.fn(({ repo }) => ({
      reviewsOwed: 0, dispatched: [], failed: [], refusals: 0, reconcileError: null,
      liveProcessPrs: repo === 'web-everything/web-everything' ? [10] : [],
    }));
    const out = runReviewTickAllRepos({ repos: ['web-everything/web-everything', 'plateauapp/plateau-app'], tick });
    expect(out.liveProcessPrs).toEqual([{ repo: 'web-everything/web-everything', prNumber: 10 }]);
  });
});

describe('buildCliDaemonEffects.tickOnce — carries liveProcessPrs into the NEXT tick\'s reapSessions call as priorityNames (#3383 follow-up)', () => {
  it('the first tick reaps with an empty priorityNames; the second tick reaps with names derived from the FIRST tick\'s own liveProcessPrs', async () => {
    let call = 0;
    const runReview = () => {
      call += 1;
      return call === 1
        ? { repos: [], reviewsOwed: 0, dispatched: [], failed: [], liveProcessPrs: [{ repo: 'web-everything/web-everything', prNumber: 2771 }] }
        : { repos: [], reviewsOwed: 0, dispatched: [], failed: [], liveProcessPrs: [] };
    };
    const reapSessions = vi.fn(() => ({ scanned: 0, stopped: 0, alreadyGone: 0, failures: 0, anomalies: 0, kept: 0 }));
    const effects = buildCliDaemonEffects({ owner: 'x', reapSessions, runReview });
    await effects.tickOnce();
    expect(reapSessions).toHaveBeenNthCalledWith(1, { priorityNames: new Set() });
    await effects.tickOnce();
    expect(reapSessions).toHaveBeenNthCalledWith(2, { priorityNames: new Set(['review-2771', 'fix-2771', 'ci-heal-2771']) });
  });
});

describe('buildCliDaemonEffects.onTick — logs the review-hold reconcile sweep\'s own findings (#x01u7az)', () => {
  it('logs one line per removal, naming the repo, PR, and labels removed', () => {
    const log = { error: vi.fn() };
    const effects = buildCliDaemonEffects({ owner: 'x', log });
    effects.onTick({
      repos: [], reviewsOwed: 0, dispatched: [], failed: [],
      holdReconcile: [{ num: 2549, remove: ['review:pending'], repo: 'web-everything/web-everything' }],
    });
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/web-everything\/web-everything#2549 hold-reconcile removed review:pending/));
  });

  it('logs a non-fatal holdReconcile failure per repo', () => {
    const log = { error: vi.fn() };
    const effects = buildCliDaemonEffects({ owner: 'x', log });
    effects.onTick({
      repos: [], reviewsOwed: 0, dispatched: [], failed: [],
      holdReconcileFailed: [{ repo: 'frontier-ui/frontierui', error: 'gh: rate limited' }],
    });
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/frontier-ui\/frontierui hold-reconcile failed \(non-fatal, other repos unaffected\): gh: rate limited/));
  });

  it('logs nothing extra when both are absent/empty', () => {
    const log = { error: vi.fn() };
    const effects = buildCliDaemonEffects({ owner: 'x', log });
    effects.onTick({ repos: [], reviewsOwed: 0, dispatched: [], failed: [] });
    expect(log.error.mock.calls.some((c) => /hold-reconcile/.test(c[0]))).toBe(false);
  });

  // #2766/#2767 follow-up — a FLAGGED- or HEALED-only entry carries NO `remove` key at all
  // (`sweepReviewHoldLabels`'s own return doc: the three fields are independent and optional). Before this
  // fix, the log line below unconditionally read `h.remove.join(',')` — a bare `TypeError: Cannot read
  // properties of undefined` on exactly this shape, live in the daemon's own tick loop the first time it ever
  // saw one (this sweep's entries reach `onTick` completely unfiltered from `runReviewTick`).
  it('does NOT throw on a flagged-only entry (no `remove` key) — regression for the #2766/#2767 shape', () => {
    const log = { error: vi.fn() };
    const effects = buildCliDaemonEffects({ owner: 'x', log });
    expect(() => effects.onTick({
      repos: [], reviewsOwed: 0, dispatched: [], failed: [],
      holdReconcile: [{ num: 2767, flagged: ['review:accepted', 'review:human'], flagReason: 'fetch-unavailable', fetchError: 'gh: rate limited', repo: 'web-everything/web-everything' }],
    })).not.toThrow();
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/web-everything\/web-everything#2767 hold-reconcile FLAGGED contradictory review:accepted,review:human — not auto-resolved \(fetch-unavailable, fetch error: gh: rate limited\)/));
  });

  it('does NOT throw on a healed-only entry (no `remove` key), and logs the heal + comment status', () => {
    const log = { error: vi.fn() };
    const effects = buildCliDaemonEffects({ owner: 'x', log });
    expect(() => effects.onTick({
      repos: [], reviewsOwed: 0, dispatched: [], failed: [],
      holdReconcile: [{ num: 2767, healed: ['review:accepted'], commentPosted: true, repo: 'web-everything/web-everything' }],
    })).not.toThrow();
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/web-everything\/web-everything#2767 hold-reconcile HEALED — removed review:accepted, comment posted/));
  });
});

describe('defaultReapSessions — wiring, scoped stricter than session-reaper.mjs\'s own CLI default', () => {
  it('calls runSessionReaperPass with allowedCwd/neverReapWorking/idleThresholdMs set (never a real claude/gh call)', () => {
    runSessionReaperPassMock.mockClear();
    const result = defaultReapSessions();
    expect(runSessionReaperPassMock).toHaveBeenCalledTimes(1);
    expect(runSessionReaperPassMock).toHaveBeenCalledWith({
      allowedCwd: SESSION_REAPER_REPO_ROOT,
      neverReapWorking: true,
      idleThresholdMs: DEFAULT_IDLE_REAP_THRESHOLD_MS,
      reapedLedger: expect.objectContaining({ has: expect.any(Function), add: expect.any(Function), save: expect.any(Function) }),
      priorityNames: null, // #3383 follow-up — omitted by every pre-existing caller, forwarded as-is
      // #ghost-sessions-inflate-cap — explicitly wired ON here (session-reaper.mjs's own bare default is OFF;
      // see that function's own docblock for why), never left to that default.
      pidDeadFor: expect.any(Function),
    });
    expect(result).toEqual({ scanned: 0, stopped: 0, alreadyGone: 0, failures: 0, anomalies: 0, kept: 0 });
  });
});

describe('realSleep — regression, live-caught on THIS daemon\'s own first launchd-managed run', () => {
  // The actual incident that surfaced this whole bug class: this daemon, deployed to a dedicated
  // launchd-managed clone, exited right after its first tick instead of looping. `.unref()`-ing the sleep
  // timer told Node it was fine to exit before it fired, and nothing else kept the event loop alive between
  // ticks. The SAME pattern was copied into #3870's and #3871's own daemons and fixed there too.
  it('realSleep\'s own timer is REF\'d — a resident daemon must not let Node exit before it fires', () => {
    const real = global.setTimeout;
    let captured;
    global.setTimeout = (fn, ms) => { captured = real(fn, ms); return captured; };
    try {
      realSleep(60_000); // never awaited — only the timer's own ref state is asserted, then cleared
      expect(captured.hasRef()).toBe(true); // FAILS if realSleep re-adds `.unref()`
    } finally {
      clearTimeout(captured);
      global.setTimeout = real;
    }
  });
});

// Live-caught 2026-09-26: WE PRs #2746–#2758 sat `review:pending` while every tick logged only "N owed" — no line
// said WHY each parked PR was skipped, and a skipped tick printed "tick () — 0 owed" (an empty repo list).
describe('review:pending PRs the tick did not dispatch — the daemon prints why', () => {
  const pending = (number) => ({ number, labels: [{ name: 'review:pending' }] });

  it('explainPendingNotDispatched: refusal, other-kind, lane-deferral and absent reasons; dispatched and unlabelled PRs skipped', () => {
    const plan = {
      dispatch: [{ kind: 'review', prNumber: 1 }, { kind: 'review', prNumber: 5 }, { kind: 'ci-heal', prNumber: 3, why: 'required check failing' }],
      refusals: [{ kind: 'live-process', prNumber: 2, why: 'a bound session has a LIVE pid', cwd: '/lane-9', pid: 42 }],
    };
    const out = explainPendingNotDispatched({
      prs: [pending(1), pending(2), { number: 3, labels: [{ name: 'ci:failed' }] }, pending(4), pending(5), { number: 6, labels: [] }],
      plan, dispatchable: [{ prNumber: 1 }], deferredForLanes: [{ prNumber: 5 }],
    });
    expect(out).toEqual([
      { prNumber: 2, labels: ['review:pending'], reasons: ['live-process: a bound session has a LIVE pid [cwd=/lane-9 pid=42]'] },
      { prNumber: 3, labels: ['ci:failed'], reasons: ['owed a ci-heal, not a review — required check failing'] },
      { prNumber: 4, labels: ['review:pending'], reasons: ['absent from the reconcile plan (no dispatch, no refusal)'] },
      { prNumber: 5, labels: ['review:pending'], reasons: ['review owed, but no acquirable lane this tick'] },
    ]);
    expect(explainPendingNotDispatched({ prs: null, plan })).toEqual([]);
  });

  it('runReviewTick (shared reads) returns pendingNotDispatched, and onTick prints one line per PR', () => {
    const prs = [pending(2746), pending(2758)];
    const out = runReviewTick({
      readPrs: () => prs, readAgents: () => [],
      reconcile: () => ({ dispatch: [{ kind: 'review', prNumber: 2758 }], refusals: [{ kind: 'live-process', prNumber: 2746, why: 'live pid' }] }),
      dispatch: () => ({ mode: 'job', jobPid: 1 }), tagRound: () => {}, tagStatus: () => {}, statusCandidates: () => [], holdReconcile: () => [],
    });
    expect(out.pendingNotDispatched).toEqual([{ prNumber: 2746, labels: ['review:pending'], reasons: ['live-process: live pid'] }]);
    const lines = [];
    const fx = buildCliDaemonEffects({ owner: 'o', log: { error: (l) => lines.push(l) } });
    fx.onTick({ repos: [{ repo: 'web-everything/web-everything' }], reviewsOwed: 1, dispatched: [], failed: [],
      pendingNotDispatched: out.pendingNotDispatched.map((p) => ({ ...p, repo: 'web-everything/web-everything' })) });
    expect(lines).toContain('review-daemon: web-everything/web-everything#2746 review:pending, no review dispatched — live-process: live pid');
  });

  it('runReviewTickAllRepos aggregates pendingNotDispatched with the repo', () => {
    const r = runReviewTickAllRepos({ repos: ['a/b'], tick: () => ({ reviewsOwed: 0, refusals: 0, dispatched: [], failed: [], pendingNotDispatched: [{ prNumber: 9, reasons: ['x'] }] }) });
    expect(r.pendingNotDispatched).toEqual([{ prNumber: 9, reasons: ['x'], repo: 'a/b' }]);
  });

  it('a withSelfSync-skipped tick prints its reason, never "tick ()"', () => {
    const lines = [];
    const fx = buildCliDaemonEffects({ owner: 'o', log: { error: (l) => lines.push(l) } });
    fx.onTick({ skipped: true, reason: 'writer-active', repos: [], dispatched: [], failed: [], reviewsOwed: 0 });
    expect(lines).toEqual(['review-daemon: tick skipped (writer-active) — no repo was read this tick']);
  });

  it('tickOnce reaps BEFORE discovery, so a hung session it stops frees its PR in the SAME tick', async () => {
    const order = [];
    const fx = buildCliDaemonEffects({
      owner: 'o', log: { error: () => {} },
      reapSessions: () => { order.push('reap'); return null; },
      runReview: () => { order.push('review'); return { repos: [], reviewsOwed: 0, dispatched: [], failed: [] }; },
      // #xconv1 — never the real `runConvertAdvisoryTickAllRepos` (real gh/judge IO) in a unit test.
      runConvertAdvisories: () => null,
    });
    await fx.tickOnce();
    expect(order).toEqual(['reap', 'review']);
  });
});

it('x6n7c2p required checks before review — synthetic #3432 four-tick soak spends one round', () => {
  const tagRound = vi.fn();
  const spawnAgent = vi.fn(() => '');
  const sequence = [['a', 'in_progress', null], ['a', 'completed', 'failure'],
    ['b', 'in_progress', null], ['b', 'completed', 'success']];
  const dispatched = [];
  for (const [head, status, conclusion] of sequence) {
    const out = runReviewTick({ repo: 'web-everything/web-everything',
      reconcile: () => ({ dispatch: [{ kind: 'review', prNumber: 3432, attempts: 2 }], refusals: [] }),
      readPrs: () => [{ number: 3432, labels: [{ name: 'review:pending' }] }], readAgents: () => [],
      acquirableLanes: () => 1, tagRound, tagStatus: () => {}, statusCandidates: () => [], holdReconcile: () => [],
      dispatch: options => dispatchReview({ ...options, root: '/repo', checkStaleness: () => ({ fresh: true, behind: 0 }),
        ciGate: args => readReviewCiGate({ ...args, readHead: () => head.repeat(40),
          readRequired: () => ({ source: 'live', checks: ['test', 'daemon-soak'] }),
          readChecks: () => [{ name: 'test', status: 'completed', conclusion: 'success' }, { name: 'daemon-soak', status, conclusion }],
        }),
        readBrief: () => 'review {{PR}}', mintSessionId: () => 'ci-soak', ensureSessionCwd: path => path,
        resolveSettingsEnv: () => ({}), isolateSession: () => ({ worktreeSettings: {} }), spawnAgent,
      }),
    });
    dispatched.push(out.dispatched.length);
    if (conclusion !== 'success') {
      expect(out.notStarted).toEqual([{ prNumber: 3432, reason: 'review-ci: required-checks-not-successful' }]);
      expect(tagRound).not.toHaveBeenCalled();
      expect(spawnAgent).not.toHaveBeenCalled();
    }
  }
  expect(dispatched).toEqual([0, 0, 0, 1]);
  expect(spawnAgent).toHaveBeenCalledTimes(1);
  expect(tagRound).toHaveBeenCalledTimes(1);
  expect(tagRound).toHaveBeenCalledWith(expect.objectContaining({ pr: 3432, round: 3 }));
});

it.each([false, true])('xux0rs9: a referral pause is announced once (parallel CI refusal: %s)', async parallel => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { notifyReferralHold } = await import('../../../scripts/conveyor/review-referral-hold.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'review-tick-hold-'));
  const post = vi.fn(), log = vi.fn(), dispatch = vi.fn();
  const hold = { head: 'a'.repeat(40), episode: 'hold-3481', count: 4,
    why: 'review paused: 4 referrals need a ruling; it resumes on a new push, a ruling, or a send-back' };
  const subject = { number: 3481, labels: [{ name: 'review:human' }, { name: 'review:pending' }], comments: [] };
  const refusal = { kind: 'review-referrals-pending', prNumber: 3481, referralHold: hold, why: hold.why };
  const plan = { dispatch: [], refusals: [parallel ? { kind: 'owed-ci-rerun', prNumber: 3481, reviewRefusal: refusal } : refusal] };
  try {
    for (let tick = 0; tick < 3; tick++) {
      runReviewTick({ repo: 'web-everything/web-everything', reconcile: () => plan, dispatch,
        readPrs: () => [subject], readAgents: () => [], holdReconcile: () => [],
        tagRound: vi.fn(), tagStatus: vi.fn(),
        notifyReferral: args => notifyReferralHold({ ...args, dir, post, log }),
      });
    }
    expect(dispatch).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(explainPendingNotDispatched({ prs: [subject], plan })).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('xux0rs9: an unreadable notice receipt does not prevent another PR from being reviewed', () => {
  const dispatch = vi.fn(() => ({ agentId: 'new-review' }));
  const result = runReviewTick({ repo: 'web-everything/web-everything',
    reconcile: () => ({ dispatch: [{ kind: 'review', prNumber: 3508 }], refusals: [
      { kind: 'review-referrals-pending', prNumber: 3481, referralHold: { episode: 'broken-receipt' } },
    ] }), dispatch, holdReconcile: () => [], tagRound: vi.fn(), tagStatus: vi.fn(),
    notifyReferral: () => { throw Error('unreadable receipt'); },
  });
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(result.failed).toContainEqual({ prNumber: 3481, error: 'pause notice: unreadable receipt' });
});


describe('#4154 shared scan lane assignments', () => {
  it.each([[[4, 9]], [2]])('acquirableLanes caps by count and preserves numeric dispatch shape: %j', lanes => {
    const dispatch = vi.fn(() => ({}));
    const out = runReviewTick({
      reconcile: () => ({ dispatch: [100, 101, 102].map(prNumber => ({ kind: 'review', prNumber })), refusals: [] }),
      acquirableLanes: () => lanes, dispatch, tagRound: () => {}, tagStatus: () => {},
      holdReconcile: () => [], statusCandidates: () => [],
    });
    expect(out.deferredForLanes).toBe(1);
    expect(dispatch.mock.calls.map(([call]) => call)).toEqual([100, 101].map((pr, i) => ({
      pr, repo: expect.any(String), escalationReason: [], scopePaths: [],
      ...(Array.isArray(lanes) ? { preferLane: lanes[i] } : {}),
    })));
  });
});
