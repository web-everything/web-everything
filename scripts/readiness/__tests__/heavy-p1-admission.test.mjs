import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireSlotBlocking, clearWaiting, heldSlots,
  isOldestLiveWaiter, listWaiting, markWaiting, releaseOwnedSlot,
  resolveAdmissionPolicy, resolveQueueBaseline, tryAcquireSlot,
} from '../heavy-admission.mjs';
import { createQueueBudget, queueBacklog, waitersAheadOf } from '../heavy-queue-projection.mjs';
import { assessQueueAdmission } from '../../operations/heavy-queue.mjs';

const T0 = Date.parse('2026-10-22T12:00:00Z');
let lockRoot;
beforeEach(() => { lockRoot = mkdtempSync(join(tmpdir(), 'heavy-p1-admission-')); });
afterEach(() => rmSync(lockRoot, { recursive: true, force: true }));
const policy = (mode = 'enforce', fastSlots = 0) => resolveAdmissionPolicy({
  platform: { fastSlots, priority: { mode } }, env: {},
});
const marker = (owner, kind, priority = 'P3', offset = -1000) => markWaiting({
  lockRoot, owner, kind, priority, pid: process.pid, nowIso: new Date(T0 + offset).toISOString(),
});
const snapshot = (mode = 'enforce') => resolveQueueBaseline({
  lockRoot, cap: 1, nowMs: T0, readLeases: () => [],
  env: { LANE_POOL_ROOT: lockRoot, WE_HEAVY_ADMISSION_PRIORITY: mode, WE_HEAVY_ADMISSION_FAST_SLOTS: '0' },
});
const options = () => ({
  lockRoot, cap: 1, kind: 'selected', policy: policy(), env: {}, now: () => T0,
  hostAdmission: () => ({ admitted: true }), readLease: () => null, readSendBackFixes: () => [],
  log() {}, canDefer: true, ceilingMs: 20, pollMs: 10,
});

