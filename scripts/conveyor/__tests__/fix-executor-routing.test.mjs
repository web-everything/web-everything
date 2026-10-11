import { describe, it, expect, vi } from 'vitest';
import { resolveFixExecutorSetting, chooseFixExecutor, formatFixExecutorLog } from '../../lib/fix-slot-borrow.mjs';
import { dispatchFix, roundEscalationFor } from '../reconcile-fix-dispatch.mjs';

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
        expect(spawnAgent.mock.calls[0][0].join(' ')).toContain('opus');
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
  const run = async (extra, executor) => {
    const { runReconcileFixDispatch } = await import('../reconcile-fix-dispatch.mjs');
    const dispatch = vi.fn(() => ({ pr: 42 }));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = runReconcileFixDispatch({
        root: '/repo', repo: 'we', checkStaleness: () => ({ fresh: true, behind: 0 }),
        reconcile: () => ({ dispatch: [{ kind: 'fix', prNumber: 42, headRefName: 'lane/42-x', attempts: 1, files: ['scripts/x.mjs'], ...extra }],
          refusals: [], notes: [] }),
        findItemFn: () => ({ num: '42', scope: ['we:scripts/x.mjs'], specPath: 'backlog/42-x.md' }),
        loadItems: () => [], pickFreeLanes: () => [2], listBuildClaims: () => [], listFixClaims: () => [],
        dispatchThrottle: { tryAdmit: () => ({ admit: false, kind: 'fix-cap', why: 'fixer cap full' }) },
        borrowGate: { consider: () => ({ borrow: true, executor, waitedMinutes: 30 }), clear: vi.fn() },
        tryResume: () => ({ resumed: false }), tryResumeRound: () => ({ resumed: false }), dispatch,
      });
      return { result, dispatch };
    } finally { log.mockRestore(); }
  };
  it.each([
    ['ruling-not-addressed send-back', { rulingNotAddressed: { rung, route: claudeRoute, matches: [] } }],
    ['takeover', { takeover: { rung, route: claudeRoute, attempts: 5, cap: 5 } }],
  ])('refuses a codex borrow for a %s and keeps waiting', async (_name, extra) => {
    const { result, dispatch } = await run(extra, 'codex');
    expect(dispatch).not.toHaveBeenCalled();
    expect(result.dispatched).toHaveLength(0);
    expect(result.refusals).toEqual([expect.objectContaining({ pr: 42, kind: 'fix-cap', why: expect.stringContaining("Claude") })]);
  });
  it('still lets a table-bearing entry borrow a Claude-class slot, and an ordinary one borrow codex', async () => {
    const claude = await run({ rulingNotAddressed: { rung, route: claudeRoute, matches: [] } }, 'claude');
    expect(claude.dispatch).toHaveBeenCalledTimes(1);
    const ordinary = await run({}, 'codex');
    expect(ordinary.dispatch).toHaveBeenCalledTimes(1);
  });
});
