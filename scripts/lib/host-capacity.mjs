/** Host-wide CPU window + hard memory floor. Load averages are display evidence only.
 * Missing/stale/short history uses two uncached top intervals; corrupt evidence holds.
 * No background sampler or cache is created here. Every IO boundary is injectable.
 */
import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import { resourcePaths } from './resource-admission.mjs';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { sampleHost } from './host-sample.mjs';
import { readHostMemoryReading } from './host-load.mjs';

export const CLASSES = Object.freeze(['blocker', 'review', 'smoke', 'build', 'background']);
const DEFAULT_IDLE = Object.freeze({ blocker: 5, review: 10, smoke: 15, build: 15, background: 25 });
const validIdle = n => Number.isFinite(n) && n >= 0 && n <= 100;
const numericEnv = n => typeof n === 'string' && n.trim() !== '' ? Number(n) : NaN;

/** Settings can tighten standard floors; invalid values retain the preceding safe value. */
export function loadCapacitySettings({ env = process.env, readFile = readFileSync,
  file = new URL('../settings/host-capacity.json', import.meta.url), log = () => {} } = {}) {
  let data;
  try { data = JSON.parse(readFile(file, 'utf8')).hostCapacity; } catch { /* standard fallback */ }
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
    if (error.code === 'ENOENT') return [];
    throw Error('unreadable sampler history');
  }
}

/** Returns measured evidence or an explicit unknown; never substitutes load average for CPU. */
export function readCapacity({ settings, env = process.env, root,
  history = readHistory, readFile, sample = sampleHost, memory = options => readHostMemoryReading(options).mb ?? NaN,
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
    const parsed = rows.map(row => {
      const time = Date.parse(row?.sampledAt);
      const idle = row?.cpu?.idlePct;
      if (!Number.isFinite(time) || time > at || !validIdle(idle)) throw Error('invalid sampler reading');
      return { time, idle };
    });
    const newest = parsed.reduce((latest, row) => Math.max(latest, row.time), -Infinity);
    const window = parsed.filter(row => row.time >= at - settings.windowSec * 1000);
    if (at - newest <= settings.maxFreshSec * 1000 && window.length >= 2) {
      source = 'resource-sampler';
      idlePct = window.reduce((sum, row) => sum + row.idle, 0) / window.length;
    } else {
      source = 'direct';
      // sampleHost's uncached read itself measures a one-second top interval.
      const samples = [sample({ ttlMs: 0 }), sample({ ttlMs: 0 })];
      if (!samples.every(s => s?.ok === true && validIdle(s.idlePct))) throw Error('invalid direct CPU sample');
      idlePct = (samples[0].idlePct + samples[1].idlePct) / 2;
    }
    const mb = memory({ env });
    if (!Number.isFinite(mb) || mb < 0) throw Error('unreadable memory headroom');
    memFreeGB = mb / 1024;
    return { idlePct, memFreeGB, source, loadAvg, loadPerCore };
  } catch (error) {
    return { idlePct, memFreeGB, source, loadAvg, loadPerCore, error: error.message };
  }
}

/** Unknown class/evidence holds until a subsequent tick obtains a valid reading. */
export function admit(cls, { read = readCapacity, settings, env = process.env, log = () => {} } = {}) {
  let reading = {}; let admitted = false; let detail;
  try {
    settings ??= loadCapacitySettings({ env, log });
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
