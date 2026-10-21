/**
 * @file scripts/operations/daemon-status-io.mjs
 * @description #4067 (epic #4075, under #3383) — the IO shell for the `daemon-status` operation: a read-only
 *   snapshot of every resident daemon on this host, joined from the SAME sources their own machinery already
 *   writes (launchd, the shared runner-lock lease files, each daemon's own log/state file, the per-clone
 *   overlay list) — never a second source of truth, never a mutation.
 *
 * DISCOVERY IS DYNAMIC, NOT A HARDCODED LIST. Every daemon this epic runs registers a `launchd` job named
 * `com.we.*` or `com.plateau.drain-daemon` (confirmed live: `review-daemon`, `fix-dispatch-daemon`,
 * `lease-reaper`, `lane-pool-health-watch-{we,frontierui,plateau-app}`,
 * `parked-pr-conflict-watch-{we,frontierui,plateau-app}`, `conveyor-pass-daemon.merge-orphan-sweep`,
 * `plateau.drain-daemon`). Reading `~/Library/LaunchAgents/*.plist` for that label pattern means a FUTURE
 * daemon (a new `pass-daemon.mjs` watcher, a new bespoke daemon) shows up on this page the moment its plist
 * is installed — no second registration this file would otherwise drift out of sync with.
 *
 * PER-DAEMON JOIN, five sources, each read-only:
 *   1. `launchctl list` — is the job currently running (a real pid), right now.
 *   2. The runner-lock lease file ({@link ../../skills-src/conveyor/runner-lock.mjs}) a daemon heartbeats —
 *      the SAME primitive {@link ./runner-activity-io.mjs} already reads for the dispatcher/fix-dispatch/
 *      review trio. `review-daemon`/`reconcile-fix-dispatch-daemon`'s lease keys are LITERAL string copies
 *      here, not imported — `runner-activity-io.mjs`'s own header explains why: importing either daemon's
 *      own lease-key constant back INTO a file several of that daemon's own dependencies transitively import
 *      closed a real ESM circular-import cycle and crashed it at startup (live-caught 2026-09-22). A daemon
 *      renaming its own lease key is already a breaking change to itself; a literal copy of a hardcoded
 *      sentinel string carries no drift risk either way. `pass-daemon.mjs`-driven watchers derive their
 *      lease key generically from the SAME formula {@link ../../skills-src/conveyor/pass-daemon.mjs}'s own
 *      `passDaemonLeaseKey` uses (also copied literally, same reasoning — that file is a CLI entry point
 *      with a real spawn side effect behind an `IS_CLI` guard, not a leaf worth importing from a status
 *      reader).
 *   3. Each daemon's OWN result record — read, never re-derived: `review-daemon`/`reconcile-fix-dispatch-
 *      daemon` log a one-line tick summary (`log.error(...)`, no per-line timestamp) to their `.conveyor/
 *      *.log`, so the last matching line in a bounded tail is the last tick's result; the plateau drain
 *      daemon instead writes a small structured `state.json` (`lastPass`) beside its (multi-megabyte) log —
 *      read that JSON, never the log, for the exact same information with a real timestamp already attached.
 *      Every other `pass-daemon.mjs` watcher (the six health/conflict watches, lease-reaper, the constellation
 *      sweeps) has no dispatch/refusal concept of its own — those get liveness + heartbeat only, plus the
 *      raw last non-noise log line for context, never an invented structured result.
 *   4. The per-clone overlay list — `scripts/lib/daemon-overlays.mjs` (Module B of #4044/#2625) is the
 *      declared owner of this format, but it is NOT imported here: that module (and the `daemon-rebuild.mjs`
 *      that writes to it) is still an OPEN pr at the time this operation is authored (#2625), and the
 *      operation engine's `compute` step must return synchronously (see `engine.mjs#advance` — no `await` on
 *      a step's `fn`), which rules out a dynamic `import()` here even once that module lands. Its ON-DISK
 *      FORMAT is already live and stable (confirmed by direct read of `~/.claude/daemon-overlays/*.json`
 *      while #2625 is still open — the daemon-rebuild machinery writes it whether or not its own library
 *      module has merged) — {@link readOverlaysForClone} is a synchronous, read-only reimplementation of
 *      exactly `daemon-overlays.mjs`'s own `cloneKey` + `overlayFilePath` + `readOverlayState` read path
 *      (same env var, same hash, same tolerant-corrupt-is-empty contract), so this page shows real overlays
 *      today and needs no edit once #2625 merges a library this file could otherwise have raced.
 *   5. That same #2625 rebuild machinery's per-clone `<cloneKey>.rebuild.json` (adopted/rejected/in-progress
 *      state) and `<cloneKey>.alerts.jsonl` (an append-only audit trail — `smoke-rejected`, `clone-held-stale`,
 *      `rejected-retry-due`, and any future kind `daemon-rebuild.mjs#alert(...)` logs, never a hardcoded
 *      enum). Same non-import reasoning and same `cloneOverlayKey` as point 4 — see {@link
 *      readRebuildStateForClone} / {@link readRecentAlertsForClone}. This is what makes "alive but refusing
 *      everything BECAUSE the rebuild is holding this clone off main" visible instead of an unexplained
 *      refusal count (live-caught 2026-09-25 08:14 ET: a clone held by a still-rejected smoke refused 6/tick
 *      with no visible reason before this read existed).
 *
 * PURE PARSERS, INJECTED IO. Every parse function here (`parseFixDispatchTick`, `parseReviewDaemonTick`,
 * `parseMergeOrphanSweepTick`, `classifyDaemonSpec`, `leaseKeyForClassification`, `cloneOverlayKey`) takes
 * plain text/objects and returns plain data — no fs, no process, no clock. Only {@link collectDaemonStatus}
 * and the small helpers it composes touch the outside world, and every one of those takes its real dependency
 * (`exec`, `fs`, `env`, `now`) as an injectable default, exactly the shape `runner-activity-io.mjs` already
 * uses, so a unit test never needs a real launchd, a real lease file, or a real daemon clone.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, openSync, readSync, closeSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join, resolve as resolvePath } from 'node:path';
import { homedir } from 'node:os';
import { gitRun } from '../lib/main-staleness.mjs';
import { lockDirFor, parseLockEntry } from '../readiness/file-locks.mjs';
import { RUNNER_LOCK_ROOT } from '../../skills-src/conveyor/runner-lock.mjs';

/** Where launchd job plists live for this user. Overridable for tests via `WE_LAUNCH_AGENTS_DIR`. */
export const WE_LAUNCH_AGENTS_DIR_ENV = 'WE_LAUNCH_AGENTS_DIR';

