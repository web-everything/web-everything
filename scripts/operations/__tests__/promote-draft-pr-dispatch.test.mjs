/**
 * @file promote-draft-pr-dispatch.test.mjs — draft-first PRs (operator-approved 2026-09-27):
 *   `runReconcilePromoteDraftDispatch`, the mechanical pass that calls `gh pr ready` on every PR
 *   `reconcile-core.mjs` planned `kind:'promote-draft'` for. No process is started and no real `gh` is
 *   shelled — `reconcile` and `provider` are injected, mirroring `ci-heal-pr-dispatch.test.mjs`'s own shape.
 */
import { describe, it, expect, vi } from 'vitest';
import { runReconcilePromoteDraftDispatch, defaultReadHeadCheckState, defaultReadPrLabels, isPromoteCodePath, promoteCodeClosure } from '../promote-draft-pr-dispatch.mjs';

const FRESH = () => ({ fresh: true, behind: 0 });
// Every pre-existing test in this file promotes cleanly, so it pins a fresh re-read that always says green —
// the #2811 race itself (a fresh read that disagrees with the plan) gets its OWN describe block below.
const ALWAYS_GREEN = () => ({ state: 'green', why: 'all required checks succeeded', counts: {} });
const NOOP_STATUS = () => {};

describe('runReconcilePromoteDraftDispatch (draft-first PRs)', () => {
  it('calls provider.ready for every promote-draft entry, and nothing else', async () => {
    const readyCalls = [];
    const result = runReconcilePromoteDraftDispatch({
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
    expect(result.dispatched).toEqual([{ pr: 101, kind: 'promote-draft' }, { pr: 104, kind: 'promote-draft' }]);
    expect(result.refusals).toEqual([]);
  });

  it('an empty plan promotes nothing and refuses nothing', () => {
    const result = runReconcilePromoteDraftDispatch({
      root: '/repo', reconcile: () => ({ dispatch: [], refusals: [] }),
      provider: { ready: () => { throw new Error('must not be called'); } },
      checkStaleness: FRESH, readPrLabels: () => [],
      readHeadCheckState: () => { throw new Error('must not be called'); },
      clearAwaitingCi: NOOP_STATUS,
    });
    expect(result).toEqual({ dispatched: [], refusals: [], reconcileRefusals: 0, reconcileRefusalDetails: [] });
  });

  it('a gh failure on one PR is reported as a refusal and does not stop the rest of the batch', () => {
    const readyCalls = [];
    const result = runReconcilePromoteDraftDispatch({
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
    expect(result.dispatched).toEqual([{ pr: 56, kind: 'promote-draft' }]);
    expect(result.refusals).toEqual([{ pr: 55, kind: 'ready-failed', why: 'gh pr ready failed: HTTP 502' }]);
  });

  it('carries the reconcile pass\'s own refusal count through, unmodified', () => {
    const result = runReconcilePromoteDraftDispatch({
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
    expect(() => runReconcilePromoteDraftDispatch({
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
    runReconcilePromoteDraftDispatch({
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
    const result = runReconcilePromoteDraftDispatch({
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
    const result = runReconcilePromoteDraftDispatch({
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
    const result = runReconcilePromoteDraftDispatch({
      root: '/repo',
      reconcile: () => ({ dispatch: [{ kind: 'promote-draft', prNumber: 2813, headRefOid: HEAD }], refusals: [] }),
      provider: { ready: (pr) => { readyCalls.push(pr); } },
      checkStaleness: FRESH, readPrLabels: () => [],
      readHeadCheckState: () => ({ state: 'green', why: 'all required checks succeeded', counts: {} }),
      clearAwaitingCi: NOOP_STATUS,
    });
    expect(readyCalls).toEqual([2813]);
    expect(result.dispatched).toEqual([{ pr: 2813, kind: 'promote-draft' }]);
    expect(result.refusals).toEqual([]);
  });

  it('a re-read that cannot be performed at all refuses rather than promoting on the stale plan alone', () => {
    const result = runReconcilePromoteDraftDispatch({
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
    const result = runReconcilePromoteDraftDispatch({
      root: '/repo',
      reconcile: () => ({ dispatch: [{ kind: 'promote-draft', prNumber: 2821, headRefOid: HEAD }], refusals: [] }),
      provider: { ready: () => {} },
      checkStaleness: FRESH, readPrLabels: () => [],
      readHeadCheckState: () => ({ state: 'green', why: 'ok', counts: {} }),
      clearAwaitingCi: (o) => statusCalls.push(o),
    });
    expect(result.dispatched).toEqual([{ pr: 2821, kind: 'promote-draft' }]);
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
      const result = runReconcilePromoteDraftDispatch({
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
        const result = runReconcilePromoteDraftDispatch({
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
        expect(result.dispatched).toEqual([{ pr: 187, kind: 'promote-draft' }]);
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
        runReconcilePromoteDraftDispatch({
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
    const result = runReconcilePromoteDraftDispatch({
      root: '/repo',
      reconcile: () => ({ dispatch: [{ kind: 'promote-draft', prNumber: 2822, headRefOid: HEAD }], refusals: [] }),
      provider: { ready: () => {} },
      checkStaleness: FRESH, readPrLabels: () => [],
      readHeadCheckState: () => ({ state: 'green', why: 'ok', counts: {} }),
      clearAwaitingCi: () => { throw new Error('gh hiccup'); },
    });
    expect(result.dispatched).toEqual([{ pr: 2822, kind: 'promote-draft' }]);
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
  const result = runReconcilePromoteDraftDispatch({ root: '/repo', checkStaleness: FRESH, readPrLabels: () => [],
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
    const result = runReconcilePromoteDraftDispatch({
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
  it('an unreadable closure fails closed: every code file counts', () => {
    expect(isPromoteCodePath('scripts/operations/cli-adapter.mjs', { closure: null })).toBe(true);
    expect(isPromoteCodePath('backlog/123-x.md', { closure: null })).toBe(false);
  });
});

describe('runReconcilePromoteDraftDispatch — a draft that is not promoted says why (#3806 incident)', () => {
  it('reports every non-green draft the plan refused, naming its check state; green and withdrawn are not double-reported', () => {
    const result = runReconcilePromoteDraftDispatch({
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
    const r = runReconcilePromoteDraftDispatch({ ...base, reconcile: () => plan, readPrLabels: () => [], addLabel: (a) => calls.push(a) });
    expect(calls).toEqual([expect.objectContaining({ prNumber: 3830, label: 'review:pending' })]);
    expect(r.dispatched).toEqual([{ pr: 3830, kind: 'restore-review-label', label: 'review:pending' }]);
  });
  it('re-reads labels and refuses when a review/landing label appeared since the plan', () => {
    const r = runReconcilePromoteDraftDispatch({ ...base, reconcile: () => plan, readPrLabels: () => [{ name: 'ready-to-merge' }], addLabel: () => { throw new Error('must not write'); } });
    expect(r.dispatched).toEqual([]);
    expect(r.refusals).toEqual([expect.objectContaining({ pr: 3830, kind: 'label-already-set' })]);
  });
  it('a failed write is a refusal, never a throw', () => {
    const r = runReconcilePromoteDraftDispatch({ ...base, reconcile: () => plan, readPrLabels: () => [], addLabel: () => { throw new Error('boom'); } });
    expect(r.refusals).toEqual([expect.objectContaining({ kind: 'label-failed' })]);
  });
});
