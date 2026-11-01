// Remote slot execution markers (`slot-N.unconfirmed`): written BEFORE a Forge dispatch and removed only when the
// remote run is confirmed finished. A client that dies mid-run leaves its marker behind, and the old code kept it
// forever, so a few dead clients walled off the whole cap while Forge sat idle ("remote-full" with load ~0.5).
// A marker is reaped here only on liveness evidence: its owner process is provably dead AND Forge's own fresh
// telemetry cannot account for it as a still-running remote run. Nothing is ever reaped on age alone.
import {readdirSync, readFileSync, statSync, unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {readLockEntry} from './file-locks.mjs';
import {probePidLiveness} from './pid-liveness.mjs';

export const MARKER_GRACE_MS = 120_000;
const NAME = /^slot-(\d+)\.unconfirmed$/;

/** New markers carry their owner pid so a later client can prove the owner is dead. */
export function markerContent({owner, pid, nowMs}) {
  return JSON.stringify({v: 1, owner, pid, at: nowMs}) + '\n';
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
 * receipt it created is already counted, (2) the marker is past the grace window, and (3) the number of dead-owner
 * markers exceeds Forge's reported active runs, so at most that many (the newest) may still be running.
 * Leaked Forge receipts only inflate activeRuns, which makes this stricter, never looser.
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
        let mtimeMs;
        try { mtimeMs = fs.statSync(file).mtimeMs; } catch { continue; }
        const pid = ownerPid(root, Number(m[1]), file);
        if (liveness(pid, selfPid) !== 'dead') { firstDead.delete(name); continue; }
        if (!firstDead.has(name)) firstDead.set(name, now);
        dead.push({name, file, mtimeMs});
      }
      if (!dead.length) return [];
      const telemetry = await getTelemetry();
      const sampledAt = Date.parse(telemetry?.sampledAtET), active = telemetry?.activeRuns;
      if (!Number.isFinite(sampledAt) || !Number.isSafeInteger(active) || active < 0) return [];
      dead.sort((a, b) => a.mtimeMs - b.mtimeMs);
      let budget = dead.length - Math.min(dead.length, active);
      const reaped = [];
      for (const entry of dead) {
        if (budget <= 0) break;
        if (now - entry.mtimeMs < graceMs || firstDead.get(entry.name) > sampledAt) continue;
        try { fs.unlinkSync(entry.file); } catch { continue; }
        firstDead.delete(entry.name);
        reaped.push(entry.name);
        budget -= 1;
      }
      if (reaped.length) log(`heavy-admission: reaped stale remote slot marker(s) ${reaped.join(', ')} (owner dead; Forge reports ${active} active run(s))\n`);
      return reaped;
    },
  };
}
