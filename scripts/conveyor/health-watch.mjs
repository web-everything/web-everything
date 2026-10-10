#!/usr/bin/env node
/**
 * @file scripts/conveyor/health-watch.mjs
 * @description #4077 (health daemon slice 1, ruling #4065) — the IO SHELL of the health watch. Runs the probes,
 *   hands their raw readings to the pure core (we:scripts/conveyor/health-watch-core.mjs), and writes back the
 *   episode store, the per-episode reports and the last-tick-completed stamp. Resident via one
 *   `health-watch` entry in we:skills-src/conveyor/daemon-manifest.mjs (pass-daemon runs `tick` every 5 min).
 *
 * READ-ONLY toward the fleet: it reads daemon logs, lease files, self-sync alerts, the lane-pool health lines,
 * `gh pr list` and `claude agents --json`, and runs only declared read-only diagnoses. It never dispatches,
 * notifies, files or edits anything but its own state dir. Ships in SHADOW mode (4065): what it WOULD notify /
 * dispatch is written into each report under "Held back". The ONE exception, off by default (#4078): with config
 * `investigateDispatch: true` it dispatches a diagnose-only investigation agent per episode and stops it at its
 * wall clock — see we:scripts/conveyor/health-investigate-dispatch.mjs.
 *
 * Also archives old finished Claude job folders daily (claudeJobsArchive* config); archives have no retention limit.
 * Also runs the daily temp sweep (we:scripts/conveyor/tmp-sweep.mjs): deletes our own proven-prefix temp entries
 * older than `tmpSweepOlderThanMs`, skipping any a process has as its cwd. All knobs are `tmpSweep*` config keys.
 * State lives under the pinned daemon state root (#4052, `health-watch-section.mjs#healthDir`, the ONE shared
 *   resolver every reader goes through — see that file's own header): `.conveyor/health/`
 *   state.json          episodes, per-daemon memory, log cursors, gh cache (written only by the tick)
 *   silences.json       tracked-silences (written only by `silence`/`unsilence`; the tick only reads it)
 *   last-tick.json      the last-tick-completed stamp (separate from the pass-daemon lease heartbeat, which
 *                       keeps beating through a hung tick — pass-daemon.mjs:194)
 *   episodes/<id>.md    the durable per-episode report (+ .json)
 *
 * Every child call has a hard timeout; a whole-tick watchdog kills a hung tick and records it, so the next tick
 * raises the `health-tick-overrun` smell.
 *
 * Usage:
 *   node scripts/conveyor/health-watch.mjs tick    [--json] [--force-gh] [--no-gh] [--dry-run] [--state-root=DIR]
 *                                                  [--logs-dir=DIR] [--lock-root=DIR] [--self-sync-dir=DIR]
 *                                                  [--heavy-run-samples-file=FILE]  # ungated heavy-run history fixture
 *                                                  [--ps-fixture=FILE] [--machine-load-fixture=FILE]  # machine-overload's inputs, real by default
 *                                                  [--no-investigate]  # skip the #4078 investigation pass entirely
 *                                                  [--no-file]  # skip the #4079 filing-request planning pass entirely
 *   node scripts/conveyor/health-watch.mjs claude-jobs-archive [--dry-run] [--json] [--claude-jobs-root=DIR] [--claude-jobs-archive-root=DIR]
 *   node scripts/conveyor/health-watch.mjs tmp-sweep [--dry-run] [--json] [--tmp-sweep-root=DIR]
 *   node scripts/conveyor/health-watch.mjs section [--state-root=DIR]      # the HEALTH section (operator queue)
 *   node scripts/conveyor/health-watch.mjs silence --smell=ID [--subject=S] --card=NNN [--hours=72]
 *   node scripts/conveyor/health-watch.mjs unsilence --smell=ID [--subject=S]
 */
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { sealDueBatches } from '../operations/card-batch-seal-io.mjs';
import { readFixLoopRows } from './fix-loop-ledger.mjs';
import { cachedClaudeAgents } from '../lib/claude-agents-cache.mjs';
import { archiveClaudeJobs, formatClaudeJobsArchiveLine } from './claude-jobs-archive.mjs';
import { sweepOurTmp, readBusyTopLevel, formatTmpSweepLine } from './tmp-sweep.mjs';
import { fetchPrCommits } from '../lib/pr-limit.mjs';
import { readGit } from '../lib/proc-read.mjs';
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, statSync, realpathSync, writeFileSync, renameSync, openSync, readSync, closeSync, unlinkSync,
} from 'node:fs';
import { homedir, loadavg, cpus, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_HEALTH_CONFIG, emptyHealthState, runHealthTick, renderEpisodeReport, renderHealthSection, summarizeDiagnosisOutput, scrubText, scrubDeep, parsePsOutput, MINUTE, HOUR,
} from './health-watch-core.mjs';
import { daemonJobsRoot } from '../operations/run-store.mjs';
import { SMELLS } from './health-smells/index.mjs';
import { readRecentSamples, appendSample, summarizeSample, findUngatedHeavyRuns } from './heavy-run-ungated.mjs';
import { healthDir, healthSectionLines } from './health-watch-section.mjs';
import { runInvestigations } from './health-investigate-dispatch.mjs';
import {
  planFileRequests, recordRequested, readLedgerStrict, writeLedger, spliceFilingSection, withLedgerLock,
} from './health-file-request.mjs';

export { healthDir, healthSectionLines };
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';
import { laneJournalPath, readLaneJournalTail, reconcileLaneJournalEntry } from '../lib/lane-history.mjs';
import { defaultPoolRoot } from '../lib/lane-pool-paths.mjs';
import { laneIndicesIn, poolsWithLanes } from '../lib/lane-pool-scan.mjs';
import { readVerifyMarker } from '../lib/lane-verify.mjs';
// #4317 — the same "which paths are DAEMON clones" registry `guard-lane.mjs`/`guard-bash.mjs` already use, so
// this probe's notion of "a daemon clone" can never drift from the guards'.
import { daemonCloneRoots } from '../lib/daemon-clone-registry.mjs';
import { probeDaemonCloneBranches } from '../lib/daemon-clone-branch-probe.mjs';
import { workspaceOf } from '../lib/automation-home.mjs';
import { probeBuildSessions, probeExternalRuns } from './build-supervision.mjs';
import { probeAndOwnMainCi } from './main-ci-red-io.mjs';
import { collectCredentialInventory, normalizeInventory } from './credential-inventory.mjs';
import { readGithubAppStatus, defaultCachePath } from '../lib/github-app-auth-env.mjs';
import { resolvePrLimit, readLimitState, isGlobalOffNow } from '../lib/pr-limit.mjs';
import { ghThrottleLockRoot, ghThrottleLogPath, budgetProbeArgs } from '../lib/gh-throttle.mjs';
import { persistSpendHours } from '../lib/gh-spend.mjs';
import { readSharedOpenPrs } from '../lib/pr-snapshot.mjs';
import { readClaudeAuthExpiredInfo, readHungInfo } from './hung-session.mjs';
import { readJsonlTail } from '../operations/land-advance-io.mjs';
import { defaultDrainHistoryPath } from '../operations/live-state-io.mjs';
import { readBgIsolationStallInfo } from './bg-isolation-stall.mjs';
import { stuckOnPermissionPrompt } from './health-smells/dispatch-permission-stall.mjs';
import { notifyDesktopChecked } from './branch-sync.mjs';
import { flushDigest, loadQuietSettings } from '../lib/quiet-hours-io.mjs';
import { breaksThrough } from '../lib/quiet-hours.mjs';
import { DAEMON_MANIFEST } from '../../skills-src/conveyor/daemon-manifest.mjs';
import { RUNNER_LOCK_ROOT } from '../../skills-src/conveyor/runner-lock.mjs';
import { collectDaemonStatus } from '../operations/daemon-status-io.mjs';
import { assessDaemonStatus } from '../operations/daemon-status.mjs';
import { readBacklogCards } from '../backlog-stranded-sweep.mjs';
import { readPrEventsStatuses } from '../lib/pr-events.mjs';
import { readSeatCapUsage } from '../operations/review-extra-seats.mjs';
import { runSessionWatchdogPass, resolveSessionWatchdogConfig } from './session-watchdog.mjs';
import { runGhProbeJobs, resolveHealthJobSwitches, GH_GROUP_PROBE_NAMES } from './health-watch-job.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BOOTSTRAP_TAIL_BYTES = 512 * 1024;
export const MAX_READ_BYTES = 2 * 1024 * 1024;
export const GH_CADENCE_MS = 15 * MINUTE;
/** PURE: is a cadence stamped `at` due at `now`, every `everyMs`? A missing, non-numeric or future stamp (a clock
 *  stepped back, or a forged state.json) is due — it must never make a cadence wait out the offset. */
export function cadenceDue(at, now, everyMs = GH_CADENCE_MS) {
  return typeof at !== 'number' || !Number.isFinite(at) || at <= 0 || at > now || now - at >= everyMs;
}
export const CHILD_TIMEOUT_MS = 30_000;

/**
 * quietHours breakthrough tag (card xmvc6oc): a daemon silent long enough is an emergency overnight. The duration
 * is how long the daemon has been SILENT (the smell's own `silentForMs`, from its last tick), never how old the
 * episode is — an episode opens only once the silence already exceeds the threshold, and its age is ~0 on the
 * opening alert, which would hold the very alert the breakthrough exists for. Unknown silence → null (delivered).
 */
export function daemonDownEmergency(ep) {
  if (ep?.smell !== 'daemon-silent') return undefined;
  const ms = ep.measure?.silentForMs;
  const min = ep.measure?.silentForMin; // episodes persisted before `silentForMs` existed
  const downForMs = Number.isFinite(ms) ? Math.max(0, ms) : Number.isFinite(min) ? Math.max(0, min) * MINUTE : null;
  return { kind: 'daemon-down', downForMs };
}

/**
 * Health smells whose episode IS a red main: their alert always breaks through quiet hours (`mainRed` breakthrough).
 * The tag only acts once the smell notifies at all: both are listed in `NOTIFY_EVEN_IN_SHADOW` (the operator-owned
 * list in `health-smells-notify-list.mjs`; operator rulings 2026-10-08 and 2026-10-09), so a red main raises a desktop
 * alert in shadow mode, and this tag makes it break through quiet hours.
 */
export const MAIN_RED_SMELLS = new Set(['pre-existing-red-on-main', 'main-ci-red']);

/**
 * Smells that alert ONCE per break (operator ruling 2026-10-09: one alert per broken main commit). Their subject is
 * the lane's `origin/main` tip, which changes with every merge while main stays red, and the smell reads lane markers
 * that come and go, so a per-subject or per-episode alert would storm. They are sent by their own block in `tick`
 * (not from the plan), once per continuous red window, and retried until delivered.
 */
export const ALERT_ONCE_PER_SUBJECT = new Set(['pre-existing-red-on-main']);

/** A red main whose episodes are separated by less than this is the same break. */
export const MAIN_RED_CONTINUITY_MS = 60 * MINUTE;

/**
 * Should this ALERT_ONCE episode's alert be withheld? PURE. Yes when: `main-ci-red` is already open (it tells the
 * operator about the same break, keyed on the first red commit), or an earlier episode of this smell already DELIVERED
 * its alert and is still open or closed less than {@link MAIN_RED_CONTINUITY_MS} ago (the same continuous red window).
 */
export function isRepeatAlert(ep, state, now) {
  if (!ALERT_ONCE_PER_SUBJECT.has(ep?.smell)) return false;
  const open = Object.values(state?.episodes ?? {});
  if (open.some((e) => e?.smell === 'main-ci-red' && e.status !== 'pending')) return true;
  return [...open, ...(state?.history ?? [])].some((e) => e?.smell === ep.smell && e.id !== ep.id && Number.isFinite(e.alertedAt)
    && (e.closedAt == null || now - e.closedAt < MAIN_RED_CONTINUITY_MS));
}

/**
 * The quietHours breakthrough tag for a health episode's alert, or undefined for a routine one. The real red-main
 * alert is titled `Health: pre-existing-red-on-main — main:<sha>`; it is tagged here rather than left to the title
 * fallback, which only guesses from the wording.
 */
export function breakthroughEmergency(ep) {
  if (MAIN_RED_SMELLS.has(ep?.smell)) return { kind: 'main-red' };
  return daemonDownEmergency(ep);
}

// ── paths ────────────────────────────────────────────────────────────────────────────────────────────────────

export function defaultLogsDir(env = process.env) {
  return env.HEALTH_WATCH_LOGS_DIR || join(homedir(), 'workspace', 'wev-review-daemon', '.conveyor');
}
/** builder-starved — where the build-dispatch daemon writes `build-dispatch-daemon.log` (the coordination root). */
export function defaultBuilderLogDir(env = process.env) {
  return env.HEALTH_WATCH_BUILDER_LOG_DIR || resolveCoordinationRoot();
}
export function defaultSelfSyncDir(env = process.env) {
  return env.HEALTH_WATCH_SELF_SYNC_DIR || join(homedir(), '.claude', 'daemon-self-sync-state');
}

function readJson(path, fallback) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; } }
function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

/** Read bytes [start, end) of a file as a Buffer (bounded). */
export function readRangeBuf(path, start, end) {
  const len = Math.max(0, end - start);
  const buf = Buffer.alloc(len);
  if (!len) return buf;
  const fd = openSync(path, 'r');
  try { readSync(fd, buf, 0, len, start); } finally { closeSync(fd); }
  return buf;
}

/** Read bytes [start, end) of a file (bounded). */
export function readRange(path, start, end) {
  const len = Math.max(0, end - start);
  if (!len) return '';
  const buf = Buffer.alloc(len);
  const fd = openSync(path, 'r');
  try { readSync(fd, buf, 0, len, start); } finally { closeSync(fd); }
  return buf.toString('utf8');
}

// ── probes ───────────────────────────────────────────────────────────────────────────────────────────────────

