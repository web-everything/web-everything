/** Purpose: prove host-wide smoke capacity, FIFO admission and safe persisted-state handling.
 * Exports: none (Vitest cases).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireSmokeSlot } from '../daemon-smoke-slots.mjs';
import { rebuildClone } from '../daemon-rebuild/rebuild.mjs';
import * as cloneLocks from '../daemon-clone-lock.mjs';
import * as smoke from '../daemon-rebuild/smoke.mjs';
import * as rebuildState from '../daemon-rebuild/state.mjs';
import * as leases from '../daemon-rebuild/lease.mjs';
import * as adoptions from '../overlay-adoption.mjs';

const settings = { value: undefined };

let stateDir, log, sleepers;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'we-smoke-slots-'));
  log = { error: vi.fn() };
  sleepers = [];
  settings.value = { smokeMaxConcurrent: 2 };
  const read = fs.readFileSync;
  vi.spyOn(fs, 'readFileSync').mockImplementation((path, ...args) =>
    String(path).endsWith('/daemon-rebuild-settings.json') && settings.value !== undefined
      ? JSON.stringify(settings.value) : read(path, ...args));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(stateDir, { recursive: true, force: true });
});
const state = () => JSON.parse(readFileSync(join(stateDir, 'smoke-slots.json'), 'utf8'));
const acquire = (pid, extra = {}) => acquireSmokeSlot({
  stateDir, env: {}, log, pid, isAlive: () => true, now: () => 123,
  sleep: ms => new Promise(resolve => sleepers.push({ ms, resolve })), ...extra,
});
async function wake() {
  const pending = sleepers.splice(0);
  pending.forEach(({ resolve }) => resolve());
  // Drain the async acquisition continuations without a real timer.
  await new Promise(resolve => setImmediate(resolve));
}

describe('daemon smoke slots', () => {
  it('ships a 15-minute queue default below the rebuild lease safety ceiling', () => {
    settings.value = undefined;
    const shipped = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'daemon-rebuild-settings.json'), 'utf8'));
    expect(shipped.smokeQueueMaxWaitMs).toBe(900000);
    expect(shipped.smokeQueueMaxWaitMs).toBeLessThan(leases.DEFAULT_REBUILD_LEASE_STALE_MS - 120000);
  });

  it('cap 2 admits two callers, queues the third, and release frees it on the next poll', async () => {
    const a = await acquire(11), b = await acquire(12);
    expect(a.acquired).toBe(true);
    expect(b.acquired).toBe(true);
    let admitted = false;
    const c = acquire(13).then(slot => { admitted = true; return slot; });
    await wake();
    expect(admitted).toBe(false);
    expect(log.error).toHaveBeenCalledWith('daemon-live-smoke: smoke-queued (0 ahead)');
    expect(sleepers[0].ms).toBe(2000);
    expect(state().holders).toHaveLength(2);
    await a.release();
    await wake();
    const third = await c;
    expect(admitted).toBe(true);
    expect(third.acquired).toBe(true);
    expect(state().holders.map(e => e.pid)).toEqual([12, 13]);
    await b.release(); await third.release();
    expect(state().holders).toEqual([]);
  });

  it('admits FIFO by ticket even when the later waiter polls first; logs only changed queue positions', async () => {
    const env = { WE_DAEMON_SMOKE_MAX_CONCURRENT: '1' };
    const a = await acquire(11, { env });
    const order = [];
    const b = acquire(12, { env }).then(slot => { order.push(12); return slot; });
    const c = acquire(13, { env }).then(slot => { order.push(13); return slot; });
    await wake();
    expect(log.error.mock.calls.filter(([s]) => s.includes('smoke-queued'))).toEqual([
      ['daemon-live-smoke: smoke-queued (0 ahead)'], ['daemon-live-smoke: smoke-queued (1 ahead)'],
    ]);
    await a.release();
    sleepers.reverse();
    await wake();
    const second = await b;
    expect(order).toEqual([12]);
    await wake();
    expect(log.error).toHaveBeenLastCalledWith('daemon-live-smoke: smoke-queued (0 ahead)');
    await second.release(); await wake();
    await (await c).release();
    expect(order).toEqual([12, 13]);
  });

  it('admits FIFO with cap 2 when both holders release and the later waiter polls first', async () => {
    const a = await acquire(11), b = await acquire(12);
    const order = [];
    const c = acquire(13).then(slot => { order.push(13); return slot; });
    const d = acquire(14).then(slot => { order.push(14); return slot; });
    await wake();
    expect(state().waiters.map(e => e.pid)).toEqual([13, 14]);
    await a.release(); await b.release();
    expect(state().holders).toEqual([]);
    sleepers.reverse();
    await wake();
    expect(order).toEqual([13]);
    expect(state().holders.map(e => e.pid)).toEqual([13]);
    await wake();
    const slots = await Promise.all([c, d]);
    expect(order).toEqual([13, 14]);
    expect(state().holders.map(e => e.pid)).toEqual([13, 14]);
    await Promise.all(slots.map(slot => slot.release()));
  });

  it('prunes dead holders and waiters without counting their tickets', async () => {
    writeFileSync(join(stateDir, 'smoke-slots.json'), JSON.stringify({ nextTicket: 3,
      holders: [{ pid: 91, ticket: 1, at: 1 }], waiters: [{ pid: 92, ticket: 2, at: 1 }] }));
    const slot = await acquire(13, { env: { WE_DAEMON_SMOKE_MAX_CONCURRENT: '1' }, isAlive: pid => pid === 13 });
    expect(state().holders).toEqual([{ pid: 13, ticket: 3, at: 123 }]);
    expect(state().waiters).toEqual([]);
    await slot.release();
    await slot.release(); // idempotent
  });

  it.each([
    [{ smokeMaxConcurrent: 3 }, {}, 3, 'tool'],
    [{ smokeMaxConcurrent: 3 }, { WE_DAEMON_SMOKE_MAX_CONCURRENT: '1' }, 1, 'env'],
    [{ smokeMaxConcurrent: 0 }, {}, 2, 'default'],
    ...['garbage', '0', '-1', '1.5', '', '9007199254740992'].map(raw =>
      [{ smokeMaxConcurrent: 3 }, { WE_DAEMON_SMOKE_MAX_CONCURRENT: raw }, 3, 'tool']),
    [{ smokeMaxConcurrent: 0 }, { WE_DAEMON_SMOKE_MAX_CONCURRENT: 'garbage' }, 2, 'default'],
    [{}, {}, 2, 'default'],
    [{ smokeMaxConcurrent: 1.5 }, {}, 2, 'default'],
    [{}, { WE_DAEMON_SMOKE_MAX_CONCURRENT: '9007199254740992' }, 2, 'default'],
    [{}, { WE_DAEMON_SMOKE_MAX_CONCURRENT: '-1' }, 2, 'default'],
  ])('resolves setting %j and env %j to cap %s (%s)', async (value, env, cap, source) => {
    settings.value = value;
    const slots = [];
    for (let i = 1; i <= cap; i++) slots.push(await acquire(i, { env }));
    const queued = acquire(cap + 1, { env });
    await wake();
    expect(state().holders).toHaveLength(cap);
    expect(state().waiters).toHaveLength(1);
    expect(log.error).toHaveBeenCalledWith(`daemon-live-smoke: smokeMaxConcurrent=${cap} (${source})`);
    await slots[0].release(); await wake();
    await (await queued).release();
    await Promise.all(slots.slice(1).map(slot => slot.release()));
  });

  it.each(['during temporary write', 'before rename', 'after rename'])(
    'interrupted persistence %s exposes only complete state and reclaims the crashed owner lock', async phase => {
      const path = join(stateDir, 'smoke-slots.json');
      const lock = join(stateDir, 'smoke-slots.lock');
      const previous = { nextTicket: 2, holders: [{ pid: process.pid, ticket: 1, at: 1 }], waiters: [] };
      const previousBytes = JSON.stringify(previous, null, 2);
      writeFileSync(path, previousBytes);
      // Exit inside real filesystem operations in a separate process: neither finally nor
      // acquireSmokeSlot's error cleanup may run and conceal the interrupted on-disk state.
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import fs from 'node:fs';
        import { syncBuiltinESMExports } from 'node:module';
        import { join } from 'node:path';
        import { pathToFileURL } from 'node:url';
        const [modulePath, stateDir, phase] = process.argv.slice(1);
        const target = join(stateDir, 'smoke-slots.json');
        const write = fs.writeFileSync;
        const rename = fs.renameSync;
        fs.writeFileSync = (path, data, ...options) => {
          if (String(path).endsWith('.state.json') && phase === 'during temporary write') {
            write(path, data.slice(0, Math.floor(data.length / 2)), ...options);
            process.exit(73);
          }
          return write(path, data, ...options);
        };
        fs.renameSync = (from, to) => {
          if (String(to) === target) {
            if (phase === 'after rename') rename(from, to);
            process.exit(73);
          }
          return rename(from, to);
        };
        syncBuiltinESMExports();
        const { acquireSmokeSlot } = await import(pathToFileURL(modulePath).href);
        await acquireSmokeSlot({ stateDir, env: { WE_DAEMON_SMOKE_MAX_CONCURRENT: '2' },
          log: { error() {} }, isAlive: () => true, now: () => 123 });
        process.exit(74); // The injected interruption must be reached.
      `, join(dirname(fileURLToPath(import.meta.url)), '..', 'daemon-smoke-slots.mjs'), stateDir, phase], {
        encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024,
      });
      expect(child.error).toBeUndefined();
      expect(child.stderr).toBe('');
      expect(child.signal).toBeNull();
      expect(child.status).toBe(73);
      const temporary = join(lock, fs.readdirSync(lock).find(name => name.endsWith('.state.json')) || 'state.json');
      const replacement = { nextTicket: 3,
        holders: [...previous.holders, { pid: child.pid, ticket: 2, at: 123 }], waiters: [] };
      if (phase === 'after rename') {
        expect(state()).toEqual(replacement);
        expect(fs.existsSync(temporary)).toBe(false);
      } else {
        expect(readFileSync(path, 'utf8')).toBe(previousBytes);
        const staged = readFileSync(temporary, 'utf8');
        if (phase === 'before rename') expect(JSON.parse(staged)).toEqual(replacement);
        else expect(() => JSON.parse(staged)).toThrow();
      }
      expect(fs.existsSync(join(stateDir, 'smoke-slots.lock'))).toBe(true);
      const recovered = await acquire(process.pid, { isAlive: undefined });
      expect(state().holders.some(e => e.pid === child.pid)).toBe(false);
      await recovered.release();
    },
  );

  it('fails closed on corrupt state rather than admitting an uncounted smoke', async () => {
    writeFileSync(join(stateDir, 'smoke-slots.json'), '{broken');
    await expect(acquire(11)).rejects.toThrow();
    expect(readFileSync(join(stateDir, 'smoke-slots.json'), 'utf8')).toBe('{broken');
  });

  it('rejects incomplete state instead of resetting live capacity', async () => {
    writeFileSync(join(stateDir, 'smoke-slots.json'), JSON.stringify({ holders: [] }));
    await expect(acquire(11)).rejects.toThrow('invalid smoke slot state');
  });

  it('prunes a holder that dies while a waiter is queued', async () => {
    const alive = new Set([11, 12]);
    const extra = { env: { WE_DAEMON_SMOKE_MAX_CONCURRENT: '1' }, isAlive: pid => alive.has(pid) };
    await acquire(11, extra);
    const waiting = acquire(12, extra);
    await wake();
    alive.delete(11);
    await wake();
    await (await waiting).release();
    expect(state().holders).toEqual([]);
  });

  it('removes a cancelled waiter without dropping a live holder', async () => {
    const a = await acquire(11, { env: { WE_DAEMON_SMOKE_MAX_CONCURRENT: '1' } });
    await expect(acquire(12, { env: { WE_DAEMON_SMOKE_MAX_CONCURRENT: '1' },
      sleep: async () => { throw new Error('interrupted'); } })).rejects.toThrow('interrupted');
    expect(state().waiters).toEqual([]);
    expect(state().holders.map(e => e.pid)).toEqual([11]);
    await a.release();
  });

  it('only treats ESRCH as a dead pid; EPERM holders still count', async () => {
    writeFileSync(join(stateDir, 'smoke-slots.json'), JSON.stringify({ nextTicket: 3,
      holders: [{ pid: 91, ticket: 1, at: 1 }, { pid: 92, ticket: 2, at: 1 }], waiters: [] }));
    vi.spyOn(process, 'kill').mockImplementation(pid => {
      if (pid === 91) throw Object.assign(new Error(), { code: 'ESRCH' });
      if (pid === 92) throw Object.assign(new Error(), { code: 'EPERM' });
      return true;
    });
    const slot = await acquire(13, { isAlive: undefined });
    expect(state().holders.map(e => e.pid)).toEqual([92, 13]);
    await slot.release();
  });

  it('preserves a live lock owner regardless of lock age', async () => {
    mkdirSync(join(stateDir, 'smoke-slots.lock'));
    writeFileSync(join(stateDir, 'smoke-slots.lock', 'pid'), '91');
    fs.utimesSync(join(stateDir, 'smoke-slots.lock'), 0, 0);
    let time = 0;
    await expect(acquire(11, { now: () => time, sleep: async ms => { time += ms; } }))
      .rejects.toThrow('remove only after confirming no writer is active');
    expect(time).toBe(30_000);
  });

  it('records the lock owner pid during the transaction', async () => {
    const slot = await acquire(11, { isAlive: () => {
      const lock = join(stateDir, 'smoke-slots.lock');
      const owner = fs.readdirSync(lock).find(name => name.endsWith('.pid'));
      expect(readFileSync(join(lock, owner), 'utf8')).toBe('11');
      return true;
    } });
    await slot.release();
  });

  it('reclaims a fresh lock immediately when its owner is dead', async () => {
    mkdirSync(join(stateDir, 'smoke-slots.lock'));
    writeFileSync(join(stateDir, 'smoke-slots.lock', 'pid'), '91');
    const slot = await acquire(11, { isAlive: pid => pid !== 91, sleep: async () => { throw new Error('dead lock blocked'); } });
    expect(state().holders.map(e => e.pid)).toEqual([11]);
    expect(sleepers).toEqual([]);
    await slot.release();
  });

  it('concurrent reclaimers cannot remove a replacement writer lock or lose any ticket', async () => {
    const lock = join(stateDir, 'smoke-slots.lock');
    mkdirSync(lock);
    writeFileSync(join(lock, 'pid'), '91');
    writeFileSync(join(stateDir, 'smoke-slots.json'), JSON.stringify({ nextTicket: 2,
      holders: [{ pid: 10, ticket: 1, at: 1 }], waiters: [] }));
    let second, pendingRemoval, removalError, forced = false, overlap = false;
    const wrapRemoval = original => (path, ...args) => {
      if (String(path) !== lock || forced) return original(path, ...args);
      forced = true;
      // Pause A immediately before removing the old directory. B replaces it and enters
      // its transaction; resume A's stale removal while B still holds that replacement.
      pendingRemoval = () => {
        try { original(path, ...args); } catch (error) { removalError = error; }
      };
      second = acquire(12, { env: { WE_DAEMON_SMOKE_MAX_CONCURRENT: '3' }, now: () => Date.now() + 120_000, sleep: async () => { throw new Error('unexpected contention'); }, isAlive: owner => {
        if (owner === 10 && pendingRemoval) {
          const remove = pendingRemoval;
          pendingRemoval = undefined;
          remove();
          overlap = !fs.existsSync(lock);
        }
        return owner !== 91;
      } });
      // Attach immediately so a regression cannot produce an unhandled rejection.
      second.catch(() => {});
      if (pendingRemoval) { const remove = pendingRemoval; pendingRemoval = undefined; remove(); }
      if (removalError) throw removalError;
    };
    const remove = fs.rmSync, removeDirectory = fs.rmdirSync;
    vi.spyOn(fs, 'rmSync').mockImplementation(wrapRemoval(remove));
    vi.spyOn(fs, 'rmdirSync').mockImplementation(wrapRemoval(removeDirectory));
    const first = await acquire(11, { env: { WE_DAEMON_SMOKE_MAX_CONCURRENT: '3' }, now: () => Date.now() + 120_000, sleep: async () => { throw new Error('unexpected contention'); }, isAlive: owner => owner !== 91 });
    const other = await second;
    expect(forced).toBe(true);
    expect(overlap).toBe(false);
    expect(state().holders.map(e => e.ticket).sort()).toEqual([1, 2, 3]);
    expect(state().holders.map(e => e.pid).sort()).toEqual([10, 11, 12]);
    await first.release(); await other.release();
  });

  it.each([undefined, 'broken'])('reclaims a lock with no valid owner after 60s (owner=%s)', async owner => {
    const lock = join(stateDir, 'smoke-slots.lock');
    mkdirSync(lock);
    if (owner !== undefined) writeFileSync(join(lock, 'pid'), owner);
    fs.utimesSync(lock, 0, 0);
    let time = 59_000;
    const slot = await acquire(11, { now: () => time, sleep: async ms => { time += ms; } });
    expect(time).toBe(61_000);
    await slot.release();
  });

  it.each([
    [{}, {}, 900000, 'default'],
    [{ smokeQueueMaxWaitMs: 5001 }, {}, 5001, 'tool'],
    [{ smokeQueueMaxWaitMs: 5001 }, { WE_DAEMON_SMOKE_QUEUE_MAX_WAIT_MS: '3001' }, 3001, 'env'],
    [{ smokeQueueMaxWaitMs: 0 }, {}, 900000, 'default'],
    ...['invalid', '0', '-1', '1.5', '', '9007199254740992'].map(raw =>
      [{ smokeQueueMaxWaitMs: 5001 }, { WE_DAEMON_SMOKE_QUEUE_MAX_WAIT_MS: raw }, 5001, 'tool']),
    [{ smokeQueueMaxWaitMs: 0 }, { WE_DAEMON_SMOKE_QUEUE_MAX_WAIT_MS: 'invalid' }, 900000, 'default'],
    [{ smokeQueueMaxWaitMs: 1800000 }, {}, leases.DEFAULT_REBUILD_LEASE_STALE_MS - 120000, 'tool'],
    [{ smokeQueueMaxWaitMs: 5001 }, { WE_DAEMON_SMOKE_QUEUE_MAX_WAIT_MS: '9007199254740991' },
      leases.DEFAULT_REBUILD_LEASE_STALE_MS - 120000, 'env'],
    [{ smokeQueueMaxWaitMs: leases.DEFAULT_REBUILD_LEASE_STALE_MS - 120000 }, {},
      leases.DEFAULT_REBUILD_LEASE_STALE_MS - 120000, 'tool'],
    [{}, { WE_DAEMON_SMOKE_QUEUE_MAX_WAIT_MS: '-1' }, 900000, 'default'],
    [{}, { WE_DAEMON_SMOKE_QUEUE_MAX_WAIT_MS: '1.5' }, 900000, 'default'],
    [{}, { WE_DAEMON_SMOKE_QUEUE_MAX_WAIT_MS: '9007199254740992' }, 900000, 'default'],
  ])('bounds queue residence with setting %j env %j at %sms (%s)', async (value, env, bound, source) => {
    settings.value = { ...value, smokeMaxConcurrent: 1 };
    const holder = await acquire(11);
    let time = 0;
    const slot = await acquire(12, { env, now: () => time, sleep: async ms => {
      time += ms;
      if (time > bound + 2000) throw new Error('queue exceeded bound');
    } });
    expect(time).toBe(bound);
    expect(slot.acquired).toBe(false);
    const requested = Number(env.WE_DAEMON_SMOKE_QUEUE_MAX_WAIT_MS ?? value.smokeQueueMaxWaitMs);
    if (Number.isSafeInteger(requested) && requested > bound) {
      expect(log.error).toHaveBeenCalledWith(
        `daemon-live-smoke: smokeQueueMaxWaitMs clamped from ${requested} to ${bound}ms (rebuild lease lifetime minus 2min)`);
    }
    expect(log.error).toHaveBeenCalledWith(`daemon-live-smoke: smokeQueueMaxWaitMs=${bound} (${source})`);
    expect(log.error).toHaveBeenCalledWith(`daemon-live-smoke: smoke-queue-timeout (waited ${bound}ms) — giving up this attempt`);
    expect(state().waiters).toEqual([]);
    expect(state().holders.map(e => e.pid)).toEqual([11]);
    await slot.release();
    expect(state().holders.map(e => e.pid)).toEqual([11]);
    await holder.release();
  });

  it.each([false, true])('returns no slot at the deadline with a busy state lock and never exceeds the cap (ticket=%s)', async hasTicket => {
    settings.value = { smokeMaxConcurrent: 1, smokeQueueMaxWaitMs: 3001 };
    await acquire(11);
    const lock = join(stateDir, 'smoke-slots.lock');
    const plantLock = () => {
      mkdirSync(lock);
      writeFileSync(join(lock, 'pid'), '91');
    };
    if (!hasTicket) plantLock();
    let time = 0;
    const slot = await acquire(12, { now: () => time, sleep: async ms => {
      time += ms;
      if (hasTicket && time === 2000) plantLock();
      if (time > 5001) throw new Error('cleanup exceeded queue bound');
    } });
    expect(time).toBe(3001);
    expect(slot.acquired).toBe(false);
    expect(log.error).toHaveBeenCalledWith('daemon-live-smoke: smoke-queue-timeout (waited 3001ms) — giving up this attempt');
    await slot.release();
    expect(state().holders.map(e => e.pid)).toEqual([11]);
    // An unavailable transaction cannot remove a ticket; later transactions reclaim it.
    rmSync(lock, { recursive: true });
    const next = await acquire(13, { isAlive: pid => pid === 13 });
    expect(state().waiters).toEqual([]);
    await next.release();
  });

  it('release swallows a throwing logger after three failed transactions', async () => {
    let fail = false;
    const slot = await acquire(11, { isAlive: () => {
      if (fail) throw new Error('IO unavailable');
      return true;
    } });
    fail = true;
    log.error.mockImplementation(() => { throw new Error('logger unavailable'); });
    await expect(slot.release()).resolves.toBeUndefined();
  });

  it.each([2, 3])('release retries up to three transactions and never throws (%s failures)', async failures => {
    let releasing = false, attempts = 0;
    const slot = await acquire(11, { isAlive: () => {
      if (releasing && ++attempts <= failures) throw new Error('release IO failure');
      return true;
    } });
    releasing = true;
    await expect(slot.release()).resolves.toBeUndefined();
    expect(attempts).toBe(3);
    expect(state().holders).toHaveLength(failures === 3 ? 1 : 0);
    if (failures === 3) expect(log.error).toHaveBeenCalledWith(expect.stringContaining('release failed after 3 attempts'));
    await slot.release();
    expect(attempts).toBe(failures === 3 ? 4 : 3);
    expect(state().holders).toEqual([]);
    const next = await acquire(12);
    expect(state().holders.map(e => e.pid)).toEqual([12]);
    await next.release();
  });

  it('a later acquire in the same process clears its failed release without pruning another live holder', async () => {
    let fail = false, attempts = 0;
    const failed = await acquire(11, { isAlive: () => {
      if (fail) { attempts++; throw new Error('release IO failure'); }
      return true;
    } });
    const other = await acquire(12);
    fail = true;
    await failed.release();
    expect(attempts).toBe(3);
    expect(state().holders.map(e => e.pid)).toEqual([11, 12]);
    const next = await acquire(11, { sleep: async () => { throw new Error('failed holder stranded capacity'); } });
    expect(state().holders.map(e => [e.pid, e.ticket])).toEqual([[12, 2], [11, 3]]);
    await next.release(); await other.release();
  });

  it('later transactions prune a timed-out live waiter only after max wait plus 60s by at', async () => {
    settings.value = { smokeMaxConcurrent: 1, smokeQueueMaxWaitMs: 3001 };
    let time = 0;
    const holder = await acquire(11, { now: () => time });
    const lock = join(stateDir, 'smoke-slots.lock');
    await acquire(12, { now: () => time, sleep: async ms => {
      time += ms;
      if (time === 2000) {
        mkdirSync(lock);
        writeFileSync(join(lock, 'pid'), '91');
      }
    } });
    expect(time).toBe(3001);
    expect(state().waiters).toEqual([{ pid: 12, ticket: 2, at: 0 }]);
    rmSync(lock, { recursive: true });
    time = 63_001;
    await holder.release();
    expect(state().waiters.map(e => e.pid)).toEqual([12]);
    time++;
    const next = await acquire(13, { now: () => time,
      sleep: async () => { throw new Error('abandoned waiter stranded FIFO'); } });
    expect(state().waiters).toEqual([]);
    expect(state().holders.map(e => e.pid)).toEqual([13]);
    await next.release();
  });

  it('preserves live holders older than four hours', async () => {
    writeFileSync(join(stateDir, 'smoke-slots.json'), JSON.stringify({ nextTicket: 2,
      holders: [{ pid: 91, ticket: 1, at: 0 }], waiters: [] }));
    const slot = await acquire(13, { now: () => 4 * 60 * 60 * 1000 + 1 });
    expect(state().holders.map(e => e.pid)).toEqual([91, 13]);
    await slot.release();
  });

  it('uses WE_DAEMON_SMOKE_STATE_DIR across independent callers', async () => {
    const slot = await acquireSmokeSlot({ env: { WE_DAEMON_SMOKE_STATE_DIR: stateDir }, log });
    expect(state().holders[0].pid).toBe(process.pid);
    await slot.release();
  });

  it('rebuild returns smoke-queue-timeout without smoking, releases its lease, and can retry', async () => {
    settings.value = { smokeMaxConcurrent: 1, smokeQueueMaxWaitMs: 3001 };
    const holder = await acquire(process.pid);
    const plan = { target: 'next' };
    const lease = { token: 'timed-out-build' };
    const persisted = { building: lease };
    const prepare = { ok: true, value: { plan, prevHead: 'previous', lease, alerts: ['prepare alert'] } };
    const lock = vi.spyOn(cloneLocks, 'withWriteLock').mockResolvedValueOnce(prepare)
      .mockImplementation(async (_root, action) => ({ ok: true, value: await action() }));
    vi.spyOn(rebuildState, 'readReadyCandidate').mockReturnValue(null);
    vi.spyOn(rebuildState, 'readRebuildState').mockReturnValue(persisted);
    const write = vi.spyOn(rebuildState, 'writeRebuildState').mockImplementation(() => {});
    vi.spyOn(leases, 'readRebuildStarvation').mockReturnValue(0);
    vi.spyOn(leases, 'writeRebuildStarvation').mockImplementation(() => {});
    vi.spyOn(adoptions, 'checkPendingAdoptions').mockResolvedValue(undefined);
    const runSmoke = vi.fn();
    const smokeAndAdopt = vi.spyOn(smoke, 'smokeAndAdopt').mockImplementation(async ({ runSmoke }) => runSmoke());
    let time = 123;
    const options = { root: stateDir,
      env: { WE_DAEMON_SMOKE_STATE_DIR: stateDir, WE_DAEMON_STATE_DIR: stateDir },
      log, runSmoke, versions: null, asJob: false, readyOnly: true, emitEvent: vi.fn(),
      now: () => time, sleep: async ms => { time += ms; },
    };
    leases.ACTIVE_BUILD_TOKENS.add(lease.token);
    expect(await rebuildClone(options)).toEqual({
      moved: false, adopted: false, reason: 'smoke-queue-timeout', plan, alerts: [],
    });
    expect(smokeAndAdopt).not.toHaveBeenCalled();
    expect(runSmoke).not.toHaveBeenCalled();
    expect(persisted.building).toBeNull();
    expect(write).toHaveBeenCalledWith(stateDir, persisted, options.env);
    expect(leases.ACTIVE_BUILD_TOKENS.has(lease.token)).toBe(false);
    expect(state().holders.map(e => e.pid)).toEqual([process.pid]);
    expect(state().waiters).toEqual([]);
    await holder.release();
    lock.mockResolvedValueOnce(prepare);
    await rebuildClone(options);
    expect(runSmoke).toHaveBeenCalledTimes(1);
    expect(state().holders).toEqual([]);
  });

  it.each([false, true])('rebuild holds a slot throughout smokeAndAdopt and releases in finally (throws=%s)', async throws => {
    vi.spyOn(cloneLocks, 'withWriteLock').mockResolvedValue({ ok: true,
      value: { plan: {}, prevHead: 'previous', lease: { token: 'test' } } });
    vi.spyOn(rebuildState, 'readReadyCandidate').mockReturnValue(null);
    vi.spyOn(leases, 'readRebuildStarvation').mockReturnValue(0);
    vi.spyOn(leases, 'writeRebuildStarvation').mockImplementation(() => {});
    vi.spyOn(adoptions, 'checkPendingAdoptions').mockResolvedValue(undefined);
    const options = { root: 'candidate', changedFiles: ['file.mjs'], reuseCode: true };
    const result = { verdict: 'pass' };
    const runSmoke = vi.fn(async received => {
      expect(received).toBe(options);
      expect(state().holders.map(e => e.pid)).toEqual([process.pid]);
      if (throws) throw new Error('smoke failure');
      return result;
    });
    vi.spyOn(smoke, 'smokeAndAdopt').mockImplementation(async ({ runSmoke: capped }) => {
      expect(state().holders.map(e => e.pid)).toEqual([process.pid]);
      expect(capped).toBe(runSmoke);
      const value = await capped(options);
      expect(state().holders.map(e => e.pid)).toEqual([process.pid]);
      return value;
    });
    const rebuilding = rebuildClone({ root: stateDir,
      env: { WE_DAEMON_SMOKE_STATE_DIR: stateDir, WE_DAEMON_STATE_DIR: stateDir },
      log, runSmoke, versions: null, asJob: false, readyOnly: true, emitEvent: vi.fn() });
    if (throws) await expect(rebuilding).rejects.toThrow('smoke failure');
    else expect(await rebuilding).toBe(result);
    expect(runSmoke).toHaveBeenCalledTimes(1);
    expect(state().holders).toEqual([]);
    expect(state().waiters).toEqual([]);
  });
});
