import { beforeEach, afterEach, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireSlot, listSlots, heartbeatSlot, releaseSlot, liveBuilderSlotRows, waitForSlot } from '../builder-slots.mjs';
import { BUILDER_SLOT_DEFAULTS as settings } from '../builder-slots-settings.mjs';
let root, time, o;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'builder-slots-')); time = 10000; o = { root, now: () => time, hostname: 'test', isPidAlive: () => true, settings }; });
afterEach(() => rmSync(root, { recursive: true, force: true }));
const take = (kind = 'codex', extra = {}) => acquireSlot({ ...o, class: kind, purpose: 'test', ...extra });
it('caps external at four, sharing Codex and Antigravity, and Claude at one', async () => {
  for (let i = 0; i < 4; i++) expect((await take(i === 0 ? 'antigravity' : 'codex')).ok).toBe(true);
  expect(await take()).toMatchObject({ ok: false, reason: 'full', cap: 4, holders: expect.any(Array) });
  expect((await take('claude')).ok).toBe(true);
  expect(await take('claude')).toMatchObject({ ok: false, cap: 1 });
});
it('wait succeeds after release and refuses after its budget, throttling notices', async () => {
  const holder = await take('claude'); let notices = 0;
  const request = { ...o, class: 'claude', purpose: 'waiting', waitMs: 120001, pollMs: 10000, onWaiting: () => notices++, sleep: async ms => { time += ms; } };
  expect(await waitForSlot(request)).toMatchObject({ ok: false, reason: 'wait-budget' });
  expect(notices).toBe(3);
  const result = await waitForSlot({ ...request, sleep: async ms => { time += ms; releaseSlot(holder.id, o); } });
  expect(result.ok).toBe(true);
});
it('reclaims a dead local PID but preserves a remote PID', async () => {
  await take('claude', { pid: 99 });
  expect((await take('claude', { isPidAlive: () => false })).ok).toBe(true);
  const other = await take('codex', { pid: 99, hostname: 'remote' });
  expect(listSlots({ ...o, isPidAlive: () => false }).find(r => r.id === other.id).stale).toBe(false);
});
it('reaps expired leases and heartbeat extends the TTL', async () => {
  const first = await take('claude', { ttlMs: 1000 });
  time += 900; heartbeatSlot(first.id, o); time += 900;
  expect((await take('claude')).ok).toBe(false);
  time += 101;
  expect(listSlots(o)).toMatchObject([{ id: first.id, stale: true }]);
  expect(listSlots(o)).toEqual([]);
  expect((await take('claude')).ok).toBe(true);
});
it('release is idempotent and rows occupy only builder slots', async () => {
  const slot = await take('claude');
  expect(liveBuilderSlotRows(o)).toEqual([{ num: `slot-${slot.id}`, scope: [], source: `builder slot test ${slot.id}`, executor: 'claude', borrowedFix: true }]);
  releaseSlot(slot.id, o); releaseSlot(slot.id, o);
  expect(listSlots(o)).toEqual([]);
});
it('kill switch neither writes nor reads even a corrupt store', async () => {
  writeFileSync(join(root, 'bad.json'), 'bad');
  const disabled = { ...o, settings: { ...settings, enabled: false } };
  expect(liveBuilderSlotRows(disabled)).toEqual([]);
  expect(await acquireSlot({ ...disabled, class: 'codex' })).toMatchObject({ ok: true, id: 'disabled' });
});
it('unreadable evidence refuses acquisition; zero cap refuses with an operator-visible bound', async () => {
  expect(await take('claude', { caps: { claude: 0 } })).toMatchObject({ ok: false, cap: 0 });
  writeFileSync(join(root, 'bad.json'), '{}');
  await expect(take()).rejects.toThrow('Invalid builder slot record');
});
it('serializes concurrent acquisitions and reclaims an abandoned mutex', async () => {
  time = 20001;
  mkdirSync(join(root, '.lock')); utimesSync(join(root, '.lock'), new Date(0), new Date(0));
  const results = await Promise.all(Array.from({ length: 8 }, () => take()));
  expect(results.filter(r => r.ok)).toHaveLength(4);
});

it('ignores stale rows without charging the planner a builder slot', async () => {
  await take('codex', { ttlMs: 1000 }); time += 1001;
  expect(liveBuilderSlotRows(o)).toEqual([]);
});
it('disabled heartbeat and release do not mutate existing records', async () => {
  const slot = await take(); time += 500;
  const disabled = { ...o, settings: { ...settings, enabled: false } };
  heartbeatSlot(slot.id, disabled); releaseSlot(slot.id, disabled);
  expect(listSlots(o)[0].heartbeatAt).toBe(slot.record.heartbeatAt);
});
