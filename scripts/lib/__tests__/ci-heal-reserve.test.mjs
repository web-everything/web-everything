import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCiHealReserve, resolveCiHealReserve } from '../ci-heal-reserve.mjs';
import { createDispatchThrottle } from '../dispatch-throttle.mjs';
import { runReconcileCiHealDispatch } from '../../operations/ci-heal-pr-dispatch.mjs';

const claim = (kind, pr) => ({ meta: { kind, pr, repo: 'we' } });
const idle = { loadavg: () => 1, cpuCount: () => 12 };

// Live incident 2026-10-07: PR #4235 failed its own required check, but two review-fix sessions held the whole
// fixer cap, so its ci-heal was deferred pass after pass and no one owned it.
describe('ci-heal reserve slot', () => {
  it('defaults to 1; env overrides; junk falls back', () => {
    expect(resolveCiHealReserve({ env: {} })).toBe(1);
    expect(resolveCiHealReserve({ env: { WE_CI_HEAL_RESERVE: '2' } })).toBe(2);
    expect(resolveCiHealReserve({ env: { WE_CI_HEAL_RESERVE: '0' } })).toBe(0);
    expect(resolveCiHealReserve({ env: { WE_CI_HEAL_RESERVE: 'x' } })).toBe(1);
  });
  it('one ci-heal rides the reserve; a live or same-pass ci-heal uses it up, with a logged reason', () => {
    const free = createCiHealReserve({ ...idle, env: {}, listClaims: () => [claim('fix', 1), claim('fix', 2)] });
    expect(free.tryAdmit()).toMatchObject({ admit: true });
    expect(free.tryAdmit()).toMatchObject({ admit: false, kind: 'fix-cap', why: expect.stringMatching(/reserved ci-heal/) });
    const live = createCiHealReserve({ ...idle, env: {}, listClaims: () => [claim('fix', 1), claim('ci-heal', 2)] });
    expect(live.tryAdmit().admit).toBe(false);
  });
  it('reserve 0 is off; host load still refuses', () => {
    expect(createCiHealReserve({ ...idle, env: { WE_CI_HEAL_RESERVE: '0' } }).tryAdmit().admit).toBe(false);
    expect(createCiHealReserve({ loadavg: () => 36, cpuCount: () => 12, env: {} }).tryAdmit()).toMatchObject({ admit: false, kind: 'host-load' });
  });
  it('ci-heal dispatch for a PR runs when review fixes hold the whole fixer cap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-heal-reserve-'));
    const dispatch = vi.fn(async () => ({ pr: 9, kind: 'ci-heal' }));
    const listClaims = () => [claim('fix', 1), claim('fix', 2)];
    try {
      const result = await runReconcileCiHealDispatch({
        root: '/repo', dispatchThrottle: createDispatchThrottle({ ...idle, env: {}, listClaims }),
        ciHealReserve: createCiHealReserve({ ...idle, env: {}, listClaims }),
        dispatch, queueAdmission: null, salvage: async () => null,
        reconcile: () => ({ dispatch: [{ kind: 'ci-heal', prNumber: 9, headRefName: 'lane/x', headRefOid: 'a'.repeat(40) }], refusals: [] }),
        checkStaleness: () => ({ fresh: true, behind: 0 }), flushOwed: () => ({}), pollAttempts: () => [],
        flushTimeouts: async () => [], timeoutHold: () => null,
        resolveProfile: () => ({ capabilities: { ciHeal: true }, lanePoolRepo: 'x' }),
        pickFreeLanes: () => [1], resolveWorkUnit: () => ({ itemNum: null, scope: [] }),
        unsupportedPath: join(dir, 'u.json'),
        fixLoop: { killed: () => false, readRows: () => [], append: vi.fn() },
      });
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(result.refusals.filter((r) => r.pr === 9)).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
