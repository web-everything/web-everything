/** Bounded fseventsd RSS probe and persistent admission signal. RSS from ps is KiB. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { boundedText, hostStateRoot } from './host-overload-settings.mjs';
import { readVolumeSettings } from './lanes-volume-settings.mjs';
import { appendDaemonEvent } from './daemon-events.mjs';

export const fseventsdStatePath = () => join(hostStateRoot(), 'fseventsd-rss.json');
/** Reject incomplete/malformed process evidence instead of reporting zero RSS. */
export function parseFseventsdRss(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 4 * 1024 * 1024) throw Error('invalid ps RSS evidence');
  let kb = 0;
  for (const line of text.trim().split('\n')) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) throw Error('invalid ps RSS row');
    if (match[2].split('/').at(-1) === 'fseventsd') kb += Number(match[1]);
  }
  if (!Number.isSafeInteger(kb)) throw Error('ps RSS sum overflow');
  return kb / 1024;
}
export function sampleFseventsdRss({ run = execFileSync } = {}) {
  return parseFseventsdRss(run('ps', ['-axo', 'rss=,comm='], { encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024 }));
}
export function fseventsdThresholds(options) {
  const { value, sources } = readVolumeSettings(options);
  return { warnMb: value['health.fseventsd.warnMb'], throttleMb: value['health.fseventsd.throttleMb'], sources };
}
/** Pure hysteresis: unknown evidence holds admission; recovery requires a known reading. */
export function nextFseventsdState(rssMb, { warnMb, throttleMb }, previous = {}) {
  const known = Number.isFinite(rssMb) && rssMb >= 0;
  const throttled = !known || rssMb >= throttleMb || (previous.throttled === true && rssMb >= throttleMb * 0.9);
  return { rssMb: known ? rssMb : null, warnMb, throttleMb, throttled,
    level: !known ? 'unknown' : throttled ? 'throttle' : rssMb >= warnMb ? 'warn' : 'clear' };
}
// Fresh evidence has a fixed three-minute lifetime, independent of settings;
// stale CLEAR is ignored (it cannot attest recovery). Stale THROTTLED is held
// for at most 15 minutes, then ignored with a diagnostic so a dead monitor cannot
// wedge admission forever. Missing/invalid/future timestamps are ignored too.
export const FSEVENTSD_SIGNAL_MAX_AGE_MS = 3 * 60_000;
export const FSEVENTSD_THROTTLE_MAX_AGE_MS = 15 * 60_000;
/** Absent/stale signals are ignored; corrupt/unreadable state refuses new grants. */
export function readFseventsdSignal({ path = fseventsdStatePath(), read = boundedText, now = Date.now, log = console.error } = {}) {
  try {
    const state = JSON.parse(read(path));
    if (typeof state.throttled !== 'boolean') throw Error('invalid fseventsd signal');
    const sampled = typeof state.sampledAt === 'string' ? Date.parse(state.sampledAt) : NaN;
    const age = now() - sampled;
    if (!Number.isFinite(age) || age < 0 || age > (state.throttled ? FSEVENTSD_THROTTLE_MAX_AGE_MS : FSEVENTSD_SIGNAL_MAX_AGE_MS)) {
      log('fseventsd RSS signal ignored: stale/invalid sampledAt; health-watch must refresh it');
      return { throttled: false, level: 'unknown', ignored: true, reason: 'stale fseventsd signal' };
    }
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return { throttled: false, level: 'clear' };
    return { throttled: true, level: 'unknown', reason: 'unreadable fseventsd signal; health-watch must refresh it' };
  }
}
/** One tick writes atomically and emits transitions on the daemon event stream consumed by monitors. */
export async function checkFseventsdRss({ path = fseventsdStatePath(), sample = sampleFseventsdRss,
  thresholds = fseventsdThresholds(), emit = appendDaemonEvent, log = console.error, now = Date.now,
  write = state => { mkdirSync(dirname(path), { recursive: true }); const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state) + '\n', { mode: 0o600 }); renameSync(tmp, path); },
  previous = readFseventsdSignal({ path }),
} = {}) {
  let rssMb = null;
  try { rssMb = sample(); } catch { /* unknown measurements retain the throttle until a successful probe */ }
  const state = { ...nextFseventsdState(rssMb, thresholds, previous), sampledAt: new Date(now()).toISOString() };
  write(state);
  if (previous.level !== state.level) {
    if (state.level !== 'clear') log(`fseventsd RSS ${state.rssMb ?? 'unknown'} MB: ${state.level}; warn=${state.warnMb}, throttle=${state.throttleMb} MB`);
    await emit({ kind: `fseventsd-rss-${state.level}`, daemon: 'health-watch', detail: state });
  }
  return state;
}
