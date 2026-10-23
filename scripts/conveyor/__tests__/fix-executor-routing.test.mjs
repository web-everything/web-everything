import { describe, it, expect, vi } from 'vitest';
import { resolveFixExecutorSetting, chooseFixExecutor, formatFixExecutorLog } from '../../lib/fix-slot-borrow.mjs';
import { fixDetachedProvider, fixLauncherAvailable } from '../../operations/dispatch-providers/fix.mjs';
import { dispatchFix, roundEscalationFor, routeFixExecutor } from '../reconcile-fix-dispatch.mjs';

const setting = { value: 'codex-first', source: 'default' };
describe('fix.executor cascade', () => {
  it.each([
    [{}, setting],
    [{ platform: { fix: { executor: 'claude' } } }, { value: 'claude', source: 'platform' }],
    [{ platform: { fix: { executor: 'claude' } }, repo: { fix: { executor: 'provider-routing' } } }, { value: 'provider-routing', source: 'repo' }],
    [{ repo: { fix: { executor: 'claude' } }, env: { WE_FIX_EXECUTOR: 'codex-first' } }, { value: 'codex-first', source: 'env' }],
    [{ repo: { fix: { executor: 'claude' } }, env: { WE_FIX_EXECUTOR: 'invalid' } }, { value: 'claude', source: 'repo' }],
    [{ platform: { fix: { executor: 'invalid' } }, repo: { fix: { executor: 'invalid' } } }, setting],
  ])('resolves %j', (inputs, expected) => {
    expect(resolveFixExecutorSetting({ env: {}, platform: {}, repo: {}, ...inputs })).toEqual(expected);
  });
});
describe('fix executor decision', () => {
  it.each([
    [{ round: 1 }, 'codex'], [{ round: 1, kind: 'ci-heal' }, 'codex'],
    [{ takeover: true }, 'claude'], [{ round: 3 }, 'claude'],
    [{ strongerModel: true }, 'claude'], [{ mainFix: true }, 'claude'],
    [{ launcherAvailable: false }, 'claude'],
    [{ setting: { value: 'claude', source: 'env' } }, 'claude'],
    [{ setting: { value: 'provider-routing', source: 'repo' } }, 'claude'],
  ])('routes %j to %s', (input, executor) => {
    expect(chooseFixExecutor({ setting, launcherAvailable: true, ...input }).executor).toBe(executor);
  });
  // Review finding (PR #4897 round 2, reconcile-fix-dispatch.mjs:1364): every source `launchTableFor` can pick a
  // stronger Claude model from must route to Claude. Codex ignores the ladder table, so the rung would be logged but
  // never applied. Walks the real planned-entry shapes through the real `roundEscalationFor` -> `chooseFixExecutor`
  // composition both call sites (`dispatchFix` and the daemon's `fixExecutorRoute`) use.
  describe('every launch-table source routes to Claude', () => {
    const claudeRoute = { provider: 'claude', model: 'opus', effort: 'high' };
    const rung = { id: 'opus-high', at: 1 };
    const fixSettings = { strongerModelFromRound: 3 };
    const loadLadder = () => ({ rungs: [{ id: 'opus-high', from: 3, provider: 'claude', model: 'opus', effort: 'high' }] });
    const routeAsCallSitesDo = (planned) => chooseFixExecutor({
      setting, launcherAvailable: true, ...planned, round: planned.round ?? 1,
      strongerModel: !!roundEscalationFor(planned, { fixSettings, loadLadder }),
    });
    it.each([
      ['ruling-not-addressed send-back with a rung (round 1)', { rulingNotAddressed: { rung, route: claudeRoute, matches: [1] } }],
      ['ruling-not-addressed send-back with a rung (round 2)', { round: 2, rulingNotAddressed: { rung, route: claudeRoute } }],
      ['ruling-not-addressed send-back whose rung routes to codex (dispatch only wires claude)', { rulingNotAddressed: { rung, route: { provider: 'codex' } } }],
      ['ruling-not-addressed send-back with no routed rung', { rulingNotAddressed: { matches: [1], route: null } }],
      ['takeover', { takeover: { rung, route: claudeRoute, attempts: 5, cap: 5 } }],
      ['round-escalation rung (round 3)', { round: 3 }],
    ])('%s', (_name, planned) => {
      expect(routeAsCallSitesDo(planned).executor).toBe('claude');
    });
    it('still sends an ordinary round 1 and round 2 repair to codex', () => {
      expect(routeAsCallSitesDo({ round: 1 }).executor).toBe('codex');
      expect(routeAsCallSitesDo({ round: 2 }).executor).toBe('codex');
    });
    it('dispatchFix launches a ruling-not-addressed send-back on Claude with the ladder model, never the codex launcher', () => {
      const spawnBorrowed = vi.fn(() => 'pid:1');
      const spawnAgent = vi.fn(() => 'backgrounded · 2be0905c · fix-42\n');
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        dispatchFix({ pr: 42, itemNum: '42', lane: 2, laneRef: 'lane/42-x', scope: ['we:scripts/x.mjs'],
          rulingNotAddressed: { rung, route: claudeRoute,
            matches: [{ finding: { file: 'scripts/x.mjs', line: 1, summary: 's' }, ruling: 'block', misses: 1 }] } }, {
          root: '/repo', readBrief: () => '{{PR_NUM}} {{LANE_REF}} {{LANE}} {{SCOPE}} {{SESSION_SLUG}}',
          readFixClaim: () => null, acquireClaim: () => ({ ok: true }), stampExecutor: vi.fn(), stampRunner: vi.fn(),
          postNotice: vi.fn(), fixExecutorRoute: (planned) => chooseFixExecutor({ setting, launcherAvailable: true, ...planned }),
          writeBorrowedPrompt: () => '/tmp/fix-42.md', spawnBorrowed, spawnAgent,
        });
        expect(spawnBorrowed).not.toHaveBeenCalled();
        expect(spawnAgent).toHaveBeenCalledTimes(1);
        expect(spawnAgent.mock.calls[0][0]).toEqual(expect.arrayContaining(['--model']));
        expect(spawnAgent.mock.calls[0][0].join(' ')).toContain('sonnet');
      } finally { log.mockRestore(); }
    });
  });
  it('explains fallback and formats the exact log line', () => {
    expect(chooseFixExecutor({ setting, launcherAvailable: false }).reason).toMatch(/unavailable.*fallback/);
    expect(formatFixExecutorLog({ executor: 'codex', reason: 'ordinary fix', source: 'default' }))
      .toBe('fix executor: codex (ordinary fix, source default)');
  });
  it('launches a routed fix through the existing non-Claude provider without borrowing', () => {
    const spawnBorrowed = vi.fn(() => 'pid:123');
    const acquireClaim = vi.fn(() => ({ ok: true }));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      dispatchFix({ pr: 42, itemNum: '42', lane: 2, laneRef: 'lane/42-x', scope: ['we:scripts/x.mjs'] }, {
        root: '/repo', readBrief: () => '{{PR_NUM}} {{LANE_REF}} {{LANE}} {{SCOPE}} {{SESSION_SLUG}}',
        readFixClaim: () => null, acquireClaim, stampExecutor: vi.fn(), stampRunner: vi.fn(),
        fixExecutorRoute: () => chooseFixExecutor({ setting, launcherAvailable: true }),
        writeBorrowedPrompt: () => '/tmp/fix-42.md', spawnBorrowed,
        spawnAgent: () => { throw new Error('unexpected Claude launch'); },
      });
      expect(spawnBorrowed).toHaveBeenCalledWith(expect.objectContaining({ policyRoute: { provider: 'codex' } }));
      expect(acquireClaim.mock.calls[0][0].borrowed).toBeUndefined();
      expect(log.mock.calls.filter(([line]) => line.includes('fix executor:'))).toHaveLength(1);
    } finally { log.mockRestore(); }
  });
});

