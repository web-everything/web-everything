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
 *   - De-duplication: a repeating run of single-line messages (a tick's lines; timestamp aside) seen again inside
 *     a window is suppressed and counted; when the window ends, or the run breaks, `<ISO> (repeated N times since
 *     <ISO>) <line>` lines are written (see `formatRepeatLine`, `createDeduper`). Readers replay them with
 *     `expandRepeatedLines`, so health counts AND per-tick line order stay exact.
 *     `WE_DAEMON_LOG_DEDUPE_WINDOW_MS` (default 300000; 0 turns it off).
 *   - Rotation by size: copy-truncate (launchd keeps the file open) of the daemon's own stdout and stderr logs, found
 *     by matching fd 1 / fd 2's inode against `*.log` in the daemon log dirs (or `WE_DAEMON_LOG_PATH`). Checked at most every
 *     30s. `WE_DAEMON_LOG_MAX_BYTES` (default 20 MiB; 0 turns it off), `WE_DAEMON_LOG_KEEP` (rotated files kept,
 *     default 2: `<log>.1`, `<log>.2`).
 */
import { format } from 'node:util';
import { copyFileSync, existsSync, fstatSync, readFileSync, readdirSync, renameSync, statSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOG_TIMESTAMP_RE, expandRepeatedLines, formatRepeatLine, neutralizeMarkerText, stripLogTimestamp, timestampLines } from '../../scripts/lib/log-timestamp.mjs';

export { LOG_TIMESTAMP_RE, expandRepeatedLines, formatRepeatLine, neutralizeMarkerText, stripLogTimestamp };

export const LOG_TIMESTAMP_ENV = 'WE_DAEMON_LOG_TIMESTAMPS';
/** PURE: is stamping enabled under this env? */
export function timestampsEnabled(env = process.env) {
  return !/^(?:0|off|false|no)$/i.test(String(env?.[LOG_TIMESTAMP_ENV] ?? '').trim());
}

export const DEDUPE_WINDOW_ENV = 'WE_DAEMON_LOG_DEDUPE_WINDOW_MS';
export const MAX_BYTES_ENV = 'WE_DAEMON_LOG_MAX_BYTES';
export const KEEP_ENV = 'WE_DAEMON_LOG_KEEP';
export const LOG_PATH_ENV = 'WE_DAEMON_LOG_PATH';
/** Kept well under daemon-silent's 10 min threshold: a quiet window plus the 30 s flush timer must never read as a silent daemon. */
export const DEFAULT_DEDUPE_WINDOW_MS = 5 * 60_000;
export const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
export const DEFAULT_KEEP = 2;
const ROTATE_CHECK_MS = 30_000;
/** The longest repeating run of lines (one tick's lines) the deduper will collapse. */
const MAX_PERIOD = 64;
const MAX_DEDUPE_LINE_CHARS = 8192;

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
  // The length cap bounds what the collapser retains (it holds up to MAX_PERIOD lines, twice over).
  return typeof msg === 'string' && msg !== '' && msg.length <= MAX_DEDUPE_LINE_CHARS && !msg.includes('\n') && !/^\s/.test(msg) && !/^[\]\[{}(),;]*$/.test(msg) && !msg.startsWith('(repeated');
}

/**
 * Stateful collapser of a REPEATING RUN OF LINES (a tick is several lines: the tick line, then its details), exact
 * by construction. It only suppresses a line that continues the cycle it just saw (`hist[-p]` .. `hist[-1]`, the p
 * lines before it); the first line that breaks the cycle flushes what was suppressed and is written in full. So the
 * suppressed lines are always an unbroken walk around one cycle, and the markers that stand for them (one per cycle
 * position, in walk order, counts differing by at most one) replay in EXACT original order under the readers'
 * round-robin replay — even when details change between ticks (then nothing collapses; nothing is misattributed).
 *
 * A line is `{ tag, line }`: `tag` is the console method, part of its identity, so a stdout line and the same text on
 * stderr are different lines and each marker goes out through its own method.
 *
 * `consider(line, nowMs, tag)` -> `{ markers, plain }`: write `markers` (`{ tag, line, count, since }`), in order,
 * then the line itself when `plain`. `due(nowMs)` / `drain()` -> markers to write.
 */