/** PURE-ish: the part of a just-rotated `<log>.1` we had not read (from byte `from`, whole lines only), capped. */
export function readRotatedTail(path, from) {
  try {
    const size = statSync(path).size;
    if (size <= from) return '';
    const start = Math.max(from, size - MAX_READ_BYTES);
    const text = readRangeBuf(path, start, size).toString('utf8');
    return start > from ? text.slice(text.indexOf('\n') + 1) : text;
  } catch { return ''; }
}

/** IO: the rotation counter the daemon's rotator keeps in `<log>.rot`; null when absent or unreadable (an older daemon). */
export function readRotationCount(logPath) {
  try { const n = Number(readFileSync(`${logPath}.rot`, 'utf8').trim()); return Number.isInteger(n) && n >= 0 ? n : null; } catch { return null; }
}
/** A `<log>.1` this young may be a rotation whose counter bump has not landed yet. */
const ROTATION_IN_FLIGHT_MS = 5000;

/** Incrementally read every `*.log` in the daemon logs dir from its cursor (bootstrap: the last 512 KB). */
export function probeDaemonLogs(logsDir, cursors = {}, { only = null } = {}) {
  const out = [];
  const nextCursors = {};
  if (!existsSync(logsDir)) return { samples: out, cursors: nextCursors };
  // builder-starved — `only` reads just the named logs (the build-dispatch daemon logs to the coordination root).
  for (const f of readdirSync(logsDir).filter((n) => n.endsWith('.log') && (!only || only.includes(n.replace(/\.log$/, '')))).sort()) {
    const path = join(logsDir, f);
    const name = f.replace(/\.log$/, '');
    const st = statSync(path);
    const cur = cursors[name];
    // A rotation REPLACES `<log>.1` (copied, then renamed into place), so `<log>.1`'s own identity (inode + mtime)
    // is the evidence that does not depend on the daemon: it changes on every rotation, and on nothing else — a
    // manual truncation leaves it alone, so a stale `<log>.1` is never replayed. The rotator also bumps `<log>.rot`
    // after the log is emptied; a moved counter says the same thing sooner and survives a regrown log. Either one
    // means a rotation completed. A cursor from before `one` existed has no identity to compare, so it falls back to
    // the older rule (a shrink, with no counter on one side).
    const rot = readRotationCount(path);
    const hasOne = existsSync(`${path}.1`);
    let one = null;
    if (hasOne) { try { const s1 = statSync(`${path}.1`); one = `${s1.ino}:${s1.mtimeMs}`; } catch { /* vanished */ } }
    const sameFile = !!cur && cur.ino === st.ino;
    const shrank = sameFile && st.size < cur.size;
    const bothCounted = typeof rot === 'number' && typeof cur?.rot === 'number';
    const oneKnown = !!cur && cur.one !== undefined;
    const counted = sameFile && hasOne && (bothCounted ? rot !== cur.rot : rot != null && cur.rot == null);
    const replaced = sameFile && hasOne && oneKnown && cur.one !== one;
    // The rotator empties the log BEFORE it bumps the counter: a brand-new `<log>.1` with no counter move yet is a
    // rotation mid-flight, so hold the cursor and read nothing; the next sample sees the counter move (a daemon whose
    // counter never moves — an older one, or a failed bump — just waits out the few seconds, then `replaced` below
    // takes it). Reading now would replay `<log>.1` twice, once here and once when the counter lands.
    if (!counted && sameFile && hasOne && (replaced || (!oneKnown && shrank)) && Date.now() - statSync(`${path}.1`).mtimeMs < ROTATION_IN_FLIGHT_MS) {
      out.push({ name, mtimeMs: st.mtimeMs, sizeBytes: st.size, text: '', bootstrap: false, defaultIntervalMs: DAEMON_MANIFEST[name]?.intervalMs });
      nextCursors[name] = cur;
      continue;
    }
    const rotated = counted || replaced || (sameFile && hasOne && shrank && !oneKnown && !bothCounted);
    const bootstrap = !cur || cur.ino !== st.ino || (st.size < cur.size && !rotated);
    // 68b: copy-truncate rotation keeps the inode but shrinks the file; what we had not read yet is the tail of
    // `<log>.1`, so read it first and then the fresh file from the top, losing no refusal lines.
    // After n rotations since the cursor, the file it pointed at is `<log>.n` (read from its offset); the newer
    // `<log>.(n-1)` .. `<log>.1` were never read at all (read from the top). A rotation older than `keep` is gone.
    // A cursor with no counter was taken before any rotation was counted (no `<log>.rot` yet), so the counter IS the
    // number of rotations since.
    const nRot = !rotated ? 1 : bothCounted && rot > cur.rot ? rot - cur.rot : cur.rot == null && rot != null && rot > 0 ? rot : 1;
    let rotatedTail = '';
    if (rotated) for (let k = nRot; k >= 1; k -= 1) rotatedTail += readRotatedTail(`${path}.${k}`, k === nRot ? cur.size : 0);
    let start = bootstrap ? Math.max(0, st.size - BOOTSTRAP_TAIL_BYTES) : rotated ? 0 : cur.size;
    if (st.size - start > MAX_READ_BYTES) start = st.size - MAX_READ_BYTES;
    // Consume only through the LAST complete line: a line still being written (no trailing newline yet) is left
    // for the next sample, so a refusal split across two reads is parsed whole, never dropped.
    const buf = readRangeBuf(path, start, st.size);
    const lastNl = buf.lastIndexOf(0x0a);
    const consumed = lastNl === -1 ? 0 : lastNl + 1;
    let text = buf.subarray(0, consumed).toString('utf8');
    if (start > 0 && (bootstrap || start !== cur?.size)) text = text.slice(text.indexOf('\n') + 1); // drop a partial first line
    if (rotatedTail) text = rotatedTail + text;
    const passName = name;
    out.push({ name, mtimeMs: st.mtimeMs, sizeBytes: st.size, text, bootstrap, defaultIntervalMs: DAEMON_MANIFEST[passName]?.intervalMs });
    nextCursors[name] = { ino: st.ino, size: start + consumed, rot, one };
  }
  return { samples: out, cursors: nextCursors };
}

/** Run records older than this are never read: the smells that consume them look back 6 h at most. */
export const OPERATION_RUNS_MAX_AGE_MS = 7 * 3_600_000;
/** A single run record bigger than this is skipped (live review runs reach ~4 MB; nothing legitimate is 8x that). */
export const OPERATION_RUNS_MAX_FILE_BYTES = 8 * 1024 * 1024;
/** At most this many (newest) records are parsed per tick, whatever the directories hold. */
export const OPERATION_RUNS_MAX_RECORDS = 1500;
/** At most this many bytes of record text are parsed per tick, so the tick's memory is bounded by a constant. */
export const OPERATION_RUNS_MAX_TOTAL_BYTES = 192 * 1024 * 1024;

/**
 * Local run evidence only; fixture ticks never inspect host records. BOUNDED: the run directories grow without
 * limit (live: ~80,000 records, several GB, across the clone roots), and reading them all OOM-killed the tick. So
 * only stat each entry (cheap), keep the newest records inside the look-back window, and parse at most
 * `maxRecords` / `maxTotalBytes` of them. Directories are de-duplicated by real path (a symlinked checkout).
 */
export function probeOperationRuns({
  roots = [REPO_ROOT, ...daemonCloneRoots(workspaceOf(REPO_ROOT))], jobsRoot = daemonJobsRoot(),
  nowMs = Date.now(), maxAgeMs = OPERATION_RUNS_MAX_AGE_MS, maxFileBytes = OPERATION_RUNS_MAX_FILE_BYTES,
  maxRecords = OPERATION_RUNS_MAX_RECORDS, maxTotalBytes = OPERATION_RUNS_MAX_TOTAL_BYTES,
} = {}) {
  const dirs = roots.map((root) => join(root, '.operations', 'runs'));
  if (jobsRoot && existsSync(jobsRoot)) {
    for (const entry of readdirSync(jobsRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(join(jobsRoot, entry.name));
    }
  }
  const real = new Set();
  const candidates = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let key = dir;
    try { key = realpathSync(dir); } catch { /* keep the given path */ }
    if (real.has(key)) continue;
    real.add(key);
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const path = join(dir, name);
      let st;
      try { st = statSync(path); } catch { continue; }
      if (nowMs - st.mtimeMs > maxAgeMs || st.size > maxFileBytes) continue;
      candidates.push({ path, mtimeMs: st.mtimeMs, size: st.size });
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const records = [];
  let bytes = 0;
  for (const c of candidates) {
    if (records.length >= maxRecords || bytes + c.size > maxTotalBytes) break;
    const rec = readJson(c.path, null);
    bytes += c.size;
    if (rec) records.push(rec);
  }
  return records;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

/** Every daemon lease under the runner lock root, mapped to its log name in the logs dir. */
export function probeLeases(lockRoot, logNames) {
  const out = [];
  if (!existsSync(lockRoot)) return out;
  for (const d of readdirSync(lockRoot)) {
    const lock = readJson(join(lockRoot, d, 'lock.json'), null);
    if (!lock?.owner) continue;
    const role = String(lock.owner).split(':').slice(2).join(':');
    const base = role.startsWith('pass-daemon:') ? role.slice('pass-daemon:'.length) : role;
    const log = [base, base.replace(/^reconcile-/, '')].find((n) => logNames.has(n)) ?? base;
    out.push({ log, role, pid: lock.pid, pidAlive: pidAlive(lock.pid), heartbeatAt: Date.parse(lock.heartbeatAt || '') || null });
  }
  // One lease per daemon: lease dirs are keyed per clone path, so an older clone's dead lease can linger beside
  // the live one (seen live: 3 dead review-daemon leases, days old). The freshest heartbeat is the daemon.
  const best = new Map();
  for (const l of out) {
    const cur = best.get(l.log);
    if (!cur || (l.heartbeatAt ?? 0) > (cur.heartbeatAt ?? 0)) best.set(l.log, l);
  }
  return [...best.values()];
}

/** A launchd label → the name its log/memory is keyed by here (`com.we.fix-dispatch-daemon` → `fix-dispatch-daemon`,
 *  `com.we.conveyor-pass-daemon.merge-orphan-sweep` → `merge-orphan-sweep`, `com.plateau.drain-daemon` →
 *  `plateau-drain-daemon`). */
export function daemonNameForLabel(label) {
  return String(label).replace(/^com\.we\.(conveyor-pass-daemon\.)?/, '').replace(/^com\.plateau\./, 'plateau-');
}

/**
 * The daemon inventory + liveness, from the declared `daemon-status` read (#4067) — launchd discovery, the
 * lease heartbeat, and each daemon's own last-tick record — instead of re-deriving it. Mapped to the `leases`
 * shape the smells read. `lastActivityAt` carries daemon-status's own timestamp for a daemon whose log this
 * watch does not read (the plateau drain daemon). Every launchctl/plutil child call gets a hard timeout.
 *
 * `intervalMs` — the SAME `DAEMON_MANIFEST[name]?.intervalMs` the `daemonLogs` probe already attaches to a
 * sample as `defaultIntervalMs` (see `probeDaemonLogs` above), looked up here too and carried on the lease.
 * Root cause (2026-09-27, live `daemon-silent` false-positive FLAPPING on `merge-orphan-sweep`, open 36h+):
 * that pass now runs from its OWN dedicated clone (`wev-merge-daemon`, #3383's daemon split — a daemon that
 * writes to `main` gets its own clone), so its log never appears under this watch's single `defaultLogsDir()`
 * (`wev-review-daemon/.conveyor`) and `daemon-silent.mjs`'s primary `daemons[lease.log]` memory is never built
 * for it. It falls back to a synthetic memory built ONLY from this lease — and that fallback used to hardcode
 * `intervalMs: 120_000` (2 minutes) regardless of the daemon's REAL configured cadence, so a perfectly healthy
 * daemon on a slower cadence (merge-orphan-sweep's is 15 minutes — `MERGE_ORPHAN_SWEEP_INTERVAL_MS` in
 * `daemon-manifest.mjs`) tripped the fallback's fixed 10-minute silence threshold on every ordinary tick gap,
 * flapping open/closed forever. Carrying the real interval here lets `daemon-silent.mjs`'s fallback scale its
 * threshold the same way the primary path already does — `null` for a daemon `DAEMON_MANIFEST` does not cover
 * (every resident daemon that is not a `pass-daemon.mjs` watcher), which the smell already treats as "use the
 * generic default".
 */
export function probeDaemonStatus({ collect = collectDaemonStatus, assess = assessDaemonStatus, timeoutMs = 15_000 } = {}) {
  const exec = (cmd, args, opts = {}) => execFileSync(cmd, args, { ...opts, timeout: timeoutMs });
  const read = assess(collect({ exec }));
  return read.daemons.filter((d) => d.readable !== false).map((d) => {
    const ms = (v) => (v == null ? null : typeof v === 'number' ? v : Date.parse(v) || null);
    const entry = d.lease?.entry ?? null;
    const activity = [ms(d.tick?.lastActivityAt), ms(d.tick?.at), ms(d.tick?.logMtimeMs)].filter(Number.isFinite);
    const log = daemonNameForLabel(d.name);
    return {
      log,
      role: d.kind ?? null,
      pid: entry?.pid ?? null,
      pidAlive: !!d.running,
      heartbeatAt: ms(entry?.heartbeatAt),
      lastActivityAt: activity.length ? Math.max(...activity) : null,
      daemonState: d.state,
      headline: d.headline,
      intervalMs: DAEMON_MANIFEST[log]?.intervalMs ?? null,
    };
  });
}

/**
 * Which of these backlog card ids are `status: active` — read from each card file's own frontmatter (the
 * backlog is the tracker). Missing/unreadable cards are simply not active.
 * @returns {Set<string>}
 */
export function readActiveCards(ids, backlogDir) {
  const out = new Set();
  if (!ids.length || !existsSync(backlogDir)) return out;
  const files = readdirSync(backlogDir);
  for (const id of new Set(ids.map(String))) {
    const f = files.find((n) => n.startsWith(`${id}-`) && n.endsWith('.md'));
    if (!f) continue;
    try {
      const head = readFileSync(join(backlogDir, f), 'utf8').slice(0, 2000);
      if (/^status:\s*active\s*$/m.test(head)) out.add(id);
    } catch { /* unreadable → not active */ }
  }
  return out;
}

/** Self-sync alerts + rebuild state per daemon clone key. */
export function probeSelfSync(dir) {
  if (!existsSync(dir)) return [];
  const keys = new Set(readdirSync(dir).map((f) => f.split('.')[0]).filter(Boolean));
  return [...keys].sort().map((cloneKey) => {
    const alertsPath = join(dir, `${cloneKey}.alerts.jsonl`);
    let alerts = [];
    if (existsSync(alertsPath)) {
      const st = statSync(alertsPath);
      const text = readRange(alertsPath, Math.max(0, st.size - 256 * 1024), st.size);
      alerts = text.split('\n').slice(-400).map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean).map((a) => ({ ...a, at: Date.parse(a.at || '') || null }));
    }
    const rb = readJson(join(dir, `${cloneKey}.rebuild.json`), null);
    const rebuild = rb ? {
      adopted: rb.adopted ? { ...rb.adopted, at: Date.parse(rb.adopted.at || '') || null } : null,
      rejected: rb.rejected ?? null,
      quarantine: rb.quarantine ?? null,
      inProgress: rb.inProgress ? { ...rb.inProgress, startedAt: Date.parse(rb.inProgress.startedAt || '') || null } : null,
      // x5wbsbc: a failed live smoke keeps the clone on its last-good build instead of blocking delivery —
      // `daemon-rebuild.mjs`'s `hold`/`smokeAndAdopt` write this; `since` parsed the same way `adopted.at`/
      // `inProgress.startedAt` are (`Date.parse`, `null` when invalid — an epoch-0 string included, same style).
      held: rb.held ? { ...rb.held, since: Date.parse(rb.held.since || '') || null } : null,
    } : null;
    return { cloneKey, alerts, rebuild };
  });
}

/**
 * `clone-behind-main` probe: for every daemon clone, how far HEAD trails origin/main and since when. Objects are read
 * from this checkout after a best-effort fetch; a clone whose HEAD is not an ancestor of main (overlay) or whose
 * HEAD this checkout cannot see is skipped, never guessed.
 */
export function probeCloneLag({ roots = daemonCloneRoots(workspaceOf(REPO_ROOT)), exec = run, fetch = true, timeoutMs = 20_000, repo = REPO_ROOT } = {}) {
  const git = (args, cwd = repo) => String(exec('git', ['-C', cwd, ...args], { timeoutMs }) || '').trim();
  if (fetch) { try { git(['fetch', '--quiet', 'origin', 'main']); } catch { /* use the ref we have */ } }
  const tip = git(['rev-parse', 'origin/main']);
  const out = [];
  for (const cloneRoot of roots) {
    let head;
    try { head = git(['rev-parse', 'HEAD'], cloneRoot); } catch { continue; }
    if (head === tip) { out.push({ cloneRoot, head: head.slice(0, 9), behind: 0, behindSinceMs: null }); continue; }
    try {
      git(['merge-base', '--is-ancestor', head, tip]);
      const times = git(['log', '--reverse', '--format=%ct', `${head}..${tip}`]).split('\n').filter(Boolean);
      out.push({ cloneRoot, head: head.slice(0, 9), behind: times.length, behindSinceMs: times.length ? Number(times[0]) * 1000 : null });
    } catch { /* not an ancestor of main / head unknown here — skip */ }
  }
  return out;
}

/**
 * #4200-ish (gh-shim-lane-path) — every generated `gh` shim under `~/.claude/github-app-token/` (the legacy
 * shared `gh-shim/gh` plus each per-checkout `gh-shim.d/<hash>/gh` — see `scripts/lib/gh-app-shim.mjs`), scanned
 * for a baked `GH_THROTTLE_CLI`/`REAL_GH` path pointing INTO a lane clone (`.lanes/`). The lane pool resets,
 * recycles and deletes lane clones the moment their own PR lands — a shim baked with a lane path breaks EVERY
 * gh call routed through it the instant that lane goes away, silently, with no warning until something tries
 * to call `gh` (live: a shim found hard-coding `.../.lanes/web-everything/lane-22/scripts/lib/gh-throttle.mjs`).
 * This smell exists to catch that BEFORE the lane resets, not after. READ-ONLY toward the token store: reads
 * only the generated shim SCRIPTS themselves (baked-in paths, never a secret) — never `web-everything.json`
 * (the token cache) alongside them.
 */
export function probeGhShimLanes({ home = homedir(), exists = existsSync, readdir = readdirSync, readFile = readFileSync } = {}) {
  const root = join(home, '.claude', 'github-app-token');
  const shimPaths = [];
  const legacy = join(root, 'gh-shim', 'gh');
  if (exists(legacy)) shimPaths.push(legacy);
  const dDir = join(root, 'gh-shim.d');
  if (exists(dDir)) {
    for (const entry of readdir(dDir)) {
      const p = join(dDir, entry, 'gh');
      if (exists(p)) shimPaths.push(p);
    }
  }
  const laneLike = (v) => typeof v === 'string' && /\/\.lanes\//.test(v);
  return shimPaths.map((p) => {
    let src = '';
    try { src = readFile(p, 'utf8'); } catch { /* unreadable — reports as no baked path found, never throws */ }
    const throttleCli = src.match(/const GH_THROTTLE_CLI = "([^"]*)"/)?.[1] ?? null;
    const realGh = src.match(/const REAL_GH = "([^"]*)"/)?.[1] ?? null;
    return { path: p, throttleCli, realGh, inLane: laneLike(throttleCli) || laneLike(realGh) };
  });
}

