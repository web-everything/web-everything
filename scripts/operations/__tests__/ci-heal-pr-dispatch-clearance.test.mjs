import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect, vi } from 'vitest';
import { runReconcileCiHealDispatch } from '../ci-heal-pr-dispatch.mjs';

it.each([false, true])('clearance guard launch=%s precedes admission', async launch => {
  const dir = mkdtempSync(join(tmpdir(), 'clearance-dispatch-'));
  const entry = { kind: 'ci-heal', prNumber: 5193, headRefName: 'lane/5193', headRefOid: '9c72024172156f0f8b1b1c0c3f94b44d1031bdd3', reason: 'red-ci' };
  const dispatch = vi.fn(async () => ({ pr: 5193, sessionSlug: 'fixture' }));
  const tryAdmit = vi.fn(() => ({ admit: true }));
  const clearanceGuard = { sweep: vi.fn(), beforeCiHeal: vi.fn(() => ({ launch, why: 'no failing CI checks' })) };
  try {
    const out = await runReconcileCiHealDispatch({
      checkStaleness: () => ({ fresh: true, behind: 0 }),
      reconcile: () => ({ dispatch: [entry], refusals: [] }), clearanceGuard, dispatch,
      flushOwed: () => ({}), flushTimeouts: async () => [], pollAttempts: () => [], timeoutHold: () => null,
      pickFreeLanes: () => [1], resolveProfile: () => ({ capabilities: { ciHeal: true } }),
      resolveWorkUnit: () => ({ itemNum: null, scope: [] }), unsupportedPath: join(dir, 'unsupported.json'),
      dispatchThrottle: { tryAdmit }, ciHealReserve: null, currentBuild: () => null,
      fixLoop: { killed: () => false, readRows: () => [], append: () => {} },
    });
    expect(clearanceGuard.sweep).toHaveBeenCalledWith([entry]);
    expect(clearanceGuard.beforeCiHeal).toHaveBeenCalledWith(entry);
    expect(dispatch).toHaveBeenCalledTimes(launch ? 1 : 0);
    expect(tryAdmit).toHaveBeenCalledTimes(launch ? 1 : 0);
    if (!launch) expect(out.refusals).toContainEqual({ pr: 5193, kind: 'no-failing-ci', why: 'no failing CI checks' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
