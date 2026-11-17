/**
 * Owner source: file `host` on branch daemon-host-owner. The GitHub App cannot
 * read repo variables (403). Cache: ~/.claude/daemon-host-guard/cache.json,
 * outside every rsync root. Successful reads are reused for one remote read
 * per host per minute; failed reads are also throttled per host in memory.
 * Startup explicitly requires a new read. Failed reads never extend the
 * ten-minute fallback. Non-me evidence blocks fallback before persistence; cache
 * mutations are serialized per cache reader/host across guard states. Failed writes retain that denial until
 * a newer successful write. Failed handoffs retain ordered denial on disk; if
 * denial cannot be saved, the cache lock stays fenced. NOT yet wired into daemons.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, existsSync, rmdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { CONSTELLATION_REPOS } from './constellation-repos.mjs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const FRESH_READ_MS = 60_000;
export const CACHE_MAX_AGE_MS = 600_000;
export const CLOCK_SKEW_MS = 5_000;
export const OWNER_REF = 'daemon-host-owner';
export const OWNER_FILE = 'host';
const MAX_BUFFER = 1024 * 1024;
const validHost = (value) => typeof value === 'string'
  && value.length <= 253 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
const within = (stamp, now, age) => Number.isFinite(stamp)
  && stamp <= now + CLOCK_SKEW_MS && now - stamp <= age;
const standby = (reason) => ({ role: 'standby', reason });

export function defaultCachePath(home = homedir()) {
  return join(home, '.claude', 'daemon-host-guard', 'cache.json');
}

export function getThisHost({ exec = (file, args) => execFileSync(file, args, {
  encoding: 'utf8', timeout: 15_000, maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'],
}), hostname: fallback = hostname } = {}) {
  try {
    const host = String(exec('scutil', ['--get', 'HostName'])).trim();
    if (validHost(host)) return host;
  } catch { /* Other platforms use the OS hostname. */ }
  try {
    const host = String(fallback()).trim();
    return validHost(host) ? host : '';
  } catch { return ''; }
}

/** Pure decision. Expired or malformed evidence leaves this host on standby. */
export function decideHostRole({ thisHost, owner, ownerReadAt, now, cache, atStart = false } = {}) {
  if (!validHost(thisHost) || !Number.isFinite(now)) return standby('invalid-input');
  if ((owner === '' || validHost(owner)) && within(ownerReadAt, now, FRESH_READ_MS)) {
    if (owner === '') return standby('owner-unset');
    return owner === thisHost
      ? { role: 'active', reason: 'fresh-owner-is-this-host' }
      : standby('owner-is-other-host');
  }
  if (atStart) return standby('start-requires-fresh-read');
  if (cache != null) {
    if (cache.host !== thisHost) return standby('cache-foreign-host');
    if (Number.isFinite(cache.writtenAt) && cache.writtenAt > now + CLOCK_SKEW_MS) return standby('clock-skew');
    if (!within(cache.writtenAt, now, CACHE_MAX_AGE_MS)) return standby('cache-stale');
    if (!within(cache.readAt, now, CACHE_MAX_AGE_MS)) return standby(Number.isFinite(cache.readAt) ? 'cache-stale' : 'owner-unreadable');
    if (!['ok', 'unset'].includes(cache.status)) return standby('owner-unreadable');
    if (cache.owner === '') return standby('owner-unset');
    if (!validHost(cache.owner) || cache.status === 'unset') return standby('owner-unreadable');
    return cache.owner === thisHost
      ? { role: 'active', reason: 'cache-owner-is-this-host' }
      : standby('cache-owner-is-other-host');
  }
  return standby(Number.isFinite(ownerReadAt) && ownerReadAt > now + CLOCK_SKEW_MS
    ? 'clock-skew' : 'owner-unreadable');
}

