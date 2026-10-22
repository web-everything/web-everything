import { beforeEach, afterEach, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireSlot, isStale, listSlots, heartbeatSlot, releaseSlot, liveBuilderSlotRows, waitForSlot } from '../builder-slots.mjs';
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
  expect(await take()).toMatchObject({ ok: false, reason: 'unreadable', error: 'Invalid builder slot record' });
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

it('counts daemon and foreground external builders in both directions, including Antigravity', async () => {
  const rows = n => Array.from({ length: n }, (_, num) => ({ num: String(num), executor: num === 0 ? 'antigravity' : 'codex' }));
  expect(await take('codex', { inFlightRows: async () => rows(4) })).toMatchObject({ ok: false, reason: 'full', counts: { external: 4, claude: 0 } });
  expect(await take('claude', { inFlightRows: async () => [{ num: 'c' }] })).toMatchObject({ ok: false, reason: 'full', cap: 1 });
  expect((await take('codex', { inFlightRows: async () => rows(3) })).ok).toBe(true);
  expect(await take('antigravity', { inFlightRows: async () => rows(3) })).toMatchObject({ ok: false, reason: 'full', counts: { external: 4 } });
});
it('returns immediately on corrupt slots or a failed provider without sleeping', async () => {
  const request = { ...o, class: 'codex', waitMs: 10000, sleep: () => { throw new Error('must not sleep'); } };
  expect(await waitForSlot({ ...request, inFlightRows: async () => { throw new Error('provider unavailable'); } })).toMatchObject({ reason: 'unreadable', error: 'provider unavailable' });
  writeFileSync(join(root, 'bad.json'), '{');
  expect(await waitForSlot(request)).toMatchObject({ ok: false, reason: 'unreadable' });
});
it('refuses a failed root/mutex and treats a missing store as empty', async () => {
  const file = join(root, 'file'); writeFileSync(file, 'not a directory');
  expect(await take('codex', { root: file })).toMatchObject({ reason: 'unreadable' });
  expect(listSlots({ ...o, root: join(root, 'absent') })).toEqual([]);
});

it('returns unreadable if the mutex wait fails, without granting a lease', async () => {
  mkdirSync(join(root, '.lock'));
  expect(await take('codex', { sleep: async () => { throw new Error('mutex unavailable'); } })).toMatchObject({ ok: false, reason: 'unreadable', error: 'mutex unavailable' });
  expect(listSlots(o)).toEqual([]);
});

it('local live PID survives heartbeat starvation until maxAgeMs; remote and pid-less records use TTL', () => {
  const record = { pid: 99, host: 'test', startedAt: 0, heartbeatAt: 0, ttlMs: 1000 };
  const probe = { hostname: 'test', isPidAlive: () => true, maxAgeMs: 10000 };
  expect(isStale(record, 2000, probe)).toBe(false);
  expect(isStale(record, 2000, { ...probe, isPidAlive: () => false })).toBe(true);
  expect(isStale(record, 10001, probe)).toBe(true);
  expect(isStale({ ...record, heartbeatAt: 10000 }, 10001, probe)).toBe(true);
  expect(isStale({ ...record, pid: null }, 1000, probe)).toBe(false);
  expect(isStale({ ...record, pid: null }, 1001, probe)).toBe(true);
  expect(isStale({ ...record, host: 'remote' }, 1001, probe)).toBe(true);
});
it('listSlots applies configured hard age to existing pid records without requiring a migration', async () => {
  await take('codex', { pid: 99 });
  time += settings.ttlMs + 1;
  expect(listSlots(o)[0].stale).toBe(false);
  expect(listSlots({ ...o, settings: { ...settings, maxAgeMs: settings.ttlMs } })[0].stale).toBe(true);
});

it('acquisition counts linked unknown claims conservatively and same-class runs through the live slot', async () => {
  const holder = await take('codex');
  const claim = { num: '123', slotLink: holder.id };
  expect(await take('claude', { inFlightRows: async () => [claim] })).toMatchObject({ ok: false, reason: 'full', counts: { claude: 1, external: 1 } });
  expect(await take('codex', { caps: { codex: 1 }, inFlightRows: async () => [claim] })).toMatchObject({ ok: false, counts: { claude: 1, external: 1 } });
  expect((await take('codex', { caps: { codex: 2 }, inFlightRows: async () => [{ ...claim, executor: 'codex' }] })).ok).toBe(true);
  releaseSlot(holder.id, o);
  expect(await take('claude', { inFlightRows: async () => [claim] })).toMatchObject({ ok: false, counts: { claude: 1, external: 1 } });
});