/**
 * #4317 — every KNOWN daemon clone's own untracked `backlog/x*.md` file, aged past `agedMs`. Real
 * `git status --porcelain --untracked-files=all -- backlog` per clone root (never `--untracked-files=no`,
 * unlike the daemon rebuild's own dirty check — that check deliberately IGNORES untracked files so a sidecar
 * never blocks a rebuild; this probe exists BECAUSE that means nothing else ever surfaces one). A clone root
 * that no longer exists, or is not a real git checkout, is silently skipped — this probe never fails the tick
 * over a clone that has since been torn down.
 *
 * `agedMs` (default 15 min, matching `clone-stale.mjs`'s own `recentMs`) is the grace period: a card can sit
 * untracked for the few seconds/minutes a real filing pipeline takes before it commits, and that must never
 * read as a breach. Filtering happens HERE, in the probe, not in the smell's `evaluate` — the smell simply
 * reports whatever this function still sees.
 *
 * @param {{roots?: string[], exec?: Function, timeoutMs?: number, stat?: Function, now?: number, agedMs?: number}} [o]
 * @returns {Array<{cloneRoot: string, rel: string, mtimeMs: number}>}
 */
export function probeUntrackedBacklogCards({
  roots = daemonCloneRoots(workspaceOf(REPO_ROOT)),
  exec = run,
  timeoutMs = 15_000,
  stat = statSync,
  now = Date.now(),
  agedMs = 15 * MINUTE,
} = {}) {
  const out = [];
  for (const root of roots) {
    let status;
    try {
      status = exec('git', ['-C', root, 'status', '--porcelain', '--untracked-files=all', '--', 'backlog'], { timeoutMs });
    } catch {
      continue; // not a real checkout (any more), or `git` itself failed — nothing to report for this root
    }
    const lines = String(status || '').split('\n').map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      const m = /^\?\?\s+backlog\/(x[0-9a-z]{6}-.*\.md)$/.exec(line);
      if (!m) continue; // tracked/modified/deleted entries, and any non-hash-id backlog path, are out of scope
      const rel = `backlog/${m[1]}`;
      let mtimeMs;
      try { mtimeMs = stat(join(root, rel)).mtimeMs; } catch { continue; } // gone between status + stat
      if (now - mtimeMs >= agedMs) out.push({ cloneRoot: root, rel, mtimeMs });
    }
  }
  return out;
}

/** The last `{"checked":true,"health":{…}}` line each lane-pool-health-watch log printed. */
export function probeLanePools(logsDir) {
  const out = [];
  for (const key of Object.keys(CONSTELLATION_REPOS)) {
    const path = join(logsDir, `lane-pool-health-watch-${key}.log`);
    if (!existsSync(path)) continue;
    const st = statSync(path);
    const text = readRange(path, Math.max(0, st.size - 512 * 1024), st.size);
    // #4370 — `workerWithoutLease` (lane numbers with a live worker but no lease) rides right after `health`
    // on the same line; absent on a line written before #4370 or on a tick whose whois scan did not run.
    const matches = [...text.matchAll(/\{"checked":true,"health":(\{[^}]*\})(?:,"workerWithoutLease":(\[[\d,]*\]|null))?/g)];
    if (!matches.length) continue;
    try {
      const last = matches.at(-1);
      const reading = { repo: key, health: JSON.parse(last[1]), at: st.mtimeMs };
      if (last[2] && last[2] !== 'null') reading.workerWithoutLease = JSON.parse(last[2]);
      out.push(reading);
    } catch { /* skip */ }
  }
  return out;
}

/**
 * The `fixer-verify-never-settles` smell's input (live 2026-10-04): every lane whose verify marker is `running`,
 * with the lane's own HEAD, so the smell can tell a request nothing ever picked up (or a dispatched run that
 * outlived every ceiling) from a normal in-flight gate. Only `running` markers pay for the `git rev-parse`;
 * every other lane is one small file read. Never throws on a non-directory pool-root entry (shared walk).
 * @returns {Array<{pool:string, lane:number, sha:string|null, head:string|null, startedAt:string|null, runId:string|null, suites:string|null}>}
 */
