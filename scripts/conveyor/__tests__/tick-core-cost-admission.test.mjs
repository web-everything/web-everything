// Card x60i0ie — cost-class admission in the pure tick core: light prepares are not held by the heavy load-cap or
// the heavy queue budget when the rule is ON; heavy spawns (investigate, fix, ci-heal, builds) are unchanged.
import { describe, it, expect } from 'vitest';
import { planTick } from '../tick-core.mjs';
import { resolveCostAdmissionSettings } from '../../lib/cost-admission.mjs';

const ON = resolveCostAdmissionSettings({ env: { WE_COST_ADMISSION: 'on' } });

// REPLAY-SHAPED FIXTURE — the 2026-10-08 build-daemon picture: heavy load-cap held (median idle below the heavy
// floor), cards waiting on `needs-prepare`, one investigation, free lanes, and a full heavy queue budget.
function input({ costAdmission, idlePct = 9, queueFull = false } = {}) {
  return {
    state: { queue: [], lanes: [], prs: [] },
    plan: { launch: [], held: [
      { num: '4501', reason: 'needs-prepare' }, { num: '4502', reason: 'needs-prepare' }, { num: '4503', reason: 'needs-prepare' },
      { num: '4600', reason: 'needs-investigation' },
    ] },
    freeLanes: [1, 2, 3, 4, 5],
    loadAdmission: { held: true, idlePct, minIdlePct: 15, reason: `cpu idle ${idlePct}% (<15%)` },
    queueAdmission: queueFull ? { backlogMinutes: 10_000, slots: 3, maxWaitMinutes: 30, standardMinutes: {}, arrivalWindowMinutes: 10 } : null,
    config: { ...(costAdmission ? { costAdmission } : {}) },
    now: Date.parse('2026-10-08T21:00:00Z'),
  };
}

describe('tick-core cost-class admission', () => {
  it('OFF (today): a held load-cap withholds every prepare and the investigation', () => {
    const { decisions } = planTick(input());
    expect(decisions.spawnPrepareItems).toEqual([]);
    expect(decisions.spawnInvestigations).toEqual([]);
    expect(decisions.costAdmission).toEqual({ mode: 'off' });
  });

  it('ON: light prepares launch under the light cap while the heavy load-cap holds; investigate stays held', () => {
    const { decisions } = planTick(input({ costAdmission: ON }));
    expect(decisions.spawnPrepareItems.map((s) => s.num)).toEqual(['4501', '4502', '4503']);
    expect(decisions.spawnInvestigations).toEqual([]);
    expect(decisions.costAdmission).toMatchObject({ mode: 'on', lightFloorHeld: false, heavyLoadHeld: true });
  });

  it('ON: the light cap bounds item prepares', () => {
    const { decisions } = planTick(input({ costAdmission: { ...ON, lightMaxConcurrent: 2 } }));
    expect(decisions.spawnPrepareItems.map((s) => s.num)).toEqual(['4501', '4502']);
    expect(decisions.notes.some((n) => n.kind === 'prepare-item-cap' && n.num === '4503')).toBe(true);
  });

  it('ON: below the gentle CPU floor, light prepares are withheld too, with a note', () => {
    const { decisions } = planTick(input({ costAdmission: ON, idlePct: 3 }));
    expect(decisions.spawnPrepareItems).toEqual([]);
    expect(decisions.notes.find((n) => n.kind === 'light-cpu-floor').text).toContain('cpu idle 3.0% < light floor 5%');
  });

  it('ON: light prepares are not charged to a full heavy queue budget; OFF they are', () => {
    const quiet = (o) => ({ ...input(o), loadAdmission: { held: false, idlePct: 40 } });
    const off = planTick(quiet({ queueFull: true }));
    expect(off.decisions.spawnPrepareItems).toEqual([]);
    expect(off.decisions.queueCapHeld.prepare.length).toBeGreaterThan(0);
    const on = planTick(quiet({ queueFull: true, costAdmission: ON }));
    expect(on.decisions.spawnPrepareItems).toHaveLength(3);
    expect(on.decisions.queueCapHeld.prepare.every((h) => h.kind === 'investigate')).toBe(true);
  });

  it('ON with a quiet host: light and heavy draw disjoint lanes', () => {
    const { decisions } = planTick({ ...input({ costAdmission: ON }), loadAdmission: { held: false, idlePct: 60 } });
    const lanes = [...decisions.spawnPrepareItems, ...decisions.spawnInvestigations].map((s) => s.lane);
    expect(decisions.spawnInvestigations.map((s) => s.num)).toEqual(['4600']);
    expect(new Set(lanes).size).toBe(lanes.length);
  });
});