/** Every daemon this epic runs is labelled `com.we.*` or exactly `com.plateau.drain-daemon` — see file header. */
export function isDaemonLabel(label) {
  return typeof label === 'string' && (label.startsWith('com.we.') || label === 'com.plateau.drain-daemon');
}

export function defaultLaunchAgentsDir(env = process.env) {
  const fromEnv = typeof env?.[WE_LAUNCH_AGENTS_DIR_ENV] === 'string' ? env[WE_LAUNCH_AGENTS_DIR_ENV].trim() : '';
  return fromEnv || join(homedir(), 'Library', 'LaunchAgents');
}

const PROCESS_TIMEOUT_MS = 5_000;

/** Bounded, never-throwing child read: missing binary, non-zero exit, or a timeout all read as `null`, never
 *  crash the whole snapshot over one unreadable daemon. */
function execText(cmd, args, { timeoutMs = PROCESS_TIMEOUT_MS, exec = execFileSync } = {}) {
  try {
    return String(exec(cmd, args, {
      encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024,
    }) ?? '');
  } catch { return null; }
}

/**
 * `launchctl list`'s bare three-column table (`PID\tStatus\tLabel`, `-` for a not-currently-running job) —
 * read once, indexed by label. A failed/unavailable `launchctl` (non-macOS, sandboxed) reads as `{}`, so
 * every daemon just falls through to `running:false` rather than aborting the snapshot.
 * @returns {Record<string, {pid:number|null, status:number|null}>}
 */
export function readLaunchctlTable({ exec = execFileSync } = {}) {
  const text = execText('launchctl', ['list'], { exec });
  if (text == null) return {};
  const table = {};
  for (const line of text.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 3) continue;
    const [pidCol, statusCol, ...labelCols] = cols;
    const label = labelCols.join(' ');
    if (!isDaemonLabel(label)) continue;
    const pid = /^-?\d+$/.test(pidCol) ? Number(pidCol) : null;
    const status = /^-?\d+$/.test(statusCol) ? Number(statusCol) : null;
    table[label] = { pid, status };
  }
  return table;
}

/** `plutil -convert json -o - <path>` — the built-in macOS converter, never a hand-rolled plist/XML parser.
 *  Tolerant: a missing binary, a malformed plist, or a non-JSON-shaped result all read as `null`. */
export function readPlistAsJson(path, { exec = execFileSync } = {}) {
  const text = execText('plutil', ['-convert', 'json', '-o', '-', path], { exec });
  if (text == null) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}

