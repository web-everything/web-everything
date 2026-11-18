import { describe, expect, it } from 'vitest';
import { resourceStep, shadowTune } from '../delivery-capacity-tune.mjs';
import { DELIVERY_CAPACITY_DEFAULTS, assessCapacity } from '../delivery-capacity.mjs';

const NOW = Date.UTC(2026, 10, 15, 12);
const H = 3600000;
const policy = {
  ...structuredClone(DELIVERY_CAPACITY_DEFAULTS), mode: 'units',
  autoTune: { ...DELIVERY_CAPACITY_DEFAULTS.autoTune,
    heavyWaitMaxMin: 10, lanesFreeMin: 3, activeHighRatio: 0.6, activeLowRatio: 0.3,
    sessionUnits: 1, minutesPerUnit: 30, laneUnits: 0.5, rebaseUnits: 0.25 },
};
const waitingPr = number => ({ number, liveSessions: 0, ciMin: 0, heavyMin: 0, laneHeld: false, rebases: 0 });
const resources = () => ({ heavyWaitMin: 0, lanesFree: 5, prs: [waitingPr(1)] });
const readout = () => ({
  ...assessCapacity({ prs: [], host: { idlePct: 30, memGb: 8 }, policy, nowMs: NOW }),
  used: 30, verdict: 'deliver', slots: 0,
});
const tune = (overrides = {}) => shadowTune({
  readout: readout(), policy, resources: resources(), merged: [], rows: [], nowMs: NOW, ...overrides,
});
const step = (signals = {}, overrides = {}) => resourceStep({
  cap: 30, signals: { idlePct: 30, memGb: 8, ...resources(), capBinding: true, ...signals },
  policy, last: null, nowMs: NOW, ...overrides,
});
const hold = (row, reason, cap = 30) => expect(row).toMatchObject({
  action: 'hold', from: cap, to: cap, changed: false, reason,
});
const freeze = value => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const suggestion = ({ action, from, to, changed, reason }) => ({ action, from, to, changed, reason });

