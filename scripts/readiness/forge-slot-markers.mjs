// Remote slot execution markers (`slot-N.unconfirmed`): written BEFORE a Forge dispatch and removed only when the
// remote run is confirmed finished. A client that dies mid-run leaves its marker behind, and the old code kept it
// forever, so a few dead clients walled off the whole cap while Forge sat idle ("remote-full" with load ~0.5).
// A marker is reaped here only on liveness evidence: its owner process is provably dead AND Forge's own fresh
// telemetry cannot account for it as a still-running remote run. Nothing is ever reaped on age alone.
import {readdirSync, readFileSync, statSync, unlinkSync, writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {join} from 'node:path';
import {readLockEntry, reserve, releaseLockDir} from './file-locks.mjs';
import {probePidLiveness} from './pid-liveness.mjs';

export const MARKER_GRACE_MS = 120_000;
const NAME = /^slot-(\d+)\.unconfirmed$/;

/** New markers carry their owner pid so a later client can prove the owner is dead. */
export function markerContent({owner, pid, nowMs}) {
  return JSON.stringify({v: 1, owner, pid, at: nowMs}) + '\n';
}

const LOCK_KEY = 'marker-mutation';
// The critical section is a stat plus an unlink (milliseconds); a long lease makes takeover of a live holder implausible.
const LOCK_LEASE_MINUTES = 10;
const holds = (root, owner) => readLockEntry(root, LOCK_KEY)?.owner === owner;
/** Marker creation and reaping share one short mutex, so a reaper can never remove a marker it did not judge. */
async function withMarkerLock(root, work, {clock = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms))} = {}) {
  const owner = 'marker-' + randomBytes(12).toString('hex'), start = clock();
  for (;;) {
    // Never hand `reserve` a liveness verdict read earlier: it rereads the holder itself, so a stale `dead` could
    // reclaim a live holder's lock. A crashed holder is reclaimed by its 1-minute lease instead.
    const now = clock();
    if (reserve(root, LOCK_KEY, owner, now, new Date(now).toISOString(), process.pid, 'unknown', LOCK_LEASE_MINUTES, null, true).ok) break;
    if (clock() - start >= 3000) throw new Error('remote-marker-busy');
    await sleep(25);
  }
  try { return await work(() => holds(root, owner)); } finally { if (holds(root, owner)) releaseLockDir(root, LOCK_KEY); }
}
/** Exclusive create of a dispatch marker under the mutex; throws if one already exists. */
export function writeMarkerExclusive(root, file, content, opts) {
  return withMarkerLock(root, still => { if (!still()) throw new Error('remote-marker-lock-lost'); writeFileSync(file, content, {flag: 'wx', mode: 0o600}); }, opts);
}

function ownerPid(root, index, file) {
  try {
    const marker = JSON.parse(readFileSync(file, 'utf8'));
    if (Number.isInteger(marker?.pid)) return marker.pid;
  } catch { /* legacy text marker: fall through to the slot lock's holder */ }
  try { return readLockEntry(root, `slot-${index}`)?.pid ?? null; } catch { return null; }
}

/**
 * Stateful reaper for one wait loop. `step()` is cheap and idempotent. It reads Forge telemetry (a lazy async getter)
 * only when a dead-owner marker exists, so a loop with no dead markers costs one readdir.
 * A dead owner is reaped only when (1) it was first observed dead no later than the telemetry sample, so any Forge
 * receipt it created is already counted, (2) the marker is past the grace window, and (3) Forge reports ZERO active
 * runs. Telemetry is only a count and cannot say WHICH marker's run is still going, so any active run keeps every
 * dead-owner marker (never guess by age). Leaked Forge receipts therefore keep markers, never the other way round.
 */
export function createMarkerReaper({root, clock = Date.now, liveness = probePidLiveness, selfPid = process.pid,
  graceMs = MARKER_GRACE_MS, log = () => {}, fs = {readdirSync, statSync, unlinkSync}}) {
  const firstDead = new Map();
  return {
    async step(getTelemetry, now = clock()) {
      let names;
      try { names = fs.readdirSync(root); } catch { return []; }
      const dead = [];
      for (const name of names) {
        const m = NAME.exec(name);
        if (!m) continue;
        const file = join(root, name);
        let mtimeMs, ino;
        try { ({mtimeMs, ino} = fs.statSync(file)); } catch { continue; }
        const pid = ownerPid(root, Number(m[1]), file);
        const key = `${name}:${ino}:${mtimeMs}`; // a replacement marker never inherits a predecessor's death stamp
        if (liveness(pid, selfPid) !== 'dead') { firstDead.delete(key); continue; }
        if (!firstDead.has(key)) firstDead.set(key, clock()); // stamped after the death probe
        dead.push({name, key, file, mtimeMs, ino, index: Number(m[1])});
      }
      if (!dead.length) return [];
      const telemetry = await getTelemetry();
      const sampledAt = Date.parse(telemetry?.sampledAtET), active = telemetry?.activeRuns;
      if (!Number.isFinite(sampledAt) || !Number.isSafeInteger(active) || active < 0) return [];
      dead.sort((a, b) => a.mtimeMs - b.mtimeMs);
      if (active !== 0) return [];
      const reaped = [];
      for (const entry of dead) {
        if (now - entry.mtimeMs < graceMs || firstDead.get(entry.key) > sampledAt) continue;
        // Re-judge under the mutex: the marker must be the very file we judged and its owner still provably dead.
        const removed = await withMarkerLock(root, still => {
          try {
            if (!still()) return false;
            const seen = fs.statSync(entry.file);
            if (seen.ino !== entry.ino || seen.mtimeMs !== entry.mtimeMs) return false;
            if (liveness(ownerPid(root, entry.index, entry.file), selfPid) !== 'dead') return false;
            fs.unlinkSync(entry.file);
            return true;
          } catch { return false; }
        }).catch(() => false);
        if (!removed) continue;
        firstDead.delete(entry.key);
        reaped.push(entry.name);
      }
      if (reaped.length) log(`heavy-admission: reaped stale remote slot marker(s) ${reaped.join(', ')} (owner dead; Forge reports ${active} active run(s))\n`);
      return reaped;
    },
  };
}
