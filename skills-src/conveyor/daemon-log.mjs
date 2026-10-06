/**
 * @file skills-src/conveyor/daemon-log.mjs
 * @description Item 68a (card 4129) — timestamp every daemon log line. launchd redirects a daemon's stdout/stderr
 *   to its log file, so the daemon stamps its OWN console output: `installDaemonLog()` wraps console.log/info/
 *   warn/error once, prefixing each line with `2026-10-05T22:30:00.000Z `.
 *
 *   The prefix goes BEFORE the daemon name (`<ISO> review-daemon: tick (...)`). Every log parser anchors on
 *   `^name:`, so each one calls {@link stripLogTimestamp} first; old unstamped lines pass through unchanged, so
 *   a file that mixes old and new lines parses uniformly.
 *
 *   Setting: `WE_DAEMON_LOG_TIMESTAMPS=0` (or `off`/`false`) turns stamping off. Default is on.
 *
 *   Item 68b adds two more declared settings, both with safe defaults:
 *   - De-duplication: an identical single-line message (timestamp aside) seen again inside a window is
 *     suppressed and counted; when the window ends one `<ISO> (repeated N times since <ISO>) <line>` line is written
 *     (see `formatRepeatLine`). Readers replay that line with `expandRepeatedLines`, so health counts stay exact.
 *     `WE_DAEMON_LOG_DEDUPE_WINDOW_MS` (default 600000; 0 turns it off).
 *   - Rotation by size: copy-truncate (launchd keeps the file open) of the daemon's own stdout log, found by
 *     matching fd 1's inode against `*.log` in the daemon log dirs (or `WE_DAEMON_LOG_PATH`). Checked at most every
 *     30s. `WE_DAEMON_LOG_MAX_BYTES` (default 20 MiB; 0 turns it off), `WE_DAEMON_LOG_KEEP` (rotated files kept,
 *     default 2: `<log>.1`, `<log>.2`).
 */
import { format } from 'node:util';
import { copyFileSync, existsSync, fstatSync, readdirSync, renameSync, statSync, truncateSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOG_TIMESTAMP_RE, expandRepeatedLines, formatRepeatLine, stripLogTimestamp, timestampLines } from '../../scripts/lib/log-timestamp.mjs';

export { LOG_TIMESTAMP_RE, expandRepeatedLines, formatRepeatLine, stripLogTimestamp };

export const LOG_TIMESTAMP_ENV = 'WE_DAEMON_LOG_TIMESTAMPS';
/** PURE: is stamping enabled under this env? */
export function timestampsEnabled(env = process.env) {
  return !/^(?:0|off|false|no)$/i.test(String(env?.[LOG_TIMESTAMP_ENV] ?? '').trim());
}

export const DEDUPE_WINDOW_ENV = 'WE_DAEMON_LOG_DEDUPE_WINDOW_MS';
export const MAX_BYTES_ENV = 'WE_DAEMON_LOG_MAX_BYTES';
export const KEEP_ENV = 'WE_DAEMON_LOG_KEEP';
export const LOG_PATH_ENV = 'WE_DAEMON_LOG_PATH';
export const DEFAULT_DEDUPE_WINDOW_MS = 10 * 60_000;
export const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
export const DEFAULT_KEEP = 2;
const ROTATE_CHECK_MS = 30_000;
const MAX_TRACKED = 500;