export function createDeduper({ windowMs = DEFAULT_DEDUPE_WINDOW_MS } = {}) {
  let hist = []; // the last <= MAX_PERIOD lines written in full: { tag, line, key, at }
  let cyc = null; // { items, pos, start, n, since }: the cycle being suppressed
  // Every flush's markers share one `since`, and no two flushes share one (strictly increasing): that is how a reader
  // tells where one cycle's markers end and the next's begin, with no separator line between them.
  let lastSince = -Infinity;
  const sinceFor = (nowMs) => { lastSince = Math.max(nowMs, lastSince + 1); return lastSince; };
  const keyOf = (tag, line) => `${tag}\u0000${line}`;
  const markers = () => {
    if (!cyc || cyc.n === 0) return [];
    const p = cyc.items.length; const base = Math.floor(cyc.n / p); const extra = cyc.n % p; const out = [];
    for (let i = 0; i < Math.min(p, cyc.n); i += 1) {
      const it = cyc.items[(cyc.start + i) % p];
      out.push({ tag: it.tag, line: it.line, count: base + (i < extra ? 1 : 0), since: cyc.since });
    }
    cyc.n = 0; cyc.since = null;
    return out;
  };
  return {
    consider(line, nowMs, tag = 'log') {
      if (!(windowMs > 0)) return { markers: [], plain: true };
      const key = keyOf(tag, line);
      if (cyc) {
        if (key === cyc.items[cyc.pos].key) {
          const at = cyc.pos;
          cyc.pos = (cyc.pos + 1) % cyc.items.length;
          if (cyc.n === 0) { cyc.start = at; cyc.since = sinceFor(nowMs); }
          cyc.n += 1;
          return { markers: [], plain: false };
        }
        const out = markers(); // the cycle broke: say what was suppressed, then write this line in full
        cyc = null; hist = [];
        hist.push({ tag, line, key, at: nowMs });
        return { markers: out, plain: true };
      }
      // Hypothesise a cycle: this line equals one written p lines ago (recently), so the p lines since then repeat.
      for (let p = 1; p <= Math.min(MAX_PERIOD, hist.length); p += 1) {
        const first = hist[hist.length - p];
        if (first.key === key && nowMs - first.at < windowMs) {
          cyc = { items: hist.slice(-p), pos: 1 % p, start: 0, n: 1, since: sinceFor(nowMs) };
          hist = [];
          return { markers: [], plain: false };
        }
      }
      hist.push({ tag, line, key, at: nowMs });
      if (hist.length > MAX_PERIOD) hist.shift();
      return { markers: [], plain: true };
    },
    // Anything suppressed for a whole window is summarised, so the log never goes quiet for longer than the window.
    due(nowMs) {
      if (!cyc || cyc.n === 0 || nowMs - cyc.since < windowMs) return [];
      return markers();
    },
    // A line the collapser cannot touch (multi-line, indented, ...) is about to be written, or the daemon is exiting:
    // summarise now so it can neither jump ahead of the suppressed lines nor be separated from them.
    drain() { const out = markers(); cyc = null; hist = []; return out; },
  };
}

/** The sidecar a reader compares to its cursor to learn, deterministically, that a rotation completed. */
export function rotationCountPath(logPath) { return `${logPath}.rot`; }

/**
 * Copy-truncate rotation: `<log>.(keep-1)` -> `<log>.keep` ... `<log>` -> `<log>.1`, then empty `<log>` in place.
 * `<log>.1` is staged under a temp name and renamed into place, so a reader never sees a half-copied file; the
 * rotation counter in `<log>.rot` is bumped LAST (after the truncate), so a reader that sees it change knows both
 * `<log>.1` and the emptied `<log>` are final. Returns true when it rotated. Never throws.
 */
