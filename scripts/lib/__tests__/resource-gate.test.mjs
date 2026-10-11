import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RESOURCE_GATE_STANDARD, resolveResourceGateSettings, loadResourceGateSettings, logGateSettingsOnce,
  cutoverDecision, gateLaunch, decideFixCap, createResourceFixThrottle, resolveCutoverMode,
} from '../resource-gate.mjs';
import { admitLaunch, resolveCostAdmissionSettings } from '../cost-admission.mjs';
import { lightResourceDecision } from '../cost-admission-facts.mjs';

const NOW = Date.parse('2026-10-10T15:00:00Z');
const snap = ({ idle = 40, pressure = 1, ageMs = 5000, freshForMs = 20000, freePct, swapUsedPct } = {}) => ({
  sampledAt: new Date(NOW - ageMs).toISOString(), freshUntil: new Date(NOW - ageMs + freshForMs).toISOString(),
  cpu: { idlePct: idle, loadAvg: [60] }, memory: { pressureLevel: pressure, ...(freePct !== undefined ? { freePct } : {}), ...(swapUsedPct !== undefined ? { swapUsedPct } : {}) },
  disk: { busyPct: 100 }, heavySlots: { held: 1, cap: 4 },
});
let root;
const writeSnap = (s) => { mkdirSync(join(root, 'resource'), { recursive: true }); writeFileSync(join(root, 'resource', 'snapshot.json'), JSON.stringify(s)); };
const quiet = () => {};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'resource-gate-'));
  vi.stubEnv('WE_RESOURCE_SHADOW', 'on');
  vi.stubEnv('WE_RESOURCE_CUTOVER', '');
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

// The legacy gate always says the OPPOSITE of the fixture, so each test proves which side decided.
const legacyAdmit = () => ({ admit: true, note: 'legacy admit' });
const legacyHold = () => ({ admit: false, kind: 'host-load', why: 'legacy load-average hold' });

describe('gateLaunch — each kind decides through admit() at its threshold (enforce)', () => {
  // Standard thresholds (we:scripts/lib/resource-policy.mjs): build 15, fix 8, ci-heal 8, review 10, prepare 5 (light).
  it.each([['build', 15], ['fix', 8], ['ci-heal', 8], ['review', 10]])('%s: admitted at idle = %s%%, waits just below, over a legacy verdict', (kind, floor) => {
    writeSnap(snap({ idle: floor }));
    const at = gateLaunch({ kind, root, nowMs: NOW, legacyGate: legacyHold, settings: { cutover: 'enforce' }, log: quiet });
    expect(at).toMatchObject({ admit: true, decidedBy: 'admit', admission: { verdict: 'admit' } });
    expect(at.note).toContain(`admit({kind:'${kind}'})`);
    writeSnap(snap({ idle: floor - 0.5 }));
    const below = gateLaunch({ kind, root, nowMs: NOW, legacyGate: legacyAdmit, settings: { cutover: 'enforce' }, log: quiet });
    expect(below).toMatchObject({ admit: false, kind: 'host-load', decidedBy: 'admit', admission: { verdict: 'wait' } });
    expect(below.why).toContain('legacy said admit');
  });
  it('critical memory pressure holds every kind', () => {
    writeSnap(snap({ idle: 90, pressure: 4 }));
    for (const kind of ['build', 'fix', 'prepare', 'light']) {
      expect(gateLaunch({ kind, root, nowMs: NOW, legacyGate: legacyAdmit, settings: { cutover: 'enforce' }, log: quiet }).admit).toBe(false);
    }
  });
  it('a stale or missing snapshot holds a heavy kind and admits a light one, even when the legacy gate says the opposite', () => {
    for (const setup of [() => writeSnap(snap({ ageMs: 120000 })), () => {}]) {
      rmSync(join(root, 'resource'), { recursive: true, force: true });
      setup();
      for (const kind of ['build', 'fix', 'ci-heal', 'review']) {
        const d = gateLaunch({ kind, root, nowMs: NOW, legacyGate: legacyAdmit, settings: { cutover: 'enforce' }, log: quiet });
        expect(d).toMatchObject({ admit: false, decidedBy: 'admit', admission: { unknown: true } });
      }
      for (const kind of ['prepare', 'light']) {
        expect(gateLaunch({ kind, root, nowMs: NOW, legacyGate: legacyHold, settings: { cutover: 'enforce' }, log: quiet }))
          .toMatchObject({ admit: true, decidedBy: 'admit', admission: { unknown: true } });
      }
    }
  });
  it('logs old | new, then the decision by admit()', () => {
    writeSnap(snap({ idle: 20 }));
    const lines = [];
    gateLaunch({ kind: 'build', root, nowMs: NOW, legacyGate: legacyHold, settings: { cutover: 'enforce' }, log: (l) => lines.push(l) });
    expect(lines[0]).toMatch(/^resource-shadow gate=launch\.build kind=build old verdict: hold \(legacy load-average hold\) \| new verdict: admit/);
    expect(lines[1]).toMatch(/^resource-gate gate=launch\.build kind=build decided by admit\(\{kind:'build'\}\): admit/);
  });
});

