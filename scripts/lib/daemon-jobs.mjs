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

import {
  TERMINAL_JOB_STATUSES, JOB_CODE_MODES, DEFAULT_MAX_ATTEMPTS, isValidJobKind, withTimelineEvent,
  TASK_OUTCOMES, DEFAULT_ACTING_REPO_CAP, validateTaskIdentity, validateTaskMetadata,
} from '../operations/job-record.mjs';
import { createHash } from 'node:crypto';
import { isValidRunId } from '../operations/run-record.mjs';
import { RESOURCE_POLICY_KINDS } from './resource-policy.mjs';

export { TASK_OUTCOMES, DEFAULT_TASK_TIMEOUT_MS, DEFAULT_ACTING_REPO_CAP, validateTaskPolicy } from '../operations/job-record.mjs';

/** Bounded digest of validated structured identity; never put a logical ID directly in a path. */
export function taskRunId(task) {
  const errors = validateTaskIdentity(task);
  if (errors.length) throw new TypeError(errors.join('; '));
  const id = `task-${createHash('sha256').update(JSON.stringify([task.kind, task.repo, task.item, task.seq])).digest('hex')}`;
  if (!isValidRunId(id)) throw new TypeError('task storage ID refused by run-ID validator');
  return id;
}

/** Semantic failures are a separate budget from monotonic launch-attempt tokens. */
export function taskFailureCharge(outcome) {
  if (!TASK_OUTCOMES.includes(outcome)) throw new TypeError('task outcome must be a declared semantic outcome');
  return outcome === 'failed' ? 1 : 0;
}

/** Pure attempt deadline observation. Null delegates ordinary jobs to their existing deadline callback.
 * Queue/backoff and terminal records have no active task deadline; heartbeat/sleep never extend one.
 */
export function taskDeadlineDecision(record, { now }) {
  if (!Object.hasOwn(record.job, 'task')) return null;
  const errors = validateTaskMetadata(record.job.task);
  if (errors.length) throw new TypeError(errors.join('; '));
  if (!occupiesSlot(record)) return null;
  if (!Number.isFinite(now)) throw new TypeError('task deadline needs a finite now');
  const launchedAt = ms(record.job.launchedAt);
  const deadlineAt = launchedAt + record.job.task.timeoutMs;
  if (!Number.isFinite(launchedAt) || !Number.isFinite(deadlineAt)) throw new TypeError('task deadline needs a valid persisted launch time and finite deadline');
  return { deadlineAt, expired: now >= deadlineAt };
}

/** How often a running job stamps `heartbeatAt`. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;

/** A live pid whose heartbeat is older than this is STALLED (statute: SIGTERM, SIGKILL, confirm, relaunch). */
export const DEFAULT_HEARTBEAT_STALE_MS = 60_000;

/** Backstop for an unprobeable host whose heartbeat stopped, including a host renamed after reboot. */
export const DEFAULT_FOREIGN_STALE_MS = 30 * 60_000;

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
    nodeModules = false, prepareWorktree = null, stopGraceMs = null,
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
  // How long a stop waits after SIGTERM before SIGKILL — a kind whose child cleans up (releases a lane) on SIGTERM needs it.
  if (stopGraceMs !== null && (!Number.isInteger(stopGraceMs) || stopGraceMs < 1)) throw new TypeError(`daemon-jobs: kind ${kind} stopGraceMs must be a positive integer`);
  return Object.freeze({ kind, entry, codeMode, serial: !!serial, resumable: !!resumable, maxAttempts, nodeModules: !!nodeModules, prepareWorktree, stopGraceMs });
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
 *   foreignStaleMs?: number, sleepDetected?: boolean}} o
 * @returns {'terminal'|'queued'|'waiting'|'launching'|'live'|'stalled'|'dead'|'foreign'}
 */
