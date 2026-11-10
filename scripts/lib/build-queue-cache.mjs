import { mkdirSync, readdirSync, statSync, readFileSync, writeFileSync, renameSync, unlinkSync, rmSync, rmdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Key is stat-exact (mtime+size+file set); the TTL is only a safety net, so a long one cuts quiet-backlog recomputes (~20s each).
export const DEFAULT_BUILD_QUEUE_CACHE_MAX_AGE_MS = 300_000;

export function buildQueueCacheFile(backlogDir) {
  return join(tmpdir(), `we-build-queue-cache-${process.getuid?.() ?? 'unknown'}`,
    `${createHash('sha1').update(backlogDir).digest('hex')}.json`);
}

/** Stat-only fingerprint; null disables caching when the inputs cannot be inspected. */
export function buildQueueCacheKey({ backlogDir, configPath, next = false }) {
  try {
    const dirMtime = statSync(backlogDir).mtimeMs;
    const files = readdirSync(backlogDir).filter(name => name.endsWith('.md'));
    let maxMtime = 0; let totalSize = 0;
    for (const name of files) { const st = statSync(join(backlogDir, name)); maxMtime = Math.max(maxMtime, st.mtimeMs); totalSize += st.size; }
    let configMtime;
    try { configMtime = statSync(configPath).mtimeMs; }
    catch (error) { if (error.code !== 'ENOENT') throw error; configMtime = 'none'; }
    return JSON.stringify([backlogDir, dirMtime, files.length, maxMtime, totalSize, configMtime, next]);
  } catch { return null; }
}

export function readBuildQueueCache({ file, key, now = Date.now(), maxAgeMs = DEFAULT_BUILD_QUEUE_CACHE_MAX_AGE_MS }) {
  try {
    const cached = JSON.parse(readFileSync(file, 'utf8'));
    if (key !== null && cached.key === key && Number.isFinite(cached.at) && cached.at <= now &&
        now - cached.at < maxAgeMs && typeof cached.stdout === 'string') return cached.stdout;
  } catch { /* cache miss */ }
  return null;
}

/** Null means not owner; the caller bounds retries before computing unlocked. */
export function acquireBuildQueueLock({ file, now = Date.now(), staleMs = 600_000, pid = process.pid,
  io = { mkdirSync, readFileSync, writeFileSync, rmSync, rmdirSync } }) {
  const { mkdirSync: mkdir, readFileSync: read, writeFileSync: write, rmSync: remove, rmdirSync: rmdir } = io;
  const lock = `${file}.lock`;
  const guard = `${lock}.guard`;
  const ownerFile = join(lock, 'owner.json');
  const owner = JSON.stringify({ pid, at: now, token: Math.random().toString(36).slice(2) });
  let created = false;
  let guarded = false;
  try {
    mkdir(dirname(file), { recursive: true });
    // Serialize every lock mutation, including stale inspection and owner-safe release.
    // A stranded guard uses the caller's bounded wait/unlocked-compute fallback.
    try { mkdir(guard); guarded = true; }
    catch (error) { if (error.code === 'EEXIST') return null; throw error; }
    try { mkdir(lock); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const held = JSON.parse(read(ownerFile, 'utf8'));
      if (!held || !Number.isInteger(held.pid) || held.pid <= 0 || !Number.isFinite(held.at) ||
          typeof held.token !== 'string' || held.token.length === 0) return null;
      let dead = false;
      try { process.kill(held.pid, 0); }
      catch (error) { dead = error.code === 'ESRCH'; }
      if (!dead && now - held.at < staleMs) return null;
      remove(lock, { recursive: true });
      try { mkdir(lock); }
      catch (error) { if (error.code === 'EEXIST') return null; throw error; }
    }
    created = true;
    write(ownerFile, owner, 'utf8');
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      let releaseGuarded = false;
      try {
        mkdir(guard);
        releaseGuarded = true;
        if (read(ownerFile, 'utf8') === owner) remove(lock, { recursive: true });
      } catch { /* best-effort release */ }
      finally {
        if (releaseGuarded) { try { rmdir(guard); } catch { /* best-effort cleanup */ } }
      }
    };
    release.holds = () => {
      if (released) return false;
      try { return read(ownerFile, 'utf8') === owner; }
      catch { return false; }
    };
    return release;
  } catch {
    if (created) { try { remove(lock, { recursive: true }); } catch { /* best-effort cleanup */ } }
    return null;
  } finally {
    if (guarded) { try { rmdir(guard); } catch { /* best-effort cleanup */ } }
  }
}

export function waitForBuildQueueCache({ file, key, timeoutMs = 30_000, pollMs = 50, maxAgeMs = DEFAULT_BUILD_QUEUE_CACHE_MAX_AGE_MS }) {
  const deadline = Date.now() + timeoutMs;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    const stdout = readBuildQueueCache({ file, key, maxAgeMs });
    if (stdout !== null) return stdout;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    Atomics.wait(sleeper, 0, 0, Math.min(pollMs, remaining));
  }
}

export function writeBuildQueueCache({ file, key, at = Date.now(), stdout, fence }) {
  if (key === null) return;
  let temp;
  try {
    mkdirSync(dirname(file), { recursive: true });
    temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(temp, JSON.stringify({ key, at, stdout }), 'utf8');
    if (fence !== undefined && !fence()) return;
    renameSync(temp, file);
  } catch { /* best-effort cache */ }
  finally { if (temp) { try { unlinkSync(temp); } catch { /* renamed or unavailable */ } } }
}
