// The multiplier question is open; README.md records the findings and required S1.2 answer.
import { describe, expect, it } from 'vitest';
import fixtureText from './fixtures/usage-summary.web-everything.json?raw';
import { evaluateThresholds, feedState, parseUsageSummary } from './usage';

describe('fixture', () => {
  it('fixture parses as JSON', () => {
    expect(() => JSON.parse(fixtureText)).not.toThrow();
  });

  it('fixture has five usageItems with the ten documented fields', () => {
    const fixture = JSON.parse(fixtureText);
    expect(fixture.timePeriod).toEqual({ year: 2026, month: 11 });
    expect(fixture.organization).toBe('web-everything');
    expect(fixture.usageItems).toHaveLength(5);
    const fields = [
      'product', 'sku', 'unitType', 'pricePerUnit', 'grossQuantity',
      'grossAmount', 'discountQuantity', 'discountAmount', 'netQuantity', 'netAmount',
    ];
    for (const item of fixture.usageItems) {
      expect(Object.keys(item).sort()).toEqual([...fields].sort());
    }
  });

  it('fixture used minutes include discounted minutes and exclude storage and copilot', () => {
    const fixture = JSON.parse(fixtureText);
    const usedMinutes = fixture.usageItems
      .filter((item: { product: string; unitType: string }) =>
        item.product === 'actions' && item.unitType === 'Minutes')
      .reduce((sum: number, item: { discountQuantity: number; netQuantity: number }) =>
        sum + item.discountQuantity + item.netQuantity, 0);
    expect(usedMinutes).toBe(4600);
  });

  it('fixture contains no token prefixes or Bearer strings', () => {
    expect(fixtureText).not.toMatch(/github_pat_|ghp_|gho_|ghs_|Bearer/);
    // Inspect decoded keys and values too, so JSON escapes cannot hide a match.
    JSON.parse(fixtureText, (key, value) => {
      expect(key).not.toMatch(/github_pat_|ghp_|gho_|ghs_|Bearer/);
      if (typeof value === 'string') {
        expect(value).not.toMatch(/github_pat_|ghp_|gho_|ghs_|Bearer/);
      }
      return value;
    });
  });
});

