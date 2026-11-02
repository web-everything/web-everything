// Remote slot execution markers (`slot-N.unconfirmed`): written BEFORE a Forge dispatch and removed only when the
// remote run is confirmed finished. A client that dies mid-run leaves its marker behind, and the old code kept it
// forever, so a few dead clients walled off the whole cap while Forge sat idle ("remote-full" with load ~0.5).
// A marker is reaped here only on liveness evidence: its owner process is provably dead AND Forge's own fresh
// telemetry cannot account for it as a still-running remote run. Nothing is ever reaped on age alone.
import {lstatSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync, renameSync, linkSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {join} from 'node:path';
import {readLockEntry, lockDirFor} from './file-locks.mjs';
import {probePidLiveness} from './pid-liveness.mjs';

export const MARKER_GRACE_MS = 120_000;
// The Forge sample must be taken this long AFTER the owner was first seen dead: it covers Forge-vs-Mac clock skew and
// a receipt created between Forge's receipt listing and its timestamp, so a sample can never predate a surviving run.
export const DEATH_SAMPLE_MARGIN_MS = 90_000;
const NAME = /^slot-(\d+)\.unconfirmed$/;
const HELD_NAME = /^slot-(\d+)\.unconfirmed(?:\.held-[0-9a-f]{16})?$/;

/** New markers carry their owner pid so a later client can prove the owner is dead. `run` (the Forge run id) is added once known. */
export function markerContent({owner, pid, nowMs, host, run}) {
  return JSON.stringify({v: 1, note: 'remote termination unconfirmed', host, owner, pid, at: nowMs, ...(run ? {run} : {})}) + '\n';
}

const CLOCK_SKEW_MS = 60_000;
const LEGACY_TEXT = 'remote termination unconfirmed';
const RUN = /^r-[a-f0-9]{32}$/;

// Every entry must be readable before a missing run can count as evidence of absence.
function readableRecentRuns(recent) {
  return Array.isArray(recent) && Array.from(recent).every(entry => entry !== null
    && typeof entry === 'object' && !Array.isArray(entry)
    && typeof entry.runId === 'string' && RUN.test(entry.runId)
    && typeof entry.startedAtET === 'string' && Number.isFinite(Date.parse(entry.startedAtET))
    && (entry.code === null || (Number.isSafeInteger(entry.code) && entry.code >= 0 && entry.code <= 255)));
}

/**
 * Record the Forge run id beside this client's marker, in a sidecar bound to the marker's owner. The marker file itself is
 * never rewritten (a reaper may be judging its inode), and a stale sidecar of another owner is ignored.
 */
export function recordMarkerRun(file, {owner, run}) {
  if (!RUN.test(run)) return false;
  const tmp = `${file}.run-${randomBytes(6).toString('hex')}`;
  try {
    if (JSON.parse(readFileSync(file, 'utf8'))?.owner !== owner) return false;
    writeFileSync(tmp, JSON.stringify({owner, run}) + '\n', {flag: 'wx', mode: 0o600});
    renameSync(tmp, `${file}.run`);
    return true;
  } catch { try { unlinkSync(tmp); } catch { /* none */ } return false; }
}

function sidecarRun(file, owner) {
  try {
    const saved = JSON.parse(readFileSync(`${file}.run`, 'utf8'));
    return saved?.owner === owner && typeof saved.run === 'string' && RUN.test(saved.run) ? saved.run : null;
  } catch { return null; }
}

/**
 * What Forge's recent-run telemetry says about one run: `finished` (a result code was published), `inflight` (listed
 * without a code) or `absent` (not listed). The caller guarantees the sample postdates the owner's death by a margin.
 */
export function runVerdict(telemetry, run) {
  const entry = telemetry.recent.find(item => item?.runId === run);
  if (!entry) return 'absent';
  return Number.isInteger(entry.code) ? 'finished' : 'inflight';
}

/**
 * Slot indices whose marker (or a held tombstone) is present: those slots are never handed out. A canonical marker
 * that is listed but gone by the time it is examined was renamed by a reaper: the listing is retaken until stable,
 * and an unstable listing fails closed. A canonical marker counts only if it resolves (a dangling link is refused
 * later by exclusive creation); a held tombstone always counts; any listing error other than ENOENT throws.
 */
export function blockedSlots(root, cap, readdir = readdirSync, stat = statSync, lstat = lstatSync) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const blocked = new Set();
    let names = [], raced = false;
    try { names = readdir(root); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    for (const name of names) {
      const m = HELD_NAME.exec(name);
      if (!m || Number(m[1]) >= cap) continue;
      if (name.includes('.held-')) { blocked.add(Number(m[1])); continue; }
      try { lstat(join(root, name)); } catch (error) { if (error?.code === 'ENOENT') { raced = true; continue; } throw error; }
      try { stat(join(root, name)); blocked.add(Number(m[1])); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; } // dangling link: not a resolvable marker
    }
    if (!raced) return blocked;
  }
  throw new Error('remote-marker-listing-unstable');
}

