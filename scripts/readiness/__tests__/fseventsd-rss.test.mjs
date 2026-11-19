import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFseventsdRss, sampleFseventsdRss, nextFseventsdState, checkFseventsdRss, readFseventsdSignal, fseventsdThresholds } from '../../lib/fseventsd-rss.mjs';
import { acquireSlotBlocking, listWaiting } from '../heavy-admission.mjs';
const roots = [];
const scratch = () => { const root = mkdtempSync(join(tmpdir(), 'rss-test-')); roots.push(root); return root; };
const thresholds = { warnMb: 1024, throttleMb: 2048 };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it('sums only fseventsd RSS and bounds the injectable runner', () => {
  const run = vi.fn(() => '1048576 /System/fseventsd\n524288 fseventsd\n999999 other\n');
  expect(sampleFseventsdRss({ run })).toBe(1536);
  expect(run).toHaveBeenCalledWith('ps', ['-axo', 'rss=,comm='], expect.objectContaining({ timeout: 5000, maxBuffer: 4 * 1024 * 1024 }));
});
it('default thresholds and cascade overrides are deterministic', () => {
  expect(fseventsdThresholds({ env: {}, prefs: {}, tool: {} })).toMatchObject(thresholds);
  expect(fseventsdThresholds({ env: { WE_FSEVENTSD_WARN_MB: '100' }, prefs: { health: { fseventsd: { warnMb: 200 } } }, tool: {}, log: () => {} }).warnMb).toBe(100);
});
it('warns separately from throttling, holds hysteresis, and clears below 90 percent', () => {
  expect(nextFseventsdState(1024, thresholds)).toMatchObject({ level: 'warn', throttled: false });
  expect(nextFseventsdState(2048, thresholds)).toMatchObject({ level: 'throttle', throttled: true });
  expect(nextFseventsdState(1900, thresholds, { throttled: true }).throttled).toBe(true);
  expect(nextFseventsdState(1800, thresholds, { throttled: true })).toMatchObject({ level: 'warn', throttled: false });
  expect(nextFseventsdState(100, thresholds)).toMatchObject({ level: 'clear', throttled: false });
});
it('unknown, unreadable and oversized evidence fail closed; absent state preserves default', () => {
  expect(() => parseFseventsdRss('')).toThrow();
  expect(() => parseFseventsdRss('bad fseventsd')).toThrow();
  expect(() => parseFseventsdRss('x'.repeat(4 * 1024 * 1024 + 1))).toThrow();
  expect(nextFseventsdState(null, thresholds).throttled).toBe(true);
  const path = join(scratch(), 'state.json');
  expect(readFseventsdSignal({ path }).throttled).toBe(false);
  writeFileSync(path, '{}'); expect(readFseventsdSignal({ path }).throttled).toBe(true);
  expect(readFseventsdSignal({ read: () => { throw Error('EACCES'); } }).throttled).toBe(true);
});
it('persists throttle/recovery and emits monitor events only on transitions', async () => {
  const path = join(scratch(), 'state.json'), emit = vi.fn(), log = vi.fn();
  const tick = rssMb => checkFseventsdRss({ path, thresholds, sample: () => rssMb, emit, log });
  await tick(1200); expect(readFseventsdSignal({ path }).throttled).toBe(false);
  await tick(2200); await tick(2100); expect(readFseventsdSignal({ path }).throttled).toBe(true);
  await tick(100); expect(readFseventsdSignal({ path }).throttled).toBe(false);
  expect(emit.mock.calls.map(([event]) => event.kind)).toEqual(['fseventsd-rss-warn', 'fseventsd-rss-throttle', 'fseventsd-rss-clear']);
  expect(log).toHaveBeenCalledTimes(2);
});
it('refuses new grants while throttled even with host admission allowed and cleans its waiter', async () => {
  const lockRoot = scratch();
  const result = await acquireSlotBlocking({ lockRoot, cap: 1, owner: 'rss-test', env: {}, canDefer: true,
    readFsevents: () => ({ throttled: true, rssMb: 2200 }), hostAdmission: () => ({ admitted: true }), log: () => {} });
  expect(result).toMatchObject({ ok: false, deferred: true });
  expect(listWaiting(lockRoot)).toEqual([]);
});
it('queue checks the signal again after waiting and grants only after recovery', async () => {
  const lockRoot = scratch(); let clock = 0, blocked = true;
  const result = await acquireSlotBlocking({ lockRoot, cap: 1, owner: 'rss-recovery', env: {}, canDefer: true, waitMs: 1000,
    now: () => clock, pollMs: 10, sleep: async ms => { clock += ms; blocked = false; },
    readFsevents: () => ({ throttled: blocked }), hostAdmission: () => ({ admitted: true }), log: () => {} });
  expect(result.ok).toBe(true);
});
it('mandatory calls also defer at their ceiling instead of bypassing the throttle', async () => {
  const lockRoot = scratch(); let clock = 0;
  const result = await acquireSlotBlocking({ lockRoot, cap: 1, owner: 'rss-ceiling', env: {}, ceilingMs: 20, pollMs: 10,
    now: () => clock, sleep: async ms => { clock += ms; }, readFsevents: () => ({ throttled: true }), log: () => {} });
  expect(result).toMatchObject({ ok: false, deferred: true, waitedMs: 20 });
});