describe('cutoverDecision — shadow keeps the legacy verdict deciding', () => {
  it('shadow: the legacy verdict stands, the shared one is still computed and attached', () => {
    writeSnap(snap({ idle: 50 }));
    const d = gateLaunch({ kind: 'build', root, nowMs: NOW, legacyGate: legacyHold, settings: { cutover: 'shadow' }, log: quiet });
    expect(d).toMatchObject({ admit: false, decidedBy: 'legacy', why: 'legacy load-average hold', admission: { verdict: 'admit' } });
  });
  it('the process env switch WE_RESOURCE_CUTOVER=shadow applies even to a hand-built env', () => {
    vi.stubEnv('WE_RESOURCE_CUTOVER', 'shadow');
    expect(loadResourceGateSettings({ env: {} }).settings.cutover).toBe('shadow');
  });
  it('resolveCutoverMode follows the switch and defaults to enforce', () => {
    expect(resolveCutoverMode({ WE_RESOURCE_CUTOVER: 'shadow' })).toBe('shadow');
    expect(resolveCutoverMode({ WE_RESOURCE_CUTOVER: 'enforce' })).toBe('enforce');
    expect(resolveCutoverMode({ WE_RESOURCE_CUTOVER: 'bogus' })).toBe('enforce');
  });
  it('a throwing observer and a throwing admit() leave the legacy result (never throws)', () => {
    const d = cutoverDecision({ gate: 'g', kind: 'build', legacy: { admit: true }, mode: 'enforce',
      shadow: () => { throw Error('x'); }, admitFn: () => { throw Error('y'); } });
    expect(d).toEqual({ admit: true, decidedBy: 'legacy' });
  });
});

describe('light launches (cost admission) decide through admit({kind:"light"})', () => {
  const settings = resolveCostAdmissionSettings({ env: { WE_COST_ADMISSION: 'on' } });
  it('admit() replaces the legacy light CPU floor; budget and light cap still refuse first', () => {
    writeSnap(snap({ idle: 3 })); // below the light floor 5
    vi.stubEnv('WE_COORDINATION_ROOT', root);
    const facts = { cpuIdlePct: 50, memFreePct: 40, minMemFreePct: 15 };
    const resource = lightResourceDecision({ env: { WE_COORDINATION_ROOT: root }, facts, now: NOW, settings, gateSettings: { cutover: 'enforce' } });
    expect(resource).toMatchObject({ admit: false, decidedBy: 'admit' });
    expect(admitLaunch({ kind: 'prepare-item', settings, facts: { ...facts, resource, lightInFlight: 0 } })).toMatchObject({ admit: false, reason: 'resource-admission' });
    expect(admitLaunch({ kind: 'prepare-item', settings, facts: { ...facts, resource, lightInFlight: 9 } })).toMatchObject({ admit: false, reason: 'light-cap' });
    writeSnap(snap({ idle: 6 }));
    const ok = lightResourceDecision({ env: { WE_COORDINATION_ROOT: root }, facts: { ...facts, cpuIdlePct: 1 }, now: NOW, settings, gateSettings: { cutover: 'enforce' } });
    expect(admitLaunch({ kind: 'prepare-item', settings, facts: { ...facts, cpuIdlePct: 1, resource: ok, lightInFlight: 0 } })).toMatchObject({ admit: true, rule: 'light' });
  });
  it('a stale snapshot admits light work (logged as unknown)', () => {
    writeSnap(snap({ ageMs: 600000 }));
    const d = lightResourceDecision({ env: { WE_COORDINATION_ROOT: root }, facts: {}, now: NOW, settings, gateSettings: { cutover: 'enforce' } });
    expect(d).toMatchObject({ admit: true, decidedBy: 'admit', admission: { unknown: true } });
  });
  it('the production call (no explicit settings) resolves the default settings layer and still decides', () => {
    writeSnap(snap({ idle: 3 }));
    const d = lightResourceDecision({ env: { WE_COORDINATION_ROOT: root }, facts: { cpuIdlePct: 50, memFreePct: 40, minMemFreePct: 15 }, now: NOW, gateSettings: { cutover: 'enforce' } });
    expect(d).toMatchObject({ admit: false, decidedBy: 'admit' });
  });
  it('a legacy-decided resource fact (shadow) leaves the legacy floor in force', () => {
    const facts = { cpuIdlePct: 2, resource: { admit: true, decidedBy: 'legacy' }, lightInFlight: 0 };
    expect(admitLaunch({ kind: 'prepare-item', settings, facts })).toMatchObject({ admit: false, reason: 'light-cpu-floor' });
  });
});