export function probeLaneVerifyMarkers({ poolRoot, readHead } = {}) {
  if (!poolRoot) return [];
  const head = readHead || ((dir) => { try { return readGit(['rev-parse', 'HEAD'], { cwd: dir, timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } });
  const out = [];
  for (const pool of poolsWithLanes(poolRoot)) {
    for (const lane of laneIndicesIn(join(poolRoot, pool))) {
      const dir = join(poolRoot, pool, `lane-${lane}`);
      let marker;
      try { marker = readVerifyMarker(join(dir, '.git')); } catch { continue; }
      if (!marker || marker.corrupt) continue;
      // Perf 42 — a red marker whose failures all reproduce on origin/main (read by `pre-existing-red-on-main`).
      if (marker.status === 'red' && marker.redCause === 'pre-existing-on-main') {
        out.push({ pool, lane, sha: marker.sha ?? null, head: head(dir), status: 'red', redCause: marker.redCause, redCauseEvidence: marker.redCauseEvidence ?? null, finishedAt: marker.finishedAt ?? null });
        continue;
      }
      if (marker.status !== 'running') continue;
      out.push({ pool, lane, sha: marker.sha ?? null, head: head(dir), startedAt: marker.startedAt ?? null, runId: marker.runId ?? null, suites: marker.suites ?? null });
    }
  }
  return out;
}

/**
 * #4370 — the `lane-destructive-unpushed` smell's input: the recent tail of every pool's lane lifecycle journal
 * (`<poolRoot>/<pool>/.lane-journal.jsonl`), entries newer than `windowMs` only. Rechecks candidate commits against local remote refs. `[]` when no
 * pool has a journal yet.
 * @returns {Array<{pool:string, entries:Array<object>}>}
 */
export function probeLaneJournal({ poolRoot, now = Date.now(), windowMs = 24 * 60 * MINUTE } = {}) {
  if (!poolRoot || !existsSync(poolRoot)) return [];
  const out = [];
  for (const pool of readdirSync(poolRoot)) {
    const poolDir = join(poolRoot, pool);
    if (!existsSync(laneJournalPath(poolDir))) continue;
    const entries = readLaneJournalTail(poolDir).filter((e) => {
      const t = Date.parse(e?.ts);
      return Number.isFinite(t) && now - t <= windowMs;
    });
    out.push({ pool, entries: entries.map((e) => Number.isInteger(e.lane)
      ? reconcileLaneJournalEntry(join(poolDir, `lane-${e.lane}`), e) : e) });
  }
  return out;
}

function run(cmd, args, { timeoutMs = CHILD_TIMEOUT_MS, cwd = REPO_ROOT } = {}) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** `machine-overload`'s own process snapshot: every live process, BSD/macOS `ps` column order
 *  `pid,ppid,pcpu,etime,command` (parsed by the pure {@link parsePsOutput}). `--ps-fixture=FILE` (tick()) reads
 *  this same column order from a file instead — the incident-reproduction path (no load generator is ever run
 *  to test this smell). */
export function probeProcesses({ exec = run } = {}) {
  return parsePsOutput(exec('ps', ['-Ao', 'pid,ppid,pcpu,etime,command'], { timeoutMs: 15_000 }));
}

/** `machine-overload`'s own load signal: `os.loadavg()` (1/5/15 min) + core count, so the smell can normalize
 *  loadavg to "per core". `--machine-load-fixture=FILE` (tick()) reads `{load1,load5,load15,cpuCount}` JSON
 *  instead — real `os.loadavg()` right now reads whatever this machine's normal load is, never the incident. */
export function probeMachineLoad({ getLoadAvg = loadavg, getCpuCount = () => cpus().length } = {}) {
  const [load1, load5, load15] = getLoadAvg();
  return { load1, load5, load15, cpuCount: Math.max(1, getCpuCount()) };
}

/** `gh-call-failures`' input: the TAIL (last `maxBytes`) of gh-throttle's sidecar `calls.jsonl`, parsed. The
 *  file grows unbounded (14MB live), so only the tail is read; a torn first line is skipped. `[]` if absent. */
export function probeGhCalls({ logPath = ghThrottleLogPath(ghThrottleLockRoot()), maxBytes = 2 * 1024 * 1024 } = {}) {
  if (!existsSync(logPath)) return [];
  const size = statSync(logPath).size;
  const len = Math.min(size, maxBytes);
  const buf = Buffer.alloc(len);
  const fd = openSync(logPath, 'r');
  try { readSync(fd, buf, 0, len, size - len); } finally { closeSync(fd); }
  const out = [];
  for (const line of buf.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* torn first line / partial write */ }
  }
  return out;
}

/** `gh-graphql-budget`'s input: the App installation's REAL GraphQL bucket (the in-band `rateLimit` field — never
 *  the REST `/rate_limit` endpoint, whose `graphql` entry disagreed with it live) plus the throttle's active
 *  shared budget-block records. 1 GraphQL point per tick. */
/** #4309 — the hourly GitHub-spend persistence step `tick` runs alongside {@link probeGhCalls}: rolls every fully
 *  closed hour of `calls.jsonl` into `spend-hourly.jsonl` (next to the log) through gh-spend.mjs's own cursor. */
export function persistGhSpend({ logPath = ghThrottleLogPath(ghThrottleLockRoot()), now = Date.now(), persist = persistSpendHours } = {}) {
  return persist({ logPath, now });
}

export function probeGraphqlBudget({ exec = run, lockRoot = ghThrottleLockRoot(), nowMs = Date.now() } = {}) {
  let sample = null;
  try {
    const raw = exec('gh', budgetProbeArgs('graphql'));
    const j = JSON.parse(String(raw || '{}'))?.data?.rateLimit;
    if (j && typeof j.remaining === 'number') sample = { remaining: j.remaining, limit: typeof j.limit === 'number' ? j.limit : null, resetAt: j.resetAt || null };
  } catch { sample = null; }
  const blocks = [];
  try {
    for (const f of readdirSync(lockRoot)) {
      if (!/^budget-block-.*\.json$/.test(f)) continue;
      try { const b = JSON.parse(readFileSync(join(lockRoot, f), 'utf8')); if (Number.isFinite(b?.untilMs) && b.untilMs > nowMs) blocks.push(b); } catch { /* torn */ }
    }
  } catch { /* no lock root yet */ }
  return { sample, blocks };
}

/** #4066 `open-prs-over-limit`'s input: the open-PR backpressure limit per repo key and whether the operator has
 *  it globally off — both read through `we:scripts/lib/pr-limit.mjs`'s own resolvers, never re-derived. */
export function probePrLimit({ env = process.env, readState = readLimitState, nowMs = Date.now() } = {}) {
  const limits = Object.fromEntries(Object.keys(CONSTELLATION_REPOS).map((k) => [k, resolvePrLimit(k, env)]));
  const globalOff = String(env.WE_PR_LIMIT_OFF || '') === '1' || isGlobalOffNow(readState(), nowMs);
  return { limits, globalOff };
}

/** #4066 `github-app-token`'s cache read: ONLY `expiresAt` from the shared App token cache — the token itself is
 *  never read into the health process. `{present:false}` when there is no cache (App auth not configured). */
export function probeAppToken({ path = defaultCachePath(), readFile = readFileSync, exists = existsSync } = {}) {
  if (!exists(path)) return { present: false };
  let expiresAt = null;
  try { expiresAt = JSON.parse(readFile(path, 'utf8'))?.expiresAt ?? null; } catch { expiresAt = null; }
  return { present: true, expiresAt: typeof expiresAt === 'string' ? expiresAt : null };
}

/** #4066 `github-app-token`'s REST headroom: `gh api rate_limit` `.resources.core` (`{limit, used, remaining,
 *  reset}`). The rate_limit endpoint itself is free — it does not count against the bucket it reports. */
export function probeRestBudget({ exec = run } = {}) {
  const j = JSON.parse(String(exec('gh', budgetProbeArgs('core'), { timeoutMs: 15_000 }) || '{}'));
  return { limit: j?.limit ?? null, used: j?.used ?? null, remaining: j?.remaining ?? null, reset: j?.reset ?? null };
}

export function probePrs({ exec = run, readCommits = fetchPrCommits, now = Date.now() } = {}) {
  const out = [];
  for (const { slug } of Object.values(CONSTELLATION_REPOS)) {
    // #gh-graphql-budget — the host-shared open-PR snapshot when this is the real `run` (never a test's fake exec).
    // `isDraft` (draft-first PRs, operator-approved 2026-09-27) — already part of `SNAPSHOT_FIELDS`, added here
    // so the `draft-not-promoted` smell can read it; the shared-cache path costs nothing extra for it.
    // #4066 — `mergeable` + `comments` for the queue smells: `pr-stage-stall` classifies stages the stuck-PR
    // watch's own way (needs `mergeable`) and reads its markers off the thread; `stood-down-prs` counts the
    // stand-down markers. Both are already in the shared snapshot's field set, so the snapshot path costs nothing extra.
    const fields = 'number,title,headRefName,headRefOid,labels,statusCheckRollup,updatedAt,isDraft,mergeable,comments';
    const shared = exec === run ? readSharedOpenPrs({ repo: slug, fields }) : null;
    const listed = shared || JSON.parse(exec('gh', ['pr', 'list', '--repo', slug, '--state', 'open', '--limit', '100', '--json', fields]));
    const rows = Array.isArray(listed) ? listed : []; // a throttle deferral object = skip this repo's PR smells this pass
    for (const pr of rows) {
      // Snapshot rows may be cached. Only a successful fresh provider read counts for this smell — and only a PR
      // whose cached labels hold no `review:*` label can be in breach, so a labelled PR costs no per-PR call
      // (the shared snapshot stays the budgeted path for the common case). The labelled row still reports a clean
      // observation from those cached labels, so an open `review-label-missing` episode CLOSES once the label is
      // restored (the smell ignores absent subjects); a stale cache can only delay detecting a NEW breach by one
      // snapshot refresh, never report a false one.
      let reviewObservation = null;
      const cachedReviewLabelled = Array.isArray(pr.labels) && pr.labels.some(l => typeof l?.name === 'string' && l.name.startsWith('review:'));
      if (cachedReviewLabelled) reviewObservation = { state: 'OPEN', labels: pr.labels.map(l => ({ name: l?.name })), commits: [], observedAt: now, cached: true };
      else try {
        const live = JSON.parse(exec('gh', ['pr', 'view', String(pr.number), '--repo', slug, '--json', 'state,labels,headRefOid,headRefName,baseRefName']));
        if (live && !Array.isArray(live)) reviewObservation = { ...live, observedAt: now,
          commits: readCommits(slug, pr.number, { headRefName: live.headRefName, headRefOid: live.headRefOid, baseRefName: live.baseRefName,
            ...(exec !== run ? { exec: args => exec('gh', args) } : {}) }) };
      } catch { /* Unknown, not a clean observation. */ }
      out.push({
        reviewObservation,
        repo: slug, number: pr.number, title: pr.title, headRefName: pr.headRefName, headRefOid: pr.headRefOid ?? null, updatedAt: pr.updatedAt,
        isDraft: !!pr.isDraft,
        mergeable: pr.mergeable ?? null,
        // Only what the marker readers need (leading line, time, trusted author) — never the whole comment record.
        comments: (pr.comments || []).map((c) => ({
          body: c.body, createdAt: c.createdAt, author: { login: c.author?.login ?? null }, viewerDidAuthor: c.viewerDidAuthor,
        })),
        labels: Array.isArray(pr.labels) ? pr.labels.map(l => ({ name: l?.name })) : [],
        labelsValid: Array.isArray(pr.labels) && pr.labels.every(l => l && typeof l.name === 'string' && l.name.length > 0),
        // `status` (draft-first PRs, operator-approved 2026-09-27) — carried alongside `state`/`conclusion` so
        // `we:scripts/operations/pr-status.mjs#reduceCheckState` (the `draft-not-promoted` smell's own green
        // check) reads the SAME completion signal every other CI-truth consumer in this repo does off a raw
        // `gh pr view --json statusCheckRollup` CheckRun entry (`status`+`conclusion`) — omitting it here would
        // have every real GitHub-Actions check (CheckRun-shaped, no `.state` at all) read as perpetually
        // "running" through that function, since it never looks at `.state`.
        statusCheckRollup: (pr.statusCheckRollup || []).map((c) => ({ name: c.name || c.context, conclusion: c.conclusion, state: c.state, status: c.status, completedAt: c.completedAt })),
      });
    }
  }
  return out;
}

export function probeAgents({ exec = run } = {}) {
  const arr = JSON.parse(cachedClaudeAgents({ fetch: () => exec('claude', ['agents', '--json'], { cwd: homedir() }) }));
  // `cwd`/`sessionId` carried through (additive — no existing smell reads `probes.agents` at all yet) so the
  // claude-auth-expired sign below can resolve each background session's own transcript.
  // #xrv69j6 — `status`/`waitingFor` ALSO carried through (additive, same reasoning): a background session
  // blocked on Claude Code's own unanswerable permission prompt reports `state: "blocked"`,
  // `status: "waiting"`, `waitingFor: "permission prompt"` (measured live, `claude agents --json`, session
  // `fix-2735`) — the `dispatch-permission-stall` smell below is the first reader.
  return arr.map((a) => ({
    name: a.name, state: a.state, kind: a.kind, startedAt: a.startedAt, cwd: a.cwd, sessionId: a.sessionId,
    status: a.status ?? null, waitingFor: a.waitingFor ?? null,
    // #4068 — `pid` carried through (additive) for the `live-process-stale-transcript` probe below.
    pid: Number.isInteger(a.pid) ? a.pid : null,
  }));
}

/** #4068 — a PR-bound dispatcher session name (`fix-2735`, `ci-heal-2711`, `review-2911`) → its PR number. Other
 *  kinds (`conveyor-<item>`, `prepare-<item>`) end in a BACKLOG number, not a PR, and are never PR-bound. */
export function prBoundSessionPr(name) {
  const m = /^(?:fix|ci-heal|review)-(\d+)$/.exec(String(name ?? ''));
  return m ? Number(m[1]) : null;
}

/**
 * #4068 — the `live-process-stale-transcript` sign's input: everything that can hold a PR as `live-process` in
 * `reconcile-core.mjs#assessLiveness`, each with its last-activity age. Two sources, matching
 * `reconcile-pass.mjs#defaultReadAgents`' own merged listing:
 *   - REVIEW JOBS (x26lw6u) — `<clone>/.operations/review-jobs/<slug>.json` records whose pid is alive, in this
 *     checkout and every daemon clone. The reconcile pass reads no transcript for these at all: a live pid holds
 *     the PR "however stale its transcript looks". Activity = the newest mtime of the job's own `<slug>.*` files
 *     (its log, its loop output). READ-ONLY: a dead record is skipped, never pruned (`listReviewJobAgents` prunes;
 *     the health watch never writes into a daemon clone).
 *   - PR-BOUND CLAUDE SESSIONS ({@link prBoundSessionPr}) the listing still shows unfinished — activity = their
 *     transcript's last entry via the reaper's own {@link readHungInfo}. (The reconcile pass already frees a
 *     session whose transcript crosses the hung threshold; one pending on a tool call can still hold its PR.)
 * A row whose activity cannot be read is kept with `lastActivityAgeMs: null` — never guessed stale.
 * @returns {Array<{pr:number, repo:string|null, name:string, source:'review-job'|'session', pid:number|null, lastActivityAgeMs:number|null, reason:string|null}>}
 */
export function probeLiveBindings(agents, {
  roots = [REPO_ROOT, ...daemonCloneRoots(workspaceOf(REPO_ROOT))],
  readInfo = readHungInfo, isAlive = pidAlive, nowMs = Date.now(), thresholdMs = 30 * MINUTE,
  readdir = readdirSync, readFile = readFileSync, stat = statSync,
} = {}) {
  const out = [];
  for (const dir of [...new Set(roots.map((r) => join(r, '.operations', 'review-jobs')))]) {
    let names;
    try { names = readdir(dir); } catch { continue; }
    for (const f of names.filter((n) => /^[A-Za-z0-9][A-Za-z0-9_-]*\.json$/.test(n))) {
      let rec;
      try { rec = JSON.parse(readFile(join(dir, f), 'utf8')); } catch { continue; }
      const pr = Number(rec?.pr);
      if (!Number.isInteger(rec?.pid) || !Number.isInteger(pr) || !isAlive(rec.pid)) continue;
      const slug = f.slice(0, -'.json'.length);
      let newest = null;
      for (const g of names.filter((n) => n.startsWith(`${slug}.`))) {
        try { const m = stat(join(dir, g)).mtimeMs; if (newest == null || m > newest) newest = m; } catch { /* vanished */ }
      }
      out.push({ pr, repo: rec.repo ?? null, name: String(rec.slug ?? slug), source: 'review-job', pid: rec.pid, lastActivityAgeMs: newest == null ? null : Math.max(0, nowMs - newest), reason: null });
    }
  }
  for (const a of Array.isArray(agents) ? agents : []) {
    const pr = prBoundSessionPr(a?.name);
    const state = String(a?.state ?? '').toLowerCase();
    if (pr == null || a?.kind !== 'background' || state === 'done' || state === 'stopped') continue;
    if (Number.isInteger(a.pid) && !isAlive(a.pid)) continue; // probed dead — reconcile frees that PR itself
    let info = null;
    try { info = readInfo(a, nowMs, thresholdMs); } catch { info = null; }
    out.push({ pr, repo: null, name: a.name, source: 'session', pid: Number.isInteger(a.pid) ? a.pid : null, lastActivityAgeMs: Number.isFinite(info?.ageMs) ? info.ageMs : null, reason: info?.reason ?? null });
  }
  return out;
}

/**
 * xegykal — THE SESSION WATCHDOG probe (`we:scripts/conveyor/session-watchdog.mjs`). Runs one watchdog pass at most
 * every `sessionWatchdog.intervalMinutes` (a config dimension in this health dir's `config.json`, merged over the
 * platform default) and caches the result in `<healthDir>/session-watchdog.json`, so a tick between passes still
 * hands the smells the last result (their episodes neither close nor re-open on an off-tick). The pass reads its
 * own `claude agents --json` listing (local, no API) every pass — not the gh-cadence `agents` probe, which runs
 * only every 15 minutes. Any watchdog fixture flag (`--watchdog-agents-fixture`, `--watchdog-claims-fixture`,
 * `--watchdog-heads-fixture`) replays a recorded host, and a fixture-scoped tick (`--state-root`, `--logs-dir` or
 * `--lock-root`, the same `fixtureTick` rule the other probes use) reads no host state at all — no real
 * `claude agents`, claim listing, PR-head cache, heavy-admission read or coordination-root event log. Either one,
 * or `--dry-run`, never acts.
 * @returns {object} the pass result plus `{cached:boolean, configError:string|null}`
 */
export function probeSessionWatchdog({
  dir, now = Date.now(), config = {}, processes = undefined, flags = {}, runPass = runSessionWatchdogPass,
} = {}) {
  const { config: cfg, error: configError } = resolveSessionWatchdogConfig(config.sessionWatchdog);
  const cachePath = join(dir, 'session-watchdog.json');
  const fixture = flags['watchdog-agents-fixture'];
  const anyFixture = !!(fixture || flags['watchdog-claims-fixture'] || flags['watchdog-heads-fixture']);
  const scoped = !!(flags['logs-dir'] || flags['lock-root'] || flags['state-root']);
  const isolated = anyFixture || scoped;
  const prev = anyFixture ? null : readJson(cachePath, null);
  const prevAt = Date.parse(prev?.at ?? '');
  // 30 s of slack so a 5-minute tick that lands a few seconds early still runs a 5-minute pass. A cached `at` in
  // the future (a clock stepped back, or a forged cache file) is stale, never a reason to skip the pass.
  if (prev && Number.isFinite(prevAt) && prevAt <= now && now - prevAt < cfg.intervalMinutes * MINUTE - 30_000) {
    return { ...prev, cached: true, configError };
  }
  const readFix = (k) => JSON.parse(readFileSync(flags[k], 'utf8'));
  const heads = flags['watchdog-heads-fixture'] ? readFix('watchdog-heads-fixture') : null;
  const result = runPass({
    nowMs: now, config: cfg,
    act: cfg.act && !isolated && !flags['dry-run'] && !flags['no-watchdog-act'],
    ...(fixture ? { agents: readFix('watchdog-agents-fixture') } : scoped ? { agents: [] } : {}),
    ...(processes !== undefined ? { processes } : {}),
    ...(flags['watchdog-claims-fixture'] ? { listClaims: () => readFix('watchdog-claims-fixture') } : scoped ? { listClaims: () => [] } : {}),
    ...(heads ? { prHeadFor: (repo, pr) => heads[`${repo}#${pr}`] ?? null } : scoped ? { prHeadFor: () => null } : {}),
    ...(isolated ? { eventDir: join(dir, 'session-watchdog-events'), readHeavy: () => null } : {}),
  });
  if (!anyFixture && !flags['dry-run']) writeJsonAtomic(cachePath, result);
  return { ...result, cached: false, configError };
}

/**
 * #4068 — the drain daemon's own per-pass `history.jsonl` (`{at, ms, exit, considered, merged, deferred,
 * failed}` per pass — the same file `live-state` reads), trimmed to the last `windowMs` and to the fields the
 * `drain-pass-over-budget`/`drain-merge-rate-drop` signs read. `null` when the file is absent (a host with no
 * resident drain — the smells then have nothing to say, rather than reading "zero merges").
 */
export function probeDrainHistory({ path = defaultDrainHistoryPath(), nowMs = Date.now(), windowMs = 7 * HOUR, read = readJsonlTail } = {}) {
  if (!existsSync(path)) return null;
  const { entries } = read(path, { maxBytes: 4 * 1024 * 1024 });
  return entries
    .map((e) => ({ at: Date.parse(e?.at || ''), ms: e?.ms, exit: e?.exit, considered: e?.considered ?? 0, merged: e?.merged ?? 0, deferred: e?.deferred ?? 0, failed: e?.failed ?? 0 }))
    .filter((e) => Number.isFinite(e.at) && e.at <= nowMs && nowMs - e.at <= windowMs);
}

/**
 * Live incident, night of 2026-09-25/26 ET — the operator's own Claude login expired and every daemon-
 * dispatched session hit an immediate CLI auth failure. Reads each BACKGROUND session's own transcript via the
 * shared detector ({@link readClaudeAuthExpiredInfo}, `we:scripts/conveyor/hung-session.mjs` — the SAME one
 * `session-reaper.mjs`'s reap axis and `reconcile-core.mjs`'s liveness mark both use, so this sign can never
 * disagree with either about what "auth-expired" means) and returns just the ones it flags, each carrying its
 * OWN `startedAt` (the "when" the `claude-auth-expired` smell's own 30-minute window measures from — these
 * sessions fail on their very first turn, so `startedAt` IS effectively "when the failure happened").
 * @param {Array<{name?:string, kind?:string, cwd?:string, sessionId?:string, startedAt?:string|number}>} agents
 * @param {{readInfo?:Function}} [io]
 * @returns {Array<{name:string, startedAt:number|null}>}
 */
export function probeAuthExpiredSessions(agents, { readInfo = readClaudeAuthExpiredInfo } = {}) {
  const out = [];
  for (const a of Array.isArray(agents) ? agents : []) {
    if (a?.kind !== 'background' || !a?.cwd || !a?.sessionId) continue;
    let info = null;
    try { info = readInfo(a); } catch { info = null; }
    if (info?.authExpired !== true) continue;
    const startedAt = typeof a.startedAt === 'number' ? a.startedAt : Date.parse(a.startedAt ?? '');
    out.push({ name: a.name ?? null, startedAt: Number.isFinite(startedAt) ? startedAt : null });
  }
  return out;
}

/**
 * #x9fbg1x, live incident `fix-2748`/`fix-2770` (2026-09-26) — reads each session `stuckOnPermissionPrompt`
 * (`we:scripts/conveyor/health-smells/dispatch-permission-stall.mjs`) already names as stuck on an unanswerable
 * permission prompt, and asks the SAME shared detector `reconcile-core.mjs#markBgIsolationStalls` uses
 * (`we:scripts/conveyor/bg-isolation-stall.mjs#readBgIsolationStallInfo`) whether its OWN transcript shows
 * Claude Code's own background-session worktree-isolation guard refusal ("Call EnterWorktree first…")
 * specifically, rather than some other permission gate (e.g. the lane-grant one `dispatch-permission-stall`
 * already covers generically). Returns only the ones it confirms — modeled directly on
 * {@link probeAuthExpiredSessions} just above, same shape, same "read a transcript only for a candidate the
 * cheap listing check already narrowed to" cost discipline.
 * @param {Array<{name?:string, kind?:string, state?:string, waitingFor?:string, cwd?:string, sessionId?:string, startedAt?:string|number}>} agents
 * @param {{readInfo?:Function}} [io]
 * @returns {Array<{name:string, sessionId:string|null, cwd:string|null, startedAt:number|null, evidence:string|null}>}
 */
export function probeBgIsolationStalls(agents, { readInfo = readBgIsolationStallInfo } = {}) {
  const out = [];
  for (const a of stuckOnPermissionPrompt(agents)) {
    let info = null;
    try { info = readInfo(a); } catch { info = null; }
    if (info?.stall !== true) continue;
    const startedAt = typeof a.startedAt === 'number' ? a.startedAt : Date.parse(a.startedAt ?? '');
    out.push({
      name: a.name ?? null, sessionId: a.sessionId ?? null, cwd: a.cwd ?? null,
      startedAt: Number.isFinite(startedAt) ? startedAt : null, evidence: info.evidence ?? null,
    });
  }
  return out;
}

/**
 * The `stale-claim` smell's class-A input: every `status: active`/`preparing` backlog claim's liveness, via the
 * declared `stale-state` read (#911) — shelled exactly like `lane-starvation`'s own `diagnose` already does, so
 * this probe and that diagnose never drift onto two different readers. Read-only; a hard timeout, like every
 * other child call in this file.
 * @returns {{observedAt:string, records:Array<object>, gaps:string[]}}
 */
export function probeStaleState({ exec = run, timeoutMs = 90_000, repoRoot = REPO_ROOT } = {}) {
  const out = exec(process.execPath, [join(repoRoot, 'scripts/operations/run.mjs'), 'stale-state', '--json'], { timeoutMs, cwd: repoRoot });
  return JSON.parse(out).verdict;
}

/**
 * The `stale-claim` smell's class-B input: every backlog card (`{stem, body}`, reused from
 * `../backlog-stranded-sweep.mjs`'s own reader — never a second `backlog/` scan) plus the merged-PR list its
 * pure `sweepStrandings` matches against. ONE `gh pr list --state merged` read serves both the smell's `matched`
 * tier (via `sweepStrandings`) and its lower-confidence `mentioned` tier (a body scan over this same list) —
 * never a duplicate merged-PR fetch.
 * @returns {{cards:Array<{stem:string, body:string}>, prs:Array<object>}}
 */
export function probeMergedPrs({ exec = run, limit = 800, timeoutMs = 60_000, repoRoot = REPO_ROOT } = {}) {
  const prs = JSON.parse(exec('gh', ['pr', 'list', '--repo', CONSTELLATION_REPOS.we.slug, '--state', 'merged', '--limit', String(limit), '--json', 'number,title,headRefName,body'], { timeoutMs }));
  return { cards: readBacklogCards(repoRoot), prs };
}

// Every probe name `collectGhProbes` can report under — the gh-cadence group's error-streak keys and the allowlist
// for a job result — lives in health-watch-job.mjs (which this file imports; the reverse would be a cycle).
export { GH_GROUP_PROBE_NAMES };

/**
 * #4131 — the gh-cadence probe group (every 15 min): open PRs, the agent listing and everything read off it,
 * stale-state and merged PRs. The slow part of a tick (live 2026-10-09: ~130 s of a ~150 s tick). Run inline by
 * the tick, or inside the `health-gh-probe` job's worker thread (we:scripts/conveyor/health-watch-job.mjs).
 * Each probe's failure is captured in `errors` (scrubbed), never thrown, so one failing read never blocks the
 * others. `sourceRoot` is the daemon clone: the job runs from a pinned code snapshot, so every read of the
 * checkout itself (backlog, review jobs, the stale-state CLI) must name the real clone, never the snapshot.
 * @returns {{probes: object, errors: Record<string, string>}}
 */
export function collectGhProbes({ now = Date.now(), sourceRoot = REPO_ROOT, skipBuildSessions = false } = {}) {
  const probes = {};
  const errors = {};
  const attempt = (name, fn) => {
    try { return fn(); } catch (e) { errors[name] = scrubText(String(e?.message || e).split('\n')[0]); return undefined; }
  };
  const prs = attempt('prs', () => probePrs({ now }));
  const agents = attempt('agents', () => probeAgents());
  // Each probe is set independently of the other succeeding: red-pr-unattended still only evaluates once BOTH
  // are present (its own `probes: ['prs', 'agents']` declaration already gates that), but stale-claim needs
  // only `prs` and must not sit blocked on a failing `agents` read too. `ghCache.at` still needs both, so a
  // partial gh hiccup keeps `ghDue` true and retries sooner rather than waiting the full cadence.
  if (prs) probes.prs = prs;
  if (agents) probes.agents = agents;
  // claude-auth-expired's own probe needs only `agents` (the exact same listing, same cadence) — independent
  // of whether `prs` also succeeded this tick, same reasoning as stale-claim's two probes just below.
  if (agents) probes.authExpired = attempt('authExpired', () => probeAuthExpiredSessions(agents));
  // #x9fbg1x — same cadence/gating reasoning as `authExpired` just above: needs only the same `agents`
  // listing, independent of whether `prs` also succeeded this tick.
  if (agents) probes.bgIsolationStalls = attempt('bgIsolationStalls', () => probeBgIsolationStalls(agents));
  // #4068 — same `agents` listing, same gating: what can hold a PR as `live-process` (review jobs + PR-bound
  // sessions) and how long since each last did anything.
  if (agents) {
    probes.liveBindings = attempt('liveBindings', () => probeLiveBindings(agents, {
      nowMs: now, roots: [sourceRoot, ...daemonCloneRoots(workspaceOf(sourceRoot))],
    }));
  }
  // Build/prepare supervision (operator 2026-10-06) — same `agents` listing, bounded transcript tail reads.
  if (agents && !skipBuildSessions) probes.buildSessions = attempt('buildSessions', () => probeBuildSessions(agents, { nowMs: now, prs: prs || [] }));
  // stale-claim's two probes ride the same 'gh' cadence (both are gh/git-heavy reads); independent of the
  // prs/agents pairing above — one failing never blocks the other.
  const staleState = attempt('staleState', () => probeStaleState({ repoRoot: sourceRoot }));
  if (staleState) probes.staleState = staleState;
  const mergedPrs = attempt('mergedPrs', () => probeMergedPrs({ repoRoot: sourceRoot }));
  if (mergedPrs) probes.mergedPrs = mergedPrs;
  for (const k of Object.keys(probes)) if (probes[k] === undefined) delete probes[k];
  return { probes, errors };
}

// ── the tick ─────────────────────────────────────────────────────────────────────────────────────────────────

function acquireTickLock(dir) {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'tick.lock');
  try {
    if (existsSync(p) && Date.now() - statSync(p).mtimeMs > 10 * MINUTE) unlinkSync(p);
    writeFileSync(p, String(process.pid), { flag: 'wx' });
    return () => { try { unlinkSync(p); } catch { /* gone */ } };
  } catch { return null; }
}

