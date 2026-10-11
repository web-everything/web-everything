import { describe, it, expect, vi } from 'vitest';
import { resolveFixExecutorSetting, chooseFixExecutor, formatFixExecutorLog } from '../../lib/fix-slot-borrow.mjs';
import { dispatchFix } from '../reconcile-fix-dispatch.mjs';

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
    const launchClaude = vi.fn(() => 'claude-session');
    const stampExecutor = vi.fn();
    const stampRunner = vi.fn();
    const writePrompt = vi.fn(() => '/tmp/ci-heal.md');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const run = createRoutedCiHealDispatch({
      dispatch: dispatchCiHeal,
      route: () => chooseFixExecutor({ setting: { value, source: 'env' }, launcherAvailable: true }),
      createSinks: ({ provider }) => ({ [DISPATCH_EFFECT]: async (payload) => {
        let runnerPid;
        const handle = await provider({ ...payload, reportWrapped: (pid) => { runnerPid = pid; } });
        return { handle, dispatch: { wrapped: !!runnerPid, runnerPid } };
      } }),
      launchCodex, launchClaude, writePrompt, removePrompt: vi.fn(), stampExecutor,
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
        expect(launchClaude).not.toHaveBeenCalled();
        expect(launchCodex).toHaveBeenCalledWith(expect.objectContaining({
          policyRoute: { provider: 'codex' }, ref: 'lane/42-x', claimRepo: 'we', promptFile: '/tmp/ci-heal.md',
        }));
        expect(writePrompt).toHaveBeenCalledWith('ci-heal-42', expect.stringContaining('CI-heal 42: red-ci lane/42-x'));
        expect(stampExecutor).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ci-heal', owner: 'test-owner' }));
        expect(stampRunner).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ci-heal', pid: 123 }));
      } else {
        expect(launchCodex).not.toHaveBeenCalled();
        expect(launchClaude).toHaveBeenCalledTimes(1);
      }
      expect(log.mock.calls.filter(([line]) => line.includes('fix executor:'))).toHaveLength(1);
    } finally { log.mockRestore(); }
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