function nonNegInt(v, dflt) {
  if (v == null || String(v).trim() === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt;
}
/** PURE: the declared 68b settings under `env`, bad values falling back to the safe default. */
export function logSettings(env = process.env) {
  return {
    dedupeWindowMs: nonNegInt(env?.[DEDUPE_WINDOW_ENV], DEFAULT_DEDUPE_WINDOW_MS),
    maxBytes: nonNegInt(env?.[MAX_BYTES_ENV], DEFAULT_MAX_BYTES),
    keep: Math.max(1, nonNegInt(env?.[KEEP_ENV], DEFAULT_KEEP)),
    logPath: env?.[LOG_PATH_ENV] ? String(env[LOG_PATH_ENV]) : null,
  };
}

/**
 * PURE: may this message be collapsed? Only a single non-blank line that does not start with whitespace and is not
 * bare punctuation, so a pretty-printed multi-line object is never thinned out.
 */
export function dedupable(msg) {
  return typeof msg === 'string' && msg !== '' && !msg.includes('\n') && !/^\s/.test(msg) && !/^[\]\[{}(),;]*$/.test(msg);
}

/**
 * Stateful collapser. `consider(line, nowMs)` -> true when the line must be written, false when it is a repeat that
 * was counted instead. `due(nowMs)` / `drain()` return `{ line, count, since }` summaries to write.
 */
export function createDeduper({ windowMs = DEFAULT_DEDUPE_WINDOW_MS } = {}) {
  const seen = new Map(); // line -> { since, count }
  const take = (key, e) => { seen.delete(key); return e.count > 0 ? { line: key, count: e.count, since: e.since } : null; };
  return {
    consider(line, nowMs) {
      if (!(windowMs > 0)) return true;
      const e = seen.get(line);
      if (e) { e.count += 1; return false; }
      seen.set(line, { since: nowMs, count: 0 });
      return true;
    },
    due(nowMs) {
      const out = [];
      for (const [key, e] of [...seen]) {
        if (nowMs - e.since >= windowMs || seen.size > MAX_TRACKED) { const s = take(key, e); if (s) out.push(s); else seen.delete(key); }
      }
      return out;
    },
    drain() { return [...seen].map(([k, e]) => take(k, e)).filter(Boolean); },
  };
}

/**
 * Copy-truncate rotation: `<log>.(keep-1)` -> `<log>.keep` ... `<log>` -> `<log>.1`, then empty `<log>` in place.
 * Returns true when it rotated. Never throws.
 */
export function rotateLogIfNeeded(logPath, { maxBytes = DEFAULT_MAX_BYTES, keep = DEFAULT_KEEP, fs = {} } = {}) {
  const io = { statSync, existsSync, renameSync, copyFileSync, truncateSync, unlinkSync, ...fs };
  try {
    if (!logPath || !(maxBytes > 0) || io.statSync(logPath).size <= maxBytes) return false;
    if (io.existsSync(`${logPath}.${keep}`)) io.unlinkSync(`${logPath}.${keep}`);
    for (let i = keep - 1; i >= 1; i -= 1) if (io.existsSync(`${logPath}.${i}`)) io.renameSync(`${logPath}.${i}`, `${logPath}.${i + 1}`);
    io.copyFileSync(logPath, `${logPath}.1`);
    io.truncateSync(logPath, 0);
    return true;
  } catch { return false; }
}

const HERE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export function defaultLogDirs() {
  return [join(HERE_ROOT, '.conveyor'), join(homedir(), 'workspace/.operations/coordination')];
}
/** IO: the path of the regular file fd `fd` writes to, found by inode among `*.log` in `dirs`; null if none. */
export function resolveStdoutLogPath({ dirs = defaultLogDirs(), fd = 1 } = {}) {
  try {
    const me = fstatSync(fd);
    if (!me.isFile()) return null;
    for (const dir of dirs) {
      let names; try { names = readdirSync(dir); } catch { continue; }
      for (const n of names) {
        if (!n.endsWith('.log')) continue;
        try { const st = statSync(join(dir, n)); if (st.ino === me.ino && st.dev === me.dev) return join(dir, n); } catch { /* vanished */ }
      }
    }
  } catch { /* not resolvable */ }
  return null;
}

const INSTALLED = Symbol.for('we.daemonLog.installed');

/**
 * Wrap `target`'s log/info/warn/error so each line is stamped, identical repeats are collapsed and the daemon's own
 * stdout log is size-rotated. Idempotent. Returns a restore function.
 * @param {{ target?: Console, env?: object, now?: () => Date, logPath?: string|null, timers?: boolean }} [opts]
 */
export function installDaemonLog({ target = console, env = process.env, now = () => new Date(), logPath, timers = true } = {}) {
  if (target[INSTALLED]) return () => {};
  const stamp = timestampsEnabled(env);
  const cfg = logSettings(env);
  const dedupe = cfg.dedupeWindowMs > 0;
  const rotate = cfg.maxBytes > 0;
  if (!stamp && !dedupe && !rotate) return () => {};
  const originals = {};
  for (const m of ['log', 'info', 'warn', 'error']) if (typeof target[m] === 'function') originals[m] = target[m];
  const emit = (text) => originals.log.call(target, stamp ? timestampLines(text, now().getTime()) : text);
  const deduper = createDeduper({ windowMs: cfg.dedupeWindowMs });
  const flush = (list) => { for (const s of list) originals.log.call(target, formatRepeatLine(s.line, s.count, s.since, now().getTime())); };
  let path = logPath === undefined ? cfg.logPath : logPath;
  let resolved = path !== undefined && path !== null;
  let lastCheck = 0;
  const housekeeping = () => {
    const t = now().getTime();
    if (dedupe) flush(deduper.due(t));
    if (!rotate || t - lastCheck < ROTATE_CHECK_MS) return;
    lastCheck = t;
    if (!resolved) { path = resolveStdoutLogPath(); resolved = true; }
    if (path) rotateLogIfNeeded(path, { maxBytes: cfg.maxBytes, keep: cfg.keep });
  };
  for (const m of Object.keys(originals)) {
    target[m] = (...args) => {
      const msg = format(...args);
      housekeeping();
      if (dedupe && dedupable(msg) && !deduper.consider(msg, now().getTime())) return;
      originals[m].call(target, stamp ? timestampLines(msg, now().getTime()) : msg);
    };
  }
  let timer = null;
  if (timers && (dedupe || rotate)) { timer = setInterval(() => { try { housekeeping(); } catch { /* best effort */ } }, ROTATE_CHECK_MS); timer.unref?.(); }
  const onExit = () => { if (dedupe) flush(deduper.drain()); };
  if (timers) process.on('exit', onExit);
  target[INSTALLED] = true;
  return () => {
    onExit();
    if (timer) clearInterval(timer);
    if (timers) process.off('exit', onExit);
    Object.assign(target, originals); delete target[INSTALLED];
  };
}
