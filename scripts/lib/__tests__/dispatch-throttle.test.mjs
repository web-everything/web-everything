import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDispatchThrottle, hostLoadGate, countLiveFixSessions, resolveFixDispatchMaxConcurrent,
  resolveMaxLoadPerCore, resolveHeavyAdmissionCap,
} from '../dispatch-throttle.mjs';
import { resolveCap } from '../../readiness/heavy-admission.mjs';
import { runReconcileFixDispatch } from '../../conveyor/reconcile-fix-dispatch.mjs';
import { runReconcileCiHealDispatch } from '../../operations/ci-heal-pr-dispatch.mjs';

const claim = (kind, pr) => ({ meta: { kind, pr, repo: 'we' } });

describe('declared settings', () => {
  it('defaults: fix cap 2, 2.0 load/core, heavy cap 2; env overrides; junk falls back', () => {
    expect(resolveFixDispatchMaxConcurrent({ env: {} })).toBe(2);
    expect(resolveMaxLoadPerCore({ env: {} })).toBe(2);
    expect(resolveHeavyAdmissionCap({ env: {} })).toBe(2);
    expect(resolveFixDispatchMaxConcurrent({ env: { WE_FIX_DISPATCH_MAX_CONCURRENT: '4' } })).toBe(4);
    expect(resolveMaxLoadPerCore({ env: { WE_MAX_LOAD_PER_CORE: '1.5' } })).toBe(1.5);
    expect(resolveFixDispatchMaxConcurrent({ env: { WE_FIX_DISPATCH_MAX_CONCURRENT: '0' } })).toBe(2);
    expect(resolveMaxLoadPerCore({ env: { WE_MAX_LOAD_PER_CORE: 'x' } })).toBe(2);
  });
  it('heavy-admission resolveCap reads the declared setting, env still wins', () => {
    expect(resolveCap({})).toBe(2);
    expect(resolveCap({ WE_HEAVY_ADMISSION_CAP: '3' })).toBe(3);
    expect(resolveHeavyAdmissionCap({ env: {}, file: { heavyAdmissionCap: 5 } })).toBe(5);
  });
});

describe('hostLoadGate', () => {
  it('refuses above max load per core, admits at/below, fails open on unreadable load', () => {
    expect(hostLoadGate({ load: 36, cores: 12, maxLoadPerCore: 2 })).toMatchObject({ admit: false, kind: 'host-load' });
    expect(hostLoadGate({ load: 24, cores: 12, maxLoadPerCore: 2 }).admit).toBe(true);
    expect(hostLoadGate({ load: NaN, cores: 12 }).admit).toBe(true);
  });
});

describe('createDispatchThrottle', () => {
  const idle = { loadavg: () => 1, cpuCount: () => 12 };
  it('counts only live fix and ci-heal claims', () => {
    expect(countLiveFixSessions([claim('fix', 1), claim('ci-heal', 2), claim('fixing', 3), claim('build', 4)])).toBe(2);
  });
  it('refuses fix-cap at the cap, counting launches admitted in the same pass', () => {
    const t = createDispatchThrottle({ ...idle, env: {}, listClaims: () => [claim('fix', 1)] });
    expect(t.tryAdmit('fix').admit).toBe(true);
    expect(t.tryAdmit('ci-heal')).toMatchObject({ admit: false, kind: 'fix-cap' });
  });
  it('refuses host-load when the machine is hot, with free slots', () => {
    const t = createDispatchThrottle({ loadavg: () => 36, cpuCount: () => 12, env: {}, listClaims: () => [] });
    expect(t.tryAdmit('fix')).toMatchObject({ admit: false, kind: 'host-load' });
  });
});

describe('wired into the dispatchers', () => {
  const hot = () => createDispatchThrottle({ loadavg: () => 36, cpuCount: () => 12, env: {}, listClaims: () => [] });
  const full = () => createDispatchThrottle({ loadavg: () => 1, cpuCount: () => 12, env: {}, listClaims: () => [claim('fix', 1), claim('ci-heal', 2)] });
  it('fix dispatch defers with fix-cap / host-load and never dispatches', () => {
    for (const [mk, kind] of [[full, 'fix-cap'], [hot, 'host-load']]) {
      const dispatch = vi.fn();
      const result = runReconcileFixDispatch({
        root: '/repo', dispatchThrottle: mk(), dispatch, tryResume: () => ({ resumed: false, resumeAttempt: null }),
        reconcile: () => ({ dispatch: [{ kind: 'fix', prNumber: 7, headRefName: 'lane/7-x' }], refusals: [] }),
        findItemFn: () => ({ num: '7', slug: 'x', specPath: 'backlog/7-x.md', scope: ['we:a.mjs'] }),
        loadItems: () => [], pickFreeLanes: () => [2], checkStaleness: () => ({ fresh: true, behind: 0 }),
        fetchItemlessDiffPaths: () => [], listBuildClaims: () => [], listFixClaims: () => [],
      });
      expect(dispatch).not.toHaveBeenCalled();
      expect(result.refusals).toContainEqual(expect.objectContaining({ pr: 7, kind }));
    }
  });
  it('ci-heal dispatch defers with fix-cap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'throttle-ci-heal-'));
    const dispatch = vi.fn();
    try {
      const result = await runReconcileCiHealDispatch({
        root: '/repo', dispatchThrottle: full(), dispatch, queueAdmission: null, salvage: async () => null,
        reconcile: () => ({ dispatch: [{ kind: 'ci-heal', prNumber: 9, headRefName: 'lane/x', headRefOid: 'a'.repeat(40) }], refusals: [] }),
        checkStaleness: () => ({ fresh: true, behind: 0 }), flushOwed: () => ({}), pollAttempts: () => [],
        flushTimeouts: async () => [], timeoutHold: () => null,
        resolveProfile: () => ({ capabilities: { ciHeal: true }, lanePoolRepo: 'x' }),
        pickFreeLanes: () => [1], resolveWorkUnit: () => ({ itemNum: null, scope: [] }),
        unsupportedPath: join(dir, 'u.json'),
        fixLoop: { killed: () => false, readRows: () => [], append: vi.fn() },
      });
      expect(dispatch).not.toHaveBeenCalled();
      expect(result.refusals).toContainEqual(expect.objectContaining({ pr: 9, kind: 'fix-cap' }));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
