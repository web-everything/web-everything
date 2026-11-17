/**
 * Purpose: cap host-wide daemon rebuild live smokes with persistent FIFO tickets.
 * Queue expiry fails closed: give up this attempt so the next rebuild job can retry within the cap.
 * Exports: acquireSmokeSlot({env, log, stateDir, pid, isAlive, now, sleep, onWait}) → {acquired, release()}.
 */
import fs, { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { cascadePolicy } from './policy-cascade.mjs';
import { rebuildLeaseStaleMs } from './daemon-rebuild/lease.mjs';

// Retain only failed releases; a later acquire by this process retries them under the state lock.
const failedTickets = new Set();

const positive = value => Number.isSafeInteger(value) && value > 0;
// The queue-wait ceiling never collapses to 0: a short rebuild lease must still allow a capacity check.
const MIN_QUEUE_WAIT_MS = 1000;
const LEASE_RUN_RESERVE_MS = 2 * 60_000;
// Queue residence leaves the smoke run its reserve of the lease: a flat 2min for leases of 3min or more,
// and two thirds of a shorter lease. The short-lease ceiling scales with the lease (stale/3, continuous at
// 3min) so it stays well above one 2s poll or a briefly busy state lock, instead of collapsing to a floor.
function queueWaitCeiling(staleMs) {
  const ceiling = staleMs >= 1.5 * LEASE_RUN_RESERVE_MS ? staleMs - LEASE_RUN_RESERVE_MS : Math.floor(staleMs / 3);
  return Math.max(MIN_QUEUE_WAIT_MS, ceiling);
}
const SETTINGS = join(dirname(fileURLToPath(import.meta.url)), 'daemon-rebuild-settings.json');

function setting(env, log, key, envKey, fallback, ceiling = Infinity) {
  let tool;
  try { tool = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'))?.[key]; }
  catch {
    if (key === 'smokeMaxConcurrent') {
      log.error?.('daemon-live-smoke: smokeMaxConcurrent=1 (settings read/parse failure) — inspect daemon-rebuild-settings.json before retrying');
      return 1;
    }
  }
  const raw = env[envKey];
  const override = raw === undefined ? undefined : /^\d+$/.test(raw) ? Number(raw) : NaN;
  // Invalid layers are ignored independently: env → configured settings → default.
  const resolved = cascadePolicy(key, tool, {
    env, standard: fallback, valid: positive, envValues: { '': override },
  });
  const source = resolved.sources[''] === 'standard' ? 'default' : resolved.sources[''];
  const value = Math.min(resolved.value, ceiling);
  if (value !== resolved.value) {
    log.error?.(`daemon-live-smoke: ${key} clamped from ${resolved.value} to ${value}ms (bounded by the rebuild lease lifetime)`);
  }
  log.error?.(`daemon-live-smoke: ${key}=${value} (${source})`);
  return value;
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

function readState(path) {
  let state;
  try { state = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return { nextTicket: 1, holders: [], waiters: [] };
    throw error;
  }
  // id is optional so state written before per-acquisition ids still reads; when present it must be a string.
  const entry = value => positive(value?.pid) && positive(value?.ticket) && Number.isFinite(value?.at)
    && (value.id === undefined || typeof value.id === 'string');
  if (!positive(state?.nextTicket) || !Array.isArray(state?.holders) || !Array.isArray(state?.waiters)) {
    throw new Error('daemon-live-smoke: invalid smoke slot state; inspect smoke-slots.json before retrying');
  }
  const entries = [...state.holders, ...state.waiters];
  if (!entries.every(entry) || entries.some(e => e.ticket >= state.nextTicket)
    || new Set(entries.map(e => e.ticket)).size !== entries.length
    // Release matches by id, so a duplicated id would remove another acquisition's entry too.
    || new Set(entries.filter(e => e.id !== undefined).map(e => e.id)).size !== entries.filter(e => e.id !== undefined).length) {
    throw new Error('daemon-live-smoke: invalid smoke slot entries; inspect smoke-slots.json before retrying');
  }
  return state;
}

/** Only the small state transaction holds the mkdir lock; neither waiting nor smoke execution does.
 * Corrupt/unreadable state fails closed. Dead lock owners are reclaimed immediately; missing owners
 * get a 60s grace period. A crash cannot expose a partially written state file. Queue expiry fails closed.
 * Optional onWait is awaited outside the slot lock on every occupied queue poll.
 */
export async function acquireSmokeSlot({
  env = process.env, log = console,
  stateDir = env.WE_DAEMON_SMOKE_STATE_DIR || join(homedir(), '.claude', 'daemon-self-sync-state'),
  pid = process.pid, isAlive = processAlive, now = Date.now, sleep = setTimeout, onWait,
} = {}) {
  if (!positive(pid)) throw new Error('daemon-live-smoke: invalid slot pid');
  const cap = setting(env, log, 'smokeMaxConcurrent', 'WE_DAEMON_SMOKE_MAX_CONCURRENT', 2);
  const maxWait = setting(env, log, 'smokeQueueMaxWaitMs', 'WE_DAEMON_SMOKE_QUEUE_MAX_WAIT_MS', 900_000,
    queueWaitCeiling(rebuildLeaseStaleMs(env)));
  const queuedAt = now();
  const deadline = queuedAt + maxWait;
  const expired = new Error('smoke queue expired');
  mkdirSync(stateDir, { recursive: true });
  const path = resolve(stateDir, 'smoke-slots.json');
  const lock = join(stateDir, 'smoke-slots.lock');
  async function transaction(update, until = Infinity) {
    const started = now();
    const token = `owner-${randomUUID()}`;
    const ownerFile = `${token}.pid`;
    const temporaryFile = `${token}.state.json`;
    for (;;) {
      try {
        // Publish an already nonempty directory: there is never an empty acquisition
        // window in which a stale reclaimer's rmdir could remove this writer's lock.
        const prepared = fs.mkdtempSync(join(stateDir, '.smoke-slot-'));
        try {
          writeFileSync(join(prepared, ownerFile), String(pid));
          // rename may replace an empty directory. Send existing ownerless locks
          // through the same 60s grace check rather than bypassing recovery policy.
          if (fs.existsSync(lock)) throw Object.assign(new Error('slot lock exists'), { code: 'EEXIST' });
          renameSync(prepared, lock);
        } finally {
          rmSync(prepared, { recursive: true, force: true });
        }
        break;
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
        try {
          const observed = fs.statSync(lock);
          const files = fs.readdirSync(lock);
          const owners = files.filter(name => /^owner-[a-f0-9-]+\.pid$/.test(name) || name === 'pid');
          if (owners.length > 1) throw new Error('daemon-live-smoke: ambiguous slot lock owners');
          let owner;
          try {
            const raw = owners.length ? readFileSync(join(lock, owners[0]), 'utf8') : '';
            owner = /^\d+$/.test(raw) && positive(Number(raw)) ? Number(raw) : undefined;
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
          const liveOwner = owner !== undefined && isAlive(owner);
          if (!liveOwner && (owner !== undefined || now() - observed.mtimeMs >= 60_000)) {
            // Names are unique to each transaction. Only unlink this snapshot's files,
            // then atomically remove the directory *if empty*. A concurrent replacement
            // has its own owner file, so rmdir refuses it even after this stale snapshot.
            for (const name of files) {
              try { fs.unlinkSync(join(lock, name)); }
              catch (error) { if (error.code !== 'ENOENT') throw error; }
            }
            try { fs.rmdirSync(lock); }
            catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
            continue;
          }
          if (now() >= until) throw expired;
          if (liveOwner && now() - started >= 30_000) {
            throw new Error('daemon-live-smoke: slot lock busy for 30s; inspect smoke-slots.lock and remove only after confirming no writer is active, then retry');
          }
        } catch (error) {
          if (error.code === 'ENOENT') continue;
          throw error;
        }
        await sleep(Math.min(2000, until - now()));
      }
    }
    try {
      const state = readState(path);
      state.holders = state.holders.filter(e => isAlive(e.pid));
      state.waiters = state.waiters.filter(e => isAlive(e.pid) && now() - e.at <= maxWait + 60_000)
        .sort((a, b) => a.ticket - b.ticket);
      const result = update(state);
      const temporary = join(lock, temporaryFile);
      fs.writeFileSync(temporary, JSON.stringify(state));
      fs.renameSync(temporary, path);
      return result;
    } finally {
      for (const name of [temporaryFile, ownerFile]) {
        try { fs.unlinkSync(join(lock, name)); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      try { fs.rmdirSync(lock); }
      catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
    }
  }

  // Ownership is the per-acquisition id, never the ticket number: a ticket whose state write failed is
  // re-issued to the next acquirer (even in this same process), so cleanup by ticket could erase its entry.
  const id = randomUUID();
  let ticket;
  // True once an update may have persisted this acquisition's waiter entry (a failed write can still have landed).
  let maybePersisted = false;
  let released = false;
  const failedTicket = { path, pid, id };
  const release = async (until = Infinity) => {
    if (released) return;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await transaction(state => {
          state.holders = state.holders.filter(e => e.id !== id);
          state.waiters = state.waiters.filter(e => e.id !== id);
        }, until);
        released = true;
        failedTickets.delete(failedTicket);
        return;
      } catch (error) {
        if (attempt === 3) {
          failedTickets.add(failedTicket);
          // Even a broken logger must not mask a smoke result. The next acquire retries cleanup.

          try { log.error?.(`daemon-live-smoke: slot release failed after 3 attempts: ${error.message}`); } catch { /* best effort */ }
        }
      }
    }
  };
  let lastAhead;
  try {
    const pending = [...failedTickets].filter(e => e.path === path && e.pid === pid);
    if (pending.length) {
      const ids = new Set(pending.map(e => e.id));
      try {
        await transaction(state => {
          state.holders = state.holders.filter(e => !ids.has(e.id));
          state.waiters = state.waiters.filter(e => !ids.has(e.id));
        }, deadline);
        for (const entry of pending) failedTickets.delete(entry);
      } catch (error) {
        // A cleanup that cannot get the state lock must not cost a free slot: keep the entries for the
        // next acquire and still make the capacity attempt below.
        if (error !== expired) throw error;
        log.error?.('daemon-live-smoke: stale-ticket cleanup deferred (state lock busy) — retrying on the next acquire');
      }
    }
    for (;;) {
      // Always attempt capacity first; the deadline is only tested after a failed attempt.
      // A ticket is claimed locally only after its transaction committed: if the write fails, nextTicket
      // was not persisted and the number goes to someone else.
      let claimed;
      const ahead = await transaction(state => {
        let mine = ticket;
        if (mine === undefined) {
          if (!positive(state.nextTicket + 1)) throw new Error('daemon-live-smoke: slot tickets exhausted; inspect state before retrying');
          mine = state.nextTicket++;
          state.waiters.push({ pid, ticket: mine, at: now(), id });
        }
        const index = state.waiters.findIndex(e => e.id === id);
        if (index < 0) throw new Error('daemon-live-smoke: own smoke ticket missing');
        // Capacity never permits a later ticket to pass the queue head.
        if (index === 0 && state.holders.length < cap) {
          state.holders.push(...state.waiters.splice(index, 1));
          claimed = mine; maybePersisted = true;
          return null;
        }
        // Nothing persists when update throws: a ticket created in this attempt is simply never claimed.
        if (now() >= deadline) throw expired;
        claimed = mine; maybePersisted = true;
        return index;
      }, deadline);
      ticket = claimed;
      if (ahead === null) return { acquired: true, release };
      if (ahead !== lastAhead) log.error?.(`daemon-live-smoke: smoke-queued (${ahead} ahead)`);
      lastAhead = ahead;
      await onWait?.();
      await sleep(Math.min(2000, Math.max(0, deadline - now())));
    }
  } catch (error) {
    if (error === expired) {
      if (maybePersisted) await release(now());
      log.error?.(`daemon-live-smoke: smoke-queue-timeout (waited ${now() - queuedAt}ms) — giving up this attempt`);
      return { acquired: false, release() {} };
    }
    if (maybePersisted) await release();
    throw error;
  }
}
