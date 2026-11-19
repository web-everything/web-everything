import { describe, it, expect } from 'vitest';
import { planCapacity, planHorizon, workingSlot, resetSlot, HOUR } from './capacity-planner.mjs';
import { chooseBuilder, readProviderCapacity, PROVIDER_DEFAULTS, scoreProvider, burnWindows } from './provider-capacity.mjs';
import { resolveRoutingSettings } from './routing-settings.mjs';
import { capacityCalendar, renderCalendar, capacityCalendarOperation } from '../operations/capacity-calendar.mjs';
import { validateInput } from '../operations/registry.mjs';
const now = Date.parse('2026-11-19T15:00:00Z'); // Thursday 10am ET
const bucket = (count, hours) => ({ count, expiresAt: new Date(now + hours * HOUR).toISOString() });
const cap = (model = 'restartOnReset', used = 30, extra = {}) => ({ provider: 'codex', account: 'codex', windowModel: model,
  known: true, health: 1, windows: [{ name: 'weekly', usedPercent: used, resetsAt: now + 144 * HOUR, lengthHours: 168 }], now, ...extra });
const plan = (c, opts = {}, config = {}) => planCapacity(c, config, { now, ...opts });

describe('per-window-model planner', () => {
  it('Claude 40% with one day of seven left burns at a higher rate', () => {
    const c = cap('fixed', 40); c.windows[0].resetsAt = now + 24 * HOUR;
    expect(plan(c)).toMatchObject({ action: 'burn', pace: 'behind', desiredRatePerHour: 2.5 });
  });
  it('Codex 30% with two resets holds and paces; 97% only resets with queued demand', () => {
    const c = cap('restartOnReset', 30, { bankedResets: [bucket(2, 240)] });
    expect(plan(c, { demandRatePerHour: 2 })).toMatchObject({ action: 'hold-reset', burnAggressively: false });
    c.windows[0].usedPercent = 97;
    expect(plan(c, { queuedDemand: 1 }).action).toBe('reset-now');
    expect(plan(c).action).toBe('hold-reset');
  });
  it('required rate uses current remainder plus banked capacity and cumulative expiry deadlines', () => {
    const p = plan(cap('restartOnReset', 30, { bankedResets: [bucket(1, 10), bucket(1, 20)] }), { demandRatePerHour: 2 });
    expect(p.requiredRatePerHour).toBe(17);
    expect(p).toMatchObject({ bankedCount: 2, onTrack: false, burnAggressively: true, scoreBoost: 3, pullWork: ['audits', 'red-teams', 'backlog-builds'] });
    const c = cap('restartOnReset', 30, { bankedResets: [bucket(2, 10)], currentRatePerHour: 1 });
    expect(scoreProvider(c, 'fix', { now }).paceFactor).toBeGreaterThan(1);
    expect(burnWindows([c], { now })[0]).toMatchObject({ kind: 'capacity-burn-window', pullWork: ['audits', 'red-teams', 'backlog-builds'] });
  });
  it('no banked resets uses fixed-window pacing and never invents future grants', () => {
    const c = cap('restartOnReset', 40, { bankedResets: [] }); c.windows[0].resetsAt = now + 24 * HOUR;
    expect(plan(c)).toMatchObject({ action: 'pace', pacingAction: 'burn', bankedCount: 0 });
    expect(plan({ ...c, grantCadenceDays: 1 })).toEqual(plan(c));
    const args = { capacities: [c], now, demandPerDay: 200 };
    expect(planHorizon({ ...args, capacities: [{ ...c, grantCadenceDays: 1 }] })).toEqual(planHorizon(args));
  });
  it('rolling over-rate slows and unknown length stays unknown', () => {
    const c = cap('rolling'); c.windows[0].lengthHours = 10;
    expect(plan(c, { demandRatePerHour: 12 })).toMatchObject({ allowedRatePerHour: 10, action: 'slow' });
    c.windows[0].lengthHours = null;
    expect(plan(c, { demandRatePerHour: 12 })).toMatchObject({ allowedRatePerHour: null, pace: 'unknown' });
  });
  it('unknown demand, malformed evidence and oversized inventory require operator input', () => {
    expect(plan(cap('restartOnReset', 30, { bankedResets: [bucket(1, 10)] })).onTrack).toBeNull();
    expect(plan(cap('restartOnReset', 30, { bankedResets: [bucket(1001, 10)] })).needsOperatorInput).toMatch(/1000/);
    expect(workingSlot(now, 1, { start: 'bad' })).toBeNull();
    expect(planHorizon({ capacities: [], days: 91 })).toHaveProperty('needsOperatorInput');
  });
});

