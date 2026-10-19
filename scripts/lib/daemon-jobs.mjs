/**
 * @file scripts/lib/daemon-jobs.mjs
 * @description THE DAEMON JOB POLICY — the pure half of the shared job layer (#4125, statute `#daemon-jobs`,
 *   decision 4120; audit `we:reports/2026-09-24-daemon-blocking-antipatterns.md`).
 *
 * A daemon action that can outlast a small part of its tick runs as a JOB: a detached child with a run-store
 * record (`we:scripts/operations/job-record.mjs`). The tick only starts jobs and reads records. This file
 * decides, from a record and a few observations, what the tick does next:
 *
 *   - {@link classifyJob}   — live / stalled / dead / launching / queued / waiting / foreign / terminal
 *   - {@link planReattach}  — leave alone, stop-then-relaunch, relaunch (resume from checkpoint), or fail
 *   - {@link admitJobs}     — which queued jobs start now, under the per-daemon cap and the serial lane
 *   - {@link detectSleep}   — did the host sleep between two ticks (wall gap vs monotonic gap)
 *   - {@link selectEvictions} — which snapshot stores go (unreferenced, keep at most 2)
 *   - the record transitions every writer applies (`markLaunching`, `markClaimed`, …)
 *
 * The io half — `ps`, spawn, signals, the locked record store, the tick loop and the job-side runner — is
 * `daemon-jobs-runtime.mjs`; code snapshots and `node_modules` stores are `daemon-job-snapshots.mjs`.
 *
 * PURE. No fs, no clock, no process: every time is a caller's clock reading, every liveness answer a
 * caller's probe.
 */

import { TERMINAL_JOB_STATUSES, JOB_CODE_MODES, DEFAULT_MAX_ATTEMPTS, isValidJobKind, withTimelineEvent } from '../operations/job-record.mjs';

/** How often a running job stamps `heartbeatAt`. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;

/** A live pid whose heartbeat is older than this is STALLED (statute: SIGTERM, SIGKILL, confirm, relaunch). */
export const DEFAULT_HEARTBEAT_STALE_MS = 60_000;

/** How long a spawned child has to claim its record before the launch counts as dead. */
export const DEFAULT_LAUNCH_GRACE_MS = 30_000;

/** First retry delay; attempt n waits `base * 2^(n-1)`. */
export const DEFAULT_BACKOFF_BASE_MS = 30_000;

/**
 * THE SLEEP RULE (ratify red-team finding 2). Between two ticks, the wall clock (`Date.now()`) keeps running
 * through a host sleep while the monotonic clock (`performance.now()` — `mach_absolute_time`/`CLOCK_UPTIME_RAW`
 * on macOS, `CLOCK_MONOTONIC` on Linux) does not. A blocked event loop or a slow tick moves BOTH clocks
 * equally, so only a sleep (or a forward wall-clock step) opens a gap. When `wallDelta - monoDelta` exceeds
 * this threshold the tick SKIPS the staleness check — every job's heartbeat went quiet for the same reason
 * the daemon's did — and judges only dead pids. It never skips otherwise, so a live-but-stuck job is still
 * caught on the next tick.
 */
export const SLEEP_GAP_THRESHOLD_MS = 10_000;

/** Snapshot stores kept when no live job references them (ratify red-team finding 3). */
export const DEFAULT_SNAPSHOT_KEEP = 2;

/**
 * Declare a job kind. `serial` kinds share ONE lane per daemon (single writers — at most one runs at a time).
 * `resumable: false` relaunches from step 0 instead of the checkpoint (bot-session jobs are relaunched, never
 * resumed — `#conveyor-session-lifecycle-policy`). `entry` is the job script, repo-relative, run inside the
 * snapshot (readonly-tree) or the kind's own worktree (mutates-tree).
 * @param {{kind: string, entry: string, codeMode?: string, serial?: boolean, resumable?: boolean,
 *   maxAttempts?: number, nodeModules?: boolean, prepareWorktree?: Function}} def
 */