describe('R940 resource-based shadow tuning', () => {
  it('idle waiting PRs: many PRs with zero activity weigh zero and cause no reduction', () => {
    const idle = { ...resources(), prs: Array.from({ length: 100 }, (_, i) => waitingPr(i + 1)) };
    expect(tune({ resources: idle }).row).toMatchObject({ action: 'raise', from: 30, to: 32, changed: true });
    expect(step({ prs: idle.prs })).toMatchObject({ action: 'raise', from: 30, to: 32, changed: true });
  });

  it('busy PRs: live sessions plus heavy minutes lower the suggested cap', () => {
    // Three PRs at 3 + 120/30 = 7 units each exceed the 18-unit high threshold.
    const busy = { ...resources(), prs: [1, 2, 3].map(number => ({
      ...waitingPr(number), liveSessions: 3, heavyMin: 120,
    })) };
    expect(tune({ resources: busy }).row).toMatchObject({ action: 'lower', from: 30, to: 24, changed: true });
  });

  it('counts sessions, CI, heavy work, held lanes and rebases using policy weights', () => {
    // Each PR is 1 + (15+15)/30 + 0.5 + 2*0.25 = 3 units: total exactly 18.
    const prs = Array.from({ length: 6 }, (_, i) => ({
      number: i + 1, liveSessions: 1, ciMin: 15, heavyMin: 15, laneHeld: true, rebases: 2,
    }));
    expect(step({ prs })).toMatchObject({ action: 'lower', to: 24 });
    const lighter = { ...policy, autoTune: { ...policy.autoTune, sessionUnits: 0.5,
      minutesPerUnit: 60, laneUnits: 0.25, rebaseUnits: 0.125 } };
    expect(step({ prs }, { policy: lighter })).toMatchObject({ action: 'raise', to: 32 });
  });

  it.each([
    ['idle', () => ({ readout: { ...readout(), why: ['gate open (idle NaN% mem 8GB)'] } })],
    ['memory', () => ({ readout: { ...readout(), why: ['gate open (idle 30% mem InfinityGB)'] } })],
    ['heavyWait', () => ({ resources: { ...resources(), heavyWaitMin: undefined } })],
    ['lanes', () => ({ resources: { ...resources(), lanesFree: NaN } })],
    ...['number', 'liveSessions', 'ciMin', 'heavyMin', 'rebases'].map(field => [
      'PR ' + field, () => ({ resources: { ...resources(), prs: [{ ...waitingPr(1), [field]: Infinity }] } }),
    ]),
    ['resources absent', () => ({ resources: undefined })],
  ])('unknown reading (%s): holds and never raises', (_name, overrides) => {
    hold(tune(overrides()).row, 'resource evidence unreadable');
  });

  it.each(['idlePct', 'memGb', 'heavyWaitMin', 'lanesFree'])('resourceStep fails closed on missing %s', field => {
    hold(step({ [field]: undefined }), 'resource evidence unreadable');
  });

  it.each(['number', 'liveSessions', 'ciMin', 'heavyMin', 'laneHeld', 'rebases'])(
    'resourceStep holds when %s evidence is missing from a PR', field => {
      const pr = waitingPr(1);
      expect(step({ prs: [pr] })).toMatchObject({ action: 'raise', changed: true, to: 32 });
      delete pr[field];
      hold(step({ prs: [pr] }), 'resource evidence unreadable');
      hold(tune({ resources: { ...resources(), prs: [pr] } }).row, 'resource evidence unreadable');
    },
  );

  it('TTM-only change produces an identical suggestion; merge statistics are info only', () => {
    const merged = (hours, partial = false) => Array.from({ length: 12 }, (_, i) => ({
      number: i + 1, createdAt: new Date(NOW - (hours + 1) * H).toISOString(),
      mergedAt: new Date(NOW - H).toISOString(), events: [], partial,
    }));
    const fast = tune({ merged: merged(1) }).row;
    const slow = tune({ merged: merged(100, true) }).row;
    expect(suggestion(fast)).toEqual(suggestion(slow));
    expect(fast).toMatchObject({ action: 'raise', to: 32, changed: true });
    expect(fast.info).toEqual({ merges: 12, medianTtmH: 1, meanRounds: 1, partial: 0 });
    expect(slow.info).toEqual({ merges: 12, medianTtmH: 100, meanRounds: 1, partial: 12 });
    for (const row of [fast, slow]) {
      for (const key of ['merges', 'medianTtmH', 'meanRounds', 'partial']) {
        expect(row).not.toHaveProperty(key);
        expect(row.signals).not.toHaveProperty(key);
      }
    }
  });

  it('discoveryIncomplete makes assessCapacity verdict hold AND tune hold', () => {
    const assessed = assessCapacity({ prs: [], host: { idlePct: 30, memGb: 8 },
      policy, nowMs: NOW, discoveryIncomplete: true });
    expect(assessed).toMatchObject({ verdict: 'hold', slots: 0 });
    expect(assessed.fallbackReason).toContain('PR discovery incomplete; inspect full population');
    hold(tune({ readout: assessed }).row, 'PR discovery incomplete');
    hold(tune({ readout: { ...readout(), discoveryIncomplete: true } }).row, 'PR discovery incomplete');
  });

  it('readout fallbackReason blocks tuning even with healthy resource readings', () => {
    hold(tune({ readout: { ...readout(), fallbackReason: 'PR evidence incomplete; inspect full population' } }).row,
      'PR discovery incomplete');
  });

  it.each(['hold', 'pin'])('manual %s override is respected', kind => {
    hold(tune({ readout: { ...readout(), override: { kind } } }).row, 'manual override active');
  });

  it('cap<minUnits is held without raising it to the minimum', () => {
    hold(step({}, { cap: 5 }), 'configured cap below minUnits; not tuned', 5);
    hold(tune({ policy: { ...policy, unitCap: 5 } }).row, 'configured cap below minUnits; not tuned', 5);
  });

  it('clamps at maxUnits and minUnits, including an oversized configured cap', () => {
    expect(step({}, { cap: 60 })).toMatchObject({ from: 60, to: 48, changed: true });
    expect(step({}, { cap: 47 })).toMatchObject({ action: 'raise', to: 48 });
    expect(step({ idlePct: 1 }, { cap: 13 })).toMatchObject({ action: 'lower', to: 12 });
    expect(step({ idlePct: 1 }, { cap: 12 })).toMatchObject({ action: 'hold', to: 12, changed: false });
  });

  it('enforced cap unchanged: shadowTune leaves frozen readout cap, verdict and slots untouched', () => {
    const input = freeze(readout());
    const before = structuredClone(input);
    const out = tune({ readout: input });
    expect(out.row).toMatchObject({ schema: 'deliveryCapacity.tune.v1', tsMs: NOW,
      action: 'raise', from: 30, to: 32, changed: true });
    expect(out.row.ts).toBe(new Date(NOW).toISOString());
    expect(input).toEqual(before);
    expect(input).toMatchObject({ cap: 30, verdict: 'deliver', slots: 0 });
  });

  it('cooldown holds after a change, survives journaled holds and expires at everyMin', () => {
    const last = { tsMs: NOW - 30 * 60000, changed: true, to: 30 };
    hold(step({}, { last }), 'cooldown');
    const rows = [last, { tsMs: NOW - 60000, changed: false, from: 30, to: 30 }];
    hold(tune({ rows }).row, 'cooldown');
    expect(tune({ rows, nowMs: last.tsMs + policy.autoTune.everyMin * 60000 }).row)
      .toMatchObject({ action: 'raise', from: 30, to: 32, changed: true });
  });

  it.each([
    ['low idle', { idlePct: 14 }], ['low memory', { memGb: 3 }],
    ['heavy wait', { heavyWaitMin: 11 }], ['few free lanes', { lanesFree: 2 }],
  ])('lowers on %s independently of merge evidence', (_name, signals) => {
    expect(step(signals)).toMatchObject({ action: 'lower', from: 30, to: 24, changed: true });
  });

  it('raises only when binding and at or below the low activity threshold', () => {
    expect(step({ capBinding: false })).toMatchObject({ action: 'hold', to: 30, changed: false });
    expect(step({ prs: [{ ...waitingPr(1), liveSessions: 9 }] })).toMatchObject({ action: 'raise', to: 32 });
    expect(step({ prs: [{ ...waitingPr(1), liveSessions: 10 }] })).toMatchObject({ action: 'hold', to: 30 });
  });

  it('lowers on a readable low host reading even when per-PR resources are absent, and never raises', () => {
    expect(step({ idlePct: 5, prs: null })).toMatchObject({ action: 'lower', changed: true, to: 24 });
    expect(step({ memGb: 1, heavyWaitMin: undefined })).toMatchObject({ action: 'lower', changed: true });
    hold(step({ prs: null }), 'resource evidence unreadable');
    expect(tune({ resources: undefined, readout: { ...readout(), why: ['gate closed (idle 5% mem 8GB)'] } }).row)
      .toMatchObject({ action: 'lower' });
  });

  it('holds when the resource rows do not cover every open PR (empty or short population)', () => {
    hold(step({ prs: [], openCount: 10 }), 'resource evidence unreadable');
    hold(tune({ readout: { ...readout(), openCount: 10 }, resources: { ...resources(), prs: [] } }).row, 'resource evidence unreadable');
    hold(tune({ readout: { ...readout(), openCount: undefined } }).row, 'resource evidence unreadable');
  });
});
