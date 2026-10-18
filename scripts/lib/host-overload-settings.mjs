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
const leaves = {
  'host.maxWaitMs': [DEFAULT_HOST_MAX_WAIT_MS, 'WE_HOST_MAX_WAIT_MS', (v) => Number.isSafeInteger(v) && v >= 0],
  'host.maxLoadPerCore': [2, 'WE_HOST_MAX_LOAD_PER_CORE', (v) => Number.isFinite(v) && v > 0],
  'lanes.transcripts.explicitScan': [true, 'WE_LANE_TRANSCRIPT_EXPLICIT_SCAN', (v) => typeof v === 'boolean'],
  'lanes.gc.schedule': [86400000, 'WE_LANES_GC_SCHEDULE_MS', (v) => Number.isSafeInteger(v) && v >= 60000],
};
const get = (obj, path) => path.split('.').reduce((v, k) => v?.[k], obj);
const flatten = (obj) => Object.fromEntries(Object.keys(leaves).map((k) => [k, get(obj, k)]).filter(([, v]) => v !== undefined));
export function resolveHostOverloadSettings({ platform = {}, tool = {}, env = process.env, log = (s) => process.stderr.write(`${s}\n`) } = {}) {
  const envValues = {};
  for (const [k, [, name]] of Object.entries(leaves)) if (env[name] !== undefined) {
    envValues[k] = k.endsWith('explicitScan') ? (env[name] === 'true' ? true : env[name] === 'false' ? false : env[name]) : Number(env[name]);
  }
  const r = resolveCascade({ standard: Object.fromEntries(Object.entries(leaves).map(([k, [v]]) => [k, v])), platform: flatten(platform), tool: flatten(tool), envValues,
    valid: Object.fromEntries(Object.entries(leaves).map(([k, [, , valid]]) => [k, valid])) });
  if (r.invalid.length) throw Error(`host-overload invalid policy: ${r.invalid.join(', ')}`);
  const settings = { host: {}, lanes: { transcripts: {}, gc: {} } };
  for (const k of Object.keys(leaves)) {
    const parts = k.split('.'); let into = settings;
    for (const p of parts.slice(0, -1)) into = into[p];
    into[parts.at(-1)] = r.value[k];
  }
  log(`policy-cascade · host-overload: ${Object.keys(leaves).map((k) => `${k}=${r.value[k]} (${r.sources[k]})`).join(', ')}`);
  return { settings, sources: r.sources };
}
export function loadHostOverloadSettings({ env = process.env, log, toolPath = join(dirname(fileURLToPath(import.meta.url)), '../settings/host-overload.json') } = {}) {
  const p = readPlatformPreferences({ env, readFile: (path) => boundedText(path) });
  if (p.errors.length) throw Error(`host-overload: ${p.errors.join(', ')}`);
  let platform = p.prefs;
  // Existing host preferences use this location; the canonical cascade file wins when both are present.
  try { const host = JSON.parse(boundedText(env.WE_PLATFORM_PREFERENCES || join(homedir(), '.claude', 'platform-preferences.json'))); platform = { ...host, ...platform }; }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  let tool = {};
  try { tool = JSON.parse(boundedText(toolPath)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return resolveHostOverloadSettings({ platform, tool, env, log });
}
