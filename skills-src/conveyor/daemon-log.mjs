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
 *   Out of scope (68b): rotation and de-duplication.
 */
import { format } from 'node:util';
import { LOG_TIMESTAMP_RE, stripLogTimestamp, timestampLines } from '../../scripts/lib/log-timestamp.mjs';

export { LOG_TIMESTAMP_RE, stripLogTimestamp };

export const LOG_TIMESTAMP_ENV = 'WE_DAEMON_LOG_TIMESTAMPS';
/** PURE: is stamping enabled under this env? */
export function timestampsEnabled(env = process.env) {
  return !/^(?:0|off|false|no)$/i.test(String(env?.[LOG_TIMESTAMP_ENV] ?? '').trim());
}

const INSTALLED = Symbol.for('we.daemonLog.installed');

/**
 * Wrap `target`'s log/info/warn/error so each line is stamped. Idempotent. Returns a restore function.
 * @param {{ target?: Console, env?: object, now?: () => Date }} [opts]
 */
export function installDaemonLog({ target = console, env = process.env, now = () => new Date() } = {}) {
  if (!timestampsEnabled(env) || target[INSTALLED]) return () => {};
  const originals = {};
  for (const m of ['log', 'info', 'warn', 'error']) {
    const orig = target[m];
    if (typeof orig !== 'function') continue;
    originals[m] = orig;
    target[m] = (...args) => orig.call(target, timestampLines(format(...args), now().getTime()));
  }
  target[INSTALLED] = true;
  return () => { Object.assign(target, originals); delete target[INSTALLED]; };
}