/**
 * Pull the shape this operation needs out of a raw plist JSON object. Tolerant of any missing field — a
 * daemon's plist that doesn't say `WorkingDirectory`/`ProgramArguments` still gets a row (with those `null`),
 * rather than a crash that drops it from the whole snapshot.
 * @param {string} label
 * @param {object} plist
 */
export function extractDaemonSpec(label, plist) {
  const args = Array.isArray(plist?.ProgramArguments) ? plist.ProgramArguments.filter((a) => typeof a === 'string') : [];
  const clone = typeof plist?.WorkingDirectory === 'string' ? plist.WorkingDirectory : null;
  const logPath = typeof plist?.StandardOutPath === 'string' ? plist.StandardOutPath
    : typeof plist?.StandardErrorPath === 'string' ? plist.StandardErrorPath : null;
  const env = plist?.EnvironmentVariables && typeof plist.EnvironmentVariables === 'object' ? plist.EnvironmentVariables : {};
  return { label, clone, programArguments: args, logPath, env };
}

/**
 * Which daemon FAMILY this plist launches, from its own argv — never from the launchd label alone (a label
 * is an operator-chosen name; the argv is what actually runs). Pure.
 * @param {{programArguments:string[]}} spec
 * @returns {{kind:string, pass?:string}}
 */
export function classifyDaemonSpec({ programArguments = [] } = {}) {
  const scriptArg = programArguments.find((a) => a.endsWith('.mjs'));
  const script = scriptArg ? basename(scriptArg) : null;
  if (script === 'pass-daemon.mjs') {
    const passFlag = programArguments.find((a) => a.startsWith('--pass='));
    const pass = passFlag ? passFlag.slice('--pass='.length) : null;
    return pass ? { kind: 'pass-daemon', pass } : { kind: 'unknown', script };
  }
  if (script === 'review-daemon.mjs') return { kind: 'review-daemon' };
  if (script === 'reconcile-fix-dispatch-daemon.mjs') return { kind: 'fix-dispatch-daemon' };
  if (script === 'daemon.mjs') return { kind: 'drain-daemon' };
  return { kind: 'unknown', script };
}

// ── lease keys — literal copies of each daemon's own sentinel string; see the file header for why ─────────
const REVIEW_DAEMON_LEASE_KEY = '<conveyor:review-daemon-lease>';
const FIX_DISPATCH_DAEMON_LEASE_KEY = '<conveyor:reconcile-fix-dispatch-daemon-lease>';
/** Mirrors `skills-src/conveyor/pass-daemon.mjs#passDaemonLeaseKey` exactly (literal copy, see file header). */
export function passDaemonLeaseKeyMirror(passName) { return `<conveyor:pass-daemon:${passName}-lease>`; }

/**
 * The runner-lock lease key a classified daemon heartbeats under, or `null` for a daemon family with no
 * lease of its own (the plateau drain daemon tracks liveness through its own `state.json`/pid instead).
 * @param {{kind:string, pass?:string}} classification
 */
export function leaseKeyForClassification({ kind, pass } = {}) {
  if (kind === 'review-daemon') return REVIEW_DAEMON_LEASE_KEY;
  if (kind === 'fix-dispatch-daemon') return FIX_DISPATCH_DAEMON_LEASE_KEY;
  if (kind === 'pass-daemon' && pass) return passDaemonLeaseKeyMirror(pass);
  return null;
}

/** Read one lease file (never throws): `{ present:false }` missing, `{ present:true, entry }` parsed,
 *  `{ present:null, error }` an unreadable lock dir (a genuine infra error, distinct from "no lease"). */
export function readLeaseEntry(leaseKey, { lockRoot = RUNNER_LOCK_ROOT, readText = (p) => readFileSync(p, 'utf8') } = {}) {
  if (!leaseKey) return { present: false, entry: null, error: null };
  const file = join(lockDirFor(lockRoot, leaseKey), 'lock.json');
  let text;
  try { text = readText(file); }
  catch (e) { return e?.code === 'ENOENT' ? { present: false, entry: null, error: null } : { present: null, entry: null, error: e.message }; }
  const entry = parseLockEntry(text);
  return entry ? { present: true, entry, error: null } : { present: true, entry: null, error: 'malformed lease' };
}

// ── bounded log tail ─────────────────────────────────────────────────────────────────────────────────────

const DEFAULT_TAIL_BYTES = 64 * 1024;

/** Real fs ops, injectable as one bag so a test can fake a huge/rotating log without touching disk. */
const REAL_FS = { statSync, openSync, readSync, closeSync };

/**
 * The last `maxBytes` of a file, never loading the whole thing (a live daemon log can be 10MB+). Missing
 * file → `null`; any other read error is reported rather than silently swallowed as "no log yet".
 * @returns {{text:string, mtimeMs:number, truncated:boolean}|null|{error:string}}
 */