/** True when a held tombstone exists for this slot (fails closed: an unreadable directory counts as held). */
export function heldTombstone(root, index, readdir = readdirSync) {
  try { return readdir(root).some(name => { const m = HELD_NAME.exec(name); return m && name.includes('.held-') && Number(m[1]) === index; }); }
  catch { return true; }
}

/**
 * Parsed marker. `legacy` is a bare-text (non-JSON) marker that was READ successfully; it has no host/pid/run, so only
 * the slot lock can attribute it. `unreadable` means the file could not be read or is neither valid JSON nor the known bare text: unknown, never a reason to reap.
 */
function readMarker(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return {unreadable: true, legacy: false, host: undefined, pid: null, run: null, at: null}; }
  try {
    const marker = JSON.parse(text);
    if (marker && typeof marker === 'object' && !Array.isArray(marker)) {
      // A field that is present must be well formed; a malformed structured marker is unknown evidence, never reapable.
      const ok = (key, test) => marker[key] === undefined || test(marker[key]);
      if (!ok('host', v => typeof v === 'string') || !ok('owner', v => typeof v === 'string') || !ok('pid', Number.isInteger)
        || !ok('at', Number.isFinite) || !ok('run', v => typeof v === 'string' && RUN.test(v))) {
        return {unreadable: true, legacy: false, host: undefined, pid: null, run: null, at: null};
      }
      return {legacy: false, host: marker.host, owner: marker.owner, pid: marker.pid ?? null,
        run: marker.run ?? (marker.owner !== undefined ? sidecarRun(file, marker.owner) : null),
        at: marker.at ?? null};
    }
  } catch { /* not JSON: legacy only if it is exactly the known bare text */ }
  if (text.trim() !== LEGACY_TEXT) return {unreadable: true, legacy: false, host: undefined, pid: null, run: null, at: null};
  return {legacy: true, host: undefined, pid: null, run: null, at: null};
}

/** Slot-lock holder for a slot: `absent` only when the lock directory provably does not exist; unreadable metadata is `unknown`. */
function slotHolder(root, index) {
  const dir = lockDirFor(root, `slot-${index}`);
  try { lstatSync(dir); } catch (error) { return error?.code === 'ENOENT' ? {state: 'absent'} : {state: 'unknown'}; }
  let entry;
  try { entry = readLockEntry(root, `slot-${index}`); } catch { return {state: 'unknown'}; }
  return entry && Number.isInteger(entry.pid) ? {state: 'held', pid: entry.pid} : {state: 'unknown'};
}

function ownerPid(root, index, file) {
  const marker = readMarker(file);
  if (marker.unreadable) return null;
  if (!marker.legacy && marker.pid !== null) return marker.pid;
  const holder = slotHolder(root, index);
  return holder.state === 'held' ? holder.pid : null;
}

/** True only on proof the owner is gone. A bare marker with provably no slot-lock holder has no live local owner. */
function ownerGone(root, index, file, liveness, selfPid) {
  const marker = readMarker(file);
  if (marker.unreadable) return false;
  if (marker.legacy) {
    const holder = slotHolder(root, index);
    if (holder.state === 'absent') return true;
    return holder.state === 'held' && liveness(holder.pid, selfPid) === 'dead';
  }
  return liveness(ownerPid(root, index, file), selfPid) === 'dead';
}

/**
 * Stateful reaper for one wait loop. `step()` is cheap and idempotent. It reads Forge telemetry (a lazy async getter)
 * only when a dead-owner marker exists, so a loop with no dead markers costs one readdir.
 * Decided PER RUN, never from the global active-run count (which a busy Forge never lets reach zero). A dead-owner,
 * host-bound marker is reaped when it is past the grace window, the telemetry sample was taken at least
 * DEATH_SAMPLE_MARGIN_MS after the owner was first seen dead (the stamp persists in a sidecar, so a later client completes
 * what an earlier one began), and Forge's readable telemetry shows ITS run finished or absent. A run still listed without
 * a result keeps the marker. A marker whose run id was never recorded (the client died before prepare returned) is kept
 * while any run started inside its own possible window ([at - skew, first-seen-dead]) is still unfinished.
 * Unreadable or malformed telemetry reaps nothing. A bare legacy text marker has no host or run to ask Forge about: it is
 * reaped past the grace window once no live local process holds its slot lock.
 */