export function defineJobKind(def) {
  const {
    kind, entry, codeMode = 'readonly-tree', serial = false, resumable = true, maxAttempts = DEFAULT_MAX_ATTEMPTS,
    nodeModules = false, prepareWorktree = null,
  } = def || {};
  if (!isValidJobKind(kind)) throw new TypeError(`daemon-jobs: invalid job kind ${JSON.stringify(kind)}`);
  if (typeof entry !== 'string' || !entry || entry.startsWith('/') || entry.split('/').includes('..')) {
    throw new TypeError(`daemon-jobs: kind ${kind} needs a repo-relative entry script`);
  }
  if (!JOB_CODE_MODES.includes(codeMode)) throw new TypeError(`daemon-jobs: kind ${kind} codeMode must be one of ${JOB_CODE_MODES.join('|')}`);
  if (codeMode === 'mutates-tree' && typeof prepareWorktree !== 'function') {
    // A tree-changing job runs in its OWN working tree of main, never the daemon clone — so the kind must say
    // how that tree is made. No default: guessing would put the job in the daemon clone.
    throw new TypeError(`daemon-jobs: mutates-tree kind ${kind} must provide prepareWorktree(record)`);
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new TypeError(`daemon-jobs: kind ${kind} maxAttempts must be a positive integer`);
  return Object.freeze({ kind, entry, codeMode, serial: !!serial, resumable: !!resumable, maxAttempts, nodeModules: !!nodeModules, prepareWorktree });
}

/** Index kind definitions by name, refusing duplicates. */
export function kindRegistry(defs) {
  const map = new Map();
  for (const d of defs) {
    const def = d && Object.isFrozen(d) && d.kind ? d : defineJobKind(d);
    if (map.has(def.kind)) throw new TypeError(`daemon-jobs: kind ${def.kind} declared twice`);
    map.set(def.kind, def);
  }
  return map;
}

/**
 * Did the host sleep between two tick observations?
 * @param {{wallMs: number, monoMs: number}|null} prev
 * @param {{wallMs: number, monoMs: number}} cur
 * @param {number} [thresholdMs]
 * @returns {{slept: boolean, gapMs: number}}
 */
export function detectSleep(prev, cur, thresholdMs = SLEEP_GAP_THRESHOLD_MS) {
  if (!prev || !cur) return { slept: false, gapMs: 0 };
  const gapMs = (cur.wallMs - prev.wallMs) - (cur.monoMs - prev.monoMs);
  // A backwards wall step (NTP slewing the clock back) is a negative gap — not a sleep.
  return { slept: gapMs > thresholdMs, gapMs };
}

function ms(iso) {
  return iso ? Date.parse(iso) : NaN;
}

/**
 * Classify one job record.
 *
 * `liveness` is the caller's probe of `job.handle` — `'alive'` (pid exists on this host AND its start time
 * matches), `'dead'` (no such pid, or the pid was reused), `'foreign'` (the handle is another host's, which
 * this daemon cannot judge) — or `null` when the record has no handle.
 *
 * @param {object} record - a job run record.
 * @param {{now: number, liveness: ('alive'|'dead'|'foreign'|null), staleMs?: number, launchGraceMs?: number,
 *   sleepDetected?: boolean}} o
 * @returns {'terminal'|'queued'|'waiting'|'launching'|'live'|'stalled'|'dead'|'foreign'}
 */
export function classifyJob(record, { now, liveness, staleMs = DEFAULT_HEARTBEAT_STALE_MS, launchGraceMs = DEFAULT_LAUNCH_GRACE_MS, sleepDetected = false }) {
  const job = record.job;
  if (TERMINAL_JOB_STATUSES.includes(job.status)) return 'terminal';
  if (job.status === 'queued') {
    const due = ms(job.nextAttemptAt);
    return Number.isFinite(due) && due > now ? 'waiting' : 'queued';
  }
  if (!job.handle) {
    // `launching` with no handle: the child has not claimed yet. Within the grace it may still; after it, the
    // spawn died before claiming (or the daemon died between spawn and claim) — a dead launch.
    const launched = ms(job.launchedAt);
    return Number.isFinite(launched) && now - launched <= launchGraceMs ? 'launching' : 'dead';
  }
  if (liveness === 'foreign') return 'foreign';
  if (liveness !== 'alive') return 'dead';
  if (sleepDetected) return 'live';
  const beat = ms(job.heartbeatAt ?? job.startedAt);
  if (!Number.isFinite(beat)) return 'live';
  return now - beat > staleMs ? 'stalled' : 'live';
}

/** Retry delay before attempt `attempts + 1`, given `attempts` launches so far. */
export function backoffMs(attempts, baseMs = DEFAULT_BACKOFF_BASE_MS) {
  return baseMs * 2 ** Math.max(0, attempts - 1);
}

/**
 * What the tick does with one classified job.
 *   - `none`    — live, launching, waiting, foreign, terminal, or queued (admission decides those)
 *   - `requeue` — requeue with backoff, resuming from the checkpoint unless the kind says not
 *   - `fail`    — out of attempts (or the kind is gone): fail visibly
 * `stopFirst` is set for a stalled job: SIGTERM, then SIGKILL, confirm gone — only then requeue or fail.
 * @param {object} record
 * @param {string} state - from {@link classifyJob}
 * @param {{kindDef?: object|null}} [o]
 * @returns {{type: 'none'|'requeue'|'fail', stopFirst?: boolean, reason?: string, resume?: boolean}}
 */
export function planReattach(record, state, { kindDef } = {}) {
  const job = record.job;
  if (state !== 'stalled' && state !== 'dead') return { type: 'none' };
  const stopFirst = state === 'stalled';
  const why = stopFirst ? 'heartbeat stale on a live pid' : 'handle dead';
  if (!kindDef) return { type: 'fail', stopFirst, reason: `${why}; kind ${job.kind} is not declared by this daemon` };
  if (job.attempts >= job.maxAttempts) {
    return { type: 'fail', stopFirst, reason: `${why}; ${job.attempts}/${job.maxAttempts} attempts used; last error: ${job.error ?? 'unknown'}` };
  }
  return { type: 'requeue', stopFirst, reason: why, resume: kindDef.resumable };
}

/** Does this job occupy a concurrency slot? Anything spawned and not yet terminal does. */
export function occupiesSlot(record) {
  return record.job.status === 'launching' || record.job.status === 'running';
}

/**
 * Which queued jobs start now. Occupied slots are every `launching`/`running` job (a stalled job holds its
 * slot until it is confirmed gone). Serial kinds share ONE lane: none is admitted while another serial job
 * occupies a slot, and at most one per pass. Oldest first (by the queue time on the timeline, then id).
 * @param {{records: object[], kinds: Map<string, object>, maxConcurrent: number, now: number}} o
 * @returns {string[]} ids to launch, in order
 */
export function admitJobs({ records, kinds, maxConcurrent, now }) {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) throw new TypeError('daemon-jobs: maxConcurrent must be a positive integer');
  const isSerial = (r) => !!kinds.get(r.job.kind)?.serial;
  const occupying = records.filter(occupiesSlot);
  let free = maxConcurrent - occupying.length;
  let serialBusy = occupying.some(isSerial);
  const queuedAt = (r) => ms(r.job.timeline?.find((e) => e.event === 'queued')?.at) || 0;
  const due = records
    .filter((r) => r.job.status === 'queued' && kinds.has(r.job.kind))
    .filter((r) => { const t = ms(r.job.nextAttemptAt); return !Number.isFinite(t) || t <= now; })
    .sort((a, b) => queuedAt(a) - queuedAt(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const admitted = [];
  for (const r of due) {
    if (free <= 0) break;
    if (isSerial(r)) {
      if (serialBusy) continue;
      serialBusy = true;
    }
    admitted.push(r.id);
    free -= 1;
  }
  return admitted;
}

/**
 * Which snapshot stores to evict. A store any live (non-terminal) job references is always kept. Of the rest,
 * the newest are kept only while the total stays at or under `keep`; everything older goes.
 * @param {{stores: {key: string, mtimeMs: number}[], referenced: Set<string>|string[], keep?: number}} o
 * @returns {string[]} keys to evict
 */
export function selectEvictions({ stores, referenced, keep = DEFAULT_SNAPSHOT_KEEP }) {
  const refs = referenced instanceof Set ? referenced : new Set(referenced);
  const held = stores.filter((s) => refs.has(s.key));
  const idle = stores.filter((s) => !refs.has(s.key)).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const slots = Math.max(0, keep - held.length);
  return idle.slice(slots).map((s) => s.key);
}

// ── record transitions ─────────────────────────────────────────────────────────────────────────────────────
// Each takes a job RECORD and a caller clock reading (`at`, ISO) and returns a new record. They never read the
// store — the runtime applies them inside the record's file lock, on a fresh read.

function setJob(record, patch, event) {
  let job = { ...record.job, ...patch };
  if (event) job = withTimelineEvent(job, event);
  return { ...record, job };
}

/** A new queued job's first timeline row. */
export function markQueued(record, { at }) {
  return setJob(record, {}, { at, event: 'queued' });
}

/** The daemon spawned a child for this job: count the attempt, open the launch grace. */
export function markLaunching(record, { at, launcherPid = undefined, cwd = undefined, snapshotKeys = undefined }) {
  const attempts = record.job.attempts + 1;
  return setJob(record, {
    status: 'launching', handle: null, host: null, pid: null, procStart: null,
    launchedAt: at, heartbeatAt: null, nextAttemptAt: null, attempts,
    ...(snapshotKeys ? { snapshotKeys } : {}),
  }, { at, event: 'launched', attempt: attempts, launcherPid, cwd });
}

/** Record the child pid the spawn returned — diagnostic only; the child's own claim sets the handle. */
export function markSpawned(record, { at, pid }) {
  return setJob(record, {}, { at, event: 'spawned', pid });
}

/** The child claimed the record: it is now the job's one live handle. */
export function markClaimed(record, { at, handle, host, pid, procStart }) {
  return setJob(record, {
    status: 'running', handle, host, pid, procStart, startedAt: at, heartbeatAt: at, error: null,
  }, { at, event: 'started', attempt: record.job.attempts, pid, fromStep: record.job.checkpoint.step });
}

/** The child is alive and making progress. No timeline row — heartbeats would drown the timeline. */
export function markHeartbeat(record, { at }) {
  return setJob(record, { heartbeatAt: at });
}

/** One step applied: move the checkpoint so a relaunch resumes after it. */
export function markCheckpoint(record, { at, step, data = {} }) {
  const cp = record.job.checkpoint;
  return setJob(record, { heartbeatAt: at, checkpoint: { step, data: { ...cp.data, ...data } } }, { at, event: 'step-applied', step });
}

/** The child hit an error in a step. It exits next; the dead handle drives the retry. */
export function markStepError(record, { at, step, error }) {
  return setJob(record, { error: String(error) }, { at, event: 'step-error', step, error: String(error) });
}

/** The child finished every step. */
export function markSucceeded(record, { at }) {
  return setJob(record, { status: 'succeeded', finishedAt: at, handle: null, error: null }, { at, event: 'finished' });
}

/** The daemon stopped a stalled child (SIGTERM → SIGKILL, confirmed gone). */
export function markStopped(record, { at, signal, handle }) {
  return setJob(record, {}, { at, event: 'stopped', signal, handle });
}

/**
 * Put a stalled/dead job back in the queue with backoff. `resume: false` rewinds the checkpoint.
 * @param {object} record
 * @param {{at: string, now: number, reason: string, resume?: boolean, backoffBaseMs?: number}} o
 */
export function markRequeued(record, { at, now, reason, resume = true, backoffBaseMs = DEFAULT_BACKOFF_BASE_MS }) {
  const nextAttemptAt = new Date(now + backoffMs(record.job.attempts, backoffBaseMs)).toISOString();
  return setJob(record, {
    status: 'queued', handle: null, host: null, pid: null, procStart: null, nextAttemptAt,
    ...(resume ? {} : { checkpoint: { step: 0, data: {} } }),
  }, { at, event: 'requeued', reason, resume, nextAttemptAt });
}

/** Out of attempts, or refused: fail visibly. */
export function markFailed(record, { at, reason }) {
  return setJob(record, { status: 'failed', finishedAt: at, handle: null, error: reason }, { at, event: 'failed', reason });
}