export function tailFile(path, { maxBytes = DEFAULT_TAIL_BYTES, fs = REAL_FS } = {}) {
  let stat;
  try { stat = fs.statSync(path); }
  catch (e) { return e?.code === 'ENOENT' ? null : { error: e.message }; }
  const size = stat.size;
  const start = Math.max(0, size - maxBytes);
  const length = size - start;
  if (length <= 0) return { text: '', mtimeMs: stat.mtimeMs, truncated: false };
  const fd = fs.openSync(path, 'r');
  try {
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, start);
    return { text: buf.toString('utf8'), mtimeMs: stat.mtimeMs, truncated: start > 0 };
  } finally { fs.closeSync(fd); }
}

/** Drop node's own deprecation-warning noise so "the last real line" means something. */
function meaningfulLines(text) {
  return text.split('\n').filter((l) => l.trim() && !/^\(node:\d+\)|DeprecationWarning|Use `node --trace-deprecation/.test(l));
}

/**
 * `reconcile-fix-dispatch-daemon`'s last tick, from a bounded log tail. Its one-line summary carries no
 * timestamp of its own (see file header) — pair with the lease heartbeat for "when". Per-repo failure lines
 * that follow the summary (same tick batch) are collected as `refusalDetails`, exactly what makes "alive but
 * refusing everything" visible rather than just a bare count.
 * @returns {{found:false}|{found:true, repos:string[], dispatched:number, refused:number, refusalDetails:Array<{repo:string,error:string}>, attempted:number, succeeded:number}}
 */
export function parseFixDispatchTick(text) {
  const lines = meaningfulLines(text ?? '');
  const tickRe = /^reconcile-fix-dispatch-daemon: tick \(([^)]*)\) — dispatched (\d+), refused (\d+)/;
  let lastIdx = -1;
  let match = null;
  lines.forEach((line, i) => { const m = tickRe.exec(line); if (m) { lastIdx = i; match = m; } });
  if (!match) return { found: false };
  const failRe = /^reconcile-fix-dispatch-daemon: (\S+) tick failed \(non-fatal[^)]*\): (.+)$/;
  const refusalDetails = [];
  for (let i = lastIdx + 1; i < lines.length; i += 1) {
    const fm = failRe.exec(lines[i]);
    if (fm) refusalDetails.push({ repo: fm[1], error: fm[2] });
    else if (/^reconcile-fix-dispatch-daemon: tick \(/.test(lines[i]) || /^reconcile-fix-dispatch-daemon: started on/.test(lines[i])) break;
  }
  const repos = match[1].split(',').map((s) => s.trim()).filter(Boolean);
  const dispatched = Number(match[2]);
  const refused = Number(match[3]);
  return { found: true, repos, dispatched, refused, refusalDetails, attempted: dispatched + refused, succeeded: dispatched };
}

/**
 * `review-daemon`'s last tick outcome. A thrown tick never reaches the summary line, so this also checks for
 * the `tick failed (non-fatal)` line and reports whichever of the two is MORE RECENT in the tail (by line
 * index — the log is append-only, so a later index is a later event within the window).
 * @returns {{found:false}|{found:true, tickFailed:true, error:string}|{found:true, tickFailed:false, repos:string[], owed:number, dispatched:number, failed:number, attempted:number, succeeded:number, refused:number}}
 */
export function parseReviewDaemonTick(text) {
  const lines = meaningfulLines(text ?? '');
  const tickRe = /^review-daemon: tick \(([^)]*)\) — (\d+) owed, dispatched (\d+), failed (\d+)/;
  const failedRe = /^review-daemon: tick failed \(non-fatal\): (.+)$/;
  let tick = null; let tickIdx = -1;
  let failure = null; let failureIdx = -1;
  lines.forEach((line, i) => {
    const tm = tickRe.exec(line); if (tm) { tick = tm; tickIdx = i; }
    const fm = failedRe.exec(line); if (fm) { failure = fm; failureIdx = i; }
  });
  if (failureIdx > tickIdx) return { found: true, tickFailed: true, error: failure[1] };
  if (!tick) return { found: false };
  const repos = tick[1].split(',').map((s) => s.trim()).filter(Boolean);
  const owed = Number(tick[2]);
  const dispatched = Number(tick[3]);
  const failed = Number(tick[4]);
  return { found: true, tickFailed: false, repos, owed, dispatched, failed, attempted: owed, succeeded: dispatched, refused: failed };
}

/**
 * `merge-ai-prs.mjs`'s (the `merge-orphan-sweep` pass) last run summary line — `pass timings: ... (considered
 * N, merged M)`. No per-repo refusal detail exists for this pass (it is a whole-sweep total), so `refused`
 * is derived as `considered - merged`, not read directly.
 */
export function parseMergeOrphanSweepTick(text) {
  const lines = meaningfulLines(text ?? '');
  const re = /\(considered (\d+), merged (\d+)\)/;
  let match = null;
  for (const line of lines) { const m = re.exec(line); if (m) match = m; } // last match wins
  if (!match) return { found: false };
  const considered = Number(match[1]);
  const merged = Number(match[2]);
  return { found: true, considered, merged, attempted: considered, succeeded: merged, refused: Math.max(0, considered - merged) };
}

/** Fallback for every daemon family with no bespoke parser above: just the last real line, unparsed. */
export function lastMeaningfulLine(text) {
  const lines = meaningfulLines(text ?? '');
  return lines.length ? lines[lines.length - 1] : null;
}

// ── the plateau drain daemon's own structured state.json (never its multi-MB log) ──────────────────────────

/**
 * `DRAIN_DAEMON_STATE_ROOT/state.json` — small, structured, and already has a real timestamp on `lastPass`,
 * unlike every other daemon here. Never throws: a missing/corrupt file reads as `null` (caller reports
 * `tick: {found:false}`, same as any other daemon whose tick could not be read).
 */
export function readDrainDaemonState(stateRoot, { readText = (p) => readFileSync(p, 'utf8') } = {}) {
  if (!stateRoot) return null;
  let text;
  try { text = readText(join(stateRoot, 'state.json')); } catch { return null; }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}

/**
 * The newest `[drain-daemon] <ISO> …` stamp in a drain-daemon log tail (the drain's log IS timestamped, unlike
 * the review/fix daemons'). #4077 follow-up to #4067: `state.json`'s `lastPass.at` is the pass's START time and
 * is only rewritten when a pass ENDS, so during (or right after) a long pass it reads 20+ minutes old while the
 * drain is merging — live-caught 2026-09-25 11:39 ET, flagged `alive-and-stalled` the minute it merged #2665 and
 * #2667. The log stamp is written when each pass finishes, and the log itself grows while one runs.
 * @returns {string|null} ISO timestamp
 */
export function latestDrainLogStamp(text) {
  let best = null;
  for (const m of String(text ?? '').matchAll(/^\[drain-daemon\] (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/gm)) {
    if (!best || Date.parse(m[1]) > Date.parse(best)) best = m[1];
  }
  return best;
}

/** Normalize a drain-daemon `state.json`'s `lastPass` into the same `{attempted,succeeded,refused}` shape
 *  the other bespoke parsers return, so `assessDaemonEntry` needs no daemon-kind branching for that part. */
export function normalizeDrainLastPass(lastPass) {
  if (!lastPass || typeof lastPass !== 'object') return { found: false };
  const considered = Number(lastPass.considered) || 0;
  const merged = Number(lastPass.merged) || 0;
  const failed = Number(lastPass.failed) || 0;
  const deferred = Number(lastPass.deferred) || 0;
  const skipped = Array.isArray(lastPass.skippedPrs) ? lastPass.skippedPrs.length : 0;
  return {
    found: true, at: typeof lastPass.at === 'string' ? lastPass.at : null,
    considered, merged, failed, deferred, skipped,
    attempted: considered, succeeded: merged, refused: failed + deferred + skipped,
  };
}

// ── commits behind main — read-only, never a fetch (a daemon clone is never touched by this page) ─────────

/**
 * How far a clone's checked-out `HEAD` is behind its OWN last-known `origin/main` — deliberately NOT preceded
 * by a `git fetch`: this page must never write to a live daemon's `.git` (a fetch updates remote-tracking
 * refs) while that daemon may be self-syncing/rebuilding the SAME clone concurrently. The number is exactly
 * as fresh as that clone's own last self-sync fetch, which is the daemon's own view of its distance from
 * `main` — arguably the more meaningful number for THIS page than a live re-fetch would be.
 * @returns {{behind:number}|{behind:null, reason:string}}
 */
export function countCommitsBehindOrigin(clonePath, { run = gitRun } = {}) {
  if (!clonePath) return { behind: null, reason: 'no clone path' };
  const head = run(['rev-parse', '--verify', '-q', 'HEAD'], { cwd: clonePath });
  if (head.status !== 0) return { behind: null, reason: 'not a readable git checkout' };
  const originMain = run(['rev-parse', '--verify', '-q', 'origin/main'], { cwd: clonePath });
  if (originMain.status !== 0) return { behind: null, reason: 'no local origin/main ref' };
  const count = run(['rev-list', '--count', 'HEAD..origin/main'], { cwd: clonePath });
  if (count.status !== 0 || !/^\d+$/.test(String(count.stdout).trim())) return { behind: null, reason: 'rev-list failed' };
  return { behind: Number(String(count.stdout).trim()) };
}

// ── the per-clone overlay list — synchronous read mirroring scripts/lib/daemon-overlays.mjs, see file header ─

/** Literal copy of `daemon-overlays.mjs`'s own env var name (Module B, #4044/#2625) — see file header. */
export const WE_DAEMON_OVERLAY_DIR_ENV = 'WE_DAEMON_OVERLAY_DIR';

function overlayStateDir(env) {
  const fromEnv = typeof env?.[WE_DAEMON_OVERLAY_DIR_ENV] === 'string' ? env[WE_DAEMON_OVERLAY_DIR_ENV].trim() : '';
  return fromEnv || join(homedir(), '.claude', 'daemon-overlays');
}

/** Mirrors `daemon-overlays.mjs#cloneKey` exactly: sha256 of the clone's resolved realpath, first 16 hex
 *  chars — same fallback to a plain `resolve` when the path does not exist / `realpathSync` throws. */
export function cloneOverlayKey(root) {
  let resolved;
  try { resolved = realpathSync(root); } catch { resolved = resolvePath(root); }
  return createHash('sha256').update(resolved).digest('hex').slice(0, 16);
}

/**
 * Read a clone's overlay list, synchronously, straight off disk — see the file header for why this does not
 * import `scripts/lib/daemon-overlays.mjs`. Never throws: a missing state file is an ordinary empty list
 * (`available:true, overlays:[]`); a malformed one is `corrupt:true` (never silently read as "no overlays").
 * @returns {{available:boolean, overlays:Array<object>, corrupt:boolean}}
 */
export function readOverlaysForClone(clonePath, { env = process.env, readText = (p) => readFileSync(p, 'utf8') } = {}) {
  if (!clonePath) return { available: false, overlays: [], corrupt: false };
  const file = join(overlayStateDir(env), `${cloneOverlayKey(clonePath)}.json`);
  let text;
  try { text = readText(file); }
  catch (e) { return e?.code === 'ENOENT' ? { available: true, overlays: [], corrupt: false } : { available: true, overlays: [], corrupt: true }; }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.overlays)) return { available: true, overlays: [], corrupt: true };
    return { available: true, overlays: parsed.overlays, corrupt: false };
  } catch { return { available: true, overlays: [], corrupt: true }; }
}