export function createMarkerReaper({root, host, clock = Date.now, liveness = probePidLiveness, selfPid = process.pid,
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
    const held = entry.index;
    const tomb = `${entry.file}.held-${randomBytes(8).toString('hex')}`; // a held name still blocks its slot
    try { renameSync(entry.file, tomb); } catch { return false; }
    let judged = false;
    try {
      const seen = statSync(tomb);
      judged = seen.ino === entry.ino && seen.mtimeMs === entry.mtimeMs
        && ownerGone(root, held, tomb, liveness, selfPid);
    } catch { /* unreadable claim: treat as not judged */ }
    if (judged) {
      // The tombstone still blocks the slot here, so no successor can have written its own sidecar yet.
      try { if (entry.owner !== undefined && sidecarRun(entry.file, entry.owner) !== null) unlinkSync(`${entry.file}.run`); } catch { /* absent */ }
      try { unlinkSync(tomb); return true; } catch { /* fall through and restore */ }
    }
    try { linkSync(tomb, entry.file); unlinkSync(tomb); } catch { /* the held tombstone stays and keeps blocking its slot */ }
    return false;
  }
  const forget = (file, key) => { firstDead.delete(key); try { unlinkSync(sidecar(file)); } catch { /* absent */ } };
  return {
    async step(getTelemetry, now = clock()) {
      let names;
      try { names = fs.readdirSync(root); } catch { return []; }
      const dead = [], reaped = [];
      for (const name of names) {
        const m = NAME.exec(name);
        if (!m) continue;
        const file = join(root, name);
        let mtimeMs, ino;
        try { ({mtimeMs, ino} = fs.statSync(file)); } catch { continue; }
        const marker = readMarker(file), index = Number(m[1]);
        if (marker.unreadable) continue;
        const key = `${name}:${ino}:${mtimeMs}`; // a replacement marker never inherits a predecessor's death stamp
        if (marker.legacy) {
          // No host, run or Forge question applies: reap on proof that no live local process owns the slot.
          if (now - mtimeMs < graceMs || !ownerGone(root, index, file, liveness, selfPid)) continue;
          if (claimAndRemove({file, name, ino, mtimeMs, index})) reaped.push(name);
          continue;
        }
        // Telemetry only speaks for its own Forge host: a marker not provably bound to this host is retained.
        if (marker.host !== host || host === undefined) continue;
        if (!ownerGone(root, index, file, liveness, selfPid)) { forget(file, key); continue; }
        stampFor(file, key);
        dead.push({name, key, file, mtimeMs, ino, index, run: marker.run, at: marker.at, owner: marker.owner});
      }
      if (dead.length) {
        const telemetry = await getTelemetry();
        const sampledAt = Date.parse(telemetry?.sampledAtET), active = telemetry?.activeRuns;
        if (Number.isFinite(sampledAt) && Number.isSafeInteger(active) && active >= 0 && readableRecentRuns(telemetry.recent)) {
          dead.sort((a, b) => a.mtimeMs - b.mtimeMs);
          for (const entry of dead) {
            const diedBy = firstDead.get(entry.key);
            if (now - entry.mtimeMs < graceMs || sampledAt < diedBy + DEATH_SAMPLE_MARGIN_MS) continue;
            if (entry.run ? runVerdict(telemetry, entry.run) === 'inflight' : maybeOwnsInflight(telemetry, entry.at ?? entry.mtimeMs, diedBy)) continue;
            // Claim whatever is at the marker name with one atomic rename, THEN prove it is the file we judged. A replacement
            // swapped in meanwhile is put straight back (or kept as a held tombstone that still blocks its slot), so no
            // dispatch marker is ever lost, whatever the timing and without any lease or lock.
            if (!claimAndRemove(entry)) continue;
            forget(entry.file, entry.key);
            reaped.push(entry.name);
          }
        }
      }
      if (reaped.length) log(`heavy-admission: reaped stale remote slot marker(s) ${reaped.join(', ')} (owner dead; its Forge run is finished or absent)\n`);
      return reaped;
    },
  };
}

// A run-less marker's run could only have started between the marker's dispatch and the owner's death.
function maybeOwnsInflight(telemetry, atMs, diedByMs) {
  return telemetry.recent.some(item => {
    const started = Date.parse(item?.startedAtET);
    return !Number.isInteger(item?.code) && (!Number.isFinite(started) || (started >= atMs - CLOCK_SKEW_MS && started <= diedByMs));
  });
}