export function classifyJob(record, { now, liveness, staleMs = DEFAULT_HEARTBEAT_STALE_MS, launchGraceMs = DEFAULT_LAUNCH_GRACE_MS, foreignStaleMs = DEFAULT_FOREIGN_STALE_MS, sleepDetected = false }) {
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
  if (liveness === 'foreign') {
    const beat = ms(job.heartbeatAt ?? job.startedAt);
    return !sleepDetected && Number.isFinite(beat) && now - beat > foreignStaleMs ? 'dead' : 'foreign';
  }
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
  const repoCounts = new Map();
  const repoCaps = new Map();
  for (const r of records) {
    if (!Object.hasOwn(r.job, 'task')) continue;
    const errors = validateTaskMetadata(r.job.task);
    if (r.job.task?.kind !== r.job.kind) errors.push('job.task.kind must match job.kind');
    if (!RESOURCE_POLICY_KINDS.includes(r.job.task?.resourceKind)) errors.push('job.task.resourceKind must be declared');
    if (errors.length) throw new TypeError(errors.join('; '));
    const task = r.job.task;
    if (!task.acting || TERMINAL_JOB_STATUSES.includes(r.job.status)) continue;
    // Persisted policies may differ after a settings change: honor the strictest live repo cap.
    repoCaps.set(task.repo, Math.min(repoCaps.get(task.repo) ?? Infinity, task.actingRepoCap ?? DEFAULT_ACTING_REPO_CAP));
    if (occupiesSlot(r)) repoCounts.set(task.repo, (repoCounts.get(task.repo) ?? 0) + 1);
  }
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
    const task = r.job.task;
    if (task?.acting && (repoCounts.get(task.repo) ?? 0) >= repoCaps.get(task.repo)) continue;
    if (isSerial(r)) {
      if (serialBusy) continue;
      serialBusy = true;
    }
    admitted.push(r.id);
    if (task?.acting) repoCounts.set(task.repo, (repoCounts.get(task.repo) ?? 0) + 1);
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


const TOOL_WATCH_INTERVAL_MS = 7 * 24 * 60 * 60_000;
const TOOL_WATCH_MAX_BYTES = 1048576;
const WATCHED_TOOLS = Object.freeze({
  'antigravity-cli': ['antigravity-cli'], codex: ['codex'], gh: ['gh'], claude: ['claude', 'claude-code'],
});

/**
 * Weekly advisory job contract (flow/daemon-profile, Tool freshness).
 * The runtime registers this descriptor once and invokes tick in a job, never in its blocking tick loop.
 * All IO is required and injected: exec(command, argv, {timeout, maxBuffer, env}) must enforce the
 * process bounds and return {status, stdout, stderr}; withLock(key, action) must hold the shared durable
 * store lock through action. readState returns null ONLY for a missing record; unreadable records throw.
 * writeState atomically persists the value. alert resolves only after confirmed publication and must
 * dedupe its supplied episode id across a crash between publication and persistence.
 * No process is launched on import; this policy neither installs a daemon nor upgrades any package.
 */
export function createToolVersionWatch({ exec, withLock, readState, writeState, alert, env = {} }) {
  for (const fn of [exec, withLock, readState, writeState, alert]) {
    if (typeof fn !== 'function') throw new TypeError('tool-version-watch requires process, locked state and alert IO');
  }
  const readBrew = async args => {
    try {
      const result = await exec('brew', args, { timeout: 15000, maxBuffer: TOOL_WATCH_MAX_BYTES,
        env: { ...env, HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_ANALYTICS: '1' } });
      if (!result || result.status !== 0 || result.signal || result.error) throw new Error('read failed');
      if (typeof result.stdout !== 'string' || (result.stderr != null && typeof result.stderr !== 'string')) throw new Error('invalid output');
      if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr ?? '') > TOOL_WATCH_MAX_BYTES) throw new Error('output limit');
      const data = JSON.parse(result.stdout);
      if (!Array.isArray(data?.formulae) || !Array.isArray(data?.casks)) throw new Error('incomplete inventory');
      for (const [type, rows] of [['formula', data.formulae], ['cask', data.casks]]) {
        if (rows.some(row => !row || typeof row !== 'object' || typeof (type === 'formula' ? row.name : row.token ?? row.name) !== 'string'))
          throw new Error('incomplete package identity');
      }
      return { data };
    } catch {
      return { diagnostic: `Inspect Homebrew with brew ${args.join(' ')}; read failed, timed out, exceeded 1 MiB, or returned incomplete evidence. Retry after repairing Homebrew.` };
    }
  };
  return Object.freeze({
    kind: 'tool-version-watch', intervalMs: TOOL_WATCH_INTERVAL_MS,
    async tick({ now }) {
      if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + TOOL_WATCH_INTERVAL_MS)) throw new TypeError('tool-version-watch needs a valid now');
      return withLock('tool-version-watch', async () => {
        let state;
        try {
          state = await readState();
          if (state !== null && (!Number.isSafeInteger(state?.nextDueAt) || state.nextDueAt < 0 ||
            !state.episodes || typeof state.episodes !== 'object' || Array.isArray(state.episodes) ||
            Object.entries(state.episodes).some(([tool, id]) => !Object.hasOwn(WATCHED_TOOLS, tool) || !/^[a-f0-9]{64}$/.test(id))))
            throw new Error('invalid state');
        } catch {
          throw new Error('Inspect tool-version-watch state; unreadable or invalid evidence requires operator repair before retry.');
        }
        if (state && now < state.nextDueAt) return { status: 'not-due', nextDueAt: state.nextDueAt };
        state = state ?? { nextDueAt: 0, episodes: {} };
        // Two fixed reads per due week. Never execute tool binaries, brew update, upgrade or install.
        const inventory = await readBrew(['info', '--json=v2', '--installed']);
        const outdated = await readBrew(['outdated', '--json=v2', '--greedy']);
        const tools = Object.entries(WATCHED_TOOLS).map(([tool, aliases]) => {
          const base = { tool, provenance: 'homebrew', installed: [], latest: null, package: null, type: null };
          const unknown = diagnostic => ({ ...base, status: 'unknown', diagnostic });
          if (!inventory.data || !outdated.data) return unknown(inventory.diagnostic ?? outdated.diagnostic);
          const matches = [];
          for (const [type, rows] of [['formula', inventory.data.formulae], ['cask', inventory.data.casks]]) {
            for (const row of rows) {
              const names = [row.name, row.token, row.full_name, row.full_token, ...(Array.isArray(row.aliases) ? row.aliases : [])];
              if (names.some(name => typeof name === 'string' && aliases.includes(name.split('/').at(-1)))) matches.push({ type, row });
            }
          }
          if (matches.length === 0) return { ...base, status: 'not-installed', diagnostic: 'Not installed through Homebrew; other installation managers are outside this inventory.' };
          if (matches.length !== 1) return unknown('Inspect Homebrew inventory; multiple packages match this tool.');
          const { type, row } = matches[0];
          base.type = type;
          base.package = type === 'formula' ? row.full_name ?? row.name : row.full_token ?? row.token;
          base.installed = type === 'formula' && Array.isArray(row.installed) ? row.installed.map(item => item?.version) : [row.installed];
          base.latest = type === 'formula' ? row.versions?.stable : row.version;
          const validVersion = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
          if (!base.installed.length || !base.installed.every(validVersion) || !validVersion(base.latest))
            return unknown('Inspect Homebrew inventory; installed or latest version is incomplete.');
          const stale = (type === 'formula' ? outdated.data.formulae : outdated.data.casks).filter(item =>
            [item.name, item.token, item.full_name, item.full_token].some(name => typeof name === 'string' && [base.package, row.name, row.token].includes(name)));
          if (stale.length > 1 || (stale.length === 1 && (stale[0].current_version !== base.latest ||
            !Array.isArray(stale[0].installed_versions) ||
            JSON.stringify([...stale[0].installed_versions].sort()) !== JSON.stringify([...base.installed].sort()))))
            return unknown('Inspect Homebrew inventory and outdated output; version evidence conflicts.');
          if (!stale.length && base.installed.some(version => version !== base.latest))
            return unknown('Inspect Homebrew inventory and outdated output; freshness is unconfirmed.');
          return { ...base, status: stale.length ? 'outdated' : 'current' };
        });
        for (const tool of tools) {
          if (tool.status === 'outdated' || tool.status === 'unknown') {
            const episode = createHash('sha256').update(JSON.stringify(tool)).digest('hex');
            if (state.episodes[tool.tool] !== episode) {
              await alert({ ...tool, episode, advisory: true,
                diagnostic: tool.diagnostic ?? `Inspect Homebrew package ${tool.package}: installed ${tool.installed.join(', ')}, latest ${tool.latest}. Upgrade manually if appropriate.` });
              state.episodes[tool.tool] = episode;
              await writeState(state);
            }
          } else if (Object.hasOwn(state.episodes, tool.tool)) {
            delete state.episodes[tool.tool];
            await writeState(state);
          }
        }
        state.nextDueAt = now + TOOL_WATCH_INTERVAL_MS;
        await writeState(state);
        return { status: 'checked', nextDueAt: state.nextDueAt, tools };
      });
    },
  });
}