// ── the rebuild daemon's own per-clone state + alert trail — same non-import posture as the overlay read ───
// above (#2625/#4044 is still open; `scripts/lib/daemon-rebuild.mjs` is its declared owner but not imported
// here for the same synchronous-`compute`-step reason). Both files live at
// `<WE_DAEMON_STATE_DIR || ~/.claude/daemon-self-sync-state>/<cloneKey>.*`, keyed by the SAME `cloneOverlayKey`
// as the overlay list above (`daemon-rebuild.mjs#rebuildStatePath`/`alertsFilePath` both import that exact
// `cloneKey` from `daemon-overlays.mjs` — never re-derive their own — so mirroring it here once serves all
// three reads). This is the read that makes "alive but refusing everything BECAUSE the rebuild is holding this
// clone off main" visible instead of just an unexplained refusal count (live-caught 2026-09-25 08:14 ET: a
// clone held by a still-rejected smoke refused 6/tick with no visible reason before this).

/** Literal copy of `daemon-rebuild.mjs`'s own env var name — see the block comment above for why this is not
 *  an import. Deliberately a DIFFERENT directory than `WE_DAEMON_OVERLAY_DIR_ENV` (overlays and rebuild state
 *  are two distinct on-disk stores, never the same root). */
export const WE_DAEMON_STATE_DIR_ENV = 'WE_DAEMON_STATE_DIR';