describe('operator working slots', () => {
  const start = Date.parse('2026-11-19T23:00:00Z'); // 6pm
  const at = start + 6 * HOUR;
  it('overnight crossing resets the previous evening when expiry loss is greater', () => {
    const p = resetSlot({ at, now: start, usedPercent: 35, rate: 10, buckets: [{ count: 1, expiry: at + HOUR }] });
    expect(p.choice).toBe('early-reset'); expect(p.forfeitPercent).toBeCloseTo(45.1667, 3);
    expect(p.throttleWastePercent).toBe(100);
    expect(new Date(p.at).toISOString()).toBe('2026-11-20T00:59:00.000Z');
  });
  it('throttles overnight when the bank has time to be consumed later', () => {
    const p = resetSlot({ at, now: start, usedPercent: 35, rate: 10, buckets: [{ count: 1, expiry: at + 100 * HOUR }] });
    expect(p).toMatchObject({ choice: 'throttle', throttleWastePercent: 0 });
    expect(new Date(p.at).toISOString()).toBe('2026-11-20T14:00:00.000Z');
  });
  it('weekend crossing waits until Monday and consumes earliest expiry first', () => {
    const saturday = Date.parse('2026-11-21T12:00:00Z');
    expect(new Date(workingSlot(saturday)).toISOString()).toBe('2026-11-23T14:00:00.000Z');
    const p = plan(cap('restartOnReset', 30, { bankedResets: [bucket(1, 200), bucket(1, 20)] }), { demandRatePerHour: 10 });
    expect(p.resetChoices[0].expiresAt).toBe(bucket(1, 20).expiresAt);
    expect(p.resetPlan.length).toBe(2);
  });
  it('never alerts outside working hours even at 97% with queued demand', () => {
    const c = cap('restartOnReset', 97, { bankedResets: [bucket(1, 100)] });
    expect(planCapacity(c, {}, { now: at, queuedDemand: 1 }).action).toBe('hold-reset');
  });
});