export function runGhApi(path, { execFile = execFileSync } = {}) {
  try {
    const output = execFile('gh', ['api', path], {
      timeout: 15000, maxBuffer: MAX_BUFFER, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, status: 200, body: JSON.parse(output) };
  } catch (error) {
    const message = `${error.stderr ?? ''}\n${error.stdout ?? ''}\n${error.message ?? ''}`;
    const status = /(?:HTTP\s+|["']?status["']?\s*:\s*)(\d{3})\b/i.exec(message);
    return { ok: false, status: status ? Number(status[1]) : null, body: message };
  }
}

/** A missing ref is unset; missing/malformed contents or any other failure is unreadable. */
export async function readOwnerRemote({ ghApi: api = runGhApi } = {}) {
  try {
    const base = `repos/${CONSTELLATION_REPOS.we.slug}`;
    const ref = await api(`${base}/git/ref/heads/${OWNER_REF}`);
    if (ref?.ok === false && ref.status === 404) return { status: 'unset' };
    if (ref?.ok !== true || ref.status !== 200) throw new Error('owner ref unreadable');
    const file = await api(`${base}/contents/${OWNER_FILE}?ref=${OWNER_REF}`);
    if (file?.ok !== true || file.status !== 200 || typeof file.body?.content !== 'string') {
      throw new Error('owner contents unreadable');
    }
    const encoded = file.body.content.replace(/\s/g, '');
    if (encoded.length > MAX_BUFFER || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw new Error('invalid owner encoding; inspect host on daemon-host-owner');
    }
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded) throw new Error('noncanonical owner encoding');
    const owner = bytes.toString('utf8').trim();
    if (!owner) return { status: 'unset' };
    if (!validHost(owner)) throw new Error('invalid owner host; inspect host on daemon-host-owner');
    return { status: 'ok', owner };
  } catch (error) {
    return { status: 'error', error: String(error?.message ?? error) };
  }
}

export function readCacheFile(path = defaultCachePath()) {
  if (existsSync(`${path}.lock`)) throw new Error('cache locked; inspect abandoned writer before removing lock');
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (existsSync(`${path}.lock`)) throw new Error('cache writer changed during read');
  return value;
}

// Never reclaim a lock by age: a suspended holder could resume and publish old
// ownership. On timeout fence the holder; a nonempty lock survives its cleanup
// and makes all fallback reads fail closed until the operator inspects it.
function withCacheLock(path, mutate, { retainOnError = false } = {}) {
  const lock = `${path}.lock`;
  const deadline = performance.now() + 1000;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try { mkdirSync(lock, { mode: 0o700 }); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (performance.now() >= deadline) {
        try { writeFileSync(join(lock, 'blocked'), '', { flag: 'wx', mode: 0o600 }); }
        catch {
          // Contention is a denial even if its marker cannot be persisted.
          // Do not throw into the resolver's optional cache-write error path.
        }
        return false;
      }
      Atomics.wait(sleeper, 0, 0, 5);
    }
  }
  let result;
  let failed = false;
  try { result = mutate(); }
  catch (error) { failed = true; throw error; }
  finally {
    // Keep the directory itself as a fence even when disk-full prevents writing
    // a marker. Releasing it would allow delayed writers to restore ownership.
    if (!failed || !retainOnError) {
      try { rmdirSync(lock); }
      catch (error) {
        if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') throw error;
        result = false;
      }
    }
  }
  return result;
}

/** Atomic replacement; failed writes leave no temporary evidence behind. */
export function writeCacheFile(value, path = defaultCachePath()) {
  mkdirSync(dirname(path), { recursive: true });
  return withCacheLock(path, () => {
    let stored;
    try { stored = JSON.parse(readFileSync(path, 'utf8')); } catch { /* Repair absent/corrupt evidence. */ }
    if (supersedes(stored, value)) return false;
    replaceCacheFile(value, path);
  }, { retainOnError: value.owner !== value.host });
}

export function invalidateCacheFile(path = defaultCachePath(), failedRead) {
  if (!failedRead && !existsSync(path) && !existsSync(`${path}.lock`)) return;
  if (failedRead) mkdirSync(dirname(path), { recursive: true });
  return withCacheLock(path, () => {
    if (failedRead) {
      let stored;
      try { stored = JSON.parse(readFileSync(path, 'utf8')); } catch { /* Replace unreadable evidence. */ }
      if (preserveAfterFailure(stored, failedRead)) return false;
      // Absence cannot fence a delayed read. Preserve the handoff's read order
      // across independent guards/restarts, including when no cache existed.
      replaceCacheFile(failedRead, path);
      return;
    }
    removeCacheFile(path);
  }, { retainOnError: Boolean(failedRead) });
}

function replaceCacheFile(value, path) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally { removeCacheFile(temporary); }
}