describe('usage', () => {
  const summary = JSON.parse(fixtureText);
  const reading = { org: 'web-everything', cycle: '2026-11', includedMinutes: 50000,
    pct: 82, state: 'fresh' as const };

  it('parser totals 4600 minutes on the fixture', () => {
    expect(parseUsageSummary(summary, { includedMinutes: 50000 })).toEqual({
      org: 'web-everything', cycle: '2026-11', usedMinutes: 4600,
      includedMinutes: 50000, pct: 9.2, state: 'fresh',
    });
  });

  it('errors on missing or null quantities on Actions minutes rows', () => {
    for (const quantities of [
      {}, { discountQuantity: 20 }, { netQuantity: 10 },
      { discountQuantity: undefined, netQuantity: 10 },
      { discountQuantity: 20, netQuantity: undefined },
      { discountQuantity: null, netQuantity: 10 },
      { discountQuantity: 20, netQuantity: null },
    ]) {
      expect(parseUsageSummary({ ...summary, usageItems: [
        { product: 'actions', unitType: 'Minutes', ...quantities },
      ] }, { includedMinutes: 100 })).toEqual({ state: 'error', pct: null });
    }
  });

  it('matches minutes case-insensitively and allows unrelated rows without quantities', () => {
    const usageItems = [
      { product: 'actions', unitType: 'minutes', discountQuantity: 20, netQuantity: 0 },
      { product: 'actions', unitType: 'MINUTES', discountQuantity: 0, netQuantity: 10 },
      { product: 'copilot', unitType: 'Minutes' },
      { product: 'actions', unitType: 'GigabyteHours' },
    ];
    expect(parseUsageSummary({ ...summary, usageItems }, { includedMinutes: 100 }))
      .toMatchObject({ state: 'fresh', usedMinutes: 30, pct: 30 });
  });

  it('matches the product case-insensitively, including the documented "Actions" name', () => {
    for (const product of ['Actions', 'ACTIONS', 'actions']) {
      const parsed = parseUsageSummary({ ...summary, usageItems: [
        { product, sku: 'actions_linux', unitType: 'minutes', discountQuantity: 0, netQuantity: 1000 },
      ] }, { includedMinutes: 1000 });
      expect(parsed).toMatchObject({ state: 'fresh', usedMinutes: 1000, pct: 100 });
      expect(evaluateThresholds(parsed as never, []).firedKeys).toEqual([
        'ci-min:web-everything:80:2026-11', 'ci-min:web-everything:95:2026-11',
      ]);
    }
    // A different product that merely contains the word must still be excluded.
    expect(parseUsageSummary({ ...summary, usageItems: [
      { product: 'Copilot Actions', unitType: 'minutes', discountQuantity: 0, netQuantity: 5 },
    ] }, { includedMinutes: 100 })).toMatchObject({ state: 'fresh', usedMinutes: 0 });
  });

  it('fails closed on every malformed usage row, including unrelated rows', () => {
    for (const item of [null, undefined, [], 'actions', 3, {},
      { product: 'actions' }, { unitType: 'Minutes' },
      { product: null, unitType: 'Minutes' }, { product: 3, unitType: 'Minutes' },
      { product: 'copilot', unitType: null }, { product: 'copilot', unitType: 3 }]) {
      expect(parseUsageSummary({ ...summary, usageItems: [
        { product: 'actions', unitType: 'Minutes', discountQuantity: 20, netQuantity: 10 },
        item,
      ] }, { includedMinutes: 100 })).toEqual({ state: 'error', pct: null });
    }
  });

  it('fails closed on missing or invalid summary identity, period, or usageItems', () => {
    for (const invalid of [null, {}, { ...summary, usageItems: undefined },
      { ...summary, usageItems: {} }, { ...summary, organization: '' },
      { ...summary, organization: 3 }, { ...summary, timePeriod: null },
      { ...summary, timePeriod: { year: 2026, month: 13 } },
      { ...summary, timePeriod: { year: 2026, month: 1.5 } }]) {
      expect(parseUsageSummary(invalid, { includedMinutes: 100 }))
        .toMatchObject({ state: 'error', pct: null });
    }
  });

  it('rejects invalid quantities, overflowing totals, and unusable allowances', () => {
    for (const quantity of [-1, '3', NaN, Infinity, -Infinity]) {
      for (const field of ['discountQuantity', 'netQuantity']) {
        expect(parseUsageSummary({ ...summary, usageItems: [
          { product: 'actions', unitType: 'minutes', discountQuantity: 0,
            netQuantity: 0, [field]: quantity },
        ] }, { includedMinutes: 100 })).toMatchObject({ state: 'error', pct: null });
      }
    }
    for (const includedMinutes of [0, -1, NaN, Infinity, Number.MIN_VALUE]) {
      expect(parseUsageSummary(summary, { includedMinutes }))
        .toMatchObject({ state: 'error', pct: null });
    }
    expect(parseUsageSummary({ ...summary, usageItems: [
      { product: 'actions', unitType: 'Minutes', netQuantity: Number.MAX_VALUE,
        discountQuantity: Number.MAX_VALUE },
    ] }, { includedMinutes: 100 })).toMatchObject({ state: 'error', pct: null });
  });

  it('crosses 80 and 95 once per cycle and re-arms on a new cycle', () => {
    expect(evaluateThresholds({ ...reading, pct: 79.9 }, []).lines).toEqual([]);
    const first = evaluateThresholds(reading, []);
    expect(first).toEqual({
      lines: ['CI minutes web-everything at 82% of 50000 private min (cycle 2026-11)'],
      firedKeys: ['ci-min:web-everything:80:2026-11'],
    });
    expect(evaluateThresholds(reading, first.firedKeys).lines).toEqual([]);
    const second = evaluateThresholds({ ...reading, pct: 95 }, first.firedKeys);
    expect(second.lines).toHaveLength(1);
    expect(second.firedKeys).toContain('ci-min:web-everything:95:2026-11');
    expect(first.firedKeys).toHaveLength(1); // Input state stays untouched.
    expect(evaluateThresholds({ ...reading, pct: 99 }, second.firedKeys).lines).toEqual([]);
    const next = evaluateThresholds({ ...reading, pct: 95, cycle: '2026-12' }, second.firedKeys);
    expect(next.lines).toHaveLength(2);
    expect(next.firedKeys.slice(-2)).toEqual([
      'ci-min:web-everything:80:2026-12', 'ci-min:web-everything:95:2026-12',
    ]);
    expect(evaluateThresholds({ ...reading, pct: 80 }, []).lines).toHaveLength(1);
  });

  it('a reading without explicit state warns and never emits percentage lines', () => {
    const { state, ...withoutState } = reading;
    const first = evaluateThresholds({ ...withoutState, pct: 99 }, []);
    expect(first).toEqual({ lines: ['CI minutes feed stale >6h'],
      firedKeys: ['ci-min:web-everything:stale:2026-11'] });
    expect(evaluateThresholds({ ...reading, state: undefined }, []).lines).toEqual(first.lines);
    expect(evaluateThresholds(withoutState, first.firedKeys).lines).toEqual([]);
  });

  it('stale and failed feeds have null pct, warn once per cycle, and never report percentages', () => {
    const sixHours = 6 * 60 * 60 * 1000;
    expect(feedState({ fetchedAtMs: 0, nowMs: sixHours, ok: true })).toBe('fresh');
    for (const ok of [true, false]) {
      const state = feedState({ fetchedAtMs: 0, nowMs: sixHours + 1, ok });
      expect(state).toBe(ok ? 'stale' : 'error');
      const unavailable = { ...reading, state, pct: null };
      expect(unavailable.pct).toBeNull();
      const first = evaluateThresholds(unavailable, []);
      expect(first).toEqual({ lines: ['CI minutes feed stale >6h'],
        firedKeys: ['ci-min:web-everything:stale:2026-11'] });
      expect(evaluateThresholds(unavailable, first.firedKeys).lines).toEqual([]);
      expect(evaluateThresholds({ ...unavailable, cycle: '2026-12' }, first.firedKeys).lines)
        .toEqual(['CI minutes feed stale >6h']);
      // Even a cached numeric percentage cannot override feed failure.
      expect(evaluateThresholds({ ...unavailable, pct: 99 }, []).lines).toEqual(first.lines);
    }
    expect(feedState({ fetchedAtMs: 0, nowMs: 11, ok: true, staleAfterMs: 10 })).toBe('stale');
    for (const fetchedAtMs of [NaN, Infinity, 20]) {
      expect(feedState({ fetchedAtMs, nowMs: 10, ok: true })).toBe('error');
    }
  });
});
