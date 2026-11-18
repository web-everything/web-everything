/**
 * @file long-soak-lanes.test.mjs — main went red 2026-11-18 (first red commit 325a7f76f) on the long soak's `owed`
 * invariant, twice with a different victim but one cause: the 4-lane default pool ran dry (review
 * `deferredForLanes=1`, fix-dispatch `no-lane`) because crashed/hung/failed fake sessions strand their lanes until a
 * wall-clock reclaim. The long soak must provision headroom over the default pool.
 */
import { describe, expect, it } from 'vitest';
import { LONG_SOAK_LANES } from '../long-soak-lanes.mjs';

describe('long soak lane pool', () => {
  it('has more lanes than the 4-lane default that starved owed PRs', () => {
    expect(LONG_SOAK_LANES).toBeGreaterThan(4);
  });
});
