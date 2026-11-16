import { describe, expect, it, vi } from 'vitest';
import {
  DELIVERY_CAPACITY_DEFAULTS, resolveDeliveryCapacity, weighPr, assessCapacity, renderCapacityLine,
} from '../delivery-capacity.mjs';
import {
  DELIVERY_CAPACITY_OP, deliveryCapacityOperation, finishDeliveryCapacity,
} from '../../operations/delivery-capacity.mjs';

const DEFAULTS = {
  mode: 'count', population: 'all', openPrCap: 18, unitCap: 30,
  weights: { cards: 0.5, S: 1, M: 2.5, L: 4 }, sizeLines: { S: 150, M: 600 },
  acceptedWeight: 0, careMultiplier: { none: 1, low: 1, elevated: 1.25, high: 1.5 },
  roundPenalty: { after: 2, per: 0.25, max: 2 },
  startUnits: { byCardPoints: { 1: 'S', 2: 'S', 3: 'S', 5: 'M', 8: 'L', 13: 'L' }, unknown: 'M' },
  holdLabels: ['review:human', 'status:needs-you', 'review-status:needs-human',
    'status:escalated', 'blocked', 'advisory:ruling-needed'],
  autoTune: { mode: 'shadow', everyMin: 60, windowH: 6, minMerges: 10, ttmTargetH: 6,
    backoffFactor: 1.5, roundsTarget: 2.0, increase: 2, decrease: 0.8,
    minUnits: 12, maxUnits: 48, raiseOnlyIfBinding: true,
    heavyWaitMaxMin: 10, lanesFreeMin: 3, activeHighRatio: 0.6, activeLowRatio: 0.3,
    sessionUnits: 1, minutesPerUnit: 30, laneUnits: 0.5, rebaseUnits: 0.25 },
  heldWeight: 0, heldCap: 4, heldStaleH: 72, idleMinPct: 15, memMinGb: 4, maxStartsPerCheck: 8,
};
const OPEN_HOST = Object.freeze({ idlePct: 22, memGb: 6 });
const policy = (overrides = {}) => ({ ...structuredClone(DEFAULTS), ...overrides });
const pr = (number, overrides = {}) => ({
  number, additions: 50, deletions: 0, labels: [], files: [{ path: 'scripts/example.mjs' }],
  updatedAt: new Date().toISOString(),
  headRefName: `lane/${number}-build`, ...overrides,
});
const assess = (prs, overrides = {}, host = OPEN_HOST) =>
  assessCapacity({ prs, host, policy: policy(overrides) });
const resolve = (options = {}) => resolveDeliveryCapacity({
  env: {}, platform: {}, read: () => ({}), log: () => {}, ...options,
});
const freeze = value => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

// Frozen synthetic 2026-11-15 mix: 2 cards + 5 S + 3 M + 1 L + 1 held + 1 accepted.
// Default arithmetic is 1 + 5 + 7.5 + 4 = 17.5, not 18. The design's live
// snapshot adds a 0.5 round penalty, but the pinned PR input has no round field.
// Use an explicit L=4.5 policy for the 18.0 fixture; pin the default total too.
const SNAPSHOT = freeze([
  pr(1, { files: ['backlog/001-first.md'], additions: 734 }),
  pr(2, { files: [{ path: 'backlog/002-second.md' }] }),
  ...[3, 4, 5, 6, 7].map(number => pr(number)),
  ...[8, 9, 10].map(number => pr(number, { additions: 200 })),
  pr(11, { additions: 700 }),
  pr(12, { additions: 700, labels: ['review:human'] }),
  pr(13, { additions: 700, labels: [{ name: 'review:accepted' }] }),
]);

describe('delivery capacity S1 defaults and old count rule', () => {
  it('pins the frozen default policy and keeps count mode as the default', () => {
    expect(DELIVERY_CAPACITY_DEFAULTS).toEqual(DEFAULTS);
    expect(Object.isFrozen(DELIVERY_CAPACITY_DEFAULTS)).toBe(true);
  });

  // Deliberately independent of the new module's policy values and helpers.
  const oldRule = (O, gateOpen) => !gateOpen
    ? { verdict: 'hold', slots: 0 }
    : O >= 18 ? { verdict: 'deliver', slots: 0 }
      : { verdict: 'build', slots: Math.min(8, 18 - O) };
  it.each([0, 13, 17, 18, 25].flatMap(O => [true, false].map(gateOpen => ({ O, gateOpen }))))(
    'count mode equals the OLD rule for O=$O, gateOpen=$gateOpen', ({ O, gateOpen }) => {
      const prs = Array.from({ length: O }, (_, i) => pr(i + 1, {
        additions: 1000, labels: [i % 2 ? 'review:accepted' : 'review:human'],
      }));
      expect(assess(prs, {}, gateOpen ? OPEN_HOST : { idlePct: 14, memGb: 6 })).toMatchObject({
        mode: 'count', openCount: O, used: O, cap: 18, ...oldRule(O, gateOpen),
      });
    },
  );
});