describe('settings — one resourceGate block through the policy cascade, with sources', () => {
  it('standard → platform → tool → env per leaf; invalid values never override', () => {
    const r = resolveResourceGateSettings({
      platform: { cutover: 'shadow', fixCap: { raiseQueueOver: 3, ceiling: 'lots' } },
      tool: { fixCap: { holdCpuIdleBelowPct: 12 } },
      env: { WE_FIX_DISPATCH_MAX_CONCURRENT: '8', WE_RESOURCE_CUTOVER: 'enforce', WE_FIX_CAP_RAISE_MAX_SWAP_USED_PCT: '50' }, legacyFloor: 2,
    });
    expect(r.settings).toEqual({ cutover: 'enforce', fixCap: { floor: 8, ceiling: 12, ceilingAboveFloor: 4, raiseQueueOver: 3, raiseStepPerPass: 2,
      raiseMinMemFreePct: 10, raiseMaxSwapUsedPct: 50, raiseMaxHeavyWaitMinutes: 15,
      lowerBelowMemFreePct: 3, lowerAboveSwapUsedPct: 90, lowerAboveHeavyWaitMinutes: 45, lowerBy: 4, lowerMinimum: 2,
      holdCpuIdleBelowPct: 12 } });
    expect(r.sources).toMatchObject({ cutover: 'env WE_RESOURCE_CUTOVER', 'fixCap.floor': 'env WE_FIX_DISPATCH_MAX_CONCURRENT',
      'fixCap.ceiling': 'floor + 4', 'fixCap.raiseQueueOver': 'platform', 'fixCap.holdCpuIdleBelowPct': 'tool', 'fixCap.raiseStepPerPass': 'standard',
      'fixCap.raiseMaxSwapUsedPct': 'env WE_FIX_CAP_RAISE_MAX_SWAP_USED_PCT' });
    expect(r.invalid).toEqual(['platform.fixCap.ceiling="lots"']);
  });
  it('defaults: enforce; floor = the legacy static cap; a ceiling below the floor is raised to it', () => {
    expect(RESOURCE_GATE_STANDARD.cutover).toBe('enforce');
    const r = resolveResourceGateSettings({ tool: { fixCap: { ceiling: 3 } }, env: {}, legacyFloor: 6 });
    expect(r.settings.fixCap).toMatchObject({ floor: 6, ceiling: 6 });
    expect(r.sources['fixCap.floor']).toBe('standard (fixDispatchMaxConcurrent)');
  });
  it('logs each leaf with its source once per distinct set', () => {
    const lines = [];
    const r = resolveResourceGateSettings({ env: { WE_FIX_DISPATCH_MAX_CEILING: '11' }, legacyFloor: 7 });
    expect(logGateSettingsOnce(r, (l) => lines.push(l))).toBe(true);
    expect(logGateSettingsOnce(r, (l) => lines.push(l))).toBe(false);
    expect(lines[0]).toContain('fixCap.floor=7 (standard (fixDispatchMaxConcurrent))');
    expect(lines[0]).toContain('fixCap.ceiling=11 (env WE_FIX_DISPATCH_MAX_CEILING)');
  });
});