describe('accounts, config and horizon', () => {
  it('inactive accounts never route; shortfall for three working days recommends activation', () => {
    const active = cap('fixed', 100, { provider: 'claude', account: 'claude-a', bankedResets: [] });
    const inactive = { ...active, account: 'claude-c', active: false };
    expect(chooseBuilder({ capacities: [inactive], fallback: 'claude' }).provider).toBeNull();
    const h = planHorizon({ capacities: [active, inactive], demandPerDay: 100, now, days: 7 });
    expect(h.days.every(d => d.entries.length === 1)).toBe(true);
    expect(h.recommendations[0]).toMatchObject({ action: 'activate-account', command: 'activate claude-c' });
    expect(planHorizon({ capacities: [active, inactive], demandPerDay: 100, now, days: 2 }).recommendations).toEqual([]);
    expect(planHorizon({ capacities: [active, inactive], now }).recommendations).toEqual([]);
  });
  it('banked capacity prevents shortfall; aliases and future grants never add quota', () => {
    const c = cap('fixed', 100, { bankedResets: [bucket(3, 200)] });
    // Isolate inventory from operator availability: the default calendar closes over the weekend.
    const config = { workingHours: { start: '00:00', end: '24:00', tz: 'America/New_York', days: [0, 1, 2, 3, 4, 5, 6] } };
    const h = planHorizon({ capacities: [c, { ...c, provider: 'codex-alt', quotaOf: 'codex' }], config, now, days: 2, demandPerDay: 100 });
    expect(h.days[0].entries).toHaveLength(1);
    expect(h.days.every(d => !d.entries[0].shortfall)).toBe(true);
  });
  it('banked inventory can still shortfall when the next reset waits through the weekend', () => {
    const c = cap('fixed', 100, { bankedResets: [bucket(3, 200)] });
    const h = planHorizon({ capacities: [c], now, days: 2, demandPerDay: 100 });
    expect(h.days[0].entries[0].shortfall).toBe(false);
    expect(h.days[1].entries[0]).toMatchObject({ shortfall: true, bankedConsumed: [], expectedDemand: 100 });
  });
  it('calendar flags are optional, default false, and accept explicit booleans only', () => {
    const { input } = capacityCalendarOperation();
    expect(input.horizon).toMatchObject({ type: 'boolean', required: false, default: false });
    expect(input.json).toMatchObject({ type: 'boolean', required: false, default: false });
    expect(validateInput(input, {})).toMatchObject({ ok: true, value: { horizon: false, json: false } });
    expect(validateInput(input, { horizon: true, json: true })).toMatchObject({ ok: true, value: { horizon: true, json: true } });
    expect(validateInput(input, { horizon: 'true' }).ok).toBe(false);
    expect(validateInput(input, { json: 'true' }).ok).toBe(false);
  });
  it('unassigned Claude file stays unknown for both; assigned account alone is known', () => {
    const providers = PROVIDER_DEFAULTS.providers;
    const readers = { claude: () => ({ at: now, seven_day: { used_percentage: 20, resets_at: new Date(now + 24 * HOUR).toISOString() } }) };
    const cs = readProviderCapacity({ now, readers, settings: { providers } }).filter(c => c.provider === 'claude');
    expect(cs.map(c => c.known)).toEqual([false, false]);
    const assigned = readProviderCapacity({ now, readers, settings: { providers, claudeUsageAccount: 'claude-b' } }).filter(c => c.provider === 'claude');
    expect(assigned.map(c => c.known)).toEqual([false, true]);
    expect(renderCalendar(capacityCalendar({ capacities: cs, settings: {}, now, horizon: true }))).toMatch(/account unknown/);
    expect(capacityCalendarOperation().input.horizon.type).toBe('boolean');
  });
  it('operator seed only wins against missing or older live Codex readings; aliases share quota', () => {
    const asOf = Date.parse('2026-11-19T12:31:00Z');
    const read = at => readProviderCapacity({ now, readers: { codex: () => ({ at, used_percent: 50, resets_at: now + HOUR }) } });
    expect(read(asOf - 1)[0].windows[0]).toMatchObject({ usedPercent: 27, source: 'operator' });
    const live = read(asOf + 1); expect(live[0].windows[0].usedPercent).toBe(50);
    expect(live.find(c => c.provider === 'codex-alt').windows).toEqual(live[0].windows);
  });
  it('minimum tiers exclude tier two and select the higher scoring eligible provider', () => {
    const capacities = [cap('fixed', 20, { tier: 3 }), cap('fixed', 10, { provider: 'claude', tier: 3 }), cap('fixed', 0, { provider: 'agy-gemini', tier: 2, allowedKinds: ['fix'] })];
    const result = chooseBuilder({ kind: 'fix', capacities, settings: { routeKey: 'fix:critical-work', now } });
    expect(result.provider).toBe('claude'); expect(result.inputs[2].label).toBe('tier-excluded');
    capacities[0].windows[0].usedPercent = 0;
    expect(chooseBuilder({ kind: 'fix', capacities, settings: { routeKey: 'fix:critical-work', now } }).provider).toBe('codex');
  });
  it('settings use the declared provider block and expose provenance', () => {
    const providers = [{ ...PROVIDER_DEFAULTS.providers[0], id: 'new-model' }];
    const s = resolveRoutingSettings({ repo: { providerCapacity: { providers } }, env: {} });
    expect(s.capacity.providers).toEqual(providers); expect(s.providerCapacitySources.providers).toBe('tool');
  });
});
