/** Host-wide CPU window + hard memory floor. Load averages are display evidence only.
 * Missing/stale/short or unreadable sampler history holds admission.
 * No background sampler or cache is created here. Every IO boundary is injectable.
 */
import { readFileSync } from 'node:fs';
import childProcess from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as os from 'node:os';
import { resourcePaths } from './resource-admission.mjs';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { readHostMemoryReading, parseDarwinMemoryPressureLevel } from './host-load.mjs';

export const CLASSES = Object.freeze(['blocker', 'review', 'smoke', 'build', 'background']);
const DEFAULT_IDLE = Object.freeze({ blocker: 5, review: 10, smoke: 15, build: 15, background: 25 });
const validIdle = n => Number.isFinite(n) && n >= 0 && n <= 100;
const numericEnv = n => typeof n === 'string' && n.trim() !== '' ? Number(n) : NaN;

/** Settings can tighten standard floors; invalid file values hold, invalid env overrides are ignored. */
export function loadCapacitySettings({ env = process.env, readFile = readFileSync,
  file = resolve(dirname(fileURLToPath(import.meta.url)), '../settings/host-capacity.json'), log = () => {} } = {}) {
  let data;
  try {
    const parsed = JSON.parse(readFile(file, 'utf8'));
    const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    if (!isObject(parsed) || !isObject(parsed.hostCapacity)
      || ('idlePct' in parsed.hostCapacity && !isObject(parsed.hostCapacity.idlePct))) {
      throw Error('invalid settings shape');
    }
    data = parsed.hostCapacity;
    for (const key of ['windowSec', 'maxFreshSec', 'minMemoryMb']) {
      if (Object.hasOwn(data, key) && (!Number.isFinite(data[key]) || data[key] <= 0)) {
        throw Error(`invalid ${key}`);
      }
    }
    for (const cls of CLASSES) {
      if (data.idlePct && Object.hasOwn(data.idlePct, cls) && !validIdle(data.idlePct[cls])) {
        throw Error(`invalid idlePct.${cls}`);
      }
    }
  } catch (error) {
    throw Error('host-capacity settings unreadable', { cause: error });
  }
  const sources = {};
  const setting = (key, fallback) => {
    const n = data?.[key];
    sources[key] = Number.isFinite(n) && n > 0 ? 'scripts/settings/host-capacity.json' : 'standard';
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const settings = { windowSec: setting('windowSec', 90), maxFreshSec: setting('maxFreshSec', 90),
    minMemoryMb: Math.max(2048, setting('minMemoryMb', 2048)), idlePct: {}, sources };
  for (const cls of CLASSES) {
    const key = `WE_HOST_CAPACITY_${cls.toUpperCase()}_IDLE_PCT`;
    const configured = data?.idlePct?.[cls];
    const base = validIdle(configured) ? Math.max(DEFAULT_IDLE[cls], configured) : DEFAULT_IDLE[cls];
    const override = numericEnv(env[key]);
    settings.idlePct[cls] = validIdle(override) ? Math.max(base, override) : base;
    sources[cls] = validIdle(override) && override >= base ? `env ${key}`
      : validIdle(configured) ? 'scripts/settings/host-capacity.json' : 'standard';
  }
  try { log(`host-capacity settings ${JSON.stringify(settings)}`); } catch { /* diagnostic only */ }
  return settings;
}

function readHistory({ root, env, readFile = readFileSync }) {
  try {
    const text = readFile(resourcePaths(root ?? resolveCoordinationRoot({ env })).history, 'utf8');
    return text.trim() ? text.trim().split('\n').map(line => JSON.parse(line)) : [];
  } catch (error) {
    throw Error('unreadable sampler history');
  }
}

/** Class admission requires readable macOS pressure, even when headroom is available. */
function readCapacityMemory({ platform, exec, ...options }) {
  if (platform !== 'darwin') return readHostMemoryReading({ ...options, platform, exec }).mb ?? NaN;
  let pressure;
  let level;
  try {
    pressure = exec('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { encoding: 'utf8', timeout: 5000 });
    level = parseDarwinMemoryPressureLevel(pressure);
  } catch (error) {
    throw Error('unreadable memory pressure', { cause: error });
  }
  if (level !== 'normal') return 0;
  // Reuse the validated pressure so the shared reader cannot fall back on a second failed probe.
  return readHostMemoryReading({ ...options, platform, exec: (command, args, opts) =>
    command === 'sysctl' && args[0] === '-n' && args[1] === 'kern.memorystatus_vm_pressure_level'
      ? pressure : exec(command, args, opts) }).mb ?? NaN;
}

/** Returns measured evidence or an explicit unknown; never substitutes load average for CPU. */
export function readCapacity({ settings, env = process.env, root,
  history = readHistory, readFile,
  platform = process.platform, exec = childProcess.execFileSync,
  memory = readCapacityMemory,
  now = Date.now, load = os.loadavg, cores = () => os.cpus().length } = {}) {
  let source = 'unknown'; let idlePct = null; let memFreeGB = null;
  let loadAvg = null; let loadPerCore = null;
  try {
    const l = load(); const c = cores();
    loadAvg = Array.isArray(l) ? l[0] : l;
    loadPerCore = Number.isFinite(loadAvg) && c > 0 ? loadAvg / c : null;
  } catch { /* display only */ }
  try {
    settings ??= loadCapacitySettings({ env });
    if (!Number.isFinite(settings.windowSec) || settings.windowSec <= 0
      || !Number.isFinite(settings.maxFreshSec) || settings.maxFreshSec <= 0) throw Error('invalid capacity window');
    const at = now();
    if (!Number.isFinite(at)) throw Error('invalid clock');
    const rows = history({ root, env, readFile });
    if (!Array.isArray(rows)) throw Error('invalid sampler history');
    // Rows with an unplaceable time always hold (their age is unprovable). Placeable rows older than the window
    // are ignored without validation; every in-window row is validated, and an invalid one holds admission.
    const since = at - settings.windowSec * 1000;
    const parsed = rows.map(row => {
      const time = Date.parse(row?.sampledAt);
      if (!Number.isFinite(time)) throw Error('invalid sampler reading');
      return { row, time };
    }).filter(({ time }) => time >= since).map(({ row, time }) => {
      const idle = row?.cpu?.idlePct;
      if (time > at || !validIdle(idle)) throw Error('invalid sampler reading');
      return { time, idle, freshUntil: Date.parse(row?.freshUntil) };
    });
    const window = parsed;
    const newest = window.at(-1);
    if (window.length < 3
      || window.some((row, index) => index > 0 && row.time <= window[index - 1].time)
      || newest.time - window[0].time < (settings.windowSec / 2) * 1000
      || !Number.isFinite(newest.freshUntil) || at > newest.freshUntil
      || at - newest.time > settings.maxFreshSec * 1000) {
      throw Error('missing, stale or short sampler history');
    }
    source = 'resource-sampler';
    idlePct = window.reduce((sum, row) => sum + row.idle, 0) / window.length;
    const mb = memory({ env, platform, exec });
    if (!Number.isFinite(mb) || mb < 0) throw Error('unreadable memory headroom');
    memFreeGB = mb / 1024;
    return { idlePct, memFreeGB, source, loadAvg, loadPerCore };
  } catch (error) {
    return { idlePct, memFreeGB, source, loadAvg, loadPerCore, error: error.message };
  }
}

/** Unknown class/evidence holds until a subsequent tick obtains a valid reading. */
export function admit(cls, { read = readCapacity, settings, env = process.env, log = () => {}, readFile } = {}) {
  let reading = {}; let admitted = false; let detail;
  try {
    settings ??= loadCapacitySettings({ env, log, ...(readFile ? { readFile } : {}) });
    if (!CLASSES.includes(cls)) throw Error('unknown capacity class');
    const threshold = Math.max(DEFAULT_IDLE[cls], settings.idlePct?.[cls]);
    const floor = Math.max(2048, settings.minMemoryMb);
    if (!validIdle(threshold) || !Number.isFinite(floor)) throw Error('invalid capacity settings');
    reading = read({ settings, env });
    if (reading?.error || !validIdle(reading?.idlePct) || !Number.isFinite(reading?.memFreeGB)
      || reading.memFreeGB < 0) throw Error(reading?.error ?? 'unreadable capacity');
    admitted = reading.idlePct >= threshold && reading.memFreeGB * 1024 >= floor;
    detail = `requires idle>=${threshold}% memory>=${floor}MB`;
  } catch (error) { detail = `${error.message}; hold until readable evidence on next tick`; }
  const { idlePct = null, memFreeGB = null, source = 'unknown', loadAvg = null, loadPerCore = null } = reading ?? {};
  return { admit: admitted, reason: `host-capacity ${admitted ? 'admit' : 'hold'} class=${cls} idle=${idlePct ?? 'unknown'}% mem=${memFreeGB ?? 'unknown'}GB source=${source} (loadavg ${loadAvg ?? 'unknown'}, load ${loadPerCore ?? 'unknown'}/core display only); ${detail}`,
    idlePct, memFreeGB, class: cls, source };
}
