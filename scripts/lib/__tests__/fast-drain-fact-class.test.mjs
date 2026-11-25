import { it, expect } from 'vitest';
import { DRAIN_GATES } from '../merge-gate-inventory.mjs';
import { FAST_DRAIN_FACT_CLASSES } from '../fast-drain-context.mjs';
it('every DRAIN_GATES id maps to F1-F14 once', () => {
  expect(Object.keys(FAST_DRAIN_FACT_CLASSES).sort()).toEqual(DRAIN_GATES.map(g => g.id).sort());
  for (const row of Object.values(FAST_DRAIN_FACT_CLASSES)) {
    expect(row.fact).toMatch(/^F(?:[1-9]|1[0-4])$/);
    expect(['a', 'b', 'c']).toContain(row.class);
  }
});
it('red-team and ledger rows are classed b and a', () => {
  expect(FAST_DRAIN_FACT_CLASSES['red-team']).toEqual({ fact: 'F7', class: 'b' });
  expect(FAST_DRAIN_FACT_CLASSES.ledger).toEqual({ fact: 'F6', class: 'a' });
});