function rebuildStateDir(env) {
  const fromEnv = typeof env?.[WE_DAEMON_STATE_DIR_ENV] === 'string' ? env[WE_DAEMON_STATE_DIR_ENV].trim() : '';
  return fromEnv || join(homedir(), '.claude', 'daemon-self-sync-state');
}

const EMPTY_REBUILD_STATE = Object.freeze({ adopted: null, rejected: null, inProgress: null, quarantine: null, unverified: null });

/**
 * `<stateDir>/<cloneKey>.rebuild.json` — mirrors `daemon-rebuild.mjs#readRebuildState` exactly: a missing or
 * corrupt file reads as the empty state (fail closed to "nothing adopted, nothing rejected, nothing in
 * progress"), never a throw.
 * @returns {{available:boolean, corrupt:boolean, state:{adopted:object|null, rejected:object|null,
 *   inProgress:object|null, quarantine:object|null, unverified:object|null}}}
 */
export function readRebuildStateForClone(clonePath, { env = process.env, readText = (p) => readFileSync(p, 'utf8') } = {}) {
  if (!clonePath) return { available: false, corrupt: false, state: { ...EMPTY_REBUILD_STATE } };
  const file = join(rebuildStateDir(env), `${cloneOverlayKey(clonePath)}.rebuild.json`);
  let text;
  try { text = readText(file); }
  catch (e) { return { available: true, corrupt: e?.code !== 'ENOENT', state: { ...EMPTY_REBUILD_STATE } }; }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return { available: true, corrupt: true, state: { ...EMPTY_REBUILD_STATE } };
    return {
      available: true, corrupt: false,
      state: {
        adopted: parsed.adopted ?? null, rejected: parsed.rejected ?? null,
        inProgress: parsed.inProgress ?? null, quarantine: parsed.quarantine ?? null,
        unverified: parsed.unverified ?? null,
      },
    };
  } catch { return { available: true, corrupt: true, state: { ...EMPTY_REBUILD_STATE } }; }
}

