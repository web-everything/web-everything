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
    log.error?.(`daemon-live-smoke: ${key} clamped from ${resolved.value} to ${value}ms (rebuild lease lifetime minus 2min)`);
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
  const entry = value => positive(value?.pid) && positive(value?.ticket) && Number.isFinite(value?.at);
  if (!positive(state?.nextTicket) || !Array.isArray(state?.holders) || !Array.isArray(state?.waiters)) {
    throw new Error('daemon-live-smoke: invalid smoke slot state; inspect smoke-slots.json before retrying');
  }
  const entries = [...state.holders, ...state.waiters];
  if (!entries.every(entry) || entries.some(e => e.ticket >= state.nextTicket)
    || new Set(entries.map(e => e.ticket)).size !== entries.length) {
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
    Math.max(0, rebuildLeaseStaleMs(env) - 2 * 60_000));
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
      writeFileSync(temporary, JSON.stringify(state));
      renameSync(temporary, path);
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

  let ticket;
  let released = false;
  const failedTicket = { path, pid, ticket: undefined };
  const release = async (until = Infinity) => {
    if (released) return;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await transaction(state => {
          state.holders = state.holders.filter(e => e.ticket !== ticket);
          state.waiters = state.waiters.filter(e => e.ticket !== ticket);
        }, until);
        released = true;
        failedTickets.delete(failedTicket);
        return;
      } catch (error) {
        if (attempt === 3) {
          failedTicket.ticket = ticket;
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
      const tickets = new Set(pending.map(e => e.ticket));
      await transaction(state => {
        state.holders = state.holders.filter(e => e.pid !== pid || !tickets.has(e.ticket));
        state.waiters = state.waiters.filter(e => e.pid !== pid || !tickets.has(e.ticket));
      }, deadline);
      for (const entry of pending) failedTickets.delete(entry);
    }
    for (;;) {
      // A zero/spent budget (a rebuild lease of 2min or less clamps the wait to 0) must still make one
      // admission attempt: only an unqueued caller may take a slot that is free right now.
      if (ticket !== undefined && now() >= deadline) throw expired;
      const ahead = await transaction(state => {
        if (ticket !== undefined && now() >= deadline) throw expired;
        if (ticket === undefined) {
          if (now() >= deadline && (state.waiters.length > 0 || state.holders.length >= cap)) throw expired;
          if (!positive(state.nextTicket + 1)) throw new Error('daemon-live-smoke: slot tickets exhausted; inspect state before retrying');
          ticket = state.nextTicket++;
          state.waiters.push({ pid, ticket, at: now() });
        }
        const index = state.waiters.findIndex(e => e.ticket === ticket);
        if (index < 0) throw new Error('daemon-live-smoke: own smoke ticket missing');
        // Capacity never permits a later ticket to pass the queue head.
        if (index === 0 && state.holders.length < cap) {
          state.holders.push(...state.waiters.splice(index, 1));
          return null;
        }
        return index;
        // A zero budget leaves no room to even take the state lock; give that one attempt the lock's own 30s cap.
      }, ticket === undefined && deadline <= queuedAt ? queuedAt + 30_000 : deadline);
      if (ahead === null) return { acquired: true, release };
      if (ahead !== lastAhead) log.error?.(`daemon-live-smoke: smoke-queued (${ahead} ahead)`);
      lastAhead = ahead;
      await onWait?.();
      await sleep(Math.min(2000, Math.max(0, deadline - now())));
    }
  } catch (error) {
    if (error === expired) {
      if (ticket !== undefined) await release(now());
      log.error?.(`daemon-live-smoke: smoke-queue-timeout (waited ${now() - queuedAt}ms) — giving up this attempt`);
      return { acquired: false, release() {} };
    }
    if (ticket !== undefined) await release();
    throw error;
  }
}