function removeCacheFile(path) {
  try { unlinkSync(path); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

// readAt is the remote read's START time, never its completion time. On ties a
// persisted handoff wins over ownership, including records from older guards.
function validCacheRecord(stored, host) {
  return stored?.host === host && Number.isFinite(stored.readAt)
    && ((stored.status === 'ok' && validHost(stored.owner))
      || (stored.status === 'unset' && stored.owner === ''));
}

function supersedes(stored, next) {
  return validCacheRecord(stored, next.host)
    && (stored.readAt > next.readAt || (stored.readAt === next.readAt
      && stored.owner !== next.host && next.owner === next.host));
}

function preserveAfterFailure(stored, failedRead) {
  return supersedes(stored, failedRead)
    || (validCacheRecord(stored, failedRead.host) && stored.owner !== failedRead.host
      && stored.readAt === failedRead.readAt);
}

/** Share one state across a guard's calls; hosts never share poison or throttle. */
export function createGuardState() {
  return { hosts: new Map() };
}
// Each cache reader identifies a guard's IO context unless state is supplied.
const readerStates = new WeakMap();
const readerWrites = new WeakMap();
function stateForReader(read) {
  if (!readerStates.has(read)) readerStates.set(read, createGuardState());
  return readerStates.get(read);
}

export async function resolveHostRole({ thisHost, now = Date.now(), atStart = false,
  readCache: read = readCacheFile, writeCache: write = writeCacheFile,
  invalidateCache = (value) => invalidateCacheFile(defaultCachePath(), value),
  readRemote = readOwnerRemote, state = stateForReader(read) } = {}) {
  const decide = (extra) => decideHostRole({ thisHost, now, atStart, cache, ...extra });
  let cache = null;
  if (!validHost(thisHost) || !Number.isFinite(now)) {
    return { ...standby('invalid-input'), source: 'remote-failed' };
  }
  state.hosts ??= new Map();
  if (!state.hosts.has(thisHost)) state.hosts.set(thisHost, {});
  const hostState = state.hosts.get(thisHost);
  const readOrder = hostState.readOrder = (hostState.readOrder ?? 0) + 1;
  const cacheEvidence = hostState.latestEvidence;
  try { cache = await read(); } catch { /* Unreadable cache grants no ownership. */ }
  if (hostState.inFlight) {
    const decision = await hostState.inFlight.promise;
    // A startup caller must never inherit another caller's offline cache grant.
    return atStart && decision.source === 'remote-failed'
      ? { ...standby('start-requires-fresh-read'), source: 'remote-failed' } : decision;
  }
  const usableRead = cache?.host === thisHost && within(cache.writtenAt, now, CACHE_MAX_AGE_MS)
    && within(cache.readAt, now, FRESH_READ_MS)
    && ((cache.status === 'ok' && validHost(cache.owner)) || (cache.status === 'unset' && cache.owner === ''));
  if (!atStart && !hostState.cacheInvalidated && cacheEvidence === hostState.latestEvidence && usableRead) {
    return { ...decide({ owner: cache.owner, ownerReadAt: cache.readAt }), source: 'cache-fresh-read' };
  }
  const fallback = (throttled = false) => {
    const decision = hostState.cacheInvalidated ? standby('cache-invalidated')
      : cacheEvidence !== hostState.latestEvidence ? standby('superseded-cache-read') : decide({});
    return { ...(throttled && decision.reason === 'owner-unreadable'
      ? standby('remote-throttled') : decision), source: 'remote-failed' };
  };
  if (!atStart && within(hostState.failedReadAt, now, FRESH_READ_MS)) return fallback(true);
  const flight = {};
  hostState.inFlight = flight;
  // Defer execution until the shared promise is installed, even for sync IO.
  flight.promise = Promise.resolve().then(resolveRemote).finally(() => {
    if (hostState.inFlight === flight) delete hostState.inFlight;
  });
  return flight.promise;

  async function resolveRemote() {
    let remote;
    try { remote = await readRemote(); } catch { /* Use bounded fallback below. */ }
    if ((remote?.status === 'ok' && validHost(remote.owner)) || remote?.status === 'unset') {
      delete hostState.failedReadAt;
      const owner = remote.status === 'ok' ? remote.owner : '';
      // Evidence older than one this process already saw must not overwrite the cache.
      const stale = hostState.latestReadAt > now
        || (hostState.latestReadAt === now && hostState.latestReadOrder > readOrder);
      if (stale) return { ...standby('superseded-owner-read'), source: 'remote' };
      hostState.latestReadAt = now;
      hostState.latestReadOrder = readOrder;
      const evidence = {};
      hostState.latestEvidence = evidence;
      // Revoke immediately: another reader can run while write/invalidation awaits IO.
      if (owner !== thisHost) hostState.cacheInvalidated = true;
      // Serialize removal and replacement across states sharing this cache reader.
      const value = { host: thisHost, status: remote.status, owner, readAt: now, writtenAt: now };
      let superseded = false;
      const writes = readerWrites.get(read) ?? new Map();
      readerWrites.set(read, writes);
      const pending = (writes.get(thisHost) ?? Promise.resolve()).then(async () => {
        if (hostState.latestEvidence !== evidence) return;
        let stored;
        try { stored = await read(); } catch { /* A fresh remote read can repair a missing cache. */ }
        if (supersedes(stored, value)) {
          superseded = true;
          hostState.cacheInvalidated = true;
          return;
        }
        try {
          if (await write(value) === false) {
            superseded = true;
            hostState.cacheInvalidated = true;
            return;
          }
          if (hostState.latestEvidence === evidence) delete hostState.cacheInvalidated;
        } catch {
          if (owner !== thisHost) {
            let stored;
            try { stored = await read(); } catch { /* The conditional remover also checks under its lock. */ }
            if (!preserveAfterFailure(stored, value)) {
              try { await invalidateCache(value); } catch { /* Memory denial survives failed removal. */ }
            }
          }
        }
      });
      writes.set(thisHost, pending);
      await pending;
      if (writes.get(thisHost) === pending) writes.delete(thisHost);
      if (writes.size === 0) readerWrites.delete(read);
      if (superseded || hostState.latestEvidence !== evidence) return { ...standby('superseded-owner-read'), source: 'remote' };
      return { ...decide({ owner, ownerReadAt: now }), source: 'remote' };
    }
    hostState.failedReadAt = now;
    // Another guard may have confirmed a handoff while this read was offline.
    let latestCache;
    try { latestCache = await read(); cache = latestCache; }
    catch { cache = null; /* A locked/unreadable cache cannot preserve an old ownership snapshot. */ }
    if (supersedes(latestCache, { host: thisHost, owner: thisHost, readAt: now })) {
      hostState.cacheInvalidated = true;
      return { ...standby('superseded-cache-read'), source: 'remote-failed' };
    }
    return fallback();
  }
}
