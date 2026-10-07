/** #3383 — Nonblocking tick exclusion with fenced stale recovery and bounded ownership. */
import { it, expect, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { ensureTestTmpDir } from '../../lib/test-tmp-root.mjs';
import { tryAcquireTickMutex, withTickMutex } from '../tick-mutex.mjs';
let clock, root;
const acquire = (driverId, options = {}) => tryAcquireTickMutex({ root, owner: { driverId, pid: 42, host: 'test' }, tickId: `${driverId}#1`,
  now: () => clock, staleMs: 10, maxHoldMs: 100, isPidAlive: () => true, ...options });
beforeEach(() => { clock = 100; root = ensureTestTmpDir('WE_COORDINATION_ROOT'); });
it('is exclusive, nonblocking, and release is idempotent', () => {
  const a = acquire('a');
  expect(a.ok).toBe(true);
  expect(acquire('b')).toMatchObject({ ok: false, reason: 'busy', heldBy: { driverId: 'a' } });
  expect(a.handle.release()).toBe(true);
  expect(a.handle.release()).toBe(true);
  expect(acquire('b').ok).toBe(true);
});
it('only one simultaneous stale stealer wins and old ownership is fenced', async () => {
  const a = acquire('a'); clock += 11;
  const stolen = await Promise.all(['b', 'c'].map((id) => Promise.resolve().then(() => acquire(id))));
  expect(stolen.filter((r) => r.ok)).toHaveLength(1);
  expect(a.handle.heartbeat()).toBe(false);
  expect(a.handle.release()).toBe(false);
});
it('can steal a dead same-host pid but never interprets a backwards clock as expiry', () => {
  const a = acquire('a'); clock -= 100;
  expect(acquire('b').ok).toBe(false);
  expect(acquire('b', { isPidAlive: () => false }).ok).toBe(true);
  expect(a.handle.release()).toBe(false);
});
it('bounds total hold even while heartbeating', () => {
  const a = acquire('a');
  for (let i = 0; i < 9; i++) { clock += 10; expect(a.handle.heartbeat()).toBe(true); }
  clock += 10;
  expect(a.handle.heartbeat()).toBe(false);
});
it('releases on a thrown tick', async () => {
  await expect(withTickMutex({ root, now: () => clock }, () => { throw new Error('tick'); })).rejects.toThrow('tick');
  expect(acquire('b').ok).toBe(true);
});

it('recovers a crashed arbitration owner and only one recovery contender wins', async () => {
  const gate = join(root, 'tick-mutex.gate');
  mkdirSync(gate);
  writeFileSync(join(gate, 'owner-dead.json'), JSON.stringify({ pid: 999999, host: hostname(), token: 'dead' }));
  const results = await Promise.all(['a', 'b'].map((id) => Promise.resolve().then(() => acquire(id, { isPidAlive: (pid) => pid !== 999999 }))));
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  expect(results.find((r) => !r.ok).reason).toBe('busy');
});

it('does not mistake a competing reader’s short fence for losing the tick lease', () => {
  const gate = join(root, 'tick-mutex.gate');
  let waited = 0;
  const a = acquire('a', { wait: () => { waited++; rmSync(gate, { recursive: true }); } });
  mkdirSync(gate);
  writeFileSync(join(gate, 'owner-reader.json'), JSON.stringify({ pid: 999999, host: hostname(), token: 'reader' }));
  expect(JSON.parse(readFileSync(join(root, 'tick-mutex/owner.json'))).token).toBe(a.handle.token);
  expect(a.handle.heartbeat()).toBe(true);
  expect(waited).toBe(1);
});