function sweepOptions(config, tmpRoot, dryRun, now, run, cursor) {
  return { tmpRoot, dryRun, now, busy: readBusyTopLevel(tmpRoot, { run }),
    olderThanMs: config.tmpSweepOlderThanMs, batchSize: config.tmpSweepBatchSize,
    pauseMs: config.tmpSweepPauseMs, maxDeletes: config.tmpSweepMaxDeletesPerRun,
    timeBudgetMs: config.tmpSweepTimeBudgetMs, scanBudgetMs: config.tmpSweepScanBudgetMs, cursor };
}

function archiveOptions(config, flags, now) {
  return { jobsRoot: flags['claude-jobs-root'], archiveRoot: flags['claude-jobs-archive-root'],
    dryRun: !!flags['dry-run'], now, olderThanMs: config.claudeJobsArchiveOlderThanMs,
    maxMoves: config.claudeJobsArchiveMaxMovesPerRun, timeBudgetMs: config.claudeJobsArchiveTimeBudgetMs };
}

/** One tick: probe, evaluate, diagnose, and persist. Returns the CLI summary. */
export async function tick(flags = {}, { collectInventory = collectCredentialInventory, tmpSweepRun, ...deps } = {}) {
  const started = Date.now();
  const now = flags.now ? Date.parse(flags.now) : started;
  const dir = healthDir(flags['state-root']);
  const statePath = join(dir, 'state.json');
  const prev = { ...emptyHealthState(), ...readJson(statePath, {}) };
  const config = { ...DEFAULT_HEALTH_CONFIG, ...readJson(join(dir, 'config.json'), {}) };
  const logsDir = flags['logs-dir'] || defaultLogsDir();
  const probeErrors = {};
  const probes = {};
  // A probe's error text is scrubbed at capture: an auth failure can echo a token in its message.
  const attempt = (name, fn) => {
    const failed = (e) => { probeErrors[name] = scrubText(String(e?.message || e).split('\n')[0]); return undefined; };
    try { const value = fn(); return value?.then ? value.catch(failed) : value; } catch (e) { return failed(e); }
  };
  const sweepAllowed = flags['tmp-sweep-root'] || (!flags['state-root'] && !flags['dry-run']);
  // Both daily stamps come from state.json, so they go through `cadenceDue`: a future one must not park the sweep.
  const sweepDue = config.tmpSweepEnabled && (prev.tmpSweep?.complete === false
    || cadenceDue(prev.tmpSweep?.completedAt, now, config.tmpSweepEveryMs));
  const tmpSweep = sweepAllowed && sweepDue
    ? await attempt('tmpSweep', () => sweepOurTmp(sweepOptions(config, flags['tmp-sweep-root'] || tmpdir(), !!flags['dry-run'], now, tmpSweepRun, prev.tmpSweep?.nextCursor)))
    : null;

  if (!flags['state-root'] && !flags['dry-run']) await attempt('cardBatchSeal', () => sealDueBatches({ now }));

  const archiveAllowed = flags['claude-jobs-root'] || (!flags['state-root'] && !flags['dry-run']);
  const archiveDue = config.claudeJobsArchiveEnabled && (prev.claudeJobsArchive?.complete === false
    || cadenceDue(prev.claudeJobsArchive?.completedAt, now, config.claudeJobsArchiveEveryMs));
  const claudeJobsArchive = archiveAllowed && archiveDue
    ? await attempt('claudeJobsArchive', () => archiveClaudeJobs(archiveOptions(config, flags, now)))
    : null;

  const logs = attempt('daemonLogs', () => probeDaemonLogs(logsDir, prev.cursors || {}));
  if (logs) probes.daemonLogs = logs.samples;
  // builder-starved — the build-dispatch daemon's JSON tick log lives in the coordination root, not `logsDir`.
  const builderLogs = attempt('builderLog', () => probeDaemonLogs(flags['builder-log-dir'] || defaultBuilderLogDir(), prev.builderCursors || {}, { only: ['build-dispatch-daemon'] }));
  if (builderLogs) probes.builderLog = builderLogs.samples[0] ?? { name: 'build-dispatch-daemon', text: '' };
  // Daemon inventory: the declared daemon-status read (#4067) on a real host; the raw lease-dir scan only when a
  // test/fixture points --lock-root somewhere, or daemon-status itself fails (then that failure is a probe error).
  const leaseScan = () => probeLeases(flags['lock-root'] || RUNNER_LOCK_ROOT, new Set((logs?.samples || []).map((s) => s.name)));
  probes.leases = flags['lock-root'] ? attempt('leases', leaseScan)
    : (attempt('daemonStatus', () => probeDaemonStatus()) ?? attempt('leases', leaseScan));
  probes.selfSync = attempt('selfSync', () => probeSelfSync(flags['self-sync-dir'] || defaultSelfSyncDir()));
  probes.cloneLag = (flags['logs-dir'] || flags['lock-root'] || flags['state-root']) ? undefined : attempt('cloneLag', () => probeCloneLag());
  probes.daemonCloneBranches = (flags['logs-dir'] || flags['lock-root'] || flags['state-root']) ? undefined : attempt('daemonCloneBranches', () => probeDaemonCloneBranches({ workspace: workspaceOf(REPO_ROOT) }));
  probes.lanePools = attempt('lanePools', () => probeLanePools(logsDir));
  // #4370 — fs-only, every tick. A fixture tick (any of the fixture-dir flags) reads only an explicit
  // `--lane-pool-root`, never the host's real pool.
  const fixtureTick = flags['logs-dir'] || flags['lock-root'] || flags['state-root'];
  probes.operationRuns = attempt('operationRuns', () => probeOperationRuns(fixtureTick ? { roots: [flags['state-root'] || logsDir], jobsRoot: null } : {}));
  probes.fixLoopLedger = attempt('fixLoopLedger', () => flags['fix-loop-ledger']
    ? readFixLoopRows({ env: { WE_FIX_LOOP_LEDGER: flags['fix-loop-ledger'] } })
    : fixtureTick ? [] : readFixLoopRows());
  probes.laneJournal = attempt('laneJournal', () => probeLaneJournal({
    poolRoot: flags['lane-pool-root'] || (fixtureTick ? null : defaultPoolRoot(REPO_ROOT)), now,
  }));
  // `fixer-verify-never-settles` — fs + one `git rev-parse` per RUNNING marker only. Same fixture rule as above.
  probes.laneVerifyMarkers = attempt('laneVerifyMarkers', () => probeLaneVerifyMarkers({
    poolRoot: flags['lane-pool-root'] || (fixtureTick ? null : defaultPoolRoot(REPO_ROOT)),
  }));
  // #4200-ish — cheap, fs-only, every tick: catches a shim baked with a lane-clone path BEFORE that lane resets.
  probes.ghShimLanes = attempt('ghShimLanes', () => probeGhShimLanes());
  // #4317 — cheap, every tick: an aged untracked backlog card sitting inside a daemon clone (the exact class of
  // failure the approval-time prevention filer used to cause before it started landing through a real lane).
  probes.untrackedBacklogCards = attempt('untrackedBacklogCards', () => probeUntrackedBacklogCards({ now }));
  probes.appStatus = attempt('appStatus', () => readGithubAppStatus()) ?? null;
  // The declared heavy-command admission read (cap, held slots, waiters with requestedAt) — a fixture file in tests.
  probes.heavyQueue = attempt('heavyQueue', () => (flags['heavy-status-file']
    ? JSON.parse(readFileSync(flags['heavy-status-file'], 'utf8'))
    : JSON.parse(run(process.execPath, [join(REPO_ROOT, 'scripts/readiness/heavy-admission.mjs'), 'status', '--json'], { timeoutMs: 15_000 }))));
  // `machine-overload`'s own inputs — every tick, cheap, never gh-gated. `--ps-fixture`/`--machine-load-fixture`
  // are the incident-reproduction path: this repo never runs a load generator to test this smell (see that
  // smell's own header) — it feeds a real-shaped `ps` snapshot through the exact same tick instead.
  probes.processes = attempt('processes', () => (flags['ps-fixture']
    ? parsePsOutput(readFileSync(flags['ps-fixture'], 'utf8'))
    : probeProcesses()));
  // xegykal — the session watchdog (its own interval, every-tick probe; see probeSessionWatchdog).
  probes.sessionWatchdog = attempt('sessionWatchdog', () => probeSessionWatchdog({ dir, now, config, processes: probes.processes, flags }));
  if (probes.sessionWatchdog?.configError) probeErrors.sessionWatchdogConfig = probes.sessionWatchdog.configError;
  probes.machineLoad = attempt('machineLoad', () => (flags['machine-load-fixture']
    ? JSON.parse(readFileSync(flags['machine-load-fixture'], 'utf8'))
    : probeMachineLoad()));
  // heavy-enforce — the `heavy-run-ungated` smell's sample history (the ~60s sampler plus each tick's own append).
  const heavyRunSamplesPath = flags['heavy-run-samples-file'] || join(dir, 'heavy-run-samples.jsonl');
  probes.heavyRunSamples = attempt('heavyRunSamples', () => readRecentSamples(heavyRunSamplesPath, {
    now, windowMs: config.heavyRunUngatedWindowMs ?? 10 * MINUTE,
  }));
  // `gh-call-failures` — fs-only, every tick: the gh-throttle call log's tail (`--gh-calls-log=FILE` in tests).
  probes.ghCalls = attempt('ghCalls', () => probeGhCalls(flags['gh-calls-log'] ? { logPath: flags['gh-calls-log'] } : {}));
  // #4309 — alongside (never replacing) the 2 MB tail above: persist every fully closed hour of GitHub spend once,
  // through gh-spend.mjs's OWN byte cursor, so hours survive log rotation and the tail never loses a window.
  // A fixture tick (`--lock-root` with no `--gh-calls-log`) never persists: that would WRITE the real throttle
  // dir's cursor and hourly rows from a test run (PR #2851 review).
  const spendFixtureOnly = flags['lock-root'] && !flags['gh-calls-log'];
  const ghSpend = spendFixtureOnly ? null
    : attempt('ghSpend', () => persistGhSpend({ ...(flags['gh-calls-log'] ? { logPath: flags['gh-calls-log'] } : {}), now }));
  // `review-seat-cap-near-limit` (card xn2wf9t) — fs-only, every tick: each non-Claude review seat provider's
  // OWN daily cap usage, off the SAME scorecard store + reservation ledgers `runExtraSeats`/`runRedTeam` admit
  // against (`--scorecard-store-fixture=FILE` in tests, so this never touches a real store in the test suite).
  probes.reviewSeatCaps = attempt('reviewSeatCaps', () => readSeatCapUsage({
    storePath: flags['scorecard-store-fixture'] || undefined,
    now,
  }));
  // `gh-graphql-budget` — every tick (1 GraphQL point): the real bucket + the throttle's shared budget blocks.
  // `--graphql-budget-fixture=FILE` (a `{sample, blocks}` JSON) in tests; skipped under `--no-gh`.
  // `pr-events-stale` — fs-only, every tick: each event-driven waker's status file (`[]` while WE_PR_EVENTS is off).
  probes.prEventsStatus = attempt('prEventsStatus', () => readPrEventsStatuses(flags['pr-events-state-dir'] || undefined));
  if (flags['graphql-budget-fixture']) probes.graphqlBudget = attempt('graphqlBudget', () => JSON.parse(readFileSync(flags['graphql-budget-fixture'], 'utf8')));
  else if (!flags['no-gh']) probes.graphqlBudget = attempt('graphqlBudget', () => probeGraphqlBudget());
  // #4066 `github-app-token` — every tick: the App token cache's expiry (fs, never the token) and the REST core
  // bucket (`gh api rate_limit`, free). `restBudget` is `null` (not skipped) under `--no-gh` or on a failed read, so
  // the token subject still evaluates; a failed read is still a probe error. Fixture flags in tests.
  // A fixture tick (`--lock-root` with no `--app-token-cache`) never reads the host's real cache — its expiry would
  // make the test's episodes depend on the machine it runs on (same rule as `spendFixtureOnly` below).
  probes.appToken = flags['lock-root'] && !flags['app-token-cache'] ? { present: false }
    : attempt('appToken', () => probeAppToken(flags['app-token-cache'] ? { path: flags['app-token-cache'] } : {}));
  probes.restBudget = flags['rest-budget-fixture']
    ? attempt('restBudget', () => JSON.parse(readFileSync(flags['rest-budget-fixture'], 'utf8'))) ?? null
    : (flags['no-gh'] ? null : attempt('restBudget', () => probeRestBudget()) ?? null);
  // #4068 `drain-pass-over-budget` / `drain-merge-rate-drop` — fs-only, every tick: the resident drain's own
  // per-pass history (`--drain-history=FILE` in tests). A fixture tick (`--lock-root` with no `--drain-history`)
  // never reads the host's real file, same rule as `appToken` below.
  probes.drainHistory = flags['lock-root'] && !flags['drain-history'] ? null
    : attempt('drainHistory', () => probeDrainHistory({ ...(flags['drain-history'] ? { path: flags['drain-history'] } : {}), nowMs: now }));
  // Build/prepare supervision — external (Codex) runs live only in the build daemon's dispatch run records; fs-only,
  // bounded, every tick. A fixture tick (`--lock-root`) never reads the host's real records.
  if (!flags['lock-root']) {
    probes.externalRuns = attempt('externalRuns', () => probeExternalRuns({
      runsDir: process.env.OPERATION_RUNS_DIR || join(workspaceOf(REPO_ROOT), '.operations', 'coordination', 'build-dispatch-runs'),
      lanesRoot: process.env.LANE_POOL_ROOT || join(workspaceOf(REPO_ROOT), '.lanes'), nowMs: now }));
  }
  // Card xu1nixv — main's own CI workflow runs (read by workflow, never across all workflows) and its ONE owner per
  // broken commit, every tick (main red is the priority). The result is the `main-ci-red` smell's probe. A fixture
  // (`--main-ci-runs-fixture=<file>`) replays recorded runs and never dispatches; other fixture ticks skip it.
  if (flags['main-ci-runs-fixture'] || (!flags['no-gh'] && !flags['lock-root'] && !flags['state-root'])) {
    const fixture = flags['main-ci-runs-fixture'];
    probes.mainCiRuns = await attempt('mainCiRuns', () => probeAndOwnMainCi({
      dir, now, config, weRoot: REPO_ROOT, dryRun: !!flags['dry-run'] || !!fixture,
      ...(fixture ? { readRuns: () => JSON.parse(readFileSync(fixture, 'utf8')), readPrs: () => [], listAgents: async () => [], gates: async () => ({ killed: false, fixGate: null }) } : {}),
    }));
  }
  // #4066 `open-prs-over-limit` — fs/env only; pairs with the gh-cadenced `prs` read below.
  probes.prLimit = attempt('prLimit', () => probePrLimit());

  // state.json is a user-writable file: a non-object `ghCache` reads as empty, and every cadence stamp goes through
  // `cadenceDue`, so a corrupt or future value can never park a cadence.
  const ghCache = prev.ghCache && typeof prev.ghCache === 'object' && !Array.isArray(prev.ghCache) ? prev.ghCache : {};
  let jobsState = prev.jobs;
  let ghJob = null;
  const ghDue = !flags['no-gh'] && (flags['force-gh'] || cadenceDue(ghCache.at, now));
  // Inventory has its own cadence stamp: unrelated GitHub failures cannot cause repeated log scans.
  const inventoryDue = !flags['no-gh'] && (flags['force-gh'] || cadenceDue(prev.credentialInventoryAt, now));
  if (flags['credential-inventory-fixture'] || inventoryDue) {
    try {
      probes.credentialInventory = normalizeInventory(flags['credential-inventory-fixture']
        ? JSON.parse(readFileSync(flags['credential-inventory-fixture'], 'utf8'))
        : collectInventory({ now, cache: prev.credentialInventoryCache || [], budgetMs: 20_000 }));
      const errors = probes.credentialInventory.repositories.flatMap((r) => ['secrets', 'ci'].flatMap((kind) =>
        r[kind].complete ? [] : [`${r.repo}:${kind}:${r[kind].errors.join(',') || 'incomplete'}`]));
      if (errors.length) probeErrors.credentialInventory = errors.join('; ');
    } catch { probeErrors.credentialInventory = 'unavailable'; }
  }
  // #4131 — the gh-cadence group is the slow part of a tick (live: ~130 s of a ~150 s tick). With the
  // `ghProbes` job switch on, it runs as a detached durable job (we:scripts/conveyor/health-watch-job.mjs) and
  // this tick only consumes a finished job's result; otherwise it runs inline, exactly as before. A dry run or a
  // fixture tick never touches the host job store (a test supplies its own store through `deps.ghJobs`).
  const jobsAllowed = (!fixtureTick || !!deps.ghJobs) && !flags['dry-run'] && !flags['no-gh'];
  const ghJobsOn = jobsAllowed && resolveHealthJobSwitches(config).ghProbes;
  // Switched off with job state left behind (a rollback): still reconcile — reattach, consume, never queue — so an
  // in-flight job is never stranded; the group runs inline meanwhile. Stops once no health job record remains.
  const reconcileOnly = jobsAllowed && !ghJobsOn && !!prev.jobs;
  let ghFromJob = false;
  if (ghJobsOn || reconcileOnly) {
    const out = await attempt('ghJob', () => runGhProbeJobs({
      ...(deps.ghJobs || {}), now, due: ghJobsOn && ghDue, state: prev.jobs, drain: reconcileOnly,
      input: { now, sourceRoot: REPO_ROOT, skipBuildSessions: !!flags['lock-root'] },
    }));
    if (out) {
      jobsState = reconcileOnly && !out.summary.remaining ? undefined : out.state;
      ghJob = out.summary;
      if (out.result) {
        ghFromJob = true;
        Object.assign(probes, out.result.probes);
        for (const [k, v] of Object.entries(out.result.errors || {})) probeErrors[k] = v;
        if (out.result.probes.prs && out.result.probes.agents) ghCache.at = Math.min(out.result.sampledAt, now);
      }
      if (out.failure) probeErrors.ghJob = scrubText(out.failure);
    }
  }
  if (!ghJobsOn && ghDue && !ghFromJob) {
    const got = (deps.collectGh || collectGhProbes)({ now, skipBuildSessions: !!flags['lock-root'] });
    Object.assign(probes, got.probes);
    Object.assign(probeErrors, got.errors);
    if (got.probes.prs && got.probes.agents) ghCache.at = now;
  }

  // A tick the watchdog killed last time is the overrun smell's input.
  const overrunPath = join(dir, 'overrun.json');
  const overrun = readJson(overrunPath, null);
  let lastTickForSmells = prev.lastTick;
  if (overrun) lastTickForSmells = { ...(prev.lastTick || {}), durationMs: overrun.killedAfterMs, killedByWatchdog: true };

  // Silences live in their OWN file, written only by `silence`/`unsilence` and only read here, so a silence
  // set while a tick runs can never be lost to the tick's state.json write (nor roll that write back). Which
  // expired silences were already announced is tick state (`notifiedSilences`).
  const notified = new Set(prev.notifiedSilences || []);
  const silenceSig = (x) => `${x.smell}|${x.subject ?? '*'}|${x.card ?? ''}|${x.expiresAt ?? ''}`;
  const silences = readJson(join(dir, 'silences.json'), []).map((x) => ({ ...x, expiredNotified: notified.has(silenceSig(x)) }));
  // A silence whose tracking card is still `active` never expires (4065 Fork 3): read those cards' status.
  const activeCards = readActiveCards(silences.map((x) => x.card).filter(Boolean), flags['backlog-dir'] || join(REPO_ROOT, 'backlog'));
  // Job mode, cadence still due, no result consumed: the group took no sample this tick (its job is queued or
  // running). Inline, a failed read stays due and is re-supplied every tick, so its streak grows; here it must be
  // held — not cleared by the ticks between a job's failed samples (the core clears a streak whenever a probe
  // supplies nothing). A cadence that is satisfied is an off-cadence tick, and clears exactly as it does inline.
  // `ghJob` (the job's own failure, supplied once when it is consumed) is held the same way, so a job that keeps
  // dying builds its own streak across the ticks between its failures.
  const carryProbeErrors = ghJobsOn && ghDue && !ghFromJob ? [...GH_GROUP_PROBE_NAMES, 'ghJob'] : [];
  const result = runHealthTick({ ...prev, silences, lastTick: lastTickForSmells }, probes, deps.smells || SMELLS, now, { config, probeErrors, activeCards, carryProbeErrors });
  // Read history before evaluation, then persist this tick once. Synthetic process fixtures never persist.
  if (!flags['ps-fixture']) attempt('heavyRunSampleAppend', () => appendSample(heavyRunSamplesPath,
    probes.processes ? summarizeSample(findUngatedHeavyRuns(probes.processes), new Date(now).toISOString())
      : { at: new Date(now).toISOString(), error: probeErrors.processes || 'process snapshot unavailable' }));
  // Scrubbed ONCE, right here: everything below — the printed section, the returned summary, every file — sees
  // only the redacted state.
  const state = scrubDeep(result.state);
  if (claudeJobsArchive) state.claudeJobsArchive = { at: now, ...(claudeJobsArchive.complete ? { completedAt: now } : {}), ...claudeJobsArchive };
  else if (prev.claudeJobsArchive) state.claudeJobsArchive = prev.claudeJobsArchive;
  if (tmpSweep) state.tmpSweep = { at: now, ...(tmpSweep.complete ? { completedAt: now } : {}), ...tmpSweep };
  else if (prev.tmpSweep) state.tmpSweep = prev.tmpSweep;
  state.notifiedSilences = (result.state.silences || []).filter((x) => x.expiredNotified).map(silenceSig);
  delete state.silences;
  state.cursors = logs ? { ...(prev.cursors || {}), ...logs.cursors } : prev.cursors;
  state.builderCursors = builderLogs ? { ...(prev.builderCursors || {}), ...builderLogs.cursors } : prev.builderCursors;
  state.ghCache = { at: ghCache.at ?? null };
  if (jobsState) state.jobs = jobsState;
  else delete state.jobs;
  if (probes.credentialInventory) {
    state.credentialInventoryAt = now;
    state.credentialInventoryCache = probes.credentialInventory.ciFindings;
  }

  // Deterministic diagnoses (allowed in shadow mode) — hard timeout each.
  // Live 2026-10-09 (#4131): nine stale-claim episodes opened in one tick, each running the SAME 30 s sweep, and
  // the watchdog killed the tick at 180 s — so no state was saved, and the next tick reopened all nine. Two
  // bounds: an identical command runs once per tick (its output is shared), and no new diagnosis starts once the
  // tick has used 1.5x its budget (the rest are reported as deferred, never as a killed tick).
  const diagnoses = [];
  const diagnosisRuns = new Map();
  const diagnoseDeadline = started + (config.tickBudgetMs ?? DEFAULT_HEALTH_CONFIG.tickBudgetMs) * 1.5;
  const deferredDiagnoses = [];
  // A diagnosis the budget deferred leaves `diagnosisDeferredAt` on its episode (state.json). The planner only
  // asks for a diagnosis on an open/flapping transition, so without this the skipped work would never be asked
  // for again. Carried-over deferrals run first, oldest first, so a slow tick cannot starve them.
  const smellById = Object.fromEntries((deps.smells || SMELLS).map((s) => [s.id, s]));
  const planned = new Set(result.plan.filter((x) => x.kind === 'diagnose').map((x) => x.key));
  const carriedDiagnoses = Object.values(state.episodes)
    .filter((e) => Number.isFinite(e.diagnosisDeferredAt) && (e.status === 'open' || e.status === 'flapping')
      && !planned.has(e.key) && smellById[e.smell]?.diagnose)
    .sort((a, b) => a.diagnosisDeferredAt - b.diagnosisDeferredAt)
    .map((e) => ({ kind: 'diagnose', key: e.key, diagnose: smellById[e.smell].diagnose }));
  for (const p of [...carriedDiagnoses, ...result.plan.filter((x) => x.kind === 'diagnose')]) {
    const ep = state.episodes[p.key];
    if (!ep || flags['no-diagnose']) continue;
    const { command, args = [], timeoutMs = CHILD_TIMEOUT_MS } = p.diagnose;
    const commandLine = [command, ...args].join(' ');
    let d = diagnosisRuns.get(commandLine);
    if (!d) {
      if ((deps.clock || Date.now)() > diagnoseDeadline) {
        deferredDiagnoses.push(p.key);
        ep.diagnosisDeferredAt ??= now; // keeps the first deferral time across ticks
        continue;
      }
      try { d = { command: commandLine, code: 0, output: (deps.runDiagnosis || run)(command, args, { timeoutMs }) }; }
      catch (e) { d = { command: commandLine, code: e?.status ?? null, timedOut: e?.code === 'ETIMEDOUT' || e?.signal === 'SIGTERM', output: `${e?.stdout || ''}${e?.stderr || ''}` || String(e?.message || e) }; }
      d.output = scrubText(summarizeDiagnosisOutput(d.output)); // scrubbed at capture: every persisted copy is redacted
      diagnosisRuns.set(commandLine, d);
    }
    ep.diagnosis = { ...d };
    delete ep.diagnosisDeferredAt;
    diagnoses.push({ key: p.key, command: d.command, code: d.code });
  }
  if (deferredDiagnoses.length) probeErrors.diagnoseDeferred = `${deferredDiagnoses.length} diagnosis(es) skipped past the tick budget: ${deferredDiagnoses.slice(0, 5).join(', ')}`;

  // #4078 — the diagnose-only investigation agent: stop what is due, dispatch what the budget clears (nothing
  // unless config `investigateDispatch` is on), and put each episode's investigation status + findings on the
  // episode so the reports written below carry them. Its own failure is a probe error, never a failed tick.
  let investigations = null;
  if (!flags['no-investigate']) {
    try {
      investigations = await runInvestigations({
        dir, state, smells: SMELLS, config, now, dryRun: !!flags['dry-run'],
        closedEpisodes: result.transitions.filter((t) => t.type === 'closed').map((t) => t.episode),
      });
    } catch (e) { probeErrors.investigate = scrubText(String(e?.message || e).split('\n')[0]); }
  }

  // #4079 — filing requests (slice 5): plan which open episodes get a NEW filing request this tick and append
  // them to the ledger. This ONLY plans + ledgers; it never lands anything itself — the lane-bound landing
  // pass (scripts/operations/health-file-request-land.mjs) is invocable standalone (`node
  // scripts/operations/health-file-request-land.mjs`), never from inside this tick: its own acquire/verify/
  // open-pr sequence can run many minutes, well past this tick's timeout budget, so nothing here schedules or
  // awaits it (#4079 review round 2, claim-accuracy finding — a RECURRING driver registration for it is
  // explicitly deferred follow-up work, not yet wired by this slice). Its own failure is a probe error, never
  // a failed tick.
  //
  // The whole read-plan-write is INSIDE `withLedgerLock` — the same lock `claimForLanding`/`patchLedgerEntry`
  // take — not just the write. A bare `readLedgerStrict` + `writeLedger` pair here would let the landing
  // pass's claim (status: 'landing') or finalize (status: 'landed') land in the gap between this tick's own
  // read and write, and this tick's stale copy would then silently erase it (the ledger module's own header
  // names exactly this hazard as the reason the lock exists).
  let filingLedger = null;
  if (!flags['no-file']) {
    try {
      const smellsByIdForFiling = Object.fromEntries(SMELLS.map((s) => [s.id, s]));
      withLedgerLock(dir, () => {
        const ledgerBefore = readLedgerStrict(dir);
        const { toRequest } = planFileRequests({ episodes: state.episodes, smellsById: smellsByIdForFiling, ledger: ledgerBefore, config, now });
        filingLedger = ledgerBefore;
        for (const { request } of toRequest) filingLedger = recordRequested(filingLedger, request, now);
        if (!flags['dry-run'] && toRequest.length) writeLedger(dir, filingLedger);
      });
    } catch (e) { probeErrors.file = scrubText(String(e?.message || e).split('\n')[0]); }
  }

  // Real desktop notifications — THE MINIMAL NOTIFY PATH (#4077 slice 1 shipped with none: every `notify` plan
  // entry was only ever reported as "Held back" in a report, never actually sent, in ANY mode — see
  // `health-watch-core.mjs#planActions`'s own doc). Only entries `planActions` did NOT mark `suppressed` reach
  // here: every pre-existing smell stays exactly as silent as before in shadow mode (nothing here changes for
  // them), and the ONLY smells that can produce a non-suppressed entry while `mode: 'shadow'` are the ones
  // listed in `health-smells-notify-list.mjs`'s `NOTIFY_EVEN_IN_SHADOW` — the ONE declared place for this list
  // (deliberately not hand-enumerated here, since a stale copy here would read as authoritative; see that
  // file's own header for the operator decision behind its current contents). Best-effort:
  // `notifyDesktopChecked` already reports its own failure rather than throwing; a delivery failure here must
  // never fail the tick.
  const notifications = [];
  for (const p of result.plan.filter((x) => x.kind === 'notify' && !x.suppressed)) {
    const ep = state.episodes[p.key];
    // `--dry-run`/`--no-notify` both skip actually SENDING one (an OS-visible side effect, unlike the
    // read-only diagnoses above) — a dry-run reports what it would have sent via `result.plan` already.
    if (!ep || flags['no-notify'] || flags['dry-run']) continue;
    if (ALERT_ONCE_PER_SUBJECT.has(ep.smell)) continue; // sent once per break by the block below
    const title = `Health: ${ep.smell} — ${ep.subject}`;
    const body = scrubText(ep.recommendation || ep.summary || 'See the health report.');
    let sent;
    const emergency = breakthroughEmergency(ep);
    try { sent = notifyDesktopChecked({ title, body, emergency }); } catch (e) { sent = { ok: false, error: String(e?.message || e) }; }
    // Remember that quiet hours held this alert: the daemon-down breakthrough depends on elapsed time, so it is re-checked below.
    if (emergency?.kind === 'daemon-down' && sent?.suppressed) ep.heldByQuietHours = true;
    notifications.push({ key: p.key, ok: sent?.ok === true, error: sent?.ok === true ? null : scrubText(sent?.error ?? 'unknown') });
  }

  // A red main (operator ruling 2026-10-09): one alert per break, retried until delivered. Every open, untracked episode
  // of an ALERT_ONCE smell that has not delivered yet is sent here, so a failed send is retried next tick and an episode
  // that opened while another one's alert was still fresh stays quiet (see `isRepeatAlert`). The delivery time is stamped
  // on the episode (`alertedAt`), which is what later episodes of the same break check.
  if (!flags['no-notify'] && !flags['dry-run']) {
    for (const [key, ep] of Object.entries(state.episodes)) {
      if (!ALERT_ONCE_PER_SUBJECT.has(ep.smell) || ep.status === 'pending' || ep.tracked || Number.isFinite(ep.alertedAt)) continue;
      if (!result.plan.some((x) => x.key === key && x.kind === 'notify' && !x.suppressed) && !Number.isFinite(ep.alertAttemptedAt)) continue; // first attempt rides the open-time plan entry
      if (isRepeatAlert(ep, state, now)) continue;
      let sent;
      try { sent = notifyDesktopChecked({ title: `Health: ${ep.smell} — ${ep.subject}`, body: scrubText(ep.recommendation || ep.summary || 'See the health report.'), emergency: breakthroughEmergency(ep) }); }
      catch (e) { sent = { ok: false, error: String(e?.message || e) }; }
      ep.alertAttemptedAt = now;
      if (sent?.ok === true) ep.alertedAt = now;
      notifications.push({ key, ok: sent?.ok === true, error: sent?.ok === true ? null : scrubText(sent?.error ?? 'unknown') });
    }
  }

  // quietHours (card xmvc6oc): a daemon that dies at 02:00 is first seen minutes later — below the 30-minute
  // breakthrough, so its opening alert is held. Nothing else re-alerts for hours, so once the silence crosses
  // the threshold the held alert is re-sent as the emergency it has become (once: the flag clears on delivery).
  if (!flags['no-notify'] && !flags['dry-run']) {
    let quietSettings = null;
    for (const [key, ep] of Object.entries(state.episodes)) {
      if (!ep.heldByQuietHours || ep.status === 'pending') continue;
      const emergency = daemonDownEmergency(ep);
      if (!emergency) continue;
      try { quietSettings ??= loadQuietSettings(); } catch { continue; }
      if (!breaksThrough({ emergency }, quietSettings).breaks) continue;
      let sent;
      try { sent = notifyDesktopChecked({ title: `Health: ${ep.smell} — ${ep.subject}`, body: scrubText(ep.recommendation || ep.summary || 'See the health report.'), emergency }); }
      catch (e) { sent = { ok: false, error: String(e?.message || e) }; }
      if (sent?.ok === true && !sent.suppressed) delete ep.heldByQuietHours;
      notifications.push({ key, ok: sent?.ok === true, error: sent?.ok === true ? null : scrubText(sent?.error ?? 'unknown') });
    }
  }

  // quietHours (card xmvc6oc): this tick runs often, so it is the reliable place to send the ONE held-alerts
  // digest soon after quiet hours end (a no-op while quiet or when nothing is held).
  if (!flags['no-notify'] && !flags['dry-run']) {
    try { flushDigest({ send: (n) => notifyDesktopChecked(n, { quietGate: null }) }); } catch { /* best-effort */ }
  }

  const completedAt = Date.now();
  const durationMs = completedAt - started;
  state.lastTick = { completedAt: flags.now ? now : completedAt, durationMs, mode: config.mode, probeErrors };

  const reportDir = join(dir, 'episodes');
  const smellsById = Object.fromEntries(SMELLS.map((s) => [s.id, s]));
  const written = [];
  if (!flags['dry-run']) {
    const toWrite = [...Object.values(state.episodes).filter((e) => e.status !== 'pending'),
      ...result.transitions.filter((t) => t.type === 'closed').map((t) => t.episode)];
    for (const ep of toWrite) {
      if (!ep?.id) continue;
      const md = renderEpisodeReport(ep, { now, smell: smellsById[ep.smell], diagnosis: ep.diagnosis, plan: result.plan, mode: config.mode });
      const mdPath = join(reportDir, `${ep.id}.md`);
      writeJsonAtomic(mdPath, md);
      writeJsonAtomic(join(reportDir, `${ep.id}.json`), scrubDeep(ep));
      written.push(mdPath);
      // #4079 — splice the filing section (if any) into the report just written above.
      const filingEntry = filingLedger?.find((e) => e.key === ep.key);
      if (filingEntry) { try { spliceFilingSection(mdPath, filingEntry); } catch { /* retried next tick */ } }
    }
    writeJsonAtomic(statePath, state);
    writeJsonAtomic(join(dir, 'last-tick.json'), state.lastTick);
    if (overrun) { try { unlinkSync(overrunPath); } catch { /* gone */ } }
  }
  // The whole summary goes through the scrub too (the last choke point before stdout).
  return scrubDeep({
    now: new Date(now).toISOString(), durationMs, mode: config.mode, stateDir: dir, ghSampled: !!probes.prs, ghJob,
    claudeJobsArchive: claudeJobsArchive ?? null, tmpSweep: tmpSweep ?? null, ghSpend: ghSpend ?? null, probeErrors, transitions: result.transitions.map((t) => ({ type: t.type, key: t.key })),
    plan: result.plan.map(({ diagnose, ...rest }) => rest), diagnoses, notifications, investigations, reports: written,
    section: renderHealthSection(state, { now, reportDir }),
    skipped: result.evaluations.filter((e) => !e.results).map((e) => ({ smell: e.smell.id, missing: e.skipped, error: e.error })),
  });
}

