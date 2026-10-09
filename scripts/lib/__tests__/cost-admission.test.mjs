// Card x60i0ie — cost-class admission: the pure rule, its settings and its report line.
import { describe, it, expect } from 'vitest';
import {
  JOB_COST_CLASS, jobCostClass, COST_ADMISSION_BUILT_IN, resolveCostAdmissionSettings, costAdmissionOn, usesLightRule,
  lightCapFor, freezeHolds, tokenBudgetExhausted, admitLaunch, summarizeCostAdmission,
} from '../cost-admission.mjs';
import { sumClaudeUsdForDay } from '../cost-admission-facts.mjs';
import { hostLoadGate } from '../dispatch-throttle.mjs';

const ON = resolveCostAdmissionSettings({ env: { WE_COST_ADMISSION: 'on' } });
const OFF = resolveCostAdmissionSettings({});

describe('job cost classes', () => {
  it('heavy = runs local tests/builds; light = model + card only', () => {
    for (const k of ['build', 'fix', 'ci-heal', 'investigate', 'review']) expect(jobCostClass(k)).toBe('heavy');
    for (const k of ['prepare', 'prepare-item', 'prepare-decision', 'task-agreement', 'design', 'prep-pass', 'review-juror', 'coroner-sample']) {
      expect(jobCostClass(k)).toBe('light');
    }
  });
  it('an unknown kind is heavy (the safe default never loosens a gate)', () => {
    expect(jobCostClass('something-new')).toBe('heavy');
    expect(jobCostClass(undefined)).toBe('heavy');
    expect(Object.isFrozen(JOB_COST_CLASS)).toBe(true);
  });
});

describe('settings', () => {
  it('built-in is OFF (today\'s behaviour)', () => {
    expect(OFF).toEqual(COST_ADMISSION_BUILT_IN);
    expect(costAdmissionOn(OFF)).toBe(false);
    expect(costAdmissionOn(null)).toBe(false);
  });
  it('env wins over the file, the file over the built-in; invalid values fall through, never to on', () => {
    const file = { costAdmission: { mode: 'on', lightMaxConcurrent: 4, lightCpuIdleMinPct: 7, claudeDailyUsdBudget: 900, lightOpenPrFreeze: 'honour' } };
    expect(resolveCostAdmissionSettings({ file })).toEqual({ mode: 'on', lightMaxConcurrent: 4, lightCpuIdleMinPct: 7, claudeDailyUsdBudget: 900, lightOpenPrFreeze: 'honour' });
    expect(resolveCostAdmissionSettings({ file, env: { WE_COST_ADMISSION: 'off', WE_LIGHT_MAX_CONCURRENT: '9', WE_CLAUDE_DAILY_USD_BUDGET: 'off' } }))
      .toMatchObject({ mode: 'off', lightMaxConcurrent: 9, claudeDailyUsdBudget: null });
    expect(resolveCostAdmissionSettings({ env: { WE_COST_ADMISSION: 'yes', WE_LIGHT_MAX_CONCURRENT: '-1', WE_MIN_CPU_IDLE_PCT_LIGHT: '200' } }))
      .toEqual(COST_ADMISSION_BUILT_IN);
    expect(resolveCostAdmissionSettings({ file: { costAdmission: { mode: 'maybe' } } }).mode).toBe('off');
  });
});

describe('admitLaunch — the rule', () => {
  // REPLAY FIXTURE — build-dispatch-daemon.log 2026-10-08T13:37:51Z (ET 09:37): three build launches deferred at
  // cpu idle 5.3% < the 15% build floor. A heavy launch keeps that exact verdict with the rule ON or OFF.
  const live0937 = hostLoadGate({ kind: 'build', cpuIdlePct: 5.3, memFreePct: 80, minIdlePct: 15 });

  it('heavy work keeps today\'s gate exactly, rule ON or OFF', () => {
    for (const settings of [OFF, ON]) {
      const d = admitLaunch({ kind: 'build', settings, legacy: live0937 });
      expect(d).toMatchObject({ admit: false, costClass: 'heavy', rule: 'legacy', reason: 'host-load' });
      expect(d.why).toContain('5.3% idle < 15% needed for build');
      expect(admitLaunch({ kind: 'fix', settings, legacy: { admit: true } })).toMatchObject({ admit: true, rule: 'legacy' });
    }
  });

  it('OFF: a light kind also keeps today\'s gate (the prepare floor of 20%)', () => {
    const legacy = hostLoadGate({ kind: 'prepare', cpuIdlePct: 12, minIdlePct: 20 });
    expect(admitLaunch({ kind: 'prepare-item', settings: OFF, legacy })).toMatchObject({ admit: false, rule: 'legacy', reason: 'host-load' });
  });

  it('ON: a light prepare is admitted while the heavy gates are shut, above the gentle floor', () => {
    // Same moment as a heavy refusal at 12% idle (build floor 15%, prepare floor 20%): light is admitted at 5%.
    const legacy = hostLoadGate({ kind: 'prepare', cpuIdlePct: 12, minIdlePct: 20 });
    const d = admitLaunch({ kind: 'prepare-item', settings: ON, legacy, facts: { cpuIdlePct: 12, lightInFlight: 2 } });
    expect(d).toMatchObject({ admit: true, costClass: 'light', rule: 'light', reason: 'admitted' });
  });

  it('ON: the light gates, in order — budget, cap, CPU floor, memory', () => {
    const s = { ...ON, claudeDailyUsdBudget: 800 };
    expect(admitLaunch({ kind: 'prepare-item', settings: s, facts: { claudeUsdToday: 865.06, lightInFlight: 9, cpuIdlePct: 1 } }))
      .toMatchObject({ admit: false, reason: 'token-budget' });
    expect(admitLaunch({ kind: 'prepare-item', settings: ON, facts: { lightInFlight: 6, cpuIdlePct: 1 } }))
      .toMatchObject({ admit: false, reason: 'light-cap' });
    const floor = admitLaunch({ kind: 'prepare-item', settings: ON, facts: { lightInFlight: 0, cpuIdlePct: 4.9 } });
    expect(floor).toMatchObject({ admit: false, reason: 'light-cpu-floor' });
    expect(floor.why).toContain('4.9% < light floor 5%');
    expect(admitLaunch({ kind: 'prepare-item', settings: ON, facts: { cpuIdlePct: 50, memFreePct: 10, minMemFreePct: 15 } }))
      .toMatchObject({ admit: false, reason: 'mem-free' });
  });

  it('unreadable facts fail OPEN (a missing meter never stops work)', () => {
    expect(admitLaunch({ kind: 'prepare-item', settings: { ...ON, claudeDailyUsdBudget: 10 }, facts: {} })).toMatchObject({ admit: true });
    expect(tokenBudgetExhausted({ claudeUsdToday: null }, { claudeDailyUsdBudget: 10 })).toBe(false);
    expect(tokenBudgetExhausted({ claudeUsdToday: 999 }, ON)).toBe(false); // no budget set
  });
});