const DEFAULT_MAX_ALERTS = 10;

/** One JSON object per line (`{at, kind, detail}`, `daemon-rebuild.mjs`'s own `alert()` shape) — a corrupt
 *  line is dropped, never poisons the rest of the trail. */
export function parseAlertLines(text) {
  const alerts = [];
  for (const raw of (text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let parsed;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (parsed && typeof parsed === 'object' && typeof parsed.kind === 'string') {
      alerts.push({ at: typeof parsed.at === 'string' ? parsed.at : null, kind: parsed.kind, detail: parsed.detail ?? null });
    }
  }
  return alerts;
}

/**
 * The most recent rebuild alerts for a clone (e.g. `smoke-rejected`, `clone-held-stale`, `rejected-retry-due`
 * — see `daemon-rebuild.mjs`'s own `alert(...)` call sites for the full, open-ended set of kinds; this never
 * hardcodes which ones matter, so a future alert kind shows up here with no edit needed). Bounded to the last
 * `maxAlerts` entries of the last `DEFAULT_TAIL_BYTES` of the file — a long-lived alert trail is never loaded
 * whole, same posture as {@link tailFile} for daemon logs.
 * @returns {{available:boolean, alerts:Array<{at:string|null, kind:string, detail:object|null}>}}
 */
export function readRecentAlertsForClone(clonePath, { env = process.env, tailFs = REAL_FS, maxAlerts = DEFAULT_MAX_ALERTS } = {}) {
  if (!clonePath) return { available: false, alerts: [] };
  const file = join(rebuildStateDir(env), `${cloneOverlayKey(clonePath)}.alerts.jsonl`);
  const tail = tailFile(file, { fs: tailFs });
  if (!tail) return { available: true, alerts: [] };
  if (tail.error) return { available: true, alerts: [] };
  const all = parseAlertLines(tail.text);
  return { available: true, alerts: all.slice(-maxAlerts) };
}

// ── discovery + the full per-host snapshot ──────────────────────────────────────────────────────────────

/** `com.we.*`/`com.plateau.drain-daemon` launchd LABELS (never the `.plist` filename) discovered in the
 *  LaunchAgents dir. `[]` when the dir is missing or unreadable (e.g. a non-macOS test host) — never throws.
 *  Returns the bare label (extension stripped) so callers can join it against `launchctl list`'s own
 *  extension-free label column without a double `.plist.plist` suffix. */
export function listDaemonPlistFiles(dir, { readdir = readdirSync } = {}) {
  let entries;
  try { entries = readdir(dir); } catch { return []; }
  return entries
    .filter((f) => f.endsWith('.plist') && isDaemonLabel(basename(f, '.plist')))
    .map((f) => basename(f, '.plist'))
    .sort();
}

/**
 * One daemon's raw, unassessed snapshot: everything {@link ../daemon-status.mjs}'s `assess` step needs,
 * nothing it has already decided. Every sub-read is independently fail-soft (a bad plist, a missing log, an
 * unreadable lease each degrade THAT field to `null`/`found:false` — never abort the daemon's own row, and
 * never abort the snapshot).
 */
function collectOneDaemon(label, { launchAgentsDir, launchctlTable, exec, readText, tailFs, gitRunner, env }) {
  const plist = readPlistAsJson(join(launchAgentsDir, `${label}.plist`), { exec });
  if (!plist) return { name: label, label, readable: false, running: false };
  const spec = extractDaemonSpec(label, plist);
  const classification = classifyDaemonSpec(spec);
  const launchctlEntry = launchctlTable[label] ?? null;
  const running = !!(launchctlEntry && Number.isInteger(launchctlEntry.pid));
  const leaseKey = leaseKeyForClassification(classification);
  const lease = readLeaseEntry(leaseKey, { readText });

  let tick = { found: false };
  if (classification.kind === 'drain-daemon') {
    const stateRoot = typeof spec.env?.DRAIN_DAEMON_STATE_ROOT === 'string' ? spec.env.DRAIN_DAEMON_STATE_ROOT : null;
    const state = readDrainDaemonState(stateRoot, { readText });
    tick = normalizeDrainLastPass(state?.lastPass);
    // #4077: judge the drain's liveness on its newest real activity, not only on `lastPass.at` (a pass START).
    const passEnd = tick.found && tick.at && Number.isFinite(Number(state?.lastPass?.ms))
      ? new Date(Date.parse(tick.at) + Number(state.lastPass.ms)).toISOString() : tick.at ?? null;
    const tail = spec.logPath ? tailFile(spec.logPath, { fs: tailFs }) : null;
    const stamp = tail && !tail.error ? latestDrainLogStamp(tail.text) : null;
    const candidates = [passEnd, stamp, tail && !tail.error && tail.mtimeMs ? new Date(tail.mtimeMs).toISOString() : null].filter(Boolean);
    const lastActivityAt = candidates.length ? candidates.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a)) : null;
    tick = { ...tick, lastActivityAt, logMtimeMs: tail?.mtimeMs ?? null };
  } else if (spec.logPath) {
    const tail = tailFile(spec.logPath, { fs: tailFs });
    const text = tail && !tail.error ? tail.text : '';
    if (classification.kind === 'fix-dispatch-daemon') tick = { ...parseFixDispatchTick(text), logMtimeMs: tail?.mtimeMs ?? null };
    else if (classification.kind === 'review-daemon') tick = { ...parseReviewDaemonTick(text), logMtimeMs: tail?.mtimeMs ?? null };
    else if (classification.kind === 'pass-daemon' && classification.pass === 'merge-orphan-sweep') {
      tick = { ...parseMergeOrphanSweepTick(text), logMtimeMs: tail?.mtimeMs ?? null };
    } else {
      tick = { found: false, raw: lastMeaningfulLine(text), logMtimeMs: tail?.mtimeMs ?? null };
    }
  }

  const commitsBehind = countCommitsBehindOrigin(spec.clone, { run: gitRunner });
  const overlays = readOverlaysForClone(spec.clone, { env, readText });
  const rebuild = readRebuildStateForClone(spec.clone, { env, readText });
  const recentAlerts = readRecentAlertsForClone(spec.clone, { env, tailFs });

  return {
    name: label, label, readable: true, kind: classification.kind, pass: classification.pass ?? null,
    clone: spec.clone, script: classification.script ?? null,
    running, launchctlStatus: launchctlEntry?.status ?? null,
    leaseKey, lease, tick, commitsBehind, overlays, rebuild, recentAlerts,
  };
}