function parseFlags(argv) {
  const flags = {};
  const pos = [];
  for (const a of argv) {
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const eq = a.indexOf('=');
    flags[eq === -1 ? a.slice(2) : a.slice(2, eq)] = eq === -1 ? true : a.slice(eq + 1);
  }
  return { flags, pos };
}

async function main(argv) {
  const { flags, pos } = parseFlags(argv);
  const cmd = pos[0] || 'tick';
  const dir = healthDir(flags['state-root']);
  if (cmd === 'claude-jobs-archive') {
    const config = { ...DEFAULT_HEALTH_CONFIG, ...readJson(join(dir, 'config.json'), {}) };
    const result = archiveClaudeJobs(archiveOptions(config, flags, Date.now()));
    console.log(flags.json ? JSON.stringify(result, null, 2) : formatClaudeJobsArchiveLine(result));
    return 0;
  }
  if (cmd === 'tmp-sweep') {
    const config = { ...DEFAULT_HEALTH_CONFIG, ...readJson(join(dir, 'config.json'), {}) };
    const result = await sweepOurTmp(sweepOptions(config, flags['tmp-sweep-root'] || tmpdir(), !!flags['dry-run'], Date.now()));
    console.log(flags.json ? JSON.stringify(result, null, 2) : formatTmpSweepLine(result));
    return 0;
  }
  if (cmd === 'section') { console.log(healthSectionLines({ stateRoot: flags['state-root'] }).join('\n')); return 0; }
  if (cmd === 'silence' || cmd === 'unsilence') {
    if (!flags.smell) { console.error('health-watch: --smell=<id> is required'); return 1; }
    // Only this command writes silences.json; the tick only reads it (see tick()).
    const silencesPath = join(dir, 'silences.json');
    const subject = typeof flags.subject === 'string' ? flags.subject : null;
    const silences = readJson(silencesPath, []).filter((x) => !(x.smell === flags.smell && (x.subject ?? null) === subject));
    if (cmd === 'silence') {
      if (!flags.card) { console.error('health-watch: a silence must name the tracking card (--card=NNN)'); return 1; }
      const hours = Number(flags.hours) || DEFAULT_HEALTH_CONFIG.silenceDefaultMs / 3_600_000;
      silences.push({ smell: flags.smell, subject, card: String(flags.card), expiresAt: Date.now() + hours * 3_600_000 });
    }
    writeJsonAtomic(silencesPath, silences);
    console.log(`health-watch: ${cmd}d ${flags.smell}${subject ? ` / ${subject}` : ''}`);
    return 0;
  }
  if (cmd !== 'tick') { console.error(`health-watch: unknown command "${cmd}" (tick | tmp-sweep | claude-jobs-archive | section | silence | unsilence)`); return 1; }

  // `--in-process` is the watchdog's worker child: its parent already holds the tick lock.
  const release = flags['dry-run'] || flags['in-process'] ? () => {} : acquireTickLock(dir);
  if (!release) { console.error('health-watch: another tick holds the tick lock — skipping.'); return 0; }
  const budget = (readJson(join(dir, 'config.json'), {}).tickBudgetMs) ?? DEFAULT_HEALTH_CONFIG.tickBudgetMs;
  if (flags['in-process']) {
    // The worker: runs the tick itself. Its probes block on synchronous child calls, so no timer in THIS
    // process could interrupt it — the watchdog lives in the parent (below).
    try {
      const summary = await tick(flags);
      if (flags.json) console.log(JSON.stringify(summary, null, 2));
      else {
        console.log(`health-watch: tick ${summary.now} in ${summary.durationMs}ms (${summary.mode}); transitions: ${summary.transitions.map((t) => `${t.type} ${t.key}`).join(', ') || 'none'}`);
        if (summary.claudeJobsArchive) console.log(formatClaudeJobsArchiveLine(summary.claudeJobsArchive));
        if (summary.tmpSweep) console.log(formatTmpSweepLine(summary.tmpSweep));
        console.log(summary.section.join('\n'));
      }
      return 0;
    } finally { release(); }
  }
  try {
    return await runTickWithWatchdog(argv, { dir, killAfterMs: budget * 3 });
  } finally { release(); }
}