describe('caps and freezes', () => {
  it('lightCapFor: the light cap only for a light kind with the rule ON', () => {
    expect(lightCapFor('prepare-item', OFF, 2)).toBe(2);
    expect(lightCapFor('prepare-item', ON, 2)).toBe(6);
    expect(lightCapFor('build', ON, 2)).toBe(2);
    expect(usesLightRule('build', ON)).toBe(false);
  });

  it('freezeHolds: light skips ONLY an open-PR-count freeze; kill switch and labels hold everything', () => {
    // REPLAY FIXTURE — build-dispatch-daemon.log 2026-10-08T20:55:52Z: "19 open PRs > maxOpenPrs 12".
    const openPrs = { frozen: true, reasons: ['19 open PRs > maxOpenPrs 12'], kinds: ['open-prs'] };
    expect(freezeHolds('prepare-item', openPrs, OFF)).toBe(true);
    expect(freezeHolds('prepare-item', openPrs, ON)).toBe(false);
    expect(freezeHolds('build', openPrs, ON)).toBe(true);
    expect(freezeHolds('prepare-item', openPrs, { ...ON, lightOpenPrFreeze: 'honour' })).toBe(true);
    expect(freezeHolds('prepare-item', { frozen: true, kinds: ['open-prs', 'kill-switch'] }, ON)).toBe(true);
    expect(freezeHolds('prepare-item', { frozen: true, kinds: ['label'] }, ON)).toBe(true);
    expect(freezeHolds('prepare-item', { frozen: true, reasons: ['x'] }, ON)).toBe(true); // no kinds: not proven open-PR-only
    expect(freezeHolds('prepare-item', { frozen: false }, OFF)).toBe(false);
  });
});

describe('report line', () => {
  it('names heavy vs light admitted/refused and why', () => {
    const decisions = [
      { costClass: 'heavy', admit: false, reason: 'host-load' },
      { costClass: 'heavy', admit: false, reason: 'host-load' },
      { costClass: 'light', admit: true, reason: 'admitted' },
      { costClass: 'light', admit: false, reason: 'light-cap' },
    ];
    const { line, tally } = summarizeCostAdmission(decisions, { settings: ON, facts: { cpuIdlePct: 22.04, claudeUsdToday: 865.06 } });
    expect(tally.light.admitted).toBe(1);
    expect(line).toBe('cost-admission on, light cap 6, light floor 5% · heavy 0 admitted / 2 refused (host-load 2) · light 1 admitted / 1 refused (light-cap 1) · cpu idle 22.0% · claude $865 today (no budget)');
    expect(summarizeCostAdmission([], { settings: OFF }).line).toBe('cost-admission off · heavy 0 admitted / 0 refused · light 0 admitted / 0 refused · cpu idle ? · claude spend ? (no budget)');
  });
});

describe('claude spend fact', () => {
  it('sums claude_code.cost.usage on the ET day only; no records = null, not $0', () => {
    const rec = (receivedAt, value, name = 'claude_code.cost.usage') => ({ receivedAt, value, name });
    const records = [
      rec('2026-10-08T03:59:00Z', 100), // 2026-10-07 23:59 ET — yesterday
      rec('2026-10-08T04:01:00Z', 1.5), // 00:01 ET
      rec('2026-10-08T20:57:56.984Z', 0.315193),
      rec('2026-10-09T03:00:00Z', 2), // 23:00 ET, still 10-08
      rec('2026-10-08T12:00:00Z', 5, 'claude_code.token.usage'),
    ];
    expect(sumClaudeUsdForDay(records, '2026-10-08')).toBeCloseTo(3.815193, 6);
    expect(sumClaudeUsdForDay([], '2026-10-08')).toBeNull();
  });
});