export function rotateLogIfNeeded(logPath, { maxBytes = DEFAULT_MAX_BYTES, keep = DEFAULT_KEEP, fs = {} } = {}) {
  const io = { statSync, existsSync, renameSync, copyFileSync, truncateSync, unlinkSync, writeFileSync, readFileSync, ...fs };
  try {
    if (!logPath || !(maxBytes > 0) || io.statSync(logPath).size <= maxBytes) return false;
    if (io.existsSync(`${logPath}.${keep}`)) io.unlinkSync(`${logPath}.${keep}`);
    for (let i = keep - 1; i >= 1; i -= 1) if (io.existsSync(`${logPath}.${i}`)) io.renameSync(`${logPath}.${i}`, `${logPath}.${i + 1}`);
    io.copyFileSync(logPath, `${logPath}.1.tmp`);
    io.renameSync(`${logPath}.1.tmp`, `${logPath}.1`);
    io.truncateSync(logPath, 0);
    // The log IS rotated now: a failed counter bump must not report otherwise (readers fall back to the shrink check).
    try {
      let count = 0;
      try { const n = Number(String(io.readFileSync(rotationCountPath(logPath), 'utf8')).trim()); if (Number.isInteger(n) && n >= 0) count = n; } catch { /* first rotation */ }
      io.writeFileSync(`${rotationCountPath(logPath)}.tmp`, `${count + 1}\n`);
      io.renameSync(`${rotationCountPath(logPath)}.tmp`, rotationCountPath(logPath));
    } catch { /* best effort */ }
    return true;
  } catch {
    try { io.unlinkSync(`${logPath}.1.tmp`); } catch { /* nothing staged */ }
    return false;
  }
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
 * @param {{ target?: Console, env?: object, now?: () => Date, logPath?: string|null, logDirs?: string[], timers?: boolean }} [opts]
 */
export function installDaemonLog({ target = console, env = process.env, now = () => new Date(), logPath, logDirs = defaultLogDirs(), timers = true } = {}) {
  if (target[INSTALLED]) return () => {};
  const stamp = timestampsEnabled(env);
  const cfg = logSettings(env);
  const dedupe = cfg.dedupeWindowMs > 0;
  const rotate = cfg.maxBytes > 0;
  if (!stamp && !dedupe && !rotate) return () => {};
  const originals = {};
  for (const m of ['log', 'info', 'warn', 'error']) if (typeof target[m] === 'function') originals[m] = target[m];
  const deduper = createDeduper({ windowMs: cfg.dedupeWindowMs });
  // A summary goes out through the method its line was written with, so it lands in the same sink as that line.
  // One write per run of same-method markers: a flush's markers are ONE cycle, and a reader that sampled the file
  // between two of its lines would replay half a cycle (a single write lands whole).
  const flush = (list) => {
    const t = now().getTime();
    for (let i = 0; i < list.length;) {
      let j = i;
      while (j < list.length && list[j].tag === list[i].tag) j += 1;
      const text = list.slice(i, j).map((s) => formatRepeatLine(s.line, s.count, s.since, t)).join('\n');
      (originals[list[i].tag] ?? originals.log).call(target, text);
      i = j;
    }
  };
  // Only an explicit `logPath: null` (a test) turns rotation's path discovery off; unset means "find this process's
  // own stdout/stderr log" — what every real daemon wants.
  const given = logPath ?? cfg.logPath;
  let paths = given ? [given] : null; // null: not resolved yet
  let lastCheck = 0;
  const housekeeping = () => {
    const t = now().getTime();
    if (dedupe) flush(deduper.due(t));
    if (!rotate || t - lastCheck < ROTATE_CHECK_MS) return;
    lastCheck = t;
    // stdout and stderr may be different files (launchd's StandardOutPath / StandardErrorPath): cap both.
    if (!paths) paths = logPath === null ? [] : [...new Set([resolveStdoutLogPath({ dirs: logDirs, fd: 1 }), resolveStdoutLogPath({ dirs: logDirs, fd: 2 })].filter(Boolean))];
    for (const p of paths) rotateLogIfNeeded(p, { maxBytes: cfg.maxBytes, keep: cfg.keep });
  };
  for (const m of Object.keys(originals)) {
    target[m] = (...args) => {
      const msg = neutralizeMarkerText(format(...args)); // only this module writes real collapse markers
      housekeeping();
      if (dedupe) {
        const t = now().getTime();
        // A line the collapser cannot touch must not jump ahead of lines it is still holding back.
        const r = dedupable(msg) ? deduper.consider(msg, t, m) : { markers: deduper.drain(), plain: true };
        flush(r.markers);
        if (!r.plain) return;
      }
      originals[m].call(target, stamp ? timestampLines(msg, now().getTime()) : msg);
    };
  }
  let timer = null;
  if (timers && (dedupe || rotate)) { timer = setInterval(() => { try { housekeeping(); } catch { /* best effort */ } }, ROTATE_CHECK_MS); timer.unref?.(); }
  const onExit = () => { if (dedupe) flush(deduper.drain()); };
  if (timers) process.on('exit', onExit);
  target[INSTALLED] = true;
  const restore = () => {
    onExit();
    if (timer) clearInterval(timer);
    if (timers) process.off('exit', onExit);
    Object.assign(target, originals); delete target[INSTALLED];
  };
  restore.housekeeping = housekeeping; // what the timer runs; exposed so a test can drive it with a fake clock
  return restore;
}
