// The multiplier question is open; README.md records the findings and required S1.2 answer.
import { describe, expect, it } from 'vitest';
import fixtureText from './fixtures/usage-summary.web-everything.json?raw';

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