/**
 * The whole-tick watchdog. The tick runs in a CHILD process (`tick --in-process`) and this parent — whose event
 * loop never blocks — kills it with SIGKILL after `killAfterMs` and records `overrun.json`, which the next tick
 * turns into the `health-tick-overrun` smell. (An in-process setTimeout cannot do this: the tick's synchronous
 * execFileSync probes block the very event loop the timer needs.)
 * @returns {Promise<number>} the exit code: the child's own, or 3 when the watchdog killed it
 */
export function runTickWithWatchdog(argv, { dir, killAfterMs, script = fileURLToPath(import.meta.url) }) {
  return new Promise((resolveExit) => {
    const child = spawn(process.execPath, [script, ...argv, '--in-process'], { stdio: 'inherit' });
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { writeJsonAtomic(join(dir, 'overrun.json'), { at: new Date().toISOString(), killedAfterMs: killAfterMs }); } catch { /* best effort */ }
      console.error(`health-watch: tick exceeded ${killAfterMs}ms — killed by the watchdog.`);
      child.kill('SIGKILL');
    }, killAfterMs);
    child.on('exit', (code) => { clearTimeout(timer); resolveExit(killed ? 3 : (code ?? 1)); });
    child.on('error', () => { clearTimeout(timer); resolveExit(1); });
  });
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(`health-watch: fatal: ${e?.stack || e}`); process.exitCode = 1; });
}