/**
 * The full per-host snapshot: discover every `com.we.*`/`com.plateau.drain-daemon` job, join each one's
 * liveness + lease + tick result + git distance + overlays. Every dependency is injectable (defaults to the
 * real world) so the whole thing is unit-testable without a real launchd, a real lease dir, or a real clone.
 * `exec` drives `launchctl`/`plutil` child reads; `gitRunner` drives the (fetch-free) git distance check;
 * `readText`/`readdir`/`tailFs` drive every plain filesystem read (lease files, `state.json`, overlay state,
 * log tails) — four independent seams, so a test can fake exactly the ones it cares about.
 */
export function collectDaemonStatus({
  env = process.env,
  exec = execFileSync,
  gitRunner = gitRun,
  readText = (p) => readFileSync(p, 'utf8'),
  readdir = readdirSync,
  tailFs = REAL_FS,
  now = () => new Date(),
  launchAgentsDir = defaultLaunchAgentsDir(env),
} = {}) {
  const observedAt = now().toISOString();
  const launchctlTable = readLaunchctlTable({ exec });
  const labels = listDaemonPlistFiles(launchAgentsDir, { readdir });
  const daemons = labels.map((label) => collectOneDaemon(label, { launchAgentsDir, launchctlTable, exec, readText, tailFs, gitRunner, env }));
  return { observedAt, launchAgentsDir, daemons };
}