describe('routed CI-heal and claim accounting', () => {
  it.each(['codex-first', 'claude'])('keeps the CI-heal brief and claim with %s', async (value) => {
    const { createRoutedCiHealDispatch } = await import('../../lib/fix-slot-borrow.mjs');
    const { dispatchCiHeal } = await import('../../operations/ci-heal-pr-dispatch.mjs');
    const { DISPATCH_EFFECT } = await import('../../operations/dispatch-lane.mjs');
    const launchCodex = vi.fn(() => 'pid:123');
    const defaultProvider = vi.fn(() => 'claude-session'); // the sink's own provider; a Claude outcome must not replace it
    const stampExecutor = vi.fn();
    const stampRunner = vi.fn();
    const writePrompt = vi.fn(() => '/tmp/ci-heal.md');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const run = createRoutedCiHealDispatch({
      dispatch: dispatchCiHeal,
      route: () => chooseFixExecutor({ setting: { value, source: 'env' }, launcherAvailable: true }),
      createSinks: ({ provider = defaultProvider }) => ({ [DISPATCH_EFFECT]: async (payload) => {
        let runnerPid;
        const handle = await provider({ ...payload, reportWrapped: (pid) => { runnerPid = pid; } });
        return { handle, dispatch: { wrapped: !!runnerPid, runnerPid } };
      } }),
      launchCodex, writePrompt, removePrompt: vi.fn(), stampExecutor,
      profileFor: () => ({ slug: 'web-everything/web-everything', lanePoolRepo: '/repo' }),
    });
    try {
      const result = await run({ pr: 42, itemNum: '42', lane: 2, laneRef: 'lane/42-x', scope: ['we:scripts/x.mjs'] }, {
        root: '/repo', repo: 'we', readBrief: () => 'CI-heal {{PR_NUM}}: {{REASON}} {{LANE_REF}}',
        pollAttempts: () => [], readFixClaim: () => null, acquireClaim: () => ({ ok: true }),
        claimOwner: 'test-owner', stampRunner,
      });
      expect(result.pr).toBe(42);
      if (value === 'codex-first') {
        expect(defaultProvider).not.toHaveBeenCalled();
        expect(launchCodex).toHaveBeenCalledWith(expect.objectContaining({
          policyRoute: { provider: 'codex' }, ref: 'lane/42-x', claimRepo: 'we', promptFile: '/tmp/ci-heal.md',
        }));
        expect(writePrompt).toHaveBeenCalledWith('ci-heal-42', expect.stringContaining('CI-heal 42: red-ci lane/42-x'));
        expect(stampExecutor).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ci-heal', owner: 'test-owner' }));
        expect(stampRunner).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ci-heal', pid: 123 }));
      } else {
        expect(launchCodex).not.toHaveBeenCalled();
        expect(defaultProvider).toHaveBeenCalledTimes(1);
      }
      expect(log.mock.calls.filter(([line]) => line.includes('fix executor:'))).toHaveLength(1);
    } finally { log.mockRestore(); }
  });

  // Review finding (PR #4897, fix-slot-borrow.mjs:96): a Claude decision must keep the sink's default provider
  // (`routeDispatchProvider` → injected `spawnAgent`) AND the heal router (`routeAvailableCiHeal`), exactly like the
  // pre-change path. Real `createDispatchSinks` and real `routeAvailableCiHeal`; only fs/process seams are stubbed.
  describe.each([
    ['fix.executor=claude', { value: 'claude', source: 'env' }, {}],
    ['provider-routing', { value: 'provider-routing', source: 'env' }, {}],
    ['codex launcher unavailable', { value: 'codex-first', source: 'env' }, { launcherAvailable: false }],
    ['takeover round', { value: 'codex-first', source: 'env' }, { takeover: true }],
    ['stronger-model round', { value: 'codex-first', source: 'env' }, { strongerModel: true }],
  ])('a Claude CI-heal decision (%s) keeps default provider and heal routing', (_name, setting, extra) => {
    const NOW = Date.parse('2026-10-11T12:00:00Z');
    const held = (provider) => ({ provider, status: 'quota-exhausted', scoredAt: new Date(NOW - 60_000).toISOString(),
      quotaResetsAt: new Date(NOW + 3_600_000).toISOString() });
    // Codex and the Antigravity seats are held too, so the router has no probation worker to fall back on and the
    // native Claude hold refuses.
    const claudeHold = [held('claude'), held('codex')];
    const agyHold = { quotaResetsAt: new Date(NOW + 3_600_000).toISOString(), fallbackDecision: 'skip-quota-hold' };
    const harness = async ({ scores, agy = null }) => {
      const { createRoutedCiHealDispatch } = await import('../../lib/fix-slot-borrow.mjs');
      const { dispatchCiHeal, routeAvailableCiHeal } = await import('../../operations/ci-heal-pr-dispatch.mjs');
      const { createDispatchSinks } = await import('../../operations/dispatch-lane-io.mjs');
      const spawnAgent = vi.fn(() => 'backgrounded · 2be0905c · ci-heal-42\n');
      const launchCodex = vi.fn(() => 'pid:1');
      const routeHeal = vi.fn((p) => routeAvailableCiHeal(p, { readHolds: () => agy, readScores: () => scores, now: NOW }));
      const run = createRoutedCiHealDispatch({
        dispatch: dispatchCiHeal,
        route: () => chooseFixExecutor({ setting, launcherAvailable: true, ...extra }),
        createSinks: (o) => createDispatchSinks({ ...o, modes: {}, mintSessionId: () => 'sid', sessionCwdFor: () => '/scratch',
          ensureSessionCwd: (d) => d, grantLanePermission: () => {}, resolveSettingsEnv: () => null,
          ensureWorktreeIsolation: () => {}, reserveLane: () => ({ reserved: false }), spawnAgent }),
        launchCodex, writePrompt: vi.fn(), removePrompt: vi.fn(), stampExecutor: vi.fn(),
        profileFor: () => ({ slug: 'web-everything/web-everything', lanePoolRepo: '/repo' }),
      });
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const result = await run({ pr: 42, itemNum: '42', lane: 2, laneRef: 'lane/42-x', scope: ['we:scripts/x.mjs'] }, {
        root: '/repo', repo: 'we', readBrief: () => 'CI-heal {{PR_NUM}}', pollAttempts: () => [], readFixClaim: () => null,
        acquireClaim: () => ({ ok: true }), releaseClaim: () => {}, claimOwner: 'test-owner', stampRunner: vi.fn(), routeHeal,
      }).finally(() => log.mockRestore());
      return { result, spawnAgent, launchCodex, routeHeal, log };
    };

    it('still returns the quota-held refusal and spawns nothing', async () => {
      const { result, spawnAgent, launchCodex, routeHeal } = await harness({ scores: claudeHold, agy: agyHold });
      expect(routeHeal).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ held: true, reason: 'native Claude quota held; no eligible CI-heal route' });
      expect(spawnAgent).not.toHaveBeenCalled();
      expect(launchCodex).not.toHaveBeenCalled();
    });

    it('launches through the sink default provider (injected spawnAgent) after consulting the heal router', async () => {
      const { result, spawnAgent, launchCodex, routeHeal } = await harness({ scores: [] });
      expect(routeHeal).toHaveBeenCalledTimes(1);
      expect(spawnAgent).toHaveBeenCalledTimes(1);
      expect(launchCodex).not.toHaveBeenCalled();
      expect(result.pr).toBe(42);
    });
  });

  it('records executor metadata without borrowing or writing borrow outcomes', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { acquireFixDispatchClaim, readFixDispatchClaim } = await import('../fix-dispatch-claim.mjs');
    const { stampFixExecutor, recordBorrowOutcome } = await import('../../lib/fix-slot-borrow.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'fix-executor-'));
    vi.stubEnv('WE_COORDINATION_ROOT', dir);
    try {
      const id = { repo: 'we', pr: 42, owner: 'routing-test' };
      expect(acquireFixDispatchClaim(id).ok).toBe(true);
      expect(stampFixExecutor({ ...id, decision: chooseFixExecutor({ setting, launcherAvailable: true }) })).toBeTruthy();
      const claim = readFixDispatchClaim(id);
      expect(claim.meta.borrowed).toBeUndefined();
      expect(claim.meta.fixExecutor).toEqual({ executor: 'codex', reason: 'codex-first ordinary repair' });
      const store = { read: vi.fn(() => ({})), write: vi.fn() };
      recordBorrowOutcome({ ...id, outcome: 'no-change', store });
      expect(store.read).not.toHaveBeenCalled();
      expect(store.write).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
  });
});

