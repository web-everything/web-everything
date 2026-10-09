// Card x60i0ie — the build daemon's item-prepare launch path under cost-class admission: light prepares are
// admitted while the heavy gates (host-load, open-PR landing freeze) hold builds; OFF keeps today's behaviour.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBuildDispatchTick, planConfigFrom, policyFrom, tickCapacity } from '../build-dispatch-daemon.mjs';
import { acquireBuildDispatchClaim, releaseBuildDispatchClaim, listBuildDispatchClaims } from '../../../scripts/conveyor/build-dispatch-claim.mjs';
import { BUILD_DISPATCH_POLICY } from '../../../scripts/conveyor/build-dispatch-policy.mjs';
import { resolveCostAdmissionSettings } from '../../../scripts/lib/cost-admission.mjs';

const ON = resolveCostAdmissionSettings({ env: { WE_COST_ADMISSION: 'on' } });
const OFF = resolveCostAdmissionSettings({});

let lockRoot;
beforeEach(() => { lockRoot = mkdtempSync(join(tmpdir(), 'bdd-cost-')); });
afterEach(() => { rmSync(lockRoot, { recursive: true, force: true }); });

// REPLAY-SHAPED FIXTURE — 2026-10-08 live picture: more open PRs than `maxOpenPrs` (landing freeze), and a host
// sample below the 20% prepare floor / 15% build floor but above the 5% light floor.
function fixture({ openPrs = 3, killSwitch = false, spawns = ['4501', '4502', '4503'], cpuIdlePct = 12 } = {}) {
  const dispatch = vi.fn(() => ({ dispatching: true }));
  const sp = spawns.map((num, i) => ({ num, lane: i + 1 }));
  return {
    dispatch,
    placePrepareHold: vi.fn(),
    releasePrepareHold: vi.fn(),
    planTick: (bk) => ({ decisions: { spawnPrepareItems: sp }, nextState: { tick: (bk.tick ?? 0) + 1,
      prepareGuards: sp.map((s) => ({ ...s, kind: 'prepare-item', spawnedTick: bk.tick ?? 0 })) } }),
    fetchOpenPrs: () => [{ repo: 'web-everything/web-everything', prs: Array.from({ length: openPrs }, (_, i) => ({ number: 9000 + i, headRefName: `lane/x${i}`, labels: [], files: [] })) }],
    listClaims: () => [], listRunStoreInFlight: () => [],
    killSwitch: () => ({ engaged: killSwitch }),
    listPrepareInFlight: () => [],
    listPrepareClaims: () => listBuildDispatchClaims({ lockRoot }),
    acquirePrepareClaim: (o) => acquireBuildDispatchClaim({ ...o, lockRoot, owner: 'host:10', pid: 10 }),
    releasePrepareClaim: (o) => releaseBuildDispatchClaim({ ...o, lockRoot }),
    // Today's host gate for the `prepare` kind: 12% idle < 20% prepare floor → refused.
    hostLoadGate: (kind) => ({ admit: false, kind: 'host-load', why: `cpu-idle signal: ${cpuIdlePct}% idle < 20% needed for ${kind}` }),
    costFacts: () => ({ cpuIdlePct, memFreePct: 80, minMemFreePct: 15, claudeUsdToday: 865.06 }),
  };
}
const policy = (costAdmission, extra = {}) => ({ ...BUILD_DISPATCH_POLICY, maxOpenPrs: 2, costAdmission, ...extra });

describe('build daemon — cost-class admission of item prepares', () => {
  it('OFF (today): the open-PR landing freeze holds every prepare', async () => {
    const effects = fixture();
    const tick = await runBuildDispatchTick({ live: true, effects, policy: policy(OFF) });
    expect(tick.plan.freeze).toMatchObject({ frozen: true, kinds: ['open-prs'] });
    expect(tick.prepare.launched).toEqual([]);
    expect(effects.dispatch).not.toHaveBeenCalled();
  });

  it('OFF (today): an unfrozen tick still refuses prepares below the 20% host floor, capped at two', async () => {
    const effects = fixture({ openPrs: 0 });
    const tick = await runBuildDispatchTick({ live: true, effects, policy: policy(OFF) });
    expect(tick.prepare.cap).toBe(2);
    expect(tick.prepare.launched).toEqual([]);
    expect(tick.loadHolds[0]).toMatchObject({ kind: 'prepare', reason: 'host-load' });
    expect(tick.costAdmission.line).toContain('cost-admission off');
  });

  it('ON: light prepares launch through the open-PR freeze and the heavy CPU floor, above the light floor', async () => {
    const effects = fixture();
    const tick = await runBuildDispatchTick({ live: true, effects, policy: policy(ON) });
    expect(tick.prepare.freezeHeld).toBe(false);
    expect(tick.prepare.cap).toBe(6);
    // Detached launches are serialized one per tick only when `settleLaunches` exists; this stub launches inline.
    expect(tick.prepare.launched.map((l) => l.num)).toEqual(['4501', '4502', '4503']);
    expect(tick.costAdmission.tally.light.admitted).toBe(3);
    expect(tick.costAdmission.line).toMatch(/^cost-admission on, light cap 6, light floor 5% · heavy 0 admitted \/ 0 refused · light 3 admitted \/ 0 refused · cpu idle 12\.0% · claude \$865 today \(no budget\)$/);
    expect(tickCapacity(tick).prepareSlots).toBe(6); // in-flight is read before this tick's launches
  });

  it('ON: the kill switch still holds light work', async () => {
    const effects = fixture({ killSwitch: true });
    const tick = await runBuildDispatchTick({ live: true, effects, policy: policy(ON) });
    expect(tick.prepare.freezeHeld).toBe(true);
    expect(effects.dispatch).not.toHaveBeenCalled();
  });

  it('ON: the light cap bounds launches', async () => {
    const capped = await runBuildDispatchTick({ live: true, effects: fixture(), policy: policy({ ...ON, lightMaxConcurrent: 1 }) });
    expect(capped.prepare.launched.map((l) => l.num)).toEqual(['4501']);
  });

  it('ON: the light CPU floor and the token budget each refuse with a reason', async () => {
    const floor = await runBuildDispatchTick({ live: true, effects: fixture({ cpuIdlePct: 3 }), policy: policy(ON) });
    expect(floor.prepare.launched).toEqual([]);
    expect(floor.loadHolds.map((h) => h.reason)).toEqual(['light-cpu-floor', 'light-cpu-floor', 'light-cpu-floor']);

    const budget = await runBuildDispatchTick({ live: true, effects: fixture(), policy: policy({ ...ON, claudeDailyUsdBudget: 500 }) });
    expect(budget.prepare.launched).toEqual([]);
    expect(budget.costAdmission.line).toContain('light 0 admitted / 3 refused (token-budget 3)');
  });

  it('the policy carries the declared settings; tick-core gets them only when ON', () => {
    expect(policyFrom({}, {}).costAdmission).toEqual(OFF);
    expect(policyFrom({}, { WE_COST_ADMISSION: 'on' }).costAdmission.mode).toBe('on');
    expect(planConfigFrom(policy(OFF)).costAdmission).toBeUndefined();
    expect(planConfigFrom(policy(ON)).costAdmission).toEqual(ON);
  });
});
