/** Host overload policy: standard → platform preferences → tool → environment.
 * Invalid/unreadable policy refuses background work. All reads are bounded; sources go to stderr.
 */
import { openSync, readSync, closeSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCascade, readPlatformPreferences } from './policy-cascade.mjs';
export const hostStateRoot = () => join(userInfo().homedir, '.cache', 'we-host-overload');
export function boundedText(path, maxBytes = 256 * 1024) {
  const fd = openSync(path, 'r');
  try {
    const bytes = Buffer.alloc(maxBytes + 1);
    let count = 0;
    while (count < bytes.length) { const n = readSync(fd, bytes, count, bytes.length - count, null); if (!n) break; count += n; }
    if (count > maxBytes) throw Error('bounded read exceeded');
    return bytes.subarray(0, count).toString('utf8');
  } finally { closeSync(fd); }
}
export const DEFAULT_HOST_MAX_WAIT_MS = 15 * 60 * 1000;
export const DEFAULT_MIN_MEMORY_HEADROOM_MB = 2048;
const leaves = {
  'host.maxWaitMs': [DEFAULT_HOST_MAX_WAIT_MS, 'WE_HOST_MAX_WAIT_MS', (v) => Number.isSafeInteger(v) && v >= 0],
  'host.maxLoadPerCore': [2, 'WE_HOST_MAX_LOAD_PER_CORE', (v) => Number.isFinite(v) && v > 0],
  // verify-admission (2026-10-20) — memory-aware admission: free RAM (free + speculative + purgeable pages, NOT the
  // inactive file cache) plus free swap must be at least this many MB before a new background heavy job starts.
  // Live case: 616 MB free, swap 5.0/6.1 GB, ~30 review/verify processes. 0 is invalid: the check cannot be switched off.
  'host.minMemoryHeadroomMb': [DEFAULT_MIN_MEMORY_HEADROOM_MB, 'WE_HOST_MIN_MEMORY_HEADROOM_MB', (v) => Number.isFinite(v) && v > 0],
  // At most this many NEW review sessions per review-daemon tick while the host admits, so memory is re-sampled
  // between waves instead of one tick launching ten 600 MB review jobs at once. Owed reviews stay queued.
  'host.maxReviewDispatchPerTick': [2, 'WE_HOST_MAX_REVIEW_DISPATCH_PER_TICK', (v) => Number.isSafeInteger(v) && v >= 1],
  'lanes.transcripts.explicitScan': [true, 'WE_LANE_TRANSCRIPT_EXPLICIT_SCAN', (v) => typeof v === 'boolean'],
  'lanes.gc.schedule': [86400000, 'WE_LANES_GC_SCHEDULE_MS', (v) => Number.isSafeInteger(v) && v >= 60000],
};
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// Validate whole schema leaves BEFORE the generic cascade walks objects. Otherwise an empty
// object disappears, and a nested boolean can turn explicitScan into a truthy object.
function flatten(obj, layer) {
  const values = {};
  for (const [key, [, , valid]] of Object.entries(leaves)) {
    const parts = key.split('.');
    let value = obj;
    for (let i = 0; i < parts.length; i++) {
      if (!isObject(value)) throw Error(`host-overload invalid policy: ${layer}.${parts.slice(0, i).join('.')} must be an object`);
      if (!Object.hasOwn(value, parts[i])) { value = undefined; break; }
      value = value[parts[i]];
      if (i === parts.length - 1 && !valid(value)) throw Error(`host-overload invalid policy: ${layer}.${key}`);
    }
    if (value !== undefined) values[key] = value;
  }
  return values;
}
function expand(values) {
  const settings = { host: {}, lanes: { transcripts: {}, gc: {} } };
  for (const [key, value] of Object.entries(values)) {
    const parts = key.split('.'); let into = settings;
    for (const p of parts.slice(0, -1)) into = into[p];
    into[parts.at(-1)] = value;
  }
  return settings;
}
export function resolveHostOverloadSettings({ platform = {}, tool = {}, env = process.env, log = (s) => process.stderr.write(`${s}\n`) } = {}) {
  const envValues = {};
  for (const [k, [, name]] of Object.entries(leaves)) if (env[name] !== undefined) {
    envValues[k] = k.endsWith('explicitScan') ? (env[name] === 'true' ? true : env[name] === 'false' ? false : env[name]) : Number(env[name]);
  }
  const r = resolveCascade({ standard: Object.fromEntries(Object.entries(leaves).map(([k, [v]]) => [k, v])), platform: flatten(platform, 'platform'), tool: flatten(tool, 'tool'), envValues,
    valid: Object.fromEntries(Object.entries(leaves).map(([k, [, , valid]]) => [k, valid])) });
  if (r.invalid.length) throw Error(`host-overload invalid policy: ${r.invalid.join(', ')}`);
  const settings = expand(r.value);
  log(`policy-cascade · host-overload: ${Object.keys(leaves).map((k) => `${k}=${r.value[k]} (${r.sources[k]})`).join(', ')}`);
  return { settings, sources: r.sources };
}
export function loadHostOverloadSettings({ env = process.env, log, toolPath = join(dirname(fileURLToPath(import.meta.url)), '../settings/host-overload.json') } = {}) {
  const canonical = {};
  const p = readPlatformPreferences({ env, readFile: (path) => {
    const text = boundedText(path);
    // Preserve sibling leaves across the canonical reader's legacy/default files too.
    // Validate each file before merging, so later overrides cannot conceal invalid policy.
    Object.assign(canonical, flatten(JSON.parse(text), 'platform'));
    return text;
  } });
  if (p.errors.length) throw Error(`host-overload: ${p.errors.join(', ')}`);
  let legacy = {};
  // Existing host preferences use this location; the canonical cascade file wins when both are present.
  try { legacy = flatten(JSON.parse(boundedText(env.WE_PLATFORM_PREFERENCES || join(homedir(), '.claude', 'platform-preferences.json'))), 'platform legacy'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  let tool = {};
  try { tool = JSON.parse(boundedText(toolPath)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return resolveHostOverloadSettings({ platform: expand({ ...legacy, ...canonical }), tool, env, log });
}
