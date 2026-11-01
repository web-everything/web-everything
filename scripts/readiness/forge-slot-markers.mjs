// Remote slot execution markers (`slot-N.unconfirmed`): written BEFORE a Forge dispatch and removed only when the
// remote run is confirmed finished. A client that dies mid-run leaves its marker behind, and the old code kept it
// forever, so a few dead clients walled off the whole cap while Forge sat idle ("remote-full" with load ~0.5).
// A marker is reaped here only on liveness evidence: its owner process is provably dead AND Forge's own fresh
// telemetry cannot account for it as a still-running remote run. Nothing is ever reaped on age alone.
import {readdirSync, readFileSync, statSync, unlinkSync, writeFileSync, renameSync, linkSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {join} from 'node:path';
import {readLockEntry} from './file-locks.mjs';
import {probePidLiveness} from './pid-liveness.mjs';

export const MARKER_GRACE_MS = 120_000;
// The Forge sample must be taken this long AFTER the owner was first seen dead: it covers Forge-vs-Mac clock skew and
// a receipt created between Forge's receipt listing and its timestamp, so a sample can never predate a surviving run.
export const DEATH_SAMPLE_MARGIN_MS = 90_000;
const NAME = /^slot-(\d+)\.unconfirmed$/;
const HELD_NAME = /^slot-(\d+)\.unconfirmed(?:\.held-[0-9a-f]{16})?$/;

/** New markers carry their owner pid so a later client can prove the owner is dead. */
export function markerContent({owner, pid, nowMs}) {
  return JSON.stringify({v: 1, owner, pid, at: nowMs}) + '\n';
}

/** Slot indices whose marker (or a held tombstone) is present: those slots are never handed out. */
export function blockedSlots(root, cap, readdir = readdirSync) {
  const blocked = new Set();
  let names = [];
  // Fail closed: only a missing directory means "nothing held"; any other error must stop admission.
  try { names = readdir(root); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  for (const name of names) {
    const m = HELD_NAME.exec(name);
    if (m && Number(m[1]) < cap) blocked.add(Number(m[1]));
  }
  return blocked;
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
 * A dead owner is reaped only when (1) the telemetry sample was taken at least DEATH_SAMPLE_MARGIN_MS after the owner
 * was first seen dead (the stamp persists in a sidecar, so a later client completes what an earlier one began), (2) the marker is past the grace window, and (3) Forge reports ZERO active
 * runs. Telemetry is only a count and cannot say WHICH marker's run is still going, so any active run keeps every
 * dead-owner marker (never guess by age). Leaked Forge receipts therefore keep markers, never the other way round.
 */
export function createMarkerReaper({root, clock = Date.now, liveness = probePidLiveness, selfPid = process.pid,
  graceMs = MARKER_GRACE_MS, log = () => {}, fs = {readdirSync, statSync, unlinkSync}}) {
  const firstDead = new Map();
  const sidecar = file => file + '.dead';
  function stampFor(file, key) {
    if (firstDead.has(key)) return firstDead.get(key);
    let at;
    try { const saved = JSON.parse(readFileSync(sidecar(file), 'utf8')); if (saved.key === key && Number.isFinite(saved.at)) at = saved.at; } catch { /* none yet */ }
    if (at === undefined) {
      at = clock(); // stamped after the death probe
      try { writeFileSync(sidecar(file), JSON.stringify({key, at}), {mode: 0o600}); } catch { /* memory stamp still applies */ }
    }
    firstDead.set(key, at);
    return at;
  }
  function claimAndRemove(entry) {
    const tomb = `${entry.file}.held-${randomBytes(8).toString('hex')}`; // a held name still blocks its slot
    try { renameSync(entry.file, tomb); } catch { return false; }
    let judged = false;
    try {
      const seen = statSync(tomb);
      judged = seen.ino === entry.ino && seen.mtimeMs === entry.mtimeMs
        && liveness(ownerPid(root, entry.index, tomb), selfPid) === 'dead';
    } catch { /* unreadable claim: treat as not judged */ }
    if (judged) { try { unlinkSync(tomb); return true; } catch { /* fall through and restore */ } }
    try { linkSync(tomb, entry.file); unlinkSync(tomb); } catch { /* the held tombstone stays and keeps blocking its slot */ }
    return false;
  }
  const forget = (file, key) => { firstDead.delete(key); try { unlinkSync(sidecar(file)); } catch { /* absent */ } };
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
        if (liveness(pid, selfPid) !== 'dead') { forget(file, key); continue; }
        stampFor(file, key);
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
        if (now - entry.mtimeMs < graceMs || sampledAt < firstDead.get(entry.key) + DEATH_SAMPLE_MARGIN_MS) continue;
        // Claim whatever is at the marker name with one atomic rename, THEN prove it is the file we judged. A replacement
        // swapped in meanwhile is put straight back (or kept as a held tombstone that still blocks its slot), so no
        // dispatch marker is ever lost, whatever the timing and without any lease or lock.
        const removed = claimAndRemove(entry);
        if (!removed) continue;
        forget(entry.file, entry.key);
        reaped.push(entry.name);
      }
      if (reaped.length) log(`heavy-admission: reaped stale remote slot marker(s) ${reaped.join(', ')} (owner dead; Forge reports ${active} active run(s))\n`);
      return reaped;
    },
  };
}
