/**
 * @file scripts/lib/disk-cleanup.mjs
 * @description R498 — automatic disk cleanup. When the data volume is under `health.diskFreeMinGb`, free space in
 *   order, stopping as soon as it is back over the threshold:
 *     (a) prune daemon-jobs `.snapshots` to the newest N per daemon (reuses `evictSnapshots`), never one a
 *         non-terminal job, a live registration (daemon state file) or a running process still points at;
 *     (b) delete stale `rebuild-*` job dirs with no running job, no live pid, no process using them;
 *     (c) remove idle lane clones above a cap through lane-pool's own `remove`.
 *   Every deletion is reported to `log` with its size and reason; `dryRun` deletes nothing. Side effects
 *   (sizes, pids, processes, lanes) are injected so every refusal is unit-testable.
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { evictSnapshots, snapshotsRoot } from './daemon-job-snapshots.mjs';
import { TERMINAL_JOB_STATUSES } from '../operations/job-record.mjs';

/** Defaults for the `diskCleanup` settings block (config overrides any of them). */
export const DISK_CLEANUP_DEFAULTS = Object.freeze({
  enabled: true,
  keepSnapshots: 2,
  rebuildMaxAgeHours: 12,
  laneCap: 60,
  dailyCadenceHours: 24,
});

const MAX_STATE_FILE_BYTES = 1_000_000;
const SNAP_KINDS = [['code', 'code'], ['node-modules', 'node-modules']];

function safeList(dir) { try { return readdirSync(dir); } catch { return []; } }
function readJson(file) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } }

/** All non-snapshot job records in one daemon-jobs store dir. */
function jobRecords(dir) {
  return safeList(dir).filter((n) => n.endsWith('.json')).map((n) => readJson(join(dir, n))).filter((r) => r && r.job);
}

/** Text of every small top-level file in the daemon state dir: a live registration names its code sha there. */
function registrationText(stateDir) {
  let out = '';
  for (const name of safeList(stateDir)) {
    try {
      const p = join(stateDir, name);
      const st = statSync(p);
      if (st.isFile() && st.size <= MAX_STATE_FILE_BYTES) out += `\n${readFileSync(p, 'utf8')}`;
    } catch { /* unreadable: skip */ }
  }
  return out;
}

/** Step (a). */
export function pruneSnapshots({ jobsDir, stateDir, keep = DISK_CLEANUP_DEFAULTS.keepSnapshots, dryRun = false, processCommands = [], sizeOf, log = () => {} }) {
  const removed = [];
  const blob = `${registrationText(stateDir)}\n${processCommands.join('\n')}`;
  for (const daemon of safeList(jobsDir)) {
    const dir = join(jobsDir, daemon);
    if (!existsSync(snapshotsRoot(dir))) continue;
    const referenced = new Set(jobRecords(dir).filter((r) => !TERMINAL_JOB_STATUSES.includes(r.job.status)).flatMap((r) => r.job.snapshotKeys || []));
    for (const [sub] of SNAP_KINDS) {
      for (const key of safeList(join(snapshotsRoot(dir), sub))) {
        if (blob.includes(key)) referenced.add(`${sub === 'code' ? 'code' : 'node-modules'}:${key}`);
      }
    }
    const plan = evictSnapshots({ jobsDir: dir, referenced, keep, dryRun: true }).evicted;
    for (const ref of plan) {
      const [sub, key] = [ref.slice(0, ref.indexOf(':')), ref.slice(ref.indexOf(':') + 1)];
      const path = join(snapshotsRoot(dir), sub, key);
      const bytes = sizeOf(path);
      const entry = { action: 'snapshot', daemon, ref, path, bytes, dryRun, reason: `unpinned snapshot beyond keep=${keep} per store` };
      removed.push(entry);
      log(entry);
      if (!dryRun) rmSync(path, { recursive: true, force: true });
    }
  }
  return { removed };
}

function newestMtimeMs(dir) {
  let newest = statSync(dir).mtimeMs;
  for (const n of safeList(dir)) { try { newest = Math.max(newest, statSync(join(dir, n)).mtimeMs); } catch { /* gone */ } }
  return newest;
}