describe('delivery capacity S1 PR weights', () => {
  it('weighs the frozen 13-PR synthetic snapshot at exactly 18.0 units with explicit L=4.5', () => {
    const readout = assess(SNAPSHOT, { mode: 'units', weights: { ...DEFAULTS.weights, L: 4.5 } });
    expect(readout).toMatchObject({
      mode: 'units', used: 18, cap: 30, openCount: 13, verdict: 'build', slots: 4,
      breakdown: {
        cards: { n: 2, units: 1 }, S: { n: 5, units: 5 }, M: { n: 3, units: 7.5 },
        L: { n: 1, units: 4.5 }, held: { n: 1, units: 0, overflow: 0 },
        accepted: { n: 1, units: 0 },
      }, held: [12],
    });
    expect(assess(SNAPSHOT, { mode: 'units' }).used).toBe(17.5);
  });

  it.each([
    ['string paths', ['backlog/6868-card.md']],
    ['object paths', [{ path: 'backlog/6868-card.md' }]],
  ])('weighs a 734-line cards-only PR at 0.5 with %s', (_name, files) => {
    expect(weighPr(pr(6868, { additions: 700, deletions: 34, files }), policy())).toEqual({
      units: 0.5, kind: 'cards', held: false, accepted: false,
    });
  });

  it.each([[], ['backlog-tools/card.md'], ['backlog/../scripts/code.md'],
    ['backlog/card.md', 'scripts/code.mjs']].map(files => ({ files })))(
    'does not discount an unproven cards-only diff: $files', ({ files }) => {
    expect(weighPr(pr(1, { additions: 734, files }), policy())).toMatchObject({ kind: 'L', units: 4 });
    },
  );

  it.each([[149, 0, 'S', 1], [100, 50, 'M', 2.5], [599, 0, 'M', 2.5], [300, 300, 'L', 4]])(
    'classifies additions=%i plus deletions=%i as %s', (additions, deletions, kind, units) => {
      expect(weighPr(pr(1, { additions, deletions }), policy())).toEqual({
        units, kind, held: false, accepted: false,
      });
    },
  );

  it.each(DEFAULTS.holdLabels)('recognizes held label %s at zero standalone weight', label => {
    expect(weighPr(pr(1, { labels: [{ name: label }] }), policy())).toEqual({
      units: 0, kind: 'held', held: true, accepted: false,
    });
  });

  it('discounts four held PRs and charges the fifth full weight in number order with held overflow', () => {
    const held = [50, 10, 40, 20, 30].map(number => pr(number, {
      additions: 700, labels: ['review:human'],
    }));
    expect(assess(held.slice(1), { mode: 'units' }).used).toBe(0);
    const readout = assess(held, { mode: 'units' });
    expect(readout.used).toBe(4);
    expect(readout.breakdown.held).toMatchObject({ n: 5, overflow: 1 });
    expect(readout.held).toEqual([10, 20, 30, 40, 50]);
    expect(JSON.stringify(readout.why)).toContain('held overflow');
    // A different size on #50 proves exemption follows number, not input order.
    expect(assess(held.map(item => item.number === 50 ? { ...item, additions: 50 } : item),
      { mode: 'units' }).used).toBe(1);
  });

  it.each([['review:accepted'], [{ name: 'review:accepted' }]])('accepted PR weighs zero: %j', label => {
    const accepted = pr(1, { additions: 5000, labels: [label] });
    expect(weighPr(accepted, policy())).toEqual({ units: 0, kind: 'accepted', held: false, accepted: true });
    expect(assess([accepted], { mode: 'units' })).toMatchObject({
      used: 0, breakdown: { accepted: { n: 1, units: 0 } },
    });
  });

  it.each([{}, { additions: undefined, deletions: undefined }, { additions: NaN },
    { additions: 'unknown' }, { deletions: null }, { additions: Infinity }])(
    'unknown or non-numeric size counts as M: %j', size => {
      const item = Object.keys(size).length ? pr(1, size) : { number: 1, files: ['scripts/code.mjs'] };
      expect(weighPr(item, policy())).toMatchObject({ kind: 'M', units: 2.5 });
    },
  );
});