it('loads the routing helper in native Node without an import cycle failure', async () => {
  const { spawnSync } = await import('node:child_process');
  const { pathToFileURL } = await import('node:url');
  const { resolve } = await import('node:path');
  const moduleUrl = pathToFileURL(resolve('scripts/lib/fix-slot-borrow.mjs')).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const m = await import(${JSON.stringify(moduleUrl)}); console.log(m.resolveFixExecutorSetting({env:{},platform:{},repo:{}}).value);`],
  { encoding: 'utf8', timeout: 10000 });
  expect(child.status, child.stderr).toBe(0);
  expect(child.stdout.trim()).toBe('codex-first');
});

it('routes an admitted second round to Codex before attempting a Claude resume', async () => {
  const { runReconcileFixDispatch } = await import('../reconcile-fix-dispatch.mjs');
  const resume = vi.fn(() => { throw new Error('unexpected Claude resume'); });
  const consider = vi.fn();
  const launch = vi.fn(() => 'pid:123');
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const result = runReconcileFixDispatch({
      root: '/repo', repo: 'we', checkStaleness: () => ({ fresh: true, behind: 0 }),
      reconcile: () => ({ dispatch: [{ kind: 'fix', prNumber: 42, headRefName: 'lane/42-x', attempts: 1,
        files: ['scripts/x.mjs'] }], refusals: [], notes: [] }),
      findItemFn: () => ({ num: '42', scope: ['we:scripts/x.mjs'], specPath: 'backlog/42-x.md' }),
      loadItems: () => [], pickFreeLanes: () => [2], listBuildClaims: () => [], listFixClaims: () => [],
      dispatchThrottle: { tryAdmit: () => ({ admit: true }) }, borrowGate: { consider, clear: vi.fn() },
      tryResumeRound: resume,
      fixExecutorRoute: (planned) => chooseFixExecutor({ ...planned, setting, launcherAvailable: true }),
      dispatch: (planned, options) => dispatchFix(planned, { ...options,
        readBrief: () => 'Fix {{PR_NUM}}', readFixClaim: () => null, acquireClaim: () => ({ ok: true }),
        stampExecutor: vi.fn(), stampRunner: vi.fn(), writeBorrowedPrompt: () => '/tmp/fix-42.md',
        spawnBorrowed: launch,
      }),
    });
    expect(result.dispatched).toHaveLength(1);
    expect(result.dispatched[0].borrowed).toBeUndefined();
    expect(consider).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ policyRoute: { provider: 'codex' } }));
  } finally { log.mockRestore(); }
});

// Review self-check (PR #4897 round 2): the borrow gate is a SECOND executor chooser. A table-bearing entry (ruling
// send-back, takeover, round escalation) must never borrow a non-Claude slot, because that launcher ignores the table.
describe('borrowing a builder slot keeps table-bearing entries on Claude', () => {
  const rung = { id: 'opus-high', at: 1 };
  const claudeRoute = { provider: 'claude', model: 'opus', effort: 'high' };
  // A ladder whose `stronger-model` rung is launchable on Claude, so `roundEscalationFor` names a rung from round `fromRound`.
  const ladder = () => ({ policy: { rungs: [{ id: 'stronger-model', action: 'dispatch', taskType: 'fix-strong' }] },
    routes: { 'stronger-model': { provider: 'claude', model: 'opus' } } });
  const run = async (extra, executor, { fixSettings = { strongerModelFromRound: 3 } } = {}) => {
    const { runReconcileFixDispatch } = await import('../reconcile-fix-dispatch.mjs');
    const dispatch = vi.fn(() => ({ pr: 42 }));
    const borrowGate = { consider: vi.fn(() => ({ borrow: true, executor, waitedMinutes: 30 })), clear: vi.fn() };
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = runReconcileFixDispatch({
        root: '/repo', repo: 'we', checkStaleness: () => ({ fresh: true, behind: 0 }), fixSettings, loadLadder: ladder,
        reconcile: () => ({ dispatch: [{ kind: 'fix', prNumber: 42, headRefName: 'lane/42-x', attempts: 1, files: ['scripts/x.mjs'], ...extra }],
          refusals: [], notes: [] }),
        findItemFn: () => ({ num: '42', scope: ['we:scripts/x.mjs'], specPath: 'backlog/42-x.md' }),
        loadItems: () => [], pickFreeLanes: () => [2], listBuildClaims: () => [], listFixClaims: () => [],
        dispatchThrottle: { tryAdmit: () => ({ admit: false, kind: 'fix-cap', why: 'fixer cap full' }) },
        borrowGate,
        tryResume: () => ({ resumed: false }), tryResumeRound: () => ({ resumed: false }), dispatch,
      });
      return { result, dispatch, borrowGate };
    } finally { log.mockRestore(); }
  };
  it.each([
    ['ruling-not-addressed send-back', { rulingNotAddressed: { rung, route: claudeRoute, matches: [] } }],
    ['takeover', { takeover: { rung, route: claudeRoute, attempts: 5, cap: 5 } }],
    // Review finding (PR #4897 round 3, codex-correctness): the guard must cover every Claude-only input
    // `chooseFixExecutor` has, so a borrowed slot never bypasses the router.
    ['ordinary round-3 escalation', { attempts: 2 }],
    ['round-3 repair with no stronger-model rung configured', { attempts: 2 }, { fixSettings: { strongerModelFromRound: 0 } }],
    ['round-2 repair on a stronger-model rung (fix.strongerModelFromRound=2)', { attempts: 1 }, { fixSettings: { strongerModelFromRound: 2 } }],
  ])('refuses a codex borrow for a %s and keeps waiting', async (_name, extra, opts) => {
    const { result, dispatch } = await run(extra, 'codex', opts);
    expect(dispatch).not.toHaveBeenCalled();
    expect(result.dispatched).toHaveLength(0);
    expect(result.refusals).toEqual([expect.objectContaining({ pr: 42, kind: 'fix-cap', why: expect.stringContaining("Claude") })]);
  });
  it('dispatches a red-main fix past the full fixer cap by default without borrowing, preserving its Claude route', async () => {
    const previous = process.env.WE_MAIN_FIX_PAST_FIX_CAP;
    delete process.env.WE_MAIN_FIX_PAST_FIX_CAP;
    try {
      const { result, dispatch, borrowGate } = await run({ mainFix: true }, 'codex');
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch.mock.calls[0][0]).toEqual(expect.objectContaining({ mainFix: true }));
      expect(result.dispatched).toHaveLength(1);
      expect(result.dispatched[0].borrowed).toBeUndefined();
      expect(borrowGate.consider).not.toHaveBeenCalled();
      expect(result.refusals).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.WE_MAIN_FIX_PAST_FIX_CAP;
      else process.env.WE_MAIN_FIX_PAST_FIX_CAP = previous;
    }
  });
  it('keeps a red-main fix waiting for Claude under a full fixer cap when passing the cap is off', async () => {
    const previous = process.env.WE_MAIN_FIX_PAST_FIX_CAP;
    process.env.WE_MAIN_FIX_PAST_FIX_CAP = 'off';
    try {
      const { result, dispatch } = await run({ mainFix: true }, 'codex');
      expect(dispatch).not.toHaveBeenCalled();
      expect(result.dispatched).toHaveLength(0);
      expect(result.refusals).toEqual([expect.objectContaining({ pr: 42, kind: 'fix-cap', why: expect.stringContaining("Claude") })]);
    } finally {
      if (previous === undefined) delete process.env.WE_MAIN_FIX_PAST_FIX_CAP;
      else process.env.WE_MAIN_FIX_PAST_FIX_CAP = previous;
    }
  });
  it('still lets a table-bearing entry borrow a Claude-class slot, and an ordinary one borrow codex', async () => {
    const claude = await run({ rulingNotAddressed: { rung, route: claudeRoute, matches: [] } }, 'claude');
    expect(claude.dispatch).toHaveBeenCalledTimes(1);
    const ordinary = await run({}, 'codex');
    expect(ordinary.dispatch).toHaveBeenCalledTimes(1);
  });
});

// Review finding (PR #4897 round 3, correctness): the red-main fix PR must reach the router with `mainFix` set by the
// REAL planner, not a hand-set flag. Runs `planReconcile` -> (`planFixesFromReconcile` for a fix row) -> the SAME
// `routeFixExecutor` the fix-dispatch daemon's `fixExecutorRoute` calls, under the default `codex-first` setting.
describe('a red-main fix PR stays on Claude through the real planner', () => {
  const NOW = Date.parse('2026-09-25T02:00:00Z');
  const priority = (pr) => ({ repo: 'we', pr, firstRedSha: '7c731a95e', setAt: NOW, expiresAt: NOW + 30 * 60_000 });
  const fixPr = (over = {}) => ({
    number: 4522, state: 'OPEN', headRefName: 'lane/fix-red-main', headRefOid: 'aa11bb22cc33dd44ee55ff6677889900aabbccdd',
    labels: [{ name: 'review:changes' }], mergeStateStatus: 'CLEAN', files: ['scripts/x.mjs'],
    statusCheckRollup: [{ name: 'gate', status: 'completed', conclusion: 'success' }],
    comments: [{ body: '🔁 human review — changes requested\n\nfix the thing' }], ...over,
  });
  const route = async (entry) => {
    const { routeFixExecutor } = await import('../reconcile-fix-dispatch.mjs');
    return routeFixExecutor(entry, { setting, fixSettings: { strongerModelFromRound: 3 }, loadLadder: () => null, launcherAvailable: true });
  };
  const plan = async (prs, mainRedPriority) => {
    const { planReconcile } = await import('../reconcile-core.mjs');
    return planReconcile({ requiredChecks: ['gate'], prs, agents: [], now: NOW, ...(mainRedPriority ? { mainRedPriority } : {}) });
  };
  it('a review-changes fix row of the red-main owner routes to Claude; the same PR without the record routes to codex', async () => {
    const { planFixesFromReconcile } = await import('../reconcile-fix-dispatch.mjs');
    const planned = async (rec) => {
      const { dispatch } = await plan([fixPr()], rec);
      expect(dispatch).toEqual([expect.objectContaining({ kind: 'fix', prNumber: 4522 })]);
      const out = planFixesFromReconcile(dispatch, () => null, () => []);
      expect(out.planned).toHaveLength(1);
      return out.planned[0];
    };
    expect(await route(await planned(priority(4522)))).toMatchObject({ executor: 'claude', reason: 'main-fix' });
    expect((await route(await planned(null))).executor).toBe('codex');
  });
  it('a ci-heal row of the red-main owner routes to Claude', async () => {
    const red = fixPr({ labels: [], comments: [], statusCheckRollup: [{ name: 'gate', status: 'completed', conclusion: 'failure' }] });
    const { dispatch } = await plan([red], priority(4522));
    const heal = dispatch.find((d) => d.kind === 'ci-heal' && d.prNumber === 4522);
    expect(heal).toBeTruthy();
    expect(await route(heal)).toMatchObject({ executor: 'claude', reason: 'main-fix' });
  });
});

// Self-review (PR #4897 round 3): an idle restack row is read from `gh pr view`, never from the planner, so the
// dispatcher must stamp `mainFix` on it too; otherwise the red-main fix PR's restack routes codex-first.
describe('an idle restack of the red-main fix PR stays on Claude', () => {
  it('routes the restack through the router with mainFix set from the priority record', async () => {
    const { runReconcileFixDispatch, routeFixExecutor } = await import('../reconcile-fix-dispatch.mjs');
    const { detectStacks, PR_STACK_DEFAULTS } = await import('../pr-stack.mjs');
    const bottom = { pr: 4624, headRefName: 'lane/red-main-contain', headRefOid: 'a'.repeat(40) };
    const top = { pr: 4631, headRefName: 'lane/accept-carry-forward', headRefOid: 'c'.repeat(40) };
    const now = Date.now();
    const stacks = detectStacks([bottom, top], { isAncestor: (x, y) => x === bottom.headRefOid && y === top.headRefOid, now: () => now });
    // Each run moves the bottom to a new head: the dispatcher dedupes a restack per (top, bottom head) in-process.
    const run = (record, bottomHead) => {
      const fixExecutorRoute = vi.fn((planned) => routeFixExecutor(planned,
        { setting, fixSettings: { strongerModelFromRound: 3 }, loadLadder: () => null, launcherAvailable: true }));
      const out = runReconcileFixDispatch({ root: '/repo', repo: 'we', checkStaleness: () => ({ stale: false }),
        reconcile: () => ({ dispatch: [], refusals: [{ kind: 'nothing-owed', prNumber: top.pr }] }),
        prStack: () => ({ pairs: [{ ...stacks.pairs[0], bottomHead, inSync: false }] }), prStackSettings: PR_STACK_DEFAULTS,
        readLaneTips: () => new Map([[top.headRefName, top.headRefOid]]),
        readPrForRestack: () => ({ ...top, prNumber: top.pr, kind: 'fix', labels: [], body: '', isCrossRepository: false }),
        readMainRedPriorityRecord: () => record, fixExecutorRoute,
        findItemFn: () => null, loadItems: () => [], pickFreeLanes: () => [1], dispatch: (p) => p,
        fetchItemlessDiffPaths: () => ['scripts/x.mjs'], resolveFallbackScope: () => ['we:scripts/x.mjs'],
        resolveProfile: () => ({ capabilities: { fix: true, ciHeal: true }, canonicalPrefix: 'we' }),
        listBuildClaims: () => [], listFixClaims: () => [], priorityShadow: null });
      expect(out.dispatched).toEqual([expect.objectContaining({ pr: top.pr, restack: expect.objectContaining({ idle: true }) })]);
      return fixExecutorRoute.mock.results[0].value;
    };
    const record = { repo: 'we', pr: top.pr, firstRedSha: '7c731a95e', setAt: now, expiresAt: now + 30 * 60_000 };
    expect(run(record, 'd'.repeat(40))).toMatchObject({ executor: 'claude', reason: 'main-fix' });
    expect(run(null, 'e'.repeat(40)).executor).toBe('codex');
    expect(run({ ...record, pr: bottom.pr }, 'f'.repeat(40)).executor).toBe('codex');
  });
});

// Converge round 1: the routed-codex fallback reads `<repo>#<pr>`, and a codex launch must carry the merge target.
describe('routed codex wiring: repo and merge target reach the router and the launcher', () => {
  it.each([
    [{ isConflict: true, baseRefName: 'develop' }, 'develop'],
    [{ restack: { onto: 'lane/base' } }, 'lane/base'],
    [{}, null],
  ])('a codex ci-heal routes with options.repo and forwards mergeOnto (%j)', async (extra, mergeOnto) => {
    const { createRoutedCiHealDispatch } = await import('../../lib/fix-slot-borrow.mjs');
    const launchCodex = vi.fn(() => 'pid:1');
    const route = vi.fn(() => ({ executor: 'codex', reason: 'r', source: 's' }));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const run = createRoutedCiHealDispatch({
      dispatch: async (planned, { sinks }) => Object.values(sinks)[0]({ sessionSlug: 'ci-heal-42', prompt: 'P', claimOwner: 'o' }),
      route, createSinks: ({ provider }) => ({ launch: provider }),
      launchCodex, writePrompt: () => '/tmp/p.md', removePrompt: vi.fn(), stampExecutor: vi.fn(),
      profileFor: () => ({ slug: 'web-everything/frontier-ui', lanePoolRepo: '/fui' }),
    });
    try { await run({ pr: 42, laneRef: 'lane/42-x', scope: ['fui:x.ts'], ...extra }, { root: '/repo', repo: 'fui' }); }
    finally { log.mockRestore(); }
    expect(route).toHaveBeenCalledWith(expect.objectContaining({ repo: 'fui', kind: 'ci-heal' }));
    expect(launchCodex).toHaveBeenCalledWith(expect.objectContaining({ mergeOnto, claimRepo: 'fui', repairKind: 'ci-heal' }));
  });

  it('runReconcileFixDispatch hands the router the repo key, so a seeded frontierui ledger falls back to Claude', async () => {
    const { runReconcileFixDispatch, routeFixExecutor } = await import('../reconcile-fix-dispatch.mjs');
    const { detectStacks, PR_STACK_DEFAULTS } = await import('../pr-stack.mjs');
    const bottom = { pr: 11, headRefName: 'lane/b', headRefOid: 'a'.repeat(40) };
    const top = { pr: 12, headRefName: 'lane/t', headRefOid: 'c'.repeat(40) };
    const now = Date.now();
    const stacks = detectStacks([bottom, top], { isAncestor: (x, y) => x === bottom.headRefOid && y === top.headRefOid, now: () => now });
    const readRouted = vi.fn(({ repo, pr }) => (repo === 'frontierui' && pr === top.pr
      ? { 'frontierui#12': [{ head: top.headRefOid, outcome: 'no-change' }, { head: top.headRefOid, outcome: 'failed' }] } : {}));
    const fixExecutorRoute = vi.fn((planned) => routeFixExecutor(planned,
      { setting, fixSettings: { strongerModelFromRound: 3 }, loadLadder: () => null, launcherAvailable: true, readRouted }));
    runReconcileFixDispatch({ root: '/repo', repo: 'frontierui', checkStaleness: () => ({ stale: false }),
      reconcile: () => ({ dispatch: [], refusals: [{ kind: 'nothing-owed', prNumber: top.pr }] }),
      prStack: () => ({ pairs: [{ ...stacks.pairs[0], bottomHead: 'd'.repeat(40), inSync: false }] }), prStackSettings: PR_STACK_DEFAULTS,
      readLaneTips: () => new Map([[top.headRefName, top.headRefOid]]),
      readPrForRestack: () => ({ ...top, prNumber: top.pr, kind: 'fix', labels: [], body: '', isCrossRepository: false }),
      readMainRedPriorityRecord: () => null, fixExecutorRoute,
      findItemFn: () => null, loadItems: () => [], pickFreeLanes: () => [1], dispatch: (p) => p,
      fetchItemlessDiffPaths: () => ['x.ts'], resolveFallbackScope: () => ['fui:x.ts'],
      resolveProfile: () => ({ capabilities: { fix: true, ciHeal: true }, canonicalPrefix: 'fui' }),
      listBuildClaims: () => [], listFixClaims: () => [], priorityShadow: null });
    expect(fixExecutorRoute).toHaveBeenCalledWith(expect.objectContaining({ repo: 'frontierui', pr: top.pr }));
    expect(fixExecutorRoute.mock.results[0].value).toMatchObject({ executor: 'claude', reason: expect.stringContaining('falls back to Claude') });
  });
});

it('forwards ci-heal repair-kind after scope to the detached launcher', () => {
  const spawnDetached = vi.fn(() => ({ pid: 99 }));
  fixDetachedProvider({ pr: 7, sessionSlug: 'ci-heal-7', scope: 'we:a', repairKind: 'ci-heal' },
    { spawnDetached, readDeliveryAgentMarker: () => null, logPathFor: () => '/tmp/log' });
  const argv = spawnDetached.mock.calls[0][0];
  expect(argv[argv.indexOf('--scope=we:a') + 1]).toBe('--repair-kind=ci-heal');
});

// Card 272 part 2 (live #5045, 2026-10-13): the cheap refresh precedes every model rung.
describe('CI-heal stale-base dispatch seam', () => {
  it.each(['held', 'null', 'throw'])('handles a %s gate before routing', async mode => {
    const { createRoutedCiHealDispatch } = await import('../../lib/fix-slot-borrow.mjs');
    const route = vi.fn(() => ({ executor: 'claude' }));
    const dispatch = vi.fn(() => ({ spawned: true }));
    const staleBaseGate = vi.fn(() => {
      if (mode === 'throw') throw new Error('probe failed');
      return mode === 'held' ? { held: true, reason: 'CI re-runs first' } : null;
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const planned = { pr: 5045, round: 4 };
      const options = { repo: 'we', root: '/repo' };
      const result = await createRoutedCiHealDispatch({ dispatch, route, createSinks: () => ({}), staleBaseGate })(planned, options);
      expect(staleBaseGate).toHaveBeenCalledWith({ planned, repo: 'we', root: '/repo' });
      if (mode === 'held') {
        expect(result).toEqual({ held: true, reason: 'CI re-runs first' });
        expect(route).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled();
      } else {
        expect(result).toEqual({ spawned: true });
        expect(route).toHaveBeenCalledOnce(); expect(dispatch).toHaveBeenCalledWith(planned, { ...options, sinks: {} });
        if (mode === 'throw') expect(log).toHaveBeenCalledWith(expect.stringContaining('stale-base gate failed open: probe failed'));
      }
    } finally { log.mockRestore(); }
  });
});

describe('fallback chain routing', () => {
  const chain = {value:['codex','codex-alt','argon','claude'],source:'repo'};
  it('skips opted-in Argon while its production confinement contract is unavailable', () => {
    expect(chooseFixExecutor({ setting, chain, codexUnproductive: 3, launcherAvailable: fixLauncherAvailable }))
      .toMatchObject({ executor: 'claude', rung: 'claude', reason: expect.stringContaining('argon launcher unavailable') });
  });
  it.each(['fix', 'ci-heal'])('round 3 %s with two unproductive runs still tries codex-alt', kind => {
    const head = 'a'.repeat(40);
    const decision = routeFixExecutor({ repo: 'we', pr: 42, kind, round: 3, headRefOid: head }, {
      setting, chain, fixSettings: { strongerModelFromRound: 3 }, loadLadder: () => null,
      launcherAvailable: () => true, criticalFor: () => false,
      readRouted: () => ({ 'we#42': [{ head, outcome: 'failed' }, { head, outcome: 'no-change' }] }),
    });
    expect(decision).toMatchObject({ rung: 'codex-alt', executor: 'codex' });
  });
  it('routes triggers through the chain and keeps main-fix on Claude', () => {
    const decision = chooseFixExecutor({setting,chain,strongerModel:true,launcherAvailable:()=>true});
    expect(decision).toMatchObject({rung:'codex-alt',source:'repo',policyRoute:{model:'gpt-6-astra',effort:'high'}});
    expect(formatFixExecutorLog(decision)).toContain('fix executor: codex rung=codex-alt model=gpt-6-astra effort=high');
    expect(chooseFixExecutor({setting,chain,mainFix:true,launcherAvailable:true}).executor).toBe('claude');
  });
  it('routes Argon CI-heal with its policy and suppresses the Claude stronger rung', async () => {
    const {createRoutedCiHealDispatch} = await import('../../lib/fix-slot-borrow.mjs');
    const launchCodex = vi.fn(()=>'pid:1');
    const dispatch = vi.fn(async (p,{sinks,routeHeal}) => { expect(p.strongerModel).toBe(false); expect(routeHeal()).toBe(null); return sinks.launch({sessionSlug:'heal',prompt:'p'}); });
    const run = createRoutedCiHealDispatch({dispatch, route:()=>chooseFixExecutor({setting,chain,codexUnproductive:3,launcherAvailable:()=>true}),
      createSinks:({provider})=>({launch:provider}),launchCodex,writePrompt:()=>'/tmp/p',removePrompt:vi.fn(),stampExecutor:vi.fn(),profileFor:()=>({slug:'o/r'})});
    const log = vi.spyOn(console,'error').mockImplementation(()=>{});
    try { await run({pr:42,scope:['we:x'],strongerModel:true}); } finally {log.mockRestore();}
    expect(launchCodex).toHaveBeenCalledWith(expect.objectContaining({policyRoute:{provider:'antigravity',model:'gemini-4-argon-high'}}));
  });
});

describe('chain dispatch and critical scope', () => {
  const chain = {value:['codex','codex-alt','argon','claude'],source:'repo'};
  const options = {setting,chain,fixSettings:{strongerModelFromRound:3},loadLadder:()=>null,readRouted:()=>({}),launcherAvailable:()=>true};
  it.each([{}, {scope:[]}, {scope:['we:scripts/lib/critical-work.mjs']}])('fails closed for critical scope %j', scope => {
    for (const trigger of [{takeover:true}, {rulingNotAddressed:true}]) {
      expect(routeFixExecutor({pr:42,...trigger,...scope},options)).toMatchObject({executor:'claude',reason:'critical work never leaves Claude'});
    }
  });
  it('routes critical stronger-model work through the configured threshold', () => {
    const planned = {pr:42,strongerModel:true,scope:['we:scripts/lib/critical-work.mjs']};
    expect(routeFixExecutor(planned,options)).toMatchObject({executor:'codex',rung:'codex-alt'});
    expect(routeFixExecutor(planned,{...options,chain:{...chain,criticalClaudeFromRung:1,criticalClaudeFromRungSource:'repo'}}))
      .toMatchObject({executor:'claude',reason:'critical work reaches Claude from rung 1 (criticalClaudeFromRung=1, source=repo)'});
  });
  it('uses the injected critical verdict and fails closed on errors', () => {
    const planned = {pr:42,takeover:true,scope:['we:x.ts']};
    const criticalFor = vi.fn(()=>false);
    expect(routeFixExecutor(planned,{...options,criticalFor}).rung).toBe('codex-alt');
    expect(criticalFor).toHaveBeenCalledWith(planned);
    expect(routeFixExecutor(planned,{...options,criticalFor:()=>{throw Error('unreadable');}}).executor).toBe('claude');
  });
  it('stamps Argon as routed and forwards the model without a Claude ladder claim', () => {
    const spawnBorrowed = vi.fn(()=>'pid:1'), stampExecutor = vi.fn();
    const log = vi.spyOn(console,'error').mockImplementation(()=>{});
    try {
      dispatchFix({pr:42,itemNum:'42',lane:2,laneRef:'lane/42-x',scope:['we:x.ts'],
        rulingNotAddressed:{rung:{id:'opus-high',at:1},route:{provider:'claude',model:'opus'}}}, {
        root:'/repo',readBrief:()=>'{{PR_NUM}} {{LANE_REF}}',readFixClaim:()=>null,acquireClaim:()=>({ok:true}),
        stampExecutor,stampRunner:vi.fn(),postNotice:vi.fn(),fixExecutorRoute:()=>chooseFixExecutor({setting,chain,codexUnproductive:3,launcherAvailable:()=>true}),
        writeBorrowedPrompt:()=>'/tmp/p',spawnBorrowed,spawnAgent:()=>{throw Error('unexpected Claude');},
      });
      expect(spawnBorrowed).toHaveBeenCalledWith(expect.objectContaining({policyRoute:{provider:'antigravity',model:'gemini-4-argon-high'}}));
      expect(stampExecutor).toHaveBeenCalledWith(expect.objectContaining({decision:expect.objectContaining({executor:'antigravity',rung:'argon'})}));
      expect(log.mock.calls.find(([line])=>line.includes('ruling-not-addressed rung'))[0]).toContain('model=gemini-4-argon-high');
    } finally {log.mockRestore();}
  });
});
