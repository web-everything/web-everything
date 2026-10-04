/**
 * @file scope-overlap-aging.test.mjs — #3881: a fix waiter sat 3h+ in the scope-overlap queue
 *   ("waiting 3rd behind #3896, #3889") while those PRs cycled through repeated live ci-heal sessions on the same
 *   file. "In flight" still means a live claim or a higher-ranked waiter; the new AGING OVERRIDE admits a waiter
 *   whose episode is older than the bound past them — never past a fix accepted earlier in the same pass.
 */
import { describe, it, expect } from 'vitest';
import {
  filterFixesByInFlightScope, resolveScopeOverlapMaxWaitMinutes, DEFAULT_SCOPE_OVERLAP_MAX_WAIT_MINUTES,
} from '../reconcile-fix-dispatch.mjs';

const FILE = 'we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs';
const NOW = Date.parse('2026-10-04T16:56:00Z');
const live3896 = { meta: { pr: 3896, scope: [FILE] } };
const live3889 = { meta: { pr: 3889, scope: [FILE] } };

describe('#3881 — scope-overlap aging override', () => {
  it('the live case: #3881 (waiting since 13:32Z) is admitted past the live ci-heal claims of #3896/#3889', () => {
    const planned = [{ pr: 3881, itemNum: null, scope: [FILE], waitingSince: '2026-10-04T13:32:58Z' }];
    const out = filterFixesByInFlightScope(planned, [], [live3896, live3889], { now: NOW, maxWaitMinutes: 60 });
    expect(out.refusals).toEqual([]);
    expect(out.planned.map((e) => e.pr)).toEqual([3881]);
    expect(out.planned[0].agedAdmit).toEqual({ waitedMinutes: 203, maxWaitMinutes: 60, bypassed: ['fix PR #3896', 'fix PR #3889'] });
    expect(out.ranks[0].agedAdmit.bypassed).toEqual(['fix PR #3896', 'fix PR #3889']);
  });

  it('under the bound it still waits, exactly as before', () => {
    const planned = [{ pr: 3881, itemNum: null, scope: [FILE], waitingSince: '2026-10-04T16:30:00Z' }];
    const out = filterFixesByInFlightScope(planned, [], [live3896], { now: NOW, maxWaitMinutes: 60 });
    expect(out.planned).toEqual([]);
    expect(out.refusals.map((r) => r.kind)).toEqual(['scope-overlap']);
  });

  it('off (null) keeps the old unbounded wait', () => {
    const planned = [{ pr: 3881, itemNum: null, scope: [FILE], waitingSince: '2026-10-04T10:00:00Z' }];
    const out = filterFixesByInFlightScope(planned, [], [live3896], { now: NOW, maxWaitMinutes: null });
    expect(out.planned).toEqual([]);
  });

  it('never admits two overlapping fixes in one pass: a fix accepted earlier this pass still blocks an aged waiter', () => {
    const planned = [
      { pr: 10, itemNum: null, scope: [FILE], waitingSince: '2026-10-04T09:00:00Z' },
      { pr: 11, itemNum: null, scope: [FILE], waitingSince: '2026-10-04T10:00:00Z' },
    ];
    const out = filterFixesByInFlightScope(planned, [], [], { now: NOW, maxWaitMinutes: 60 });
    expect(out.planned.map((e) => e.pr)).toEqual([10]);
    expect(out.refusals.map((r) => r.pr)).toEqual([11]);
  });

  it('an aged waiter is not held behind a higher-ranked waiter that was itself refused this pass', () => {
    const planned = [
      // #20 out-ranks #21 (it blocks three waiters) but is itself refused: a live claim holds `other.mjs`.
      { pr: 20, itemNum: null, scope: [FILE, 'we:other.mjs'], waitingSince: '2026-10-04T16:26:00Z' },
      { pr: 22, itemNum: null, scope: ['we:other.mjs'], waitingSince: '2026-10-04T16:26:00Z' },
      { pr: 23, itemNum: null, scope: ['we:other.mjs'], waitingSince: '2026-10-04T16:26:00Z' },
      { pr: 21, itemNum: null, scope: [FILE], waitingSince: '2026-10-04T15:46:00Z' }, // 70 min
    ];
    const blockerOnOther = { meta: { pr: 99, scope: ['we:other.mjs'] } };
    const out = filterFixesByInFlightScope(planned, [], [blockerOnOther], { now: NOW, maxWaitMinutes: 60 });
    expect(out.ranks[0].pr).toBe(20);
    expect(out.planned.map((e) => e.pr)).toEqual([21]);
    expect(out.planned[0].agedAdmit.bypassed).toEqual(['fix PR #20']);
  });

  it('resolves the bound from env: default, number, 0/off', () => {
    expect(resolveScopeOverlapMaxWaitMinutes({})).toBe(DEFAULT_SCOPE_OVERLAP_MAX_WAIT_MINUTES);
    expect(resolveScopeOverlapMaxWaitMinutes({ WE_SCOPE_OVERLAP_MAX_WAIT_MINUTES: '90' })).toBe(90);
    expect(resolveScopeOverlapMaxWaitMinutes({ WE_SCOPE_OVERLAP_MAX_WAIT_MINUTES: '0' })).toBeNull();
    expect(resolveScopeOverlapMaxWaitMinutes({ WE_SCOPE_OVERLAP_MAX_WAIT_MINUTES: 'off' })).toBeNull();
    expect(resolveScopeOverlapMaxWaitMinutes({ WE_SCOPE_OVERLAP_MAX_WAIT_MINUTES: 'junk' })).toBe(DEFAULT_SCOPE_OVERLAP_MAX_WAIT_MINUTES);
  });
});