describe('delivery capacity S1 gate, slots and unreadable evidence', () => {
  it.each(['count', 'units'].flatMap(mode => [
    { idlePct: 14, memGb: 6 }, { idlePct: 22, memGb: 3.9 }, {},
    { idlePct: NaN, memGb: 6 }, { idlePct: 22, memGb: NaN }, undefined,
  ].map(host => ({ mode, host }))))('closed or unknown host gives hold in $mode: $host', ({ mode, host }) => {
    const readout = assessCapacity({ prs: [], host, policy: policy({ mode }) });
    expect(readout).toMatchObject({ mode, verdict: 'hold', slots: 0 });
  });

  it.each(['count', 'units'])('opens the gate at both inclusive thresholds in %s mode', mode => {
    expect(assess([], { mode }, { idlePct: 15, memGb: 4 })).toMatchObject({ verdict: 'build', slots: 8 });
  });

  it.each([[0, 8, 'build'], [27, 1, 'build'], [28, 0, 'build'], [30, 0, 'deliver'], [35, 0, 'deliver']])(
    'units used=%i floors and clamps slots to %i with verdict %s', (used, slots, verdict) => {
      const prs = Array.from({ length: used }, (_, i) => pr(i + 1));
      expect(assess(prs, { mode: 'units' })).toMatchObject({ used, cap: 30, slots, verdict });
    },
  );

  it.each([undefined, null, {}, 'unreadable'])('non-array PR evidence never throws and names count fallback: %j', prs => {
    let readout;
    expect(() => { readout = assess(prs, { mode: 'units' }); }).not.toThrow();
    expect(readout).toMatchObject({ mode: 'count', openCount: 0, used: 0, cap: 18 });
    expect(readout.fallbackReason).toEqual(expect.any(String));
    expect(readout.fallbackReason.trim().length).toBeGreaterThan(0);
  });

  it('throwing PR evidence never escapes and names a count-mode fallback', () => {
    const input = { host: OPEN_HOST, policy: policy({ mode: 'units' }),
      get prs() { throw new Error('PR evidence unreadable'); } };
    let readout;
    expect(() => { readout = assessCapacity(input); }).not.toThrow();
    expect(readout).toMatchObject({ mode: 'count', openCount: 0, used: 0 });
    expect(readout.fallbackReason).toEqual(expect.any(String));
    expect(readout.fallbackReason.trim()).not.toBe('');
  });

  it('throwing size getter never escapes weighPr and falls back to M', () => {
    const item = pr(1);
    Object.defineProperty(item, 'additions', { get() { throw new Error('size unreadable'); } });
    let result;
    expect(() => { result = weighPr(item, policy()); }).not.toThrow();
    expect(result).toMatchObject({ units: 2.5, kind: 'M' });
  });
});

