/**
 * @file promote-draft-pr-dispatch.test.mjs — draft-first PRs (operator-approved 2026-09-27):
 *   `runReconcilePromoteDraftDispatch`, the mechanical pass that calls `gh pr ready` on every PR
 *   `reconcile-core.mjs` planned `kind:'promote-draft'` for. No process is started and no real `gh` is
 *   shelled — `reconcile` and `provider` are injected, mirroring `ci-heal-pr-dispatch.test.mjs`'s own shape.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fixDispatchClaimRoot, fixDispatchResource } from '../../conveyor/fix-claim-store.mjs';
import { lockDirFor } from '../../readiness/file-locks.mjs';
import { runReconcilePromoteDraftDispatch, defaultNoCodeRearm, acquireNoCodeRearmLock, defaultReadHeadCheckState, defaultReadPrLabels, isPromoteCodePath, promoteCodeClosure } from '../promote-draft-pr-dispatch.mjs';

const FRESH = () => ({ fresh: true, behind: 0 });
// Every pre-existing test in this file promotes cleanly, so it pins a fresh re-read that always says green —
// the #2811 race itself (a fresh read that disagrees with the plan) gets its OWN describe block below.
const ALWAYS_GREEN = () => ({ state: 'green', why: 'all required checks succeeded', counts: {} });
const NOOP_STATUS = () => {};

describe('review-hold-only red draft promotion', () => {
  const HEAD = 'a'.repeat(40);
  const check = (name, conclusion = 'success', extra = {}) => ({ name, status: 'completed', conclusion, ...extra });
  const heldRows = () => [check('test'), check('review-gate', 'failure'), check('merge-gate', 'failure', { id: 123 })];
  const verdict = () => ({ num: 198, head_sha: HEAD, ok: false,
    results: [{ id: 'review-hold-labels', status: 'hold', reason: 'review required' }] });

  it.each([
    ['annotated merge-gate and review-gate red', heldRows(), 'red', true],
    ['review-gate red only', [check('test'), check('review-gate', 'failure'), check('merge-gate')], 'red', true],
    ['green', [check('test'), check('review-gate'), check('merge-gate')], 'green', false],
    ['another required failure', heldRows().map(row => row.name === 'test' ? check('test', 'failure') : row), 'red', false],
    ['another required check pending', heldRows().map(row => row.name === 'test' ? { ...row, status: 'in_progress', conclusion: null } : row), 'pending', false],
    ['another required check absent', heldRows().filter(row => row.name !== 'test'), 'red', false],
    ['pending', [check('test'), check('merge-gate'), { name: 'review-gate', status: 'in_progress', conclusion: null }], 'pending', false],
    ['no evidence', [], 'unchecked', false],
  ])('the fresh reader returns reviewHoldOnly for %s', (_, rows, state, reviewHoldOnly) => {
    const out = defaultReadHeadCheckState({
      repoSlug: 'web-everything/web-everything', sha: HEAD, prNumber: 198,
      runGh: () => rows.map(row => JSON.stringify(row)).join('\n'),
      getRequiredChecks: () => ({ checks: ['test', 'merge-gate', 'review-gate'], source: 'live' }),
      readPrLabels: () => ['review:pending'], readMergeGateVerdict: verdict,
      readFreeze: () => ({ error: 'not needed' }), mergeGateSetting: { value: 'on' },
    });
    expect(out).toMatchObject({ state, reviewHoldOnly });
  });

  it('the fresh reader keeps an unannotated red merge-gate ineligible when its verdict is unreadable', () => {
    const out = defaultReadHeadCheckState({
      repoSlug: 'web-everything/web-everything', sha: HEAD, prNumber: 198,
      runGh: () => heldRows().map(row => JSON.stringify(row)).join('\n'),
      getRequiredChecks: () => ({ checks: ['test', 'merge-gate', 'review-gate'], source: 'live' }),
      readPrLabels: () => ['review:pending'], readMergeGateVerdict: () => ({ error: 'unreadable' }),
      mergeGateSetting: { value: 'on' },
    });
    expect(out).toMatchObject({ state: 'red', reviewHoldOnly: false });
  });

  it.each([
    ['red without the flag', { state: 'red' }],
    ['red with false', { state: 'red', reviewHoldOnly: false }],
    ['red with a truthy string', { state: 'red', reviewHoldOnly: 'true' }],
    ['pending despite the flag', { state: 'pending', reviewHoldOnly: true }],
    ['unchecked despite the flag', { state: 'unchecked', reviewHoldOnly: true }],
  ])('refuses %s before calling ready', (_, fresh) => {
    const ready = vi.fn();
    const result = runReconcilePromoteDraftDispatch({ readClaim: () => null, readComments: () => [],
      root: '/repo',
      reconcile: () => ({ dispatch: [{ kind: 'promote-draft', prNumber: 198, headRefOid: HEAD }], refusals: [] }),
      provider: { ready }, checkStaleness: FRESH, readPrLabels: () => [],
      readHeadCheckState: () => fresh, clearAwaitingCi: NOOP_STATUS,
    });
    expect(ready).not.toHaveBeenCalled();
    expect(result.dispatched).toEqual([]);
    expect(result.refusals).toEqual([expect.objectContaining({
      pr: 198, kind: 'stale-check-refused', checkState: fresh.state, headSha: HEAD,
    })]);
  });

  it('promotes a fresh red verdict with reviewHoldOnly true through the gh pr ready seam', async () => {
    const ghThrottle = await import('../../lib/gh-throttle.mjs');
    const runGhSyncSpy = vi.spyOn(ghThrottle, 'runGhSync').mockReturnValue('');
    const clearAwaitingCi = vi.fn();
    try {
      const result = runReconcilePromoteDraftDispatch({ readClaim: () => null, readComments: () => [],
        root: '/repo', repo: 'plateauapp/plateau-app',
        reconcile: () => ({ dispatch: [{ kind: 'promote-draft', prNumber: 198, headRefOid: HEAD }], refusals: [] }),
        checkStaleness: FRESH, readPrLabels: () => [],
        readHeadCheckState: () => ({ state: 'red', reviewHoldOnly: true }), clearAwaitingCi,
      });
      expect(result.dispatched).toEqual([{ pr: 198, kind: 'promote-draft', startedAt: expect.any(String), startedSequence: expect.any(Number) }]);
      expect(result.refusals).toEqual([]);
      expect(runGhSyncSpy).toHaveBeenCalledTimes(1);
      expect(runGhSyncSpy.mock.calls[0][0]).toEqual(['pr', 'ready', '198', '--repo', 'plateauapp/plateau-app']);
      expect(clearAwaitingCi).toHaveBeenCalledWith({ pr: 198, repo: 'plateauapp/plateau-app', state: null });
    } finally {
      runGhSyncSpy.mockRestore();
    }
  });
});

describe('runReconcilePromoteDraftDispatch (draft-first PRs)', () => {
  it('calls provider.ready for every promote-draft entry, and nothing else', async () => {
    const readyCalls = [];
    const result = runReconcilePromoteDraftDispatch({ readClaim: () => null, readComments: () => [],
      root: '/repo',
      reconcile: () => ({
        dispatch: [
          { kind: 'promote-draft', prNumber: 101, headRefOid: 'a'.repeat(40) },
          { kind: 'review', prNumber: 102 },
          { kind: 'ci-heal', prNumber: 103 },
          { kind: 'promote-draft', prNumber: 104, headRefOid: 'b'.repeat(40) },
        ],
        refusals: [],
      }),
      provider: { ready: (pr) => { readyCalls.push(pr); } },
      checkStaleness: FRESH, readPrLabels: () => [],
      readHeadCheckState: ALWAYS_GREEN,
      clearAwaitingCi: NOOP_STATUS,
    });
    expect(readyCalls).toEqual([101, 104]);
    expect(result.dispatched).toEqual([{ pr: 101, kind: 'promote-draft', startedAt: expect.any(String), startedSequence: expect.any(Number) }, { pr: 104, kind: 'promote-draft', startedAt: expect.any(String), startedSequence: expect.any(Number) }]);
    expect(result.refusals).toEqual([]);
  });

  it('an empty plan promotes nothing and refuses nothing', () => {
    const result = runReconcilePromoteDraftDispatch({ readClaim: () => null, readComments: () => [],
      root: '/repo', reconcile: () => ({ dispatch: [], refusals: [] }),
      provider: { ready: () => { throw new Error('must not be called'); } },
      checkStaleness: FRESH, readPrLabels: () => [],
      readHeadCheckState: () => { throw new Error('must not be called'); },
      clearAwaitingCi: NOOP_STATUS,
    });
    expect(result).toEqual({ handled: 0, deferred: [], nextCursor: null, nextHalfCursors: { rearm: null, restore: null, close: null }, dispatched: [], refusals: [], reconcileRefusals: 0, reconcileRefusalDetails: [] });
  });

  it('a gh failure on one PR is reported as a refusal and does not stop the rest of the batch', () => {
    const readyCalls = [];
    const result = runReconcilePromoteDraftDispatch({ readClaim: () => null, readComments: () => [],
      root: '/repo',
      reconcile: () => ({
        dispatch: [
          { kind: 'promote-draft', prNumber: 55, headRefOid: 'c'.repeat(40) },
          { kind: 'promote-draft', prNumber: 56, headRefOid: 'd'.repeat(40) },
        ],
        refusals: [],
      }),
      provider: {
        ready: (pr) => {
          readyCalls.push(pr);
          if (pr === 55) throw new Error('gh pr ready failed: HTTP 502');
        },
      },
      checkStaleness: FRESH, readPrLabels: () => [],
      readHeadCheckState: ALWAYS_GREEN,
      clearAwaitingCi: NOOP_STATUS,
    });
    expect(readyCalls).toEqual([55, 56]);
    expect(result.dispatched).toEqual([{ pr: 56, kind: 'promote-draft', startedAt: expect.any(String), startedSequence: expect.any(Number) }]);
    expect(result.refusals).toEqual([{ pr: 55, kind: 'ready-failed', why: 'gh pr ready failed: HTTP 502' }]);
  });

  it('carries the reconcile pass\'s own refusal count through, unmodified', () => {
    const result = runReconcilePromoteDraftDispatch({ readClaim: () => null, readComments: () => [],
      root: '/repo',
      reconcile: () => ({ dispatch: [], refusals: [{ kind: 'draft', prNumber: 9 }] }),
      provider: { ready: () => {} },
      checkStaleness: FRESH, readPrLabels: () => [],
      readHeadCheckState: ALWAYS_GREEN,
      clearAwaitingCi: NOOP_STATUS,
    });
    expect(result.reconcileRefusals).toBe(1);
    expect(result.reconcileRefusalDetails).toEqual([{ kind: 'draft', prNumber: 9 }]);
  });

  it('refuses an unknown --repo before ever calling reconcile or provider', () => {
    expect(() => runReconcilePromoteDraftDispatch({ readClaim: () => null, readComments: () => [],
      root: '/repo', repo: 'unknown/repo',
      reconcile: () => { throw new Error('must not be called'); },
      provider: { ready: () => { throw new Error('must not be called'); } },
      checkStaleness: FRESH, readPrLabels: () => [],
      readHeadCheckState: () => { throw new Error('must not be called'); },
      clearAwaitingCi: NOOP_STATUS,
    })).toThrow(/not a constellation repo/);
  });

  it('reads a shared `--prs-file=` snapshot instead of asking `reconcile` for a fresh gh read, when given one', () => {
    let seenReadPrs = null;
    runReconcilePromoteDraftDispatch({ readClaim: () => null, readComments: () => [],
      root: '/repo', prsFile: '/tmp/some-file.json',
      reconcile: (opts) => { seenReadPrs = typeof opts.readPrs; return { dispatch: [], refusals: [] }; },
      provider: { ready: () => {} },
      checkStaleness: FRESH, readPrLabels: () => [],
      readHeadCheckState: ALWAYS_GREEN,
      clearAwaitingCi: NOOP_STATUS,
    });
    expect(seenReadPrs).toBe('function');
  });
});

describe('runReconcilePromoteDraftDispatch — stale-green re-verification (#2811)', () => {
  const HEAD = 'e52307860'.padEnd(40, '0');

  it('refuses to promote when a fresh per-sha read disagrees with the plan\'s own (stale) green read', () => {
    const readyCalls = [];
    const seenArgs = [];
    const result = runReconcilePromoteDraftDispatch({ readClaim: () => null, readComments: () => [],
      root: '/repo',
      reconcile: () => ({ dispatch: [{ kind: 'promote-draft', prNumber: 2811, headRefOid: HEAD }], refusals: [] }),
      provider: { ready: (pr) => { readyCalls.push(pr); } },
      checkStaleness: FRESH, readPrLabels: () => [],
      readHeadCheckState: (o) => { seenArgs.push(o); return { state: 'red', why: '1 of 1 check(s) concluded failing', counts: {} }; },
      clearAwaitingCi: NOOP_STATUS,
    });
    // THE WHOLE POINT: `gh pr ready` is never called once the fresh read disagrees.
    expect(readyCalls).toEqual([]);
    expect(result.dispatched).toEqual([]);
    expect(result.refusals).toEqual([{
      pr: 2811, kind: 'stale-check-refused', headSha: HEAD, checkState: 'red',
      why: expect.stringContaining('stale-green read'),
    }]);
    // Re-verified for the EXACT head sha the plan carried, never re-derived from the PR number.
    expect(seenArgs).toEqual([{ repoSlug: 'web-everything/web-everything', sha: HEAD }]);
  });

  it('still refuses on a fresh `pending` read — only a completed, all-succeeded read promotes', () => {
    const result = runReconcilePromoteDraftDispatch({ readClaim: () => null, readComments: () => [],
      root: '/repo',
      reconcile: () => ({ dispatch: [{ kind: 'promote-draft', prNumber: 2812, headRefOid: HEAD }], refusals: [] }),
      provider: { ready: () => { throw new Error('must not be called'); } },
      checkStaleness: FRESH, readPrLabels: () => [],
      readHeadCheckState: () => ({ state: 'pending', why: '1 of 2 check(s) still running', counts: {} }),
      clearAwaitingCi: NOOP_STATUS,
    });
    expect(result.dispatched).toEqual([]);
    expect(result.refusals).toEqual([expect.objectContaining({ pr: 2812, kind: 'stale-check-refused', checkState: 'pending' })]);
  });

  it('promotes normally once the fresh re-read confirms green', () => {
    const readyCalls = [];
    const result = runReconcilePromoteDraftDispatch({ readClaim: () => null, readComments: () => [],
      root: '/repo',
      reconcile: () => ({ dispatch: [{ kind: 'promote-draft', prNumber: 2813, headRefOid: HEAD }], refusals: [] }),
      provider: { ready: (pr) => { readyCalls.push(pr); } },
      checkStaleness: FRESH, readPrLabels: () => [],
      readHeadCheckState: () => ({ state: 'green', why: 'all required checks succeeded', counts: {} }),
      clearAwaitingCi: NOOP_STATUS,
    });
    expect(readyCalls).toEqual([2813]);
    expect(result.dispatched).toEqual([{ pr: 2813, kind: 'promote-draft', startedAt: expect.any(String), startedSequence: expect.any(Number) }]);
    expect(result.refusals).toEqual([]);
  });

  it('a re-read that cannot be performed at all refuses rather than promoting on the stale plan alone', () => {
    const result = runReconcilePromoteDraftDispatch({ readClaim: () => null, readComments: () => [],
      root: '/repo',
      reconcile: () => ({ dispatch: [{ kind: 'promote-draft', prNumber: 2814, headRefOid: HEAD }], refusals: [] }),
      provider: { ready: () => { throw new Error('must not be called'); } },
      checkStaleness: FRESH, readPrLabels: () => [],
      readHeadCheckState: () => { throw new Error('gh api rate limited'); },
      clearAwaitingCi: NOOP_STATUS,
    });
    expect(result.dispatched).toEqual([]);
    expect(result.refusals).toEqual([expect.objectContaining({ pr: 2814, kind: 'stale-check-unreadable' })]);
  });

  it('clears the now-stale review-status:awaiting-ci label the instant a draft promotes (#2821)', () => {
    const statusCalls = [];
    const result = runReconcilePromoteDraftDispatch({ readClaim: () => null, readComments: () => [],
      root: '/repo',
      reconcile: () => ({ dispatch: [{ kind: 'promote-draft', prNumber: 2821, headRefOid: HEAD }], refusals: [] }),
      provider: { ready: () => {} },
      checkStaleness: FRESH, readPrLabels: () => [],
      readHeadCheckState: () => ({ state: 'green', why: 'ok', counts: {} }),
      clearAwaitingCi: (o) => statusCalls.push(o),
    });
    expect(result.dispatched).toEqual([{ pr: 2821, kind: 'promote-draft', startedAt: expect.any(String), startedSequence: expect.any(Number) }]);
    expect(statusCalls).toEqual([{ pr: 2821, repo: 'web-everything/web-everything', state: null }]);
  });

  describe('defaultReadHeadCheckState — the real per-sha re-read (gh/getRequiredStatusChecks injected)', () => {
    it.each([
      ['red', [{ name: 'test', status: 'completed', conclusion: 'failure' }]],
      ['pending', [{ name: 'test', status: 'in_progress', conclusion: null }]],
      ['unchecked', []],
    ])('an unavailable required set refuses fresh %s checks before calling ready', (state, rows) => {
      const ready = vi.fn();
      const readHeadCheckState = args => defaultReadHeadCheckState({ ...args,
        runGh: () => rows.map(row => JSON.stringify(row)).join('\n'),
        getRequiredChecks: () => ({ checks: [], source: 'unavailable' }) });
      const result = runReconcilePromoteDraftDispatch({ readClaim: () => null, readComments: () => [],
        root: '/repo', repo: 'plateauapp/plateau-app',
        reconcile: () => ({ dispatch: [{ kind: 'promote-draft', prNumber: 198, headRefOid: HEAD }], refusals: [] }),
        provider: { ready }, checkStaleness: FRESH, readPrLabels: () => [], readHeadCheckState, clearAwaitingCi: NOOP_STATUS,
      });
      expect(ready).not.toHaveBeenCalled();
      expect(result.dispatched).toEqual([]);
      expect(result.refusals).toEqual([expect.objectContaining({ kind: 'stale-check-refused', checkState: state })]);
    });

    it('asks the commit-statuses endpoint for the exact sha and reduces it against the required set', () => {
      const seenArgv = [];
      const runGh = (argv) => { seenArgv.push(argv); return '{"name":"test","status":"COMPLETED","conclusion":"SUCCESS"}\n'; };
      const getRequiredChecks = () => ({ checks: ['test'], source: 'live' });
      const out = defaultReadHeadCheckState({ repoSlug: 'web-everything/web-everything', sha: HEAD, runGh, getRequiredChecks });
      expect(out.state).toBe('green');
      expect(seenArgv[0]).toEqual(expect.arrayContaining(['api', `repos/web-everything/web-everything/commits/${HEAD}/check-runs`]));
    });

    it('reads red off a completed-failure run', () => {
      const runGh = () => '{"name":"test","status":"COMPLETED","conclusion":"FAILURE"}\n';
      const out = defaultReadHeadCheckState({
        repoSlug: 'web-everything/web-everything', sha: HEAD, runGh, getRequiredChecks: () => ({ checks: ['test'], source: 'live' }),
      });
      expect(out.state).toBe('red');
    });
  });

  describe('cwd-inferred-repo fix (we:backlog/x4ua3v8) — the DEFAULT (un-injected) provider', () => {
    // Modeled on the real live incident: plateauapp/plateau-app PR #187, headRefOid c4b00de8… — the daemon runs
    // from the WE checkout (`root`), so before this fix `gh pr ready 187` resolved against
    // `web-everything/web-everything` instead of `plateauapp/plateau-app` and refused
    // ("Command failed: gh pr ready 187"). This test does NOT inject `provider` — it exercises the REAL
    // default construction (`createDraftPromoteProvider`), mocking only the underlying `runGhSync` transport
    // so no real `gh` is ever shelled.
    const PLATEAU_HEAD = 'c4b00de87f80f3b459211191d2a619b2026c87cd';

    it('FAILS before the fix / PASSES after: the real default provider calls gh with --repo plateauapp/plateau-app for a non-WE entry', async () => {
      const ghThrottle = await import('../../lib/gh-throttle.mjs');
      const runGhSyncSpy = vi.spyOn(ghThrottle, 'runGhSync').mockReturnValue('');
      try {
        const result = runReconcilePromoteDraftDispatch({ readClaim: () => null, readComments: () => [],
          root: '/repo',
          repo: 'plateauapp/plateau-app',
          reconcile: () => ({
            dispatch: [{ kind: 'promote-draft', prNumber: 187, headRefOid: PLATEAU_HEAD }],
            refusals: [],
          }),
          checkStaleness: FRESH, readPrLabels: () => [],
          readHeadCheckState: ALWAYS_GREEN,
          clearAwaitingCi: NOOP_STATUS,
        });
        expect(result.dispatched).toEqual([{ pr: 187, kind: 'promote-draft', startedAt: expect.any(String), startedSequence: expect.any(Number) }]);
        expect(result.refusals).toEqual([]);
        // THE FIX: the real `gh` transport was called with an explicit `--repo plateauapp/plateau-app` — before
        // this fix it was called as `['pr', 'ready', '187']` with no `--repo`, relying on `cwd` inference,
        // which (run from the WE checkout `root`) silently targeted `web-everything/web-everything` instead.
        const readyCall = runGhSyncSpy.mock.calls.find((c) => c[0][0] === 'pr' && c[0][1] === 'ready');
        expect(readyCall[0]).toEqual(['pr', 'ready', '187', '--repo', 'plateauapp/plateau-app']);
      } finally {
        runGhSyncSpy.mockRestore();
      }
    });

    it('the WE-default path stays byte-identical (no --repo) — unchanged by this fix', async () => {
      const ghThrottle = await import('../../lib/gh-throttle.mjs');
      const runGhSyncSpy = vi.spyOn(ghThrottle, 'runGhSync').mockReturnValue('');
      try {
        runReconcilePromoteDraftDispatch({ readClaim: () => null, readComments: () => [],
          root: '/repo',
          reconcile: () => ({
            dispatch: [{ kind: 'promote-draft', prNumber: 999, headRefOid: 'f'.repeat(40) }],
            refusals: [],
          }),
          checkStaleness: FRESH, readPrLabels: () => [],
          readHeadCheckState: ALWAYS_GREEN,
          clearAwaitingCi: NOOP_STATUS,
        });
        const readyCall = runGhSyncSpy.mock.calls.find((c) => c[0][0] === 'pr' && c[0][1] === 'ready');
        expect(readyCall[0]).toEqual(['pr', 'ready', '999']);
      } finally {
        runGhSyncSpy.mockRestore();
      }
    });
  });

  it('a clearAwaitingCi failure is best-effort and never turns a successful promotion into a refusal', () => {
    const result = runReconcilePromoteDraftDispatch({ readClaim: () => null, readComments: () => [],
      root: '/repo',
      reconcile: () => ({ dispatch: [{ kind: 'promote-draft', prNumber: 2822, headRefOid: HEAD }], refusals: [] }),
      provider: { ready: () => {} },
      checkStaleness: FRESH, readPrLabels: () => [],
      readHeadCheckState: () => ({ state: 'green', why: 'ok', counts: {} }),
      clearAwaitingCi: () => { throw new Error('gh hiccup'); },
    });
    expect(result.dispatched).toEqual([{ pr: 2822, kind: 'promote-draft', startedAt: expect.any(String), startedSequence: expect.any(Number) }]);
    expect(result.refusals).toEqual([]);
  });
});

it('xxh4zw8 fresh exact-head reader refuses complete cancelled evidence without a ready call', () => {
  const sha = '4ecb5deb362c81aa28de162db4616bb4c2009347';
  const required = ['test', 'smoke', 'daemon-soak', 'soak-replay-gate'];
  const runs = required.map((name, i) => ({ id: 110460009383 + i, name, status: 'completed', conclusion: name === 'smoke' ? 'cancelled' : 'success' }));
  const ready = vi.fn();
  const runGh = vi.fn(() => runs.map(row => JSON.stringify(row)).join('\n'));
  const readHeadCheckState = args => defaultReadHeadCheckState({ ...args, runGh, getRequiredChecks: () => ({ checks: required }) });
  expect(readHeadCheckState({ repoSlug: 'web-everything/web-everything', sha })).toMatchObject({ state: 'red', counts: { total: 4, failed: 1 } });
  const result = runReconcilePromoteDraftDispatch({ readClaim: () => null, readComments: () => [], root: '/repo', checkStaleness: FRESH, readPrLabels: () => [],
    reconcile: () => ({ dispatch: [{ kind: 'promote-draft', prNumber: 3336, headRefOid: sha }], refusals: [] }),
    provider: { ready }, readHeadCheckState, clearAwaitingCi: NOOP_STATUS });
  expect(ready).not.toHaveBeenCalled();
  expect(result.dispatched).toEqual([]);
  expect(result.refusals).toHaveLength(1);
  expect(runGh.mock.calls[0][0]).toContain(`repos/web-everything/web-everything/commits/${sha}/check-runs`);
});


describe('xul2kwr fresh withdrawal guard', () => {
  const entry = { kind: 'promote-draft', prNumber: 3432, headRefOid: 'a'.repeat(40) };
  it.each([
    [['review-status:draft-withdrawn'], 'draft-withdrawn'],
    [[{ name: 'review-status:draft-withdrawn' }], 'draft-withdrawn'],
    [undefined, 'draft-state-unreadable'], [null, 'draft-state-unreadable'],
    [{ labels: [] }, 'draft-state-unreadable'], [[null], 'draft-state-unreadable'],
    [[{}], 'draft-state-unreadable'], [[{ name: 1 }], 'draft-state-unreadable'],
    [[''], 'draft-state-unreadable'], [[42], 'draft-state-unreadable'],
    [new Error('unavailable'), 'draft-state-unreadable'],
    [[], null], [['unrelated'], null], [[{ name: 'review-status:draft-scope-change' }], null],
  ])('fresh labels %j yield %s', (labels, kind) => {
    const calls = [];
    const ready = vi.fn(() => calls.push('ready'));
    const clear = vi.fn();
    const result = runReconcilePromoteDraftDispatch({ readClaim: () => null, readComments: () => [],
      root: '/repo', repo: 'plateauapp/plateau-app', checkStaleness: FRESH,
      reconcile: () => ({ dispatch: [entry], refusals: [] }),
      readHeadCheckState: () => { calls.push('checks'); return ALWAYS_GREEN(); },
      readPrLabels: args => {
        expect(args).toEqual({ repoSlug: 'plateauapp/plateau-app', prNumber: 3432 });
        calls.push('labels');
        if (labels instanceof Error) throw labels;
        return labels;
      },
      provider: { ready }, clearAwaitingCi: clear,
    });
    expect(calls.slice(0, 2)).toEqual(['checks', 'labels']);
    if (kind) {
      expect(result.refusals).toEqual([expect.objectContaining({ pr: 3432, kind })]);
      expect(result.dispatched).toEqual([]);
      expect(ready).not.toHaveBeenCalled();
      expect(clear).not.toHaveBeenCalled();
    } else {
      expect(result.refusals).toEqual([]);
      expect(ready).toHaveBeenCalledWith(3432);
      expect(clear).toHaveBeenCalledOnce();
    }
  });

  it('reads labels with explicit repository and throttling', () => {
    const runGh = vi.fn(() => JSON.stringify({ labels: [{ name: 'unrelated' }] }));
    expect(defaultReadPrLabels({ repoSlug: 'plateauapp/plateau-app', prNumber: 3432, runGh }))
      .toEqual([{ name: 'unrelated' }]);
    expect(runGh).toHaveBeenCalledWith(
      ['pr', 'view', '3432', '--repo', 'plateauapp/plateau-app', '--json', 'labels'],
      expect.objectContaining({ throttle: expect.objectContaining({ repo: 'plateauapp/plateau-app' }) }),
    );
  });

  it.each(['bad json', '{}', 'null', '[]', '{"labels":null}', '{"labels":{}}',
    '{"labels":[null]}', '{"labels":[{}]}', '{"labels":[{"name":2}]}'])('rejects malformed envelope %s', raw => {
    expect(() => defaultReadPrLabels({ repoSlug: 'plateauapp/plateau-app', prNumber: 3432, runGh: () => raw })).toThrow();
  });
});

// LIVE INCIDENT 2026-10-03 (PR #3806): a managed daemon clone 2 commits behind origin/main made the stale-main
// guard throw for the WHOLE promote pass, though neither commit touched a file the pass imports. Promotion's only
// write is `gh pr ready` after a fresh per-sha re-check, so lag outside its own import closure must not block it.
describe('isPromoteCodePath — the declared promote code path (#3806 incident)', () => {
  it('real closure: a file the promote pass imports is on the path', () => {
    expect(promoteCodeClosure()?.complete).toBe(true);
    expect(isPromoteCodePath('scripts/operations/promote-draft-pr-dispatch.mjs')).toBe(true);
    expect(isPromoteCodePath('scripts/conveyor/reconcile-core.mjs')).toBe(true);
    expect(isPromoteCodePath('scripts/lib/draft-promote-provider.mjs')).toBe(true);
  });
  it('real closure: the CLI adapter (the two commits behind in the incident) is NOT on the path', () => {
    expect(isPromoteCodePath('scripts/operations/cli-adapter.mjs')).toBe(false);
    expect(isPromoteCodePath('scripts/operations/__tests__/render-outcome-effect-refusal.test.mjs')).toBe(false);
  });
  it('real closure: main CI evidence is on the path without the main-red owner dispatcher', () => {
    expect(promoteCodeClosure()?.complete).toBe(true);
    expect(isPromoteCodePath('scripts/conveyor/main-ci-red-probe.mjs')).toBe(true);
    expect(isPromoteCodePath('scripts/conveyor/main-ci-red-io.mjs')).toBe(false);
  });
  it('an unreadable closure fails closed: every code file counts', () => {
    expect(isPromoteCodePath('scripts/operations/cli-adapter.mjs', { closure: null })).toBe(true);
    expect(isPromoteCodePath('backlog/123-x.md', { closure: null })).toBe(false);
  });
});

describe('runReconcilePromoteDraftDispatch — a draft that is not promoted says why (#3806 incident)', () => {
  it('reports every non-green draft the plan refused, naming its check state; green and withdrawn are not double-reported', () => {
    const result = runReconcilePromoteDraftDispatch({ readClaim: () => null, readComments: () => [],
      root: '/repo',
      reconcile: () => ({
        dispatch: [],
        refusals: [
          { kind: 'draft', prNumber: 7, check: 'pending' },
          { kind: 'draft', prNumber: 8, check: 'unchecked' },
          { kind: 'draft', prNumber: 9, check: 'green' }, // withdrawn: already logged as reconcile-refused
          { kind: 'fix-claimed', prNumber: 10 },
        ],
      }),
      provider: { ready: () => { throw new Error('must not be called'); } },
      checkStaleness: FRESH, readPrLabels: () => [], readHeadCheckState: ALWAYS_GREEN, clearAwaitingCi: NOOP_STATUS,
    });
    expect(result.refusals.map((r) => [r.pr, r.kind])).toEqual([[7, 'draft-not-promoted'], [8, 'draft-not-promoted']]);
    expect(result.refusals[0].why).toMatch(/pending/);
    expect(result.refusals[1].why).toMatch(/unchecked/);
  });
});

describe('runReconcilePromoteDraftDispatch — restore-review-label half (PR #3830)', () => {
  const base = { root: '/repo', checkStaleness: FRESH, clearAwaitingCi: NOOP_STATUS, readHeadCheckState: ALWAYS_GREEN, provider: { ready: () => { throw new Error('no'); } } };
  const plan = { dispatch: [{ kind: 'restore-review-label', prNumber: 3830, label: 'review:pending' }], refusals: [] };
  it('adds review:pending to a still-label-less PR and reports it', () => {
    const calls = [];
    const r = runReconcilePromoteDraftDispatch({ readClaim: () => null, readComments: () => [], ...base, reconcile: () => plan, readPrLabels: () => [], addLabel: (a) => calls.push(a) });
    expect(calls).toEqual([expect.objectContaining({ prNumber: 3830, label: 'review:pending' })]);
    expect(r.dispatched).toEqual([{ pr: 3830, kind: 'restore-review-label', label: 'review:pending', startedAt: expect.any(String), startedSequence: expect.any(Number) }]);
  });
  it('re-reads labels and refuses when a review/landing label appeared since the plan', () => {
    const r = runReconcilePromoteDraftDispatch({ readClaim: () => null, readComments: () => [], ...base, reconcile: () => plan, readPrLabels: () => [{ name: 'ready-to-merge' }], addLabel: () => { throw new Error('must not write'); } });
    expect(r.dispatched).toEqual([]);
    expect(r.refusals).toEqual([expect.objectContaining({ pr: 3830, kind: 'label-already-set' })]);
  });
  it('a failed write is a refusal, never a throw', () => {
    const r = runReconcilePromoteDraftDispatch({ readClaim: () => null, readComments: () => [], ...base, reconcile: () => plan, readPrLabels: () => [], addLabel: () => { throw new Error('boom'); } });
    expect(r.refusals).toEqual([expect.objectContaining({ kind: 'label-failed' })]);
  });
});

it('yields between complete PR effects and resumes at the cursor with wraparound', () => {
  let time = 10, inEffect = false;
  const touched = [];
  const now = vi.fn(() => { expect(inEffect).toBe(false); return time; });
  const options = { readClaim: () => null, readComments: () => [], root: '/repo', checkStaleness: FRESH, now, deadlineAt: 10,
    reconcile: () => ({ dispatch: [3, 1, 2].map(prNumber => ({ kind: 'promote-draft', prNumber, headRefOid: 'a' })), refusals: [] }),
    readHeadCheckState: () => { inEffect = true; time = 11; return { state: 'green' }; },
    readPrLabels: () => [], provider: { ready: pr => { touched.push(pr); } },
    clearAwaitingCi: () => { expect(inEffect).toBe(true); inEffect = false; },
  };
  const first = runReconcilePromoteDraftDispatch(options);
  expect(first).toMatchObject({ handled: 1, deferred: [2, 3], nextCursor: 2 });
  expect(touched).toEqual([1]);
  // The entry check, then each PR's clock read.
  expect(now).toHaveBeenCalledTimes(3);
  touched.length = 0;
  const second = runReconcilePromoteDraftDispatch({ readClaim: () => null, readComments: () => [], ...options, cursor: first.nextCursor, deadlineAt: 20 });
  expect(touched).toEqual([2, 3, 1]);
  expect(second).toMatchObject({ handled: 3, deferred: [], nextCursor: null });
});

it('past deadline with a cursor skips reconcile, uses deferred=[cursor], and keeps the cursor for next pass', () => {
  const reconcile = vi.fn(() => ({ dispatch: [], refusals: [] }));
  const ready = vi.fn(), readHeadCheckState = vi.fn(), readPrLabels = vi.fn();
  const result = runReconcilePromoteDraftDispatch({ readClaim: () => null, readComments: () => [], root: '/repo', checkStaleness: FRESH,
    now: () => 11, deadlineAt: 10, cursor: 42, reconcile,
    provider: { ready }, readHeadCheckState, readPrLabels,
  });
  expect(result).toMatchObject({ handled: 0, deferred: [42], nextCursor: 42 });
  for (const fn of [reconcile, ready, readHeadCheckState, readPrLabels]) expect(fn).not.toHaveBeenCalled();
});

it('past deadline without a cursor skips reconcile and flags deadlineSkipped', () => {
  const reconcile = vi.fn(() => ({ dispatch: [43, 42].map(prNumber => ({ kind: 'promote-draft', prNumber })), refusals: [] }));
  const ready = vi.fn(), readHeadCheckState = vi.fn(), readPrLabels = vi.fn();
  const result = runReconcilePromoteDraftDispatch({ readClaim: () => null, readComments: () => [], root: '/repo', checkStaleness: FRESH,
    now: () => 11, deadlineAt: 10, reconcile, provider: { ready }, readHeadCheckState, readPrLabels,
  });
  expect(result).toMatchObject({ handled: 0, deferred: [], nextCursor: null, deadlineSkipped: true });
  for (const fn of [reconcile, ready, readHeadCheckState, readPrLabels]) expect(fn).not.toHaveBeenCalled();
});

it('promote-draft: a reconcile that always overruns the budget still handles one entry every pass (no starvation)', () => {
  let time = 0;
  const promoted = [];
  const options = { root: '/repo', checkStaleness: FRESH, now: () => time,
    reconcile: () => { time += 1000; return { dispatch: [5, 6].map(prNumber => ({ kind: 'promote-draft', prNumber, headRefOid: 'a' })), refusals: [] }; },
    readHeadCheckState: () => ({ state: 'green' }), readPrLabels: () => [],
    provider: { ready: pr => { promoted.push(pr); } }, clearAwaitingCi: () => {} };
  let cursor;
  for (let pass = 0; pass < 2; pass += 1) {
    const result = runReconcilePromoteDraftDispatch({ readClaim: () => null, readComments: () => [], ...options, deadlineAt: time + 100, cursor });
    expect(result).toMatchObject({ handled: 1, deferred: [pass === 0 ? 6 : 5], nextCursor: pass === 0 ? 6 : 5 });
    cursor = result.nextCursor ?? undefined;
  }
  expect(promoted).toEqual([5, 6]);
});

it('capability-off refuses promotion while a withdrawn draft remains held', () => {
  const ready = vi.fn();
  const options = { readClaim: () => null, readComments: () => [],
    root: '/repo', resolveProfile: () => ({ capabilities: { review: false } }),
    reconcile: () => ({ dispatch: [{ kind: 'promote-draft', prNumber: 198, headRefOid: 'a'.repeat(40) }], refusals: [] }),
    provider: { ready }, checkStaleness: FRESH, readPrLabels: () => [],
    readHeadCheckState: ALWAYS_GREEN, clearAwaitingCi: NOOP_STATUS,
  };
  expect(runReconcilePromoteDraftDispatch(options).refusals).toEqual([expect.objectContaining({ kind: 'unsupported-repo' })]);
  expect(ready).not.toHaveBeenCalled();
  expect(runReconcilePromoteDraftDispatch({ readClaim: () => null, readComments: () => [], ...options, readPrLabels: () => ['review-status:draft-withdrawn'] }).refusals)
    .toEqual([expect.objectContaining({ kind: 'draft-withdrawn' })]);
  expect(ready).not.toHaveBeenCalled();
});

describe('fresh operator park guard', () => {
  const entry = { kind: 'promote-draft', prNumber: 3432, headRefOid: 'a'.repeat(40) };
  const park = { author: { login: 'web-everything' }, body: '<!-- operator-park -->' };

  it('a park posted after planning stops the dispatcher write', () => {
    let comments = [];
    const ready = vi.fn();
    const readComments = vi.fn(() => comments);
    const result = runReconcilePromoteDraftDispatch({ readClaim: () => null,
      root: '/repo', repo: 'plateauapp/plateau-app', checkStaleness: FRESH,
      reconcile: () => ({ dispatch: [entry], refusals: [] }),
      readHeadCheckState: () => { comments = [park]; return ALWAYS_GREEN(); },
      readPrLabels: () => [], readComments, provider: { ready }, clearAwaitingCi: NOOP_STATUS,
    });
    expect(readComments).toHaveBeenCalledWith(3432, { repo: 'plateauapp/plateau-app' });
    expect(result.refusals).toEqual([expect.objectContaining({ kind: 'operator-parked' })]);
    expect(result.dispatched).toEqual([]);
    expect(ready).not.toHaveBeenCalled();
  });

  it.each([undefined, null, {}, 'comments', new Error('unreadable')])(
    'fails closed for fresh comments %j', comments => {
      const ready = vi.fn();
      const result = runReconcilePromoteDraftDispatch({ readClaim: () => null,
        root: '/repo', checkStaleness: FRESH,
        reconcile: () => ({ dispatch: [entry], refusals: [] }),
        readHeadCheckState: ALWAYS_GREEN, readPrLabels: () => [],
        readComments: () => { if (comments instanceof Error) throw comments; return comments; },
        provider: { ready }, clearAwaitingCi: NOOP_STATUS,
      });
      expect(result.refusals).toEqual([expect.objectContaining({
        kind: 'draft-state-unreadable', why: expect.stringContaining('retry next tick'),
      })]);
      expect(ready).not.toHaveBeenCalled();
    },
  );
});

describe('fresh review-status:draft-withdrawn label guard', () => {
  const entry = { kind: 'promote-draft', prNumber: 3432, headRefOid: 'a'.repeat(40) };
  const run = (readPrLabels, ready) => runReconcilePromoteDraftDispatch({ readClaim: () => null,
    root: '/repo', repo: 'plateauapp/plateau-app', checkStaleness: FRESH,
    reconcile: () => ({ dispatch: [entry], refusals: [] }), readHeadCheckState: ALWAYS_GREEN,
    readComments: () => [], readPrLabels, provider: { ready }, clearAwaitingCi: NOOP_STATUS,
  });
  it.each(['review-status:draft-withdrawn', { name: 'review-status:draft-withdrawn' }])('refuses a fresh parked label %j and promotes only after removal', label => {
    const ready = vi.fn();
    let labels = [label];
    const read = vi.fn(() => labels);
    expect(run(read, ready).refusals).toEqual([expect.objectContaining({ kind: 'draft-withdrawn' })]);
    expect(read).toHaveBeenCalledWith({ repoSlug: 'plateauapp/plateau-app', prNumber: 3432 });
    expect(ready).not.toHaveBeenCalled();
    labels = [];
    expect(run(read, ready).dispatched).toEqual([expect.objectContaining({ kind: 'promote-draft' })]);
    expect(ready).toHaveBeenCalledOnce();
  });
  it('refuses a park comment posted during the label read', () => {
    const ready = vi.fn();
    let comments = [];
    const calls = [];
    const result = runReconcilePromoteDraftDispatch({ readClaim: () => null, root: '/repo', checkStaleness: FRESH,
      reconcile: () => ({ dispatch: [entry], refusals: [] }), readHeadCheckState: ALWAYS_GREEN,
      readComments: () => { calls.push('comments'); return comments; },
      readPrLabels: () => {
        calls.push('labels');
        comments = [{ author: { login: 'web-everything' }, body: '<!-- operator-park -->' }];
        return [];
      },
      provider: { ready }, clearAwaitingCi: NOOP_STATUS,
    });
    expect(result.refusals).toEqual([expect.objectContaining({ kind: 'operator-parked' })]);
    expect(calls).toEqual(['labels', 'comments']);
    expect(ready).not.toHaveBeenCalled();
  });
  it.each([undefined, null, {}, [null], new Error('label read failed')])('unreadable labels fail closed: %j', labels => {
    const ready = vi.fn();
    const result = run(() => { if (labels instanceof Error) throw labels; return labels; }, ready);
    expect(result.refusals).toEqual([expect.objectContaining({ kind: 'draft-state-unreadable' })]);
    expect(ready).not.toHaveBeenCalled();
  });
});

import { runReconcileFixDispatch } from '../../conveyor/reconcile-fix-dispatch.mjs';
// D2: the real mechanical executor, with hermetic IO and writer stdout.
import { buildOperatorAnswer, NO_CODE_REARM_RECEIPT } from '../../conveyor/stand-down-answer-core.mjs';
import { buildStandDownComment } from '../../conveyor/stand-down.mjs';
import { planReconcile } from '../../conveyor/reconcile-core.mjs';
import { readCompletePrComments } from '../../conveyor/pr-comments-complete.mjs';
import { runReviewLabelCli } from '../../review-set-label.mjs';
import { formatPromoteActionLine, runPromoteDraftDispatchAllRepos } from '../../../skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs';

describe('operator no-code rearm executor', () => {
  let lockRoot;
  beforeEach(() => { lockRoot = mkdtempSync(join(tmpdir(), 'no-code-executor-')); });
  afterEach(() => rmSync(lockRoot, { recursive: true, force: true }));
  const head = 'a'.repeat(40);
  const c = (id, body) => ({ id, body, author: { login: 'chalbert' } });
  const begin = c('begin', `🔒 conveyor fix-begin — fix claim held

**Branch:** \`lane/x\` at \`${head}\``);
  const verdict = c('verdict', `🔁 review — changes requested

Fix defect`);
  const stop = c('stop', buildStandDownComment({ reason: 'needs-judgment', detail: 'Code owed?', head }));
  const answer = c('answer', buildOperatorAnswer({ standDownId: 'stop', actor: 'chalbert', reason: 'No code owed', channel: 'chat', disposition: 'rearm-review', noCodeOwed: true }));
  const thread = () => [verdict, begin, stop, answer];
  const entry = { kind: 'rearm-no-code', prNumber: 42, expectHead: head, answerId: 'answer' };
  const json = labels => JSON.stringify({ ok: true, labelsObserved: true, labels });
  function setup(over = {}) {
    const posted = [];
    const postComment = vi.fn(({ comment }) => posted.push(c('receipt', comment))), rearm = vi.fn(() => ({ status: 0, stdout: json(['review:pending']) }));
    const options = { root: '/repo', clearAwaitingCi: NOOP_STATUS, addLabel: vi.fn(), closePr: vi.fn(), readCardsOnMain: () => [], checkStaleness: FRESH, provider: { ready: vi.fn() }, reconcile: () => ({ dispatch: [entry], refusals: [] }), readPrLabels: () => ['review:changes'], readThread: () => [...thread(), ...posted], readClaim: () => null, postComment, rearm,
      acquireRearmLock: args => acquireNoCodeRearmLock({ ...args, root: lockRoot }, {
        stamp: () => ({ runnerStart: 'test-process-birth' }), identity: () => ({ alive: true }),
      }), ...over };
    return { options, postComment, rearm, run: () => runReconcilePromoteDraftDispatch(options) };
  }
  it('overlapping executors consume one answer only once', () => {
    const posted = [];
    let overlap, contender;
    const postComment = vi.fn(({ comment }) => posted.push(c(`receipt-${posted.length}`, comment)));
    const rearm = vi.fn(() => ({ status: 0, stdout: json(['review:pending']) }));
    const first = setup({ readThread: () => [...thread(), ...posted], postComment, rearm,
      readClaim: () => { overlap = contender.run(); return null; } });
    contender = setup({ ...first.options, readClaim: () => null });
    const result = first.run();
    expect(result.dispatched).toEqual([{ pr: 42, kind: 'rearm-no-code', startedAt: expect.any(String), startedSequence: expect.any(Number) }]);
    expect(overlap.dispatched).toEqual([]);
    expect(postComment).toHaveBeenCalledTimes(1);
    expect(rearm).toHaveBeenCalledTimes(1);
  });
  it('rechecks admission inside exclusion and releases the lock on a stale plan', () => {
    const comments = thread();
    const s = setup({ readThread: () => comments });
    const acquire = s.options.acquireRearmLock;
    s.options.acquireRearmLock = args => {
      const release = acquire(args);
      comments.push(c('receipt-by-predecessor', NO_CODE_REARM_RECEIPT('answer', head)));
      return release;
    };
    expect(s.run().refusals).toContainEqual(expect.objectContaining({ kind: 'rearm-no-code-stale' }));
    expect(s.postComment).not.toHaveBeenCalled();
    expect(s.rearm).not.toHaveBeenCalled();
    const release = acquire({ repoSlug: 'web-everything/web-everything', prNumber: 42 });
    release();
  });
  it('unreadable lock ownership refuses before reading evidence or writing', () => {
    const s = setup({ acquireRearmLock: () => { throw Error('operator must inspect lock ownership'); }, readThread: vi.fn() });
    expect(s.run().refusals).toContainEqual(expect.objectContaining({ kind: 'rearm-no-code-lock-unavailable' }));
    expect(s.options.readThread).not.toHaveBeenCalled();
    expect(s.postComment).not.toHaveBeenCalled();
    expect(s.rearm).not.toHaveBeenCalled();
  });
  it.each(['thread-read', 'claim-read', 'receipt-post', 'writer'])('releases exclusion after %s fails', stage => {
    const fail = () => { throw Error('fixture failure'); };
    const s = setup({ ...(stage === 'thread-read' ? { readThread: fail } : {}),
      ...(stage === 'claim-read' ? { readClaim: fail } : {}),
      ...(stage === 'receipt-post' ? { postComment: fail } : {}),
      ...(stage === 'writer' ? { rearm: fail } : {}) });
    expect(s.run().dispatched).toEqual([]);
    const release = s.options.acquireRearmLock({ repoSlug: 'web-everything/web-everything', prNumber: 42 });
    release();
  });
  function actualWriterFixture(comments = thread()) {
    const stateFile = join(lockRoot, 'state.json');
    const ghPath = join(lockRoot, 'gh');
    writeFileSync(stateFile, JSON.stringify({ state: 'OPEN', headRefOid: head, labels: ['review:changes'], comments, writes: [] }));
    writeFileSync(ghPath, [
      `#!${process.execPath}`,
      "const fs = require('node:fs');",
      "const a = process.argv.slice(2), p = process.env.REARM_TEST_STATE, s = JSON.parse(fs.readFileSync(p, 'utf8'));",
      "const save = () => fs.writeFileSync(p, JSON.stringify(s));",
      "if (a[0] === 'pr' && a[1] === 'view') console.log(JSON.stringify(s));",
      "else if (a[0] === 'api' && a[1].includes('/comments')) console.log(JSON.stringify([s.comments]));",
      "else if (a[0] === 'pr' && a[1] === 'edit') { s.labels = s.labels.filter(l => !a.some((v,i) => v === '--remove-label' && a[i+1] === l)); const i = a.indexOf('--add-label'); if (i >= 0) s.labels.push(a[i+1]); s.writes.push('labels'); save(); }",
      "else if (a[0] === 'pr' && a[1] === 'comment') { const file = a[a.indexOf('--body-file')+1]; const body = fs.readFileSync(file === '-' ? 0 : file, 'utf8'); s.comments.push({ id: 'writer-comment', body, author: { login: 'web-everything' } }); s.writes.push('comment'); save(); }",
      "else { console.error('unexpected hermetic gh call', a); process.exit(1); }",
    ].join('\n'));
    chmodSync(ghPath, 0o755);
    const read = () => JSON.parse(readFileSync(stateFile, 'utf8'));
    const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(WE_|GH_|GITHUB_|LANE_POOL_ROOT$)/.test(k)));
    const writer = vi.fn(args => defaultNoCodeRearm({ ...args, spawn: (exe, argv, opts) => spawnSync(exe, argv, { ...opts,
      env: { ...cleanEnv, PATH: `${lockRoot}:${process.env.PATH}`, HOME: lockRoot, WE_COORDINATION_ROOT: lockRoot,
        WE_GH_THROTTLE_LOCK_ROOT: join(lockRoot, 'throttle'), REARM_TEST_STATE: stateFile },
    }) }));
    const postComment = vi.fn(({ comment }) => { const s = read(); s.comments.push(c('receipt', comment)); s.writes.push('receipt'); writeFileSync(stateFile, JSON.stringify(s)); });
    return { read, writer, postComment, write: state => writeFileSync(stateFile, JSON.stringify(state)) };
  }
  it('actual rearm-review writer transitions labels once across two executor ticks', () => {
    const { read, writer, postComment } = actualWriterFixture();
    const planned = [];
    const reconcile = () => {
      const result = planReconcile({ agents: [], requiredChecks: ['gate'], prs: [{ ...read(), number: 42,
        headRefName: 'lane/test', mergeStateStatus: 'CLEAN',
        statusCheckRollup: [{ name: 'gate', status: 'completed', conclusion: 'success' }],
      }] });
      planned.push(...result.dispatch.map(row => row.kind));
      return result;
    };
    const s = setup({ reconcile, readThread: () => read().comments, readPrLabels: () => read().labels, postComment, rearm: writer });
    const first = s.run();
    expect(first.refusals).toEqual([]);
    expect(first.dispatched).toEqual([{ pr: 42, kind: 'rearm-no-code', startedAt: expect.any(String), startedSequence: expect.any(Number) }]);
    expect(read().labels).toEqual(['review:pending']);
    const after = read();
    expect(s.run().dispatched).toEqual([]);
    expect(read()).toEqual(after);
    expect(after.writes).toEqual(['receipt', 'labels', 'comment']);
    expect(planned.filter(kind => kind === 'fix')).toEqual([]);
    expect(planned.filter(kind => kind === 'rearm-no-code')).toEqual(['rearm-no-code']);
    expect(writer).toHaveBeenCalledTimes(1);
    expect(postComment).toHaveBeenCalledTimes(1);
  }, 120000);
  it.each([false, true])('receipted replacement preserves consumed writer budgets: noCodeOwed=%s', noCodeOwed => {
    const ordinary = (id, standDownId) => c(id, buildOperatorAnswer({ standDownId, actor: 'chalbert',
      reason: 'Allow one retry', channel: 'chat', disposition: 'rearm-review' }));
    const exhausted = [verdict, begin, { ...stop, id: 'waiver-stop-1' }, ordinary('waiver-1', 'waiver-stop-1'),
      { ...begin, id: 'begin-2' }, { ...stop, id: 'waiver-stop-2' }, ordinary('waiver-2', 'waiver-stop-2'),
      { ...begin, id: 'begin-3' }, stop, answer, c('original-receipt', NO_CODE_REARM_RECEIPT('answer', head))];
    const replacement = c('replacement', buildOperatorAnswer({ standDownId: 'stop', actor: 'chalbert',
      reason: 'Inspected failed handoff', channel: 'chat', disposition: 'rearm-review', noCodeOwed: true, supersedes: 'answer' }));
    const { read, write, writer, postComment } = actualWriterFixture([...exhausted, replacement]);
    const s = setup({ reconcile: () => ({ dispatch: [{ ...entry, answerId: 'replacement' }], refusals: [] }),
      readThread: () => read().comments, readPrLabels: () => read().labels, postComment,
      rearm: args => {
        // A new empty round arrives after the complete guard, before the real writer reads.
        // The replacement must not reset either
        // of the two spent waivers or the single spent no-code cap override in the writer.
        const state = read();
        state.comments.push({ ...begin, id: 'begin-4' }, { ...stop, id: 'stop-4' },
          c('over-budget', buildOperatorAnswer({ standDownId: 'stop-4', actor: 'chalbert',
            reason: 'Retry again', channel: 'chat', disposition: 'rearm-review', noCodeOwed })));
        write(state);
        return writer(args);
      },
    });
    const first = s.run();
    expect(first.dispatched).toEqual([]);
    expect(writer).toHaveBeenCalledTimes(1);
    const child = writer.mock.results[0].value;
    expect(child.status).toBe(1);
    expect(JSON.parse(child.stdout.trim().split('\n').at(-1))).toMatchObject({ ok: false, reason: expect.stringContaining('no change made') });
    expect(first.refusals).toContainEqual(expect.objectContaining({ kind: 'rearm-no-code-unconfirmed', why: expect.stringContaining('no change made') }));
    expect(read().labels).toEqual(['review:changes']);
    expect(read().writes.filter(kind => kind === 'labels')).toEqual([]);
    const after = read();
    expect(s.run().dispatched).toEqual([]);
    expect(read()).toEqual(after);
    expect(writer).toHaveBeenCalledTimes(1);
    expect(postComment).toHaveBeenCalledTimes(1);
  }, 120000);
  it.each(['deleted', 'stand-down', 'different answer', 'different head', 'untrusted author', 'duplicate id'])(
    'complete guard refuses a %s receipt before excluding it from the live thread', mode => {
      let reads = 0, receipt;
      const s = setup({ postComment: ({ comment }) => { receipt = c(17, comment); },
        readThread: () => {
          reads++;
          if (!receipt) return thread();
          if (reads === 2) return [...thread(), receipt];
          const changed = mode === 'deleted' ? []
            : mode === 'stand-down' ? [{ ...receipt, body: stop.body }]
            : mode === 'different answer' ? [{ ...receipt, body: NO_CODE_REARM_RECEIPT('another-answer', head) }]
            : mode === 'different head' ? [{ ...receipt, body: NO_CODE_REARM_RECEIPT('answer', 'b'.repeat(40)) }]
            : mode === 'untrusted author' ? [{ ...receipt, author: { login: 'outsider' } }]
            : [receipt, { ...receipt }];
          return [...thread(), ...changed];
        } });
      const result = s.run();
      expect(result.dispatched).toEqual([]);
      expect(s.rearm).not.toHaveBeenCalled();
      expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'rearm-no-code-unreadable', why: expect.stringMatching(/receipt.*(missing|changed|ambiguous)/) }));
    });
  it.each(['succeeds', 'refuses'])('only the first entry of an admitted call may overrun; later halves defer when that entry %s', outcome => {
    let time = 0;
    const readPrLabels = vi.fn(() => []), readThread = vi.fn(), closePr = vi.fn(), addLabel = vi.fn();
    const s = setup({ now: () => time, deadlineAt: 10,
      halfCursors: { restore: 'we#51', rearm: 'we#41', close: 'we#61' },
      reconcile: () => { time = 11; return { dispatch: [
        { kind: 'promote-draft', prNumber: 1, headRefOid: head },
        { kind: 'restore-review-label', prNumber: 52 }, entry,
        { kind: 'close-superseded', prNumber: 62 },
      ] }; },
      readHeadCheckState: () => outcome === 'succeeds' ? ALWAYS_GREEN() : { state: 'pending' },
      readPrLabels, readComments: () => [], readThread, closePr, addLabel });
    const result = s.run();
    expect(result).toMatchObject({ handled: 1, deferred: [52, 42, 62],
      nextHalfCursors: { restore: 'we#51', rearm: 'we#41', close: 'we#61' } });
    expect(result.refusals.filter(r => r.kind.endsWith('-deferred-budget')).map(r => [r.pr, r.kind])).toEqual([
      [52, 'restore-review-label-deferred-budget'], [42, 'rearm-no-code-deferred-budget'], [62, 'close-superseded-deferred-budget'],
    ]);
    expect(readPrLabels.mock.calls.map(([args]) => args.prNumber)).toEqual(outcome === 'succeeds' ? [1] : []);
    expect(readThread).not.toHaveBeenCalled(); expect(closePr).not.toHaveBeenCalled(); expect(addLabel).not.toHaveBeenCalled();
    expect(s.postComment).not.toHaveBeenCalled(); expect(s.rearm).not.toHaveBeenCalled();
  });
  it.each(['red-team:blocked', 'red-team:pending', 'changes verdict', 'stand-down'])(
    'post-receipt %s refuses the writer; ruling spent, zero label writes', lateEvidence => {
      const { read, write, writer, postComment } = actualWriterFixture();
      const s = setup({ readThread: () => read().comments, readPrLabels: () => read().labels, rearm: writer,
        postComment: args => {
          postComment(args);
          const state = read();
          if (lateEvidence.startsWith('red-team:')) state.labels.push(lateEvidence);
          else state.comments.push({ ...(lateEvidence === 'changes verdict' ? verdict : stop), id: 'late-evidence' });
          write(state);
        },
      });
      // Option B rechecks evidence after the receipt and leaves a stale ruling spent.
      const result = s.run();
      expect(result.dispatched).toEqual([]);
      expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'rearm-no-code-stale' }));
      expect(read().labels).not.toContain('review:pending');
      expect(read().labels).toContain('review:changes');
      expect(read().labels).not.toContain('review:accepted');
      const after = read();
      expect(s.run().dispatched).toEqual([]);
      expect(read()).toEqual(after);
      expect(after.writes).toEqual(['receipt']);
      expect(writer).not.toHaveBeenCalled();
      expect(postComment).toHaveBeenCalledTimes(1);
    }, 120000);
  it.each(['live', 'unreadable'])('fresh %s fix claim refuses with zero writes', mode => {
    const readClaim = vi.fn(() => { if (mode === 'unreadable') throw Error('store unreadable'); return { meta: { who: 'fixer' } }; });
    const s = setup({ readClaim });
    const result = s.run();
    expect(result.refusals).toContainEqual(expect.objectContaining({ kind: mode === 'live' ? 'rearm-no-code-claimed' : 'rearm-no-code-unreadable' }));
    expect(readClaim).toHaveBeenCalledWith({ repo: 'we', pr: 42 });
    expect(s.postComment).not.toHaveBeenCalled();
    expect(s.rearm).not.toHaveBeenCalled();
  });
  it.each(['fix', 'ci-heal'])('a dispatched %s claim refuses with zero writes', kind => {
    if (!process.env.TMPDIR) throw Error('This fixture requires the task TMPDIR');
    const root = mkdtempSync(join(process.env.TMPDIR, 'rearm-claims-'));
    const previousRoot = process.env.WE_COORDINATION_ROOT;
    process.env.WE_COORDINATION_ROOT = root;
    try {
      const dir = lockDirFor(fixDispatchClaimRoot(), fixDispatchResource({ repo: 'we', pr: 42, kind }));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'lock.json'), JSON.stringify({
        owner: 'dispatched-session', heartbeatAt: new Date().toISOString(),
        meta: { repo: 'we', pr: 42, kind },
      }));
      const s = setup({ readClaim: undefined });
      const result = s.run();
      expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'rearm-no-code-claimed' }));
      expect(result.dispatched).toEqual([]);
      expect(s.postComment).not.toHaveBeenCalled();
      expect(s.rearm).not.toHaveBeenCalled();
    } finally {
      if (previousRoot === undefined) delete process.env.WE_COORDINATION_ROOT;
      else process.env.WE_COORDINATION_ROOT = previousRoot;
      rmSync(root, { recursive: true, force: true });
    }
  });
  it.each(['outsider', 'unknown', 'unreadable', 'missing'])('receipt author %s refuses without spawning or spending the ruling', mode => {
    const posted = [];
    const s = setup({
      postComment: vi.fn(({ comment }) => posted.push({ id: 'new-receipt', body: comment, ...(mode === 'unknown' ? {} : { author: { login: 'outsider' } }) })),
      readThread: vi.fn(() => {
        if (posted.length && mode === 'unreadable') throw Error('readback failed');
        return [...thread(), ...(mode === 'missing' ? [] : posted)];
      }),
    });
    const result = s.run();
    expect(result.dispatched).toEqual([]);
    expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'rearm-no-code-receipt-failed' }));
    expect(s.rearm).not.toHaveBeenCalled();
  });
  it.each(['deadline', 'adoption'])('rearm loop defers remaining entries on %s and counts handled entries', mode => {
    let time = 0, yieldNow = false;
    const s = setup({ now: () => time, deadlineAt: 10, shouldYield: () => yieldNow,
      reconcile: () => ({ dispatch: [entry, { ...entry, prNumber: 43 }], refusals: [] }),
      rearm: vi.fn(() => { time = 11; yieldNow = mode === 'adoption'; return { status: 0, stdout: json(['review:pending']) }; }),
    });
    const result = s.run();
    expect(result).toMatchObject({ handled: 1, deferred: [43] });
    if (mode === 'adoption') expect(result.yieldedForAdoption).toBe(true);
    expect(s.options.rearm).toHaveBeenCalledTimes(1);
  });
  it('past the deadline an admitted call attempts exactly one rearm entry, then names each deferral', () => {
    let time = 0;
    const s = setup({ now: () => time, deadlineAt: 10, reconcile: () => { time = 11; return { dispatch: [entry, { ...entry, prNumber: 43 }, { ...entry, prNumber: 44 }], refusals: [] }; } });
    const result = s.run();
    expect(result).toMatchObject({ handled: 1, deferred: [43, 44], nextHalfCursors: { rearm: 'we#42' } });
    expect(result.refusals.map(r => [r.pr, r.kind])).toEqual([[43, 'rearm-no-code-deferred-budget'], [44, 'rearm-no-code-deferred-budget']]);
    expect(s.postComment).toHaveBeenCalledTimes(1);
    expect(s.rearm).toHaveBeenCalledTimes(1);
  });
  it.each(['review:pending', 'review:human'])('confirms exactly once from observed %s and pins the head', label => {
    const s = setup({ rearm: vi.fn(() => ({ status: 0, stdout: `diagnostic\n${json([label])}\n` })) });
    expect(s.run().dispatched).toEqual([{ pr: 42, kind: 'rearm-no-code', startedAt: expect.any(String), startedSequence: expect.any(Number) }]);
    expect(s.postComment).toHaveBeenCalledTimes(1);
    expect(s.postComment).toHaveBeenCalledWith(expect.objectContaining({ prNumber: 42, comment: NO_CODE_REARM_RECEIPT('answer', head) }));
    expect(s.options.rearm).toHaveBeenCalledTimes(1);
    expect(s.options.rearm).toHaveBeenCalledWith(expect.objectContaining({ prNumber: 42, expectHead: head, answerId: 'answer' }));
  });
  it.each([
    ['empty stdout', { status: 0, stdout: '' }],
    ['malformed JSON', { status: 0, stdout: 'not json' }],
    ['ok only without labelsObserved', { status: 0, stdout: JSON.stringify({ ok: true }) }],
    ['missing labelsObserved', { status: 0, stdout: JSON.stringify({ ok: true, labels: ['review:pending'] }) }],
    ['labels null', { status: 0, stdout: JSON.stringify({ ok: true, labelsObserved: true, labels: null }) }],
    ['changes still present', { status: 0, stdout: json(['review:pending', 'review:changes']) }],
    ['exit 1', { status: 1, stdout: json(['review:pending']) }],
    ['ok false', { status: 0, stdout: JSON.stringify({ ok: false, labelsObserved: true, labels: ['review:pending'] }) }],
    ['non-string labels', { status: 0, stdout: json(['review:pending', {}]) }],
    ['no pending or human', { status: 0, stdout: json([]) }],
  ])('zero confirms for %s', (_, child) => {
    const s = setup({ rearm: () => child });
    const result = s.run();
    expect(result.dispatched).toEqual([]);
    expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'rearm-no-code-unconfirmed' }));
    expect(s.postComment).toHaveBeenCalledTimes(1);
  });
  it.each(['throw', 'over 10 pages', 'count mismatch', 'bad labels'])('unreadable %s gives zero writes', mode => {
    const readThread = (number, opts) => {
      expect(opts).toMatchObject({ maxPages: 10 });
      if (mode === 'throw') throw Error('thread unavailable');
      if (mode === 'bad labels') return thread();
      return readCompletePrComments(number, { ...opts, gh: args => {
        if (args[1] === 'graphql') return { data: { repository: { pullRequest: { comments: { totalCount: 999 } } } } };
        return mode === 'over 10 pages' ? Array.from({ length: 100 }, (_, i) => ({ id: i, user: { login: 'chalbert' }, body: 'filler' })) : thread();
      } });
    };
    const s = setup({ readThread, ...(mode === 'bad labels' ? { readPrLabels: () => null } : {}) });
    expect(s.run().refusals).toContainEqual(expect.objectContaining({ kind: 'rearm-no-code-unreadable' }));
    expect(s.postComment).not.toHaveBeenCalled();
    expect(s.rearm).not.toHaveBeenCalled();
  });
  it.each(['over 10 pages', 'count mismatch'])('default full-thread reader refuses %s with zero writes', async mode => {
    const ghThrottle = await import('../../lib/gh-throttle.mjs');
    const gh = vi.spyOn(ghThrottle, 'runGhSync').mockImplementation(args => JSON.stringify(args[1] === 'graphql'
      ? { data: { repository: { pullRequest: { comments: { totalCount: 999 } } } } }
      : mode === 'over 10 pages' ? Array.from({ length: 100 }, (_, i) => c(`f${i}`, 'filler')) : thread()));
    try {
      const s = setup({ readThread: undefined });
      const result = s.run();
      expect(result.refusals).toContainEqual(expect.objectContaining({ kind: 'rearm-no-code-unreadable', why: expect.stringContaining('operator must inspect') }));
      expect(gh).toHaveBeenCalledTimes(mode === 'over 10 pages' ? 10 : 2);
      expect(gh.mock.calls.every(([args]) => !args.includes('--paginate'))).toBe(true);
      expect(s.postComment).not.toHaveBeenCalled();
      expect(s.rearm).not.toHaveBeenCalled();
    } finally { gh.mockRestore(); }
  });
  it.each(['changed answer', 'red-team hold', 'fix-begin raced', 'invalid answer id'])('fresh %s refuses before receipt', mode => {
    const s = setup({ readThread: () => mode === 'changed answer' ? thread().slice(0, -1) : mode === 'fix-begin raced' ? [...thread(), begin] : mode === 'invalid answer id' ? [...thread().slice(0, -1), { ...answer, id: 'answer\nattack' }] : thread(), readPrLabels: () => mode === 'red-team hold' ? ['review:changes', 'red-team:pending'] : ['review:changes'] });
    expect(s.run().refusals).toContainEqual(expect.objectContaining({ kind: 'rearm-no-code-stale' }));
    expect(s.postComment).not.toHaveBeenCalled();
    expect(s.rearm).not.toHaveBeenCalled();
  });
  it('receipt failure never spawns rearm; child throw leaves ruling spent', () => {
    const s = setup({ postComment: () => { throw Error('post failed'); } });
    expect(s.run().dispatched).toEqual([]);
    expect(s.rearm).not.toHaveBeenCalled();
    const crashed = setup({ rearm: () => { throw Error('child crashed'); } });
    expect(crashed.run().refusals).toContainEqual(expect.objectContaining({ kind: 'rearm-no-code-unconfirmed' }));
    expect(crashed.postComment).toHaveBeenCalledTimes(1);
  });
  it('101st-comment answer executes once over two ticks; tick 3 resumes ordinary review', () => {
    const comments = [...Array.from({ length: 97 }, (_, i) => c(`f${i}`, 'filler')), ...thread()];
    let labels = ['review:changes'];
    const plan = () => planReconcile({ agents: [], requiredChecks: ['gate'], prs: [{ number: 42, state: 'OPEN', headRefName: 'lane/test', headRefOid: head, rowsHead: head, rowsComplete: true, labels, comments, commentsComplete: true, mergeStateStatus: 'CLEAN', statusCheckRollup: ['gate', 'standards', 'test-shard (1)'].map(name => ({ name, status: 'completed', conclusion: 'success' })) }] });
    const s = setup({ reconcile: plan, readThread: (number, opts) => readCompletePrComments(number, { ...opts, gh: args => {
        if (args[1] === 'graphql') return { data: { repository: { pullRequest: { comments: { totalCount: comments.length } } } } };
        const page = Number(/page=(\d+)$/.exec(args[1])[1]);
        return comments.slice((page - 1) * 100, page * 100);
      } }), readPrLabels: () => labels,
      postComment: vi.fn(({ comment }) => { comments.push(c('receipt', comment)); }),
      rearm: vi.fn(() => { labels = ['review:pending']; comments.push(c('rearmed', '🔧 conveyor fix — re-armed for re-review')); return { status: 0, stdout: json(labels) }; }),
    });
    const first = s.run(), second = s.run(), third = plan();
    expect([...first.dispatched, ...second.dispatched].map(d => d.kind)).toEqual(['rearm-no-code']);
    expect(s.options.postComment).toHaveBeenCalledTimes(1);
    expect(s.options.rearm).toHaveBeenCalledTimes(1);
    expect(third.dispatch.length).toBeGreaterThan(0);
    expect(third.dispatch.every(d => d.kind === 'review')).toBe(true);
  });
  it('head-of-list promote failure still runs restore-review-label and rearm-no-code', () => {
    const addLabel = vi.fn();
    const s = setup({ reconcile: () => ({ dispatch: [{ kind: 'promote-draft', prNumber: 1, headRefOid: head }, { kind: 'restore-review-label', prNumber: 2 }, entry] }), readHeadCheckState: () => { throw Error('failed promote'); }, readPrLabels: ({ prNumber }) => prNumber === 42 ? ['review:changes'] : [], addLabel });
    expect(s.run().dispatched.map(d => d.kind)).toEqual(['restore-review-label', 'rearm-no-code']);
    expect(addLabel).toHaveBeenCalledTimes(1);
  });
  it('daemon logs mechanical rearm without launching an agent', async () => {
    const s = setup();
    const launchAgent = vi.fn();
    const fixes = runReconcileFixDispatch({ root: '/repo', checkStaleness: FRESH, reconcile: s.options.reconcile,
      dispatch: launchAgent, pickFreeLanes: () => [], findItemFn: () => null, loadItems: () => [], priorityShadow: null });
    expect(fixes.dispatched).toEqual([]);
    expect(launchAgent).not.toHaveBeenCalled();
    const result = await runPromoteDraftDispatchAllRepos({ repos: ['we'], tick: () => s.run() });
    expect(result.dispatched).toHaveLength(1);
    expect(s.rearm).toHaveBeenCalledTimes(1);
    expect(formatPromoteActionLine({ ...result.dispatched[0], repo: 'we' })).toMatch(/rearm-no-code.*no fix agent/);
  });
  it('default rearm spawns only the head-pinned writer with inert argv and bounded output', () => {
    const spawn = vi.fn(() => ({ status: 0, stdout: json(['review:pending']) }));
    expect(setup({ rearm: args => defaultNoCodeRearm({ ...args, spawn }) }).run().dispatched).toEqual([{ pr: 42, kind: 'rearm-no-code', startedAt: expect.any(String), startedSequence: expect.any(Number) }]);
      expect(spawn).toHaveBeenCalledTimes(1);
      const [file, args, options] = spawn.mock.calls[0];
      expect(file).toBe(process.execPath);
      expect(args[0].endsWith('/scripts/conveyor/rearm-review.mjs')).toBe(true);
      expect(args.slice(1)).toEqual(['42', '--repo=web-everything/web-everything', `--expect-head=${head}`, '--actor=conveyor (operator no-code ruling answer)']);
      expect(options).toMatchObject({ encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
    expect(options.shell).not.toBe(true);
  });
  it('real writer fallback stdout lacks labelsObserved and cannot confirm', () => {
    const chunks = [];
    const exit = vi.spyOn(process, 'exit').mockImplementation(code => { throw Object.assign(Error('exit'), { exitCode: code }); });
    try {
      try { runReviewLabelCli({ argv: ['42', '--repo=o/n'], fixedTo: 'rearm', defaultActor: 'test', usage: 'test', buildComment: () => 'rearm', successResult: o => ({ ok: true, ...o }), refusalResult: ({ decision }) => ({ error: decision.reason }), emit: line => chunks.push(line), provider: { readPrState: () => ({ state: 'OPEN', headRefOid: head, labels: ['review:changes'], comments: [] }), setLabels: () => {}, postComment: () => {}, readLabels: () => { throw Error('readback unavailable'); } } }); } catch (e) { expect(e.exitCode).toBe(0); }
    } finally { exit.mockRestore(); }
    const stdout = chunks.join('');
    expect(JSON.parse(stdout)).toMatchObject({ ok: true, labels: ['review:pending'] });
    expect(JSON.parse(stdout)).not.toHaveProperty('labelsObserved');
    expect(setup({ rearm: () => ({ status: 0, stdout }) }).run().refusals).toContainEqual(expect.objectContaining({ kind: 'rearm-no-code-unconfirmed' }));
  });
  it('no starvation: always-overrunning reconcile, three passes feeding cursors back, attempt order 42, 43, 42', () => {
    let time = 0, halfCursors;
    const attempts = [];
    for (let pass = 0; pass < 3; pass++) {
      const s = setup({ now: () => time, deadlineAt: time + 10, halfCursors,
        reconcile: () => { time += 11; return { dispatch: [entry, { ...entry, prNumber: 43 }] }; },
        acquireRearmLock: ({ prNumber }) => { attempts.push(prNumber); throw Error('busy; inspect lock'); } });
      halfCursors = s.run().nextHalfCursors;
    }
    expect(attempts).toEqual([42, 43, 42]);
  });
  it('each half attempts its first entry after planning overruns and defers every later entry', () => {
    let time = 0;
    const attempts = [];
    const kinds = ['promote-draft', 'restore-review-label', 'rearm-no-code', 'close-superseded'];
    const s = setup({ now: () => time, deadlineAt: 10,
      reconcile: () => {
        time = 11;
        return { dispatch: kinds.flatMap((kind, i) => [1, 2].map(n => ({ ...entry, kind, prNumber: i * 10 + n }))) };
      },
      readHeadCheckState: () => { attempts.push('promote-draft'); throw Error('checks unreadable'); },
      readPrLabels: () => { attempts.push('restore-review-label'); throw Error('labels unreadable'); },
      acquireRearmLock: () => { attempts.push('rearm-no-code'); throw Error('lock busy'); },
      readCardsOnMain: () => { attempts.push('close-superseded'); throw Error('cards unreadable'); },
    });
    const result = s.run();
    expect(attempts).toEqual(kinds);
    expect(result.handled).toBe(4);
    expect(result.dispatched).toEqual([]);
    expect(result.refusals.filter(r => r.kind.endsWith('-deferred-budget'))).toEqual(
      kinds.map((kind, i) => expect.objectContaining({ kind: `${kind}-deferred-budget`, pr: i * 10 + 2,
        why: expect.stringContaining(`passed after 1 ${kind} attempt(s)`) })),
    );
    expect(result.nextCursor).toBe(2);
    expect(result.nextHalfCursors).toEqual({ restore: 'we#11', rearm: 'we#21', close: 'we#31' });
    expect(s.postComment).not.toHaveBeenCalled();
    expect(s.rearm).not.toHaveBeenCalled();
    expect(s.options.provider.ready).not.toHaveBeenCalled();
    expect(s.options.addLabel).not.toHaveBeenCalled();
    expect(s.options.closePr).not.toHaveBeenCalled();
  });
  it('rearm progress is independent of persistent promote deferrals', () => {
    let time = 0, halfCursors, cursor;
    const attempts = [];
    for (let pass = 0; pass < 2; pass++) {
      const s = setup({ now: () => time, deadlineAt: time + 10, halfCursors, cursor,
        reconcile: () => { time += 11; return { dispatch: [1, 2].map(prNumber => ({ kind: 'promote-draft', prNumber, headRefOid: head })).concat(entry, { ...entry, prNumber: 43 }) }; },
        readHeadCheckState: ALWAYS_GREEN, readComments: () => [], clearAwaitingCi: NOOP_STATUS,
        acquireRearmLock: ({ prNumber }) => { attempts.push(prNumber); if (prNumber === 42) throw Error('busy'); return () => {}; } });
      const result = s.run(); halfCursors = result.nextHalfCursors; cursor = result.nextCursor;
      if (pass === 1) expect(result.dispatched).toContainEqual(expect.objectContaining({ pr: 43, kind: 'rearm-no-code' }));
    }
    expect(attempts).toEqual([42, 43]);
  });
  it('adoption arising during the in-lock admission reads is caught before the receipt; zero receipt, zero child, ruling unspent', () => {
    let adoption = false;
    const s = setup({ shouldYield: () => adoption, readPrLabels: () => { adoption = true; return ['review:changes']; } });
    expect(s.run()).toMatchObject({ yieldedForAdoption: true, refusals: [expect.objectContaining({ kind: 'rearm-no-code-deferred-adoption' })] });
    expect(s.postComment).not.toHaveBeenCalled(); expect(s.rearm).not.toHaveBeenCalled();
  });
  it('a fix claim appearing while the receipt posts refuses the writer (rearm-no-code-claimed)', () => {
    let claimed = false;
    const s = setup({ readClaim: () => claimed ? { owner: 'fixer' } : null });
    const post = s.options.postComment;
    s.options.postComment = args => { post(args); claimed = true; };
    expect(s.run().refusals).toContainEqual(expect.objectContaining({ kind: 'rearm-no-code-claimed' }));
    expect(s.postComment).toHaveBeenCalledOnce(); expect(s.rearm).not.toHaveBeenCalled();
  });
  it('a stand-down posted during the pre-receipt label read is seen by the comment read that follows it; no receipt', () => {
    const comments = thread();
    const s = setup({ readThread: () => comments.slice(), readPrLabels: () => { comments.push({ ...stop, id: 'late' }); return ['review:changes']; } });
    expect(s.run().refusals).toContainEqual(expect.objectContaining({ kind: 'rearm-no-code-stale' }));
    expect(s.postComment).not.toHaveBeenCalled();
  });
  it('adoption arising inside the last rearm child is observed before the close half', () => {
    let adoption = false;
    const closePr = vi.fn();
    const s = setup({ shouldYield: () => adoption, closePr, readCardsOnMain: () => [],
      reconcile: () => ({ dispatch: [entry, { kind: 'close-superseded', prNumber: 50 }] }),
      rearm: () => { adoption = true; return { status: 0, stdout: json(['review:pending']) }; } });
    expect(s.run()).toMatchObject({ yieldedForAdoption: true, nextHalfCursors: { close: null }, refusals: [expect.objectContaining({ pr: 50, kind: 'close-superseded-deferred-adoption' })] });
    expect(closePr).not.toHaveBeenCalled();
  });
  it('adoption during the receipt finishes the committed child, then yields', () => {
    let adoption = false;
    const s = setup({ shouldYield: () => adoption }); const post = s.options.postComment;
    s.options.postComment = args => { post(args); adoption = true; };
    expect(s.run()).toMatchObject({ yieldedForAdoption: true, dispatched: [expect.objectContaining({ pr: 42 })] });
    expect(s.rearm).toHaveBeenCalledOnce();
  });
  it.each(['commit', 'complete'])('throwing fresh adoption probes fail closed at %s without stranding a committed entry', point => {
    let posted = false;
    const s = setup({ shouldYield: o => { if (o?.fresh && (point === 'commit' || posted)) throw Error('unreadable adoption'); return false; } });
    const post = s.options.postComment; s.options.postComment = args => { post(args); posted = true; };
    const result = s.run();
    expect(result.yieldedForAdoption).toBe(true);
    expect(s.rearm).toHaveBeenCalledTimes(point === 'commit' ? 0 : 1);
    expect(s.postComment).toHaveBeenCalledTimes(point === 'commit' ? 0 : 1);
    expect(result.yieldReason).toContain('unreadable adoption');
  });
  const halves = [['rearm', 'rearm-no-code'], ['restore', 'restore-review-label'], ['close', 'close-superseded']];
  const boundaries = [
    ['unsorted', null, [44,42,43], true, [42], [43,44], 'we#42'],
    ['unsorted no deadline', null, [44,42,43], false, [42,43,44], [], null],
    ['removed target', 'we#43', [42,44,45], true, [44], [45,42], 'we#44'],
    ['wrap', 'we#45', [42,43,45], true, [42], [43,45], 'we#42'],
    ['exhaustion', 'we#42', [42,43], false, [43,42], [], null],
    ['foreign', 'plateau#42', [42,43], true, [42], [43], 'we#42'],
  ];
  for (const [half, kind] of halves) {
    it.each(boundaries)(`${half} cursor boundary %s`, (_case, incoming, numbers, late, attempted, deferred, next) => {
      let time = 0; const calls = [];
      const s = setup({ now: () => time, deadlineAt: late ? 10 : undefined, halfCursors: { [half]: incoming },
        reconcile: () => { time = 11; return { dispatch: numbers.map(prNumber => ({ ...entry, kind, prNumber })) }; },
        acquireRearmLock: ({ prNumber }) => { calls.push(prNumber); throw Error('lock busy'); },
        readPrLabels: ({ prNumber }) => { calls.push(prNumber); throw Error('labels unavailable'); },
        readCardsOnMain: ({ prNumber }) => { calls.push(prNumber); throw Error('cards unavailable'); } });
      const result = s.run(); expect(calls).toEqual(attempted);
      expect(result.nextHalfCursors[half]).toBe(next);
      expect(result.refusals.filter(r => r.kind === `${kind}-deferred-budget`).map(r => r.pr)).toEqual(deferred);
      if (_case === 'foreign') expect(result.refusals).toContainEqual(expect.objectContaining({ pr: null, kind: 'promote-draft-cursor-reset' }));
    });
    it(`${half} zero-attempt adoption keeps the incoming cursor and names each deferral`, () => {
      let adoption = false;
      const s = setup({ shouldYield: () => adoption, halfCursors: { [half]: 'we#42' },
        reconcile: () => ({ dispatch: [{ kind: 'promote-draft', prNumber: 1, headRefOid: head }, ...[42,43].map(prNumber => ({ ...entry, kind, prNumber }))] }),
        readHeadCheckState: ALWAYS_GREEN, readPrLabels: () => [], readComments: () => [],
        clearAwaitingCi: () => { adoption = true; } });
      const result = s.run(); expect(result.nextHalfCursors[half]).toBe('we#42');
      expect(result.refusals.filter(r => r.kind === `${kind}-deferred-adoption`).map(r => r.pr)).toEqual([43,42]);
    });
  }
  it.each(['promote-draft','restore-review-label','close-superseded'])('%s refuses live, uncertain and throwing claims with zero writes', kind => {
    for (const mode of ['live','uncertain','throw']) {
      const write = vi.fn();
      const s = setup({ reconcile: () => ({ dispatch: [{ kind, prNumber: 1, headRefOid: head }] }),
        readClaim: () => { if (mode === 'throw') throw Error('claim IO'); return mode === 'live' ? { owner: 'fix' } : { uncertain: true }; },
        readHeadCheckState: ALWAYS_GREEN, readPrLabels: () => [], readComments: () => [], readThread: () => [stop, c('close', buildOperatorAnswer({ standDownId: 'stop', actor:'chalbert', channel:'chat', reason:'Close as superseded', disposition:'close-superseded' }))],
        readCardsOnMain: () => [], provider: { ready: write }, addLabel: write, closePr: write });
      const result = s.run(); expect(write).not.toHaveBeenCalled();
      expect(result.refusals).toContainEqual(expect.objectContaining({ kind: `${kind}-${mode === 'live' ? 'claimed' : 'unreadable'}` }));
    }
  });
  it('mixed success-then-yield: first promotion commits; follow-up adoption defers every later half', () => {
    let time = 0, adoption = false; const calls = [];
    const s = setup({ now: () => time++, shouldYield: () => adoption,
      reconcile: () => ({ dispatch: [1,2].map(prNumber => ({ kind:'promote-draft',prNumber,headRefOid:head })).concat({kind:'restore-review-label',prNumber:3},entry,{kind:'close-superseded',prNumber:50}) }),
      readHeadCheckState: ALWAYS_GREEN, readPrLabels: () => [], readComments: () => [],
      provider: { ready: pr => calls.push(pr) }, clearAwaitingCi: () => { adoption = true; }, addLabel: () => calls.push('label'), closePr: () => calls.push('close') });
    const result = s.run(); expect(calls).toEqual([1]); expect(result.dispatched).toHaveLength(1);
    expect(Date.parse(result.dispatched[0].startedAt)).toBeLessThan(Date.parse(result.yieldedAt));
    expect(result.dispatched[0].startedSequence).toBeLessThan(result.yieldedSequence);
    expect(result.refusals.map(r => [r.pr,r.kind])).toEqual([[2,'promote-draft-deferred-adoption'],[3,'restore-review-label-deferred-adoption'],[42,'rearm-no-code-deferred-adoption'],[50,'close-superseded-deferred-adoption']]);
  });
  it('the first promotion re-probes adoption after planning: zero ready writes', () => {
    let adoption = false; const ready = vi.fn();
    const s = setup({ shouldYield: () => adoption, provider: { ready }, readHeadCheckState: ALWAYS_GREEN, readPrLabels: () => [], readComments: () => [],
      reconcile: () => { adoption = true; return { dispatch: [{ kind:'promote-draft',prNumber:1,headRefOid:head }] }; } });
    expect(s.run().refusals).toContainEqual(expect.objectContaining({kind:'promote-draft-deferred-adoption'})); expect(ready).not.toHaveBeenCalled();
  });
  it('a call not admitted runs no reconcile, returns every cursor unchanged, names itself once', () => {
    const reconcile = vi.fn();
    const s = setup({ now: () => 11, deadlineAt: 10, cursor: 2, halfCursors: {rearm:'we#42',restore:'we#43',close:'we#44'}, reconcile });
    const result = s.run(); expect(reconcile).not.toHaveBeenCalled();
    expect(result).toMatchObject({nextCursor:2,nextHalfCursors:{rearm:'we#42',restore:'we#43',close:'we#44'},refusals:[{pr:null,kind:'promote-draft-not-admitted',why:expect.stringMatching(/deadline.*cursor/)}]});
  });

  it.each(['promote-draft','restore-review-label','close-superseded'])('single point: %s writes immediately after its declared fresh evidence and probe', kind => {
    const events=[], closeAnswer=c('close-answer',buildOperatorAnswer({standDownId:'stop',actor:'chalbert',channel:'chat',reason:'Close as superseded',disposition:'close-superseded'}));
    const write=()=>events.push('write');
    const s=setup({reconcile:()=>({dispatch:[{kind,prNumber:1,headRefOid:head}]}),
      shouldYield:o=>{if(o?.fresh) events.push('probe');return false;},
      readHeadCheckState:()=>{events.push('checks');return ALWAYS_GREEN();},
      readPrLabels:()=>{events.push('labels');return [];},readComments:()=>{events.push('comments');return [];},
      readThread:()=>{events.push('comments');return [stop,closeAnswer];},readClaim:()=>{events.push('claim');return null;},
      readCardsOnMain:()=>{events.push('cards');return [];},provider:{ready:write},clearAwaitingCi:NOOP_STATUS,addLabel:write,closePr:write});
    expect(s.run().dispatched).toHaveLength(1);
    expect(events).toEqual(kind==='promote-draft'?['checks','labels','comments','claim','probe','write','probe']:
      kind==='restore-review-label'?['labels','claim','probe','write','probe']:['cards','comments','claim','probe','write','probe']);
  });
  it.each([['restore','restore-review-label'],['close','close-superseded']])('%s adoption after one write names the rest and saves the last-served cursor', (half,kind) => {
    let adoption=false;const write=vi.fn(()=>{adoption=true;});
    const s=setup({halfCursors:{[half]:'we#43'},shouldYield:()=>adoption,reconcile:()=>({dispatch:[42,43].map(prNumber=>({kind,prNumber}))}),
      readPrLabels:()=>[],readCardsOnMain:()=>[],readThread:()=>[stop,c('close',buildOperatorAnswer({standDownId:'stop',actor:'chalbert',channel:'chat',reason:'Close as superseded',disposition:'close-superseded'}))],addLabel:write,closePr:write});
    const result=s.run();expect(write).toHaveBeenCalledTimes(1);expect(result.nextHalfCursors[half]).toBe('we#42');
    expect(result.refusals).toEqual([expect.objectContaining({pr:43,kind:`${kind}-deferred-adoption`})]);
  });
  it.each([['restore','restore-review-label'],['close','close-superseded']])('a head entry failing every pass cannot starve later %s entries', (half,kind) => {
    let time=0, halfCursors;const writes=[];
    for(let pass=0;pass<2;pass++) {
      const write=({prNumber})=>{writes.push(prNumber);if(prNumber===42) throw Error('fixture write failure');};
      const s=setup({now:()=>time,deadlineAt:time+10,halfCursors,reconcile:()=>{time+=11;return {dispatch:[42,43].map(prNumber=>({kind,prNumber}))};},
        readPrLabels:()=>[],readCardsOnMain:()=>[],readThread:()=>[stop,c('close',buildOperatorAnswer({standDownId:'stop',actor:'chalbert',channel:'chat',reason:'Close as superseded',disposition:'close-superseded'}))],addLabel:write,closePr:write});
      halfCursors=s.run().nextHalfCursors;
    }
    expect(writes).toEqual([42,43]);expect(halfCursors[half]).toBe('we#43');
  });
  it('authority-reducing follow-ups finish even if adoption arises in the committed write', () => {
    let adoption=false;const removeLabel=vi.fn();
    const s=setup({shouldYield:()=>adoption,reconcile:()=>({dispatch:[{kind:'restore-review-label',prNumber:1,variant:'stuck'}]}),readPrLabels:()=>['ready-to-merge'],
      addLabel:()=>{adoption=true;},removeLabel});
    expect(s.run().yieldedForAdoption).toBe(true);expect(removeLabel).toHaveBeenCalledOnce();
  });
  it.each(['labels','comments','claim'])('complete-point unreadable %s refuses after receipt with zero child calls', stage => {
    let posted=false; const s=setup();const post=s.options.postComment, read=s.options.readThread;
    s.options.postComment=a=>{post(a);posted=true;};
    s.options.readPrLabels=()=>{if(posted&&stage==='labels') throw Error('labels timed out');return ['review:changes'];};
    s.options.readThread=(...a)=>{if(posted&&stage==='comments'&&s.options.readThread.calls++>0) throw Error('thread timed out');return read(...a);};s.options.readThread.calls=0;
    s.options.readClaim=()=>{if(posted&&stage==='claim') throw Error('claim IO');return null;};
    expect(s.run().refusals).toContainEqual(expect.objectContaining({kind:'rearm-no-code-unreadable'}));expect(s.rearm).not.toHaveBeenCalled();
  });
  it('single point: rearm commit and complete have labels, comments, claim before their writes', () => {
    const events = []; const s = setup({ shouldYield: o => { events.push(o?.fresh ? 'probe' : 'admission'); return false; },
      readPrLabels: () => { events.push('labels'); return ['review:changes']; }, readClaim: () => { events.push('claim'); return null; } });
    const read = s.options.readThread, post = s.options.postComment, child = s.options.rearm;
    s.options.readThread = (...a) => { events.push('comments'); return read(...a); };
    s.options.postComment = a => { events.push('receipt'); post(a); };
    s.options.rearm = a => { events.push('writer'); return child(a); };
    s.run(); expect(events).toEqual(['admission','labels','comments','claim','probe','receipt','comments','labels','comments','claim','writer','probe']);
  });

});


describe('isolated CLI deadline', () => {
  it.each(['1','0','x','-1','1.5','9007199254740992'])('CLI budget flag: %s plans only for a positive safe integer', async value => {
    const mod = await import('../promote-draft-pr-dispatch.mjs');
    const execute = vi.fn(() => ({ok:true}));
    const call = () => mod.runPromoteDraftCli({argv:[`--budget-ms=${value}`,'--prs-file=one.json'],now:()=>100,execute});
    if(value === '1') { expect(call()).toEqual({ok:true}); expect(execute).toHaveBeenCalledWith({repo:null,prsFile:'one.json',deadlineAt:101,now:expect.any(Function)}); }
    else { expect(call).toThrow(/budget-ms/); expect(execute).not.toHaveBeenCalled(); }
  });
  it('CLI budget admission before expiry permits planning overrun; pre-admission expiry plans nothing', async () => {
    const {runPromoteDraftCli} = await import('../promote-draft-pr-dispatch.mjs');
    for(const expiresBeforeAdmission of [false,true]) {
      let time=0; const reconcile=vi.fn(()=>{time=2;return {dispatch:[{kind:'restore-review-label',prNumber:42}]};}); const addLabel=vi.fn();
      const out=runPromoteDraftCli({argv:['--budget-ms=1'],now:()=>time,execute:options=>{
        if(expiresBeforeAdmission) time=2;
        return runReconcilePromoteDraftDispatch({ readClaim: () => null,...options,root:'/repo',checkStaleness:FRESH,reconcile,readPrLabels:()=>[],readClaim:()=>null,addLabel});
      }});
      expect(reconcile).toHaveBeenCalledTimes(expiresBeforeAdmission?0:1); expect(addLabel).toHaveBeenCalledTimes(expiresBeforeAdmission?0:1);
      expect(out.handled).toBe(expiresBeforeAdmission?0:1);
      if(!expiresBeforeAdmission) expect(out.dispatched[0].afterDeadline).toEqual({deadlineAt:new Date(1).toISOString()});
    }
  });
});


it('a guard-yielded entry still calls the fresh post-entry observation and keeps the first latch', () => {
  const shouldYield=vi.fn(o=>o?.fresh===true), ready=vi.fn();
  const result=runReconcilePromoteDraftDispatch({root:'/repo',checkStaleness:FRESH,now:()=>0,shouldYield,
    reconcile:()=>({dispatch:[{kind:'promote-draft',prNumber:42,headRefOid:'a'.repeat(40)}]}),
    readPrLabels:()=>[],readComments:()=>[],readClaim:()=>null,readHeadCheckState:ALWAYS_GREEN,provider:{ready}});
  expect(ready).not.toHaveBeenCalled(); expect(result.yieldedForAdoption).toBe(true);
  expect(shouldYield.mock.calls.filter(([o])=>o?.fresh===true)).toHaveLength(2);
  expect(result.yieldedSequence).toBe(2);
});