/** Step (b). */
export function pruneRebuildDirs({ jobsDir, maxAgeHours = DISK_CLEANUP_DEFAULTS.rebuildMaxAgeHours, dryRun = false, now = Date.now(), processCommands = [], isPidAlive, sizeOf, log = () => {} }) {
  const removed = []; const refused = [];
  for (const name of safeList(jobsDir)) {
    if (!name.startsWith('rebuild-')) continue;
    const dir = join(jobsDir, name);
    let age;
    try { age = now - newestMtimeMs(dir); } catch { continue; }
    const records = jobRecords(dir);
    let why = null;
    if (age < maxAgeHours * 3_600_000) why = `newer than ${maxAgeHours}h`;
    else if (records.some((r) => !TERMINAL_JOB_STATUSES.includes(r.job.status))) why = 'has a non-terminal job';
    else if (records.some((r) => Number.isInteger(r.job.pid) && isPidAlive(r.job.pid))) why = 'a recorded job pid is alive';
    else if (processCommands.some((c) => c.includes(dir))) why = 'a running process uses it';
    if (why) { refused.push({ path: dir, reason: why }); continue; }
    const entry = { action: 'rebuild-dir', path: dir, bytes: sizeOf(dir), dryRun, reason: `no running job or process and older than ${maxAgeHours}h` };
    removed.push(entry);
    log(entry);
    if (!dryRun) rmSync(dir, { recursive: true, force: true });
  }
  return { removed, refused };
}

/** Step (c): remove idle lanes above `cap`, highest-numbered first, one at a time via `removeLane` (lane-pool's own path). */
export function trimIdleLanes({ lanes, cap = DISK_CLEANUP_DEFAULTS.laneCap, dryRun = false, inspect, sizeOf, removeLane, log = () => {} }) {
  const removed = []; const refused = [];
  let excess = lanes.length - cap;
  for (const lane of [...lanes].sort((a, b) => b.n - a.n)) {
    if (excess <= 0) break;
    const s = inspect(lane);
    const blockers = ['lease', 'cwdInUse', 'unpushed', 'stash', 'dirty'].filter((k) => s[k]);
    if (blockers.length) { refused.push({ n: lane.n, path: lane.dir, reason: `not idle: ${blockers.join(', ')}` }); continue; }
    const entry = { action: 'lane', n: lane.n, path: lane.dir, bytes: sizeOf(lane.dir), dryRun, reason: `idle lane above cap ${cap}` };
    removed.push(entry);
    log(entry);
    if (!dryRun) removeLane(lane);
    excess -= 1;
  }
  return { removed, refused };
}

/**
 * Run the ladder. `freeGb()` is re-read between steps. `force` skips the threshold gate for (a)+(b) (daily cadence);
 * step (c) only ever runs while free space is still under `minGb`.
 */
export function runDiskCleanup({ freeGb, minGb, settings = DISK_CLEANUP_DEFAULTS, dryRun = false, force = false, jobsDir, stateDir,
  processCommands = [], sizeOf, isPidAlive, now = Date.now(), lanes = [], inspectLane, removeLane, steps = new Set(['a', 'b', 'c']), log = () => {} }) {
  const before = freeGb();
  const summary = { ran: false, beforeGb: before, afterGb: before, removed: [], refused: [] };
  if (!force && !(before < minGb)) return summary;
  summary.ran = true;
  const a = steps.has('a') ? pruneSnapshots({ jobsDir, stateDir, keep: settings.keepSnapshots, dryRun, processCommands, sizeOf, log }) : { removed: [] };
  const b = steps.has('b') ? pruneRebuildDirs({ jobsDir, maxAgeHours: settings.rebuildMaxAgeHours, dryRun, now, processCommands, isPidAlive, sizeOf, log }) : { removed: [], refused: [] };
  summary.removed.push(...a.removed, ...b.removed);
  summary.refused.push(...b.refused);
  summary.afterGb = freeGb();
  if (steps.has('c') && summary.afterGb < minGb) {
    const c = trimIdleLanes({ lanes, cap: settings.laneCap, dryRun, inspect: inspectLane, sizeOf, removeLane, log });
    summary.removed.push(...c.removed);
    summary.refused.push(...c.refused);
    summary.afterGb = freeGb();
  }
  return summary;
}