describe('delivery capacity S1 cascade', () => {
  it('default mode count comes from the standard layer', () => {
    expect(resolve()).toMatchObject({ value: DEFAULTS, sources: { mode: 'standard' } });
  });
  it('tool-layer mode units flips the mode and records provenance', () => {
    expect(resolve({ read: () => ({ deliveryCapacity: { mode: 'units' } }) })).toMatchObject({
      value: { mode: 'units' }, sources: { mode: 'tool' },
    });
  });
  it('explicit platform mode units flips the mode without a tool override', () => {
    expect(resolve({ platform: { mode: 'units' } })).toMatchObject({
      value: { mode: 'units' }, sources: { mode: 'platform' },
    });
  });
  it('invalid tool mode and nested leaves fall back independently to valid lower layers', () => {
    expect(resolve({ platform: { mode: 'units', weights: { cards: 0.75 } },
      read: () => ({ deliveryCapacity: { mode: 'invalid', weights: { cards: -1, S: 2 } } }),
    })).toMatchObject({ value: { mode: 'units', weights: { cards: 0.75, S: 2, M: 2.5, L: 4 } },
      sources: { mode: 'platform', 'weights.cards': 'platform', 'weights.S': 'tool' } });
    expect(resolve({ platform: { mode: 'invalid' } }).value.mode).toBe('count');
  });
  it.each(['count', 'units'])('WE_DELIVERY_CAPACITY_MODE=%s beats tool and platform', mode => {
    expect(resolve({ platform: { mode: 'units' },
      read: () => ({ deliveryCapacity: { mode: 'units' } }),
      env: { WE_DELIVERY_CAPACITY_MODE: mode },
    })).toMatchObject({ value: { mode }, sources: { mode: 'env' } });
  });
  it('invalid environment mode preserves the valid tool layer', () => {
    expect(resolve({ env: { WE_DELIVERY_CAPACITY_MODE: 'invalid' },
      read: () => ({ deliveryCapacity: { mode: 'units' } }),
    })).toMatchObject({ value: { mode: 'units' }, sources: { mode: 'tool' } });
  });
  it('logs the effective mode and its platform provenance when cascade logging is enabled', () => {
    const log = vi.fn();
    resolve({ platform: { mode: 'units', unitCap: 37 },
      env: { WE_POLICY_CASCADE_LOG: '1' }, log });
    const output = log.mock.calls.flat().join(' ');
    expect(output).toContain('deliveryCapacity');
    expect(output).toMatch(/mode="units" \(platform\)/);
    expect(output).toMatch(/unitCap=37 \(platform\)/);
  });
  it('throwing settings reader never throws and returns defaults', () => {
    let result;
    expect(() => { result = resolve({ read: () => { throw new Error('settings unreadable'); } }); }).not.toThrow();
    expect(result).toMatchObject({ value: DEFAULTS, sources: { mode: 'standard' } });
  });
});

describe('delivery capacity S1 versioned output and read-only operation', () => {
  it('pins JSON schema, exact normal key list, breakdown keys and JSON round trip', () => {
    const readout = assess(SNAPSHOT, { mode: 'units' });
    expect(readout.schema).toBe('deliveryCapacity.readout.v1');
    expect(Object.keys(readout).sort()).toEqual([
      'schema', 'mode', 'used', 'cap', 'slots', 'verdict', 'breakdown', 'held', 'why', 'sources', 'openCount',
    ].sort());
    expect(Object.keys(readout.breakdown).sort()).toEqual(['cards', 'S', 'M', 'L', 'accepted', 'held'].sort());
    expect(readout.sources).toEqual(expect.any(Object));
    expect(JSON.parse(JSON.stringify(readout))).toEqual(readout);
  });
  it.each(['count', 'units'])('renders one line with a fixed precision prefix in %s mode', mode => {
    const readout = assess(SNAPSHOT, { mode });
    const line = renderCapacityLine(readout);
    expect(line.startsWith(`capacity ${readout.used.toFixed(1)}/${readout.cap}u`)).toBe(true);
    expect(line).not.toMatch(/[\r\n]/);
    if (mode === 'count') expect(line).toContain('[mode count: 13/18 PRs]');
  });
  it('declares delivery-capacity as a read-only operation and passes collected JSON through unchanged', () => {
    const readout = assess(SNAPSHOT, { mode: 'units' });
    const collect = vi.fn(() => readout);
    const declaration = deliveryCapacityOperation({ collect });
    expect(DELIVERY_CAPACITY_OP).toBe('delivery-capacity');
    expect(declaration.name).toBe(DELIVERY_CAPACITY_OP);
    expect(declaration.verdictFrom).toBe('read');
    expect(declaration.steps).toHaveLength(1);
    expect(declaration.steps.every(({ step }) => step.kind === 'compute')).toBe(true);
    expect(collect).not.toHaveBeenCalled();
    const verdict = declaration.steps[0].step.fn();
    expect(verdict).toEqual(readout);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(finishDeliveryCapacity({ run: { verdict }, code: 0,
      lines: [JSON.stringify(verdict)], json: true,
    }, { tune: null })).toEqual({ code: 0, lines: [JSON.stringify(readout)] });
  });
  it('finishes the operation with the capacity line in plain mode and preserves exit code', () => {
    const verdict = assess([]);
    expect(finishDeliveryCapacity({ run: { verdict }, code: 7, lines: ['raw'] }, { tune: null })).toEqual({
      code: 7, lines: [renderCapacityLine(verdict)],
    });
  });
});