describe('P1 projection agrees with real slot admission', () => {
  it.each([
    ['fix-203', 'selected'], ['ci-heal-42', 'selected'],
    ['fix-203', 'FULL'], ['ci-heal-42', 'FULL'],
  ])('%s receives the next released slot ahead of the excluded %s build waiter', async (session, buildKind) => {
    marker('BUILD', buildKind);
    expect(tryAcquireSlot({ lockRoot, cap: 1, owner: 'HOLDER', nowMs: T0,
      nowIso: new Date(T0).toISOString() }).ok).toBe(true);
    let continueFix, signalBlocked;
    const resume = new Promise(resolve => { continueFix = resolve; });
    const blocked = new Promise(resolve => { signalBlocked = resolve; });
    let clock = T0;
    const fix = acquireSlotBlocking({ ...options(), owner: 'FIX', env: { WE_HEAVY_SESSION: session },
      now: () => clock, sleep: async ms => { clock += ms; signalBlocked(); await resume; },
    });
    try {
      await blocked;
      expect(heldSlots({ lockRoot, cap: 1 }).map(h => h.owner)).toEqual(['HOLDER']);
      expect(listWaiting(lockRoot)).toContainEqual(expect.objectContaining({ owner: 'FIX', priority: 'P1' }));
      const baseline = snapshot();
      expect(baseline.priorityMode).toBe('enforce');
      expect(baseline.waiting.map(w => w.priority).sort()).toEqual(['P1', 'P3']);
      expect(waitersAheadOf(baseline, session.startsWith('fix-') ? 'fix' : 'ci-heal'))
        .toMatchObject({ excludedBehindCount: 1, waiting: [expect.objectContaining({ priority: 'P1' })] });

      expect(releaseOwnedSlot({ lockRoot, cap: 1, owner: 'HOLDER' }).released).toBe(true);
      // Give the older build an actual acquisition attempt before resuming the fix.
      // A projection-only change lets it steal this free slot and fails this assertion.
      let buildClock = T0;
      const build = await acquireSlotBlocking({ ...options(), owner: 'BUILD', kind: buildKind,
        now: () => buildClock, sleep: async ms => { buildClock += ms; },
      });
      expect(build).toMatchObject({ ok: false, deferred: true });
      expect(heldSlots({ lockRoot, cap: 1 })).toEqual([]);
    } finally { continueFix(); }
    expect(await fix).toMatchObject({ ok: true, slot: 0 });
    expect(heldSlots({ lockRoot, cap: 1 })[0]).toMatchObject({ owner: 'FIX', meta: { priority: 'P1' } });
  });

  it.each([
    ['lease fix', { session: 'fix-203-lane-47-abc123' }, {}, 'P1'],
    ['lease unblock', { purpose: 'unblock-host' }, {}, 'P1'],
    ['environment unblock', null, { WE_HEAVY_UNBLOCK: '1' }, 'P1'],
    ['noncanonical unblock value', null, { WE_HEAVY_UNBLOCK: 'true' }, undefined],
    ['oversized identity', { session: 'fix-' + '2'.repeat(257) }, {}, undefined],
    ['oversized environment identity', null, { WE_HEAVY_SESSION: 'fix-' + '2'.repeat(257) }, undefined],
    ['red-main precedence', { purpose: 'main-fix-abcdef0', session: 'fix-203' }, {}, 'P0'],
  ])('records %s through the production classifier without changing P0 precedence', async (_name, lease, env, priority) => {
    const result = await acquireSlotBlocking({ ...options(), owner: 'CALLER', repo: lockRoot, env,
      readLease: () => lease, sleep: async () => { throw new Error('free slot must be acquired'); },
    });
    expect(result).toMatchObject({ ok: true, slot: 0 });
    expect(heldSlots({ lockRoot, cap: 1 })[0].meta.priority).toBe(priority);
  });

  it('ranks P0 first and P1 FCFS across both lanes for heavy slots, while preserving short-only capacity', async () => {
    marker('NORMAL', 'selected', 'P3', -4000);
    marker('FULL-P1', 'FULL', 'P1', -3000);
    marker('SHORT-P1', 'selected', 'P1', -2000);
    const rank = (owner, kind, slot) => isOldestLiveWaiter({ lockRoot, owner, kind, slot, cap: 1, nowMs: T0 });
    expect(rank('NORMAL', 'selected', 0)).toBe(false);
    expect(rank('FULL-P1', 'FULL', 0)).toBe(true);
    expect(rank('SHORT-P1', 'selected', 0)).toBe(false);
    expect(rank('SHORT-P1', 'selected', 1)).toBe(true);
    marker('REPAIR', 'FULL', 'P0', -1000);
    expect(rank('REPAIR', 'FULL', 0)).toBe(true);
    expect(rank('SHORT-P1', 'selected', 1)).toBe(false);
    clearWaiting({ lockRoot, owner: 'REPAIR' });
    clearWaiting({ lockRoot, owner: 'SHORT-P1' });
    // FULL P1 reserves the heavy slot even when that slot is free, but cannot use slot 1.
    const short = await acquireSlotBlocking({ ...options(), policy: policy('enforce', 1),
      owner: 'NORMAL', kind: 'selected', sleep: async () => { throw new Error('short-only slot is free'); },
    });
    expect(short).toMatchObject({ ok: true, slot: 1 });
    expect(heldSlots({ lockRoot, cap: 1, fastSlots: 1 }).map(h => h.owner)).toEqual(['NORMAL']);
  });

  it('preserves P0 and P1 marker classes in the live projection instead of discounting them as builds', () => {
    marker('REPAIR', 'FULL', 'P0'); marker('FIX', 'selected', 'P1'); marker('BUILD', 'selected');
    const baseline = snapshot();
    expect(baseline.waiting.map(w => w.priority).sort()).toEqual(['P0', 'P1', 'P3']);
    const ahead = waitersAheadOf(baseline, 'fix');
    expect(ahead.excludedBehindCount).toBe(1);
    expect(ahead.waiting.map(w => w.priority).sort()).toEqual(['P0', 'P1']);
  });

  it('priority off retains FCFS in the scheduler and all waiters in the projection', async () => {
    marker('BUILD', 'selected');
    let clock = T0;
    const fix = await acquireSlotBlocking({ ...options(), owner: 'FIX', policy: policy('off'),
      env: { WE_HEAVY_SESSION: 'fix-203', WE_HEAVY_UNBLOCK: '1' },
      now: () => clock, sleep: async ms => { clock += ms; },
    });
    expect(fix).toMatchObject({ ok: false, deferred: true });
    const baseline = snapshot('off');
    expect(baseline.priorityMode).toBe('off');
    expect(waitersAheadOf(baseline, 'fix')).toBe(baseline);
    expect(assessQueueAdmission(baseline).headline).toContain('counting all waiters (priority ordering off or unverified)');
  });

  it.each([undefined, null, 'unknown', 'off'])('closed path: %s priority mode retains old snapshots and reports the conservative fallback', priorityMode => {
    const baseline = { ...queueBacklog({ waiting: Array(12).fill({ kind: 'selected' }) }),
      slots: 1, maxWaitMinutes: 30, priorityMode,
    };
    expect(waitersAheadOf(baseline, 'fix')).toBe(baseline);
    expect(createQueueBudget(baseline).tryAdmit('fix')).toMatchObject({ admit: false, projectedMinutes: 39.25 });
    expect(assessQueueAdmission(baseline).headline).toContain('counting all waiters (priority ordering off or unverified)');
  });
});