describe('dynamic fixer cap', () => {
  const fixCap = { ...RESOURCE_GATE_STANDARD.fixCap, floor: 8, ceiling: 12, ceilingAboveFloor: 4, raiseQueueOver: 5, raiseStepPerPass: 2 };
  const cap = (o) => decideFixCap({ fixCap, nowMs: NOW, liveAtPassStart: 8, queueLength: 7, heavyWaitMinutes: 5,
    snapshot: snap({ idle: 45, freePct: 30, swapUsedPct: 20 }), ...o });
  it('raises above the floor when memory and swap are healthy, the heavy-queue wait is short and the fix queue is long', () => {
    expect(cap()).toMatchObject({ cap: 10, raised: true, memFreePct: 30, swapUsedPct: 20, heavyWaitMinutes: 5 });
    expect(cap().reason).toMatch(/mem free 30% ≥ 10%, swap 20% ≤ 60%, heavy wait 5m ≤ 15m and fix queue 7 > 5/);
  });
  it('CPU is only a backstop: 23% idle (live 2026-10-10, held the cap at the floor) now raises; under 10% holds', () => {
    expect(cap({ snapshot: snap({ idle: 23, freePct: 30, swapUsedPct: 20 }) })).toMatchObject({ cap: 10, raised: true });
    const held = cap({ snapshot: snap({ idle: 9, freePct: 30, swapUsedPct: 20 }) });
    expect(held).toMatchObject({ cap: 8, raised: false });
    expect(held.reason).toMatch(/cpu idle 9% < 10% backstop/);
  });
  it.each([
    ['swap nearly full (live 2026-10-10: 26.5 of 27.6 GB)', { snapshot: snap({ idle: 23, freePct: 30, swapUsedPct: 96 }) }, /swap 96% > 90%/],
    ['free memory exhausted', { snapshot: snap({ idle: 50, freePct: 2, swapUsedPct: 20 }) }, /mem free 2% < 3%/],
    ['the heavy queue is backed up', { heavyWaitMinutes: 60 }, /heavy wait 60m > 45m/],
  ])('LOWERS below the floor: %s', (_, o, why) => {
    const d = cap(o);
    expect(d).toMatchObject({ cap: 4, raised: false, lowered: true });
    expect(d.reason).toMatch(why);
  });
  it('never lowers below lowerMinimum', () => {
    expect(decideFixCap({ fixCap: { ...fixCap, floor: 3 }, nowMs: NOW, liveAtPassStart: 3, queueLength: 7, heavyWaitMinutes: 90,
      snapshot: snap({ freePct: 30, swapUsedPct: 20 }) })).toMatchObject({ cap: 2, lowered: true });
  });
  it('a ceiling under the floor handed in directly is normalised to the floor, never exceeded', () => {
    const d = decideFixCap({ fixCap: { ...fixCap, floor: 3, ceiling: 2 }, nowMs: NOW, liveAtPassStart: 3, queueLength: 7, heavyWaitMinutes: 5,
      snapshot: snap({ idle: 45, freePct: 30, swapUsedPct: 20 }) });
    expect(d).toMatchObject({ cap: 3, ceiling: 3, raised: false });
  });
  it.each([
    [1, 1], [1, 3], [2, 2], [3, 3],
  ])('lowering never lifts the cap above the floor (floor %i, ceiling %i, lowerMinimum 2)', (floor, ceiling) => {
    const d = decideFixCap({ fixCap: { ...fixCap, floor, ceiling }, nowMs: NOW, liveAtPassStart: floor, queueLength: 7, heavyWaitMinutes: 90,
      snapshot: snap({ freePct: 30, swapUsedPct: 96 }) });
    expect(d.cap).toBeLessThanOrEqual(floor);
    expect(d.cap).toBeLessThanOrEqual(ceiling);
    expect(d.lowered).toBe(d.cap < floor);
  });
  it.each([
    ['swap above the raise threshold', { snapshot: snap({ idle: 45, freePct: 30, swapUsedPct: 70 }) }],
    ['free memory under the raise threshold', { snapshot: snap({ idle: 45, freePct: 8, swapUsedPct: 20 }) }],
    ['heavy wait over the raise threshold', { heavyWaitMinutes: 20 }],
  ])('holds at the floor (no raise, no lower): %s', (_, o) => {
    expect(cap(o)).toMatchObject({ cap: 8, raised: false, lowered: false });
  });
  it('an unknown memory / swap / heavy-wait reading never blocks a raise on its own, and is named in the reason', () => {
    const d = cap({ snapshot: snap({ idle: 45 }), heavyWaitMinutes: null });
    expect(d).toMatchObject({ cap: 10, raised: true });
    expect(d.reason).toMatch(/mem free \?%/);
    expect(d.reason).toMatch(/heavy wait \?m/);
  });
  it('never above the ceiling', () => {
    expect(cap({ liveAtPassStart: 11 })).toMatchObject({ cap: 12, raised: true });
    expect(cap({ liveAtPassStart: 30 })).toMatchObject({ cap: 12 });
  });
  it.each([
    ['queue at the threshold', { queueLength: 5 }],
    ['unknown queue', { queueLength: null }],
    ['CPU under the backstop', { snapshot: snap({ idle: 9.9, freePct: 30, swapUsedPct: 20 }) }],
    ['fix not admitted (memory critical)', { snapshot: snap({ idle: 90, pressure: 4 }) }],
    ['stale snapshot', { snapshot: snap({ idle: 90, ageMs: 600000 }) }],
    ['missing snapshot', { snapshot: null }],
    ['live far below the floor', { liveAtPassStart: 2 }],
  ])('stays at the floor: %s', (_, o) => {
    expect(cap(o)).toMatchObject({ cap: 8, raised: false });
  });
  it('the throttle admits a fixer above the old static cap when raised, then refuses at the computed cap', () => {
    const claims = Array.from({ length: 8 }, (_, i) => ({ meta: { kind: 'fix', repo: 'we', pr: i + 1 } }));
    const lines = [];
    const t = createResourceFixThrottle({ listClaims: () => claims, alive: () => true, queueLength: () => 7, readSnap: () => snap({ idle: 45 }), readHeavyWait: () => 5,
      nowMs: () => NOW, settings: { cutover: 'enforce', fixCap }, gate: () => ({ admit: true, note: 'admit() admitted' }),
      env: { WE_FIX_DISPATCH_MAX_CONCURRENT: '8' }, log: (l) => lines.push(l) });
    expect(t.tryAdmit('fix')).toMatchObject({ admit: true, aboveStaticCap: true });
    expect(t.tryAdmit('ci-heal')).toMatchObject({ admit: true, aboveStaticCap: true });
    const third = t.tryAdmit('fix');
    expect(third).toMatchObject({ admit: false, kind: 'fix-cap' });
    expect(third.why).toContain('cap 10 (dynamic fixer cap: floor 8, ceiling 12');
    expect(lines[0]).toMatch(/^resource-gate fix-cap: old: static cap 8 \| new: cap 10 .* → using 10 \(enforce\)/);
    // the log line names the new inputs and where each threshold came from
    expect(lines[0]).toMatch(/inputs: mem free \?% · swap \?% · heavy wait 5m · cpu idle 45% · fix queue 7/);
    expect(lines[0]).toMatch(/thresholds: .*raiseMaxSwapUsedPct=60 \(standard\)/);
  });
  it('shadow: the static cap decides; the computed cap is only logged', () => {
    const claims = Array.from({ length: 8 }, (_, i) => ({ meta: { kind: 'fix', repo: 'we', pr: i + 1 } }));
    const lines = [];
    const t = createResourceFixThrottle({ listClaims: () => claims, alive: () => true, queueLength: 7, readSnap: () => snap({ idle: 45 }), readHeavyWait: () => 5,
      nowMs: () => NOW, settings: { cutover: 'shadow', fixCap }, gate: () => ({ admit: true }), env: { WE_FIX_DISPATCH_MAX_CONCURRENT: '8' }, log: (l) => lines.push(l) });
    expect(t.tryAdmit('fix')).toMatchObject({ admit: false, kind: 'fix-cap' });
    expect(lines[0]).toContain('new: cap 10');
    expect(lines[0]).toContain('using 8 (shadow)');
  });
  it('a held host gate refuses without counting a slot', () => {
    let calls = 0;
    const t = createResourceFixThrottle({ listClaims: () => [], queueLength: 0, readSnap: () => snap(), nowMs: () => NOW,
      settings: { cutover: 'enforce', fixCap: { ...fixCap, floor: 1, ceiling: 1 } }, log: quiet,
      gate: () => (calls++ === 0 ? { admit: false, kind: 'host-load', why: 'held' } : { admit: true }) });
    expect(t.tryAdmit('fix')).toMatchObject({ admit: false, kind: 'host-load' });
    expect(t.tryAdmit('fix').admit).toBe(true);
    expect(t.tryAdmit('fix')).toMatchObject({ admit: false, kind: 'fix-cap' });
  });
});
