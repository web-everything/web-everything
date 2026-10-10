/**
 * @file scripts/lib/builder-launch-policy.mjs
 * @description `builder.maxLaunchesPerTick` — how many NEW launches (builds + item prepares together) the build-dispatch
 *   daemon may start in one tick — resolved through the policy cascade (agent-memory 151 "policy cascade = team
 *   practice"; card x3mdsyv):
 *
 *     1. STANDARD default (Ship Evermore) — `'free-slots'`: launch as many as the free prepare and build slots allow.
 *        Every launch still passes every admission check (cost, host load, heavy, open-PR cap, freeze, scope).
 *     2. PLATFORM preference (Platform Forever, team level) — `we:scripts/lib/delivery-platform-preferences.json`, key
 *        `builder.maxLaunchesPerTick` (the same home as `mergeDelivery`, PR #4708). A missing file = layer not set.
 *     3. TOOL / project override — the `builder.maxLaunchesPerTick` leaf of the declared settings files
 *        (`we:scripts/settings/*.json`, read through `settings-files.mjs#readSettings`).
 *     4. ENV — `WE_BUILDER_MAX_LAUNCHES_PER_TICK` (an operator's one-off override on the daemon host).
 *
 *   Values: a positive integer N (1 = the old one-launch-per-tick behaviour) or `'free-slots'` (no extra bound).
 *   An invalid value never overrides a lower layer; it is reported in `invalid`. `source` names the layer that set the
 *   effective value; the daemon logs it once per process (`formatBuilderLaunchPolicyLine`).
 *
 *   PURE except `loadBuilderLaunchPolicy` (reads the two files; never throws).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSettings } from './settings-files.mjs';

export const BUILDER_POLICY_KEY = 'builder';
export const FREE_SLOTS = 'free-slots';
export const MAX_LAUNCHES_ENV = 'WE_BUILDER_MAX_LAUNCHES_PER_TICK';
export const STANDARD_BUILDER_LAUNCH = Object.freeze({ maxLaunchesPerTick: FREE_SLOTS });
export const PLATFORM_PREFERENCES_PATH = join(dirname(fileURLToPath(import.meta.url)), 'delivery-platform-preferences.json');

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const valid = (v) => v === FREE_SLOTS || (Number.isInteger(v) && v >= 1 && v <= 100);

/** Pure. `platform`/`tool` are raw `builder` blocks; `env` is a process.env-like object. */
export function resolveBuilderLaunchPolicy({ platform, tool, env } = {}) {
  let value = STANDARD_BUILDER_LAUNCH.maxLaunchesPerTick;
  let source = 'standard';
  const invalid = [];
  for (const [name, layer] of [['platform', platform], ['tool', tool]]) {
    if (layer === undefined || layer === null) continue;
    if (!isObj(layer)) { invalid.push(`${name}: not an object`); continue; }
    if (!Object.hasOwn(layer, 'maxLaunchesPerTick')) continue;
    if (!valid(layer.maxLaunchesPerTick)) { invalid.push(`${name}.maxLaunchesPerTick=${JSON.stringify(layer.maxLaunchesPerTick)}`); continue; }
    value = layer.maxLaunchesPerTick;
    source = name;
  }
  const raw = isObj(env) ? env[MAX_LAUNCHES_ENV] : undefined;
  if (raw !== undefined && raw !== '') {
    const v = raw === FREE_SLOTS ? FREE_SLOTS : /^\d+$/.test(String(raw)) ? Number(raw) : raw;
    if (valid(v)) { value = v; source = 'env'; } else invalid.push(`env.${MAX_LAUNCHES_ENV}=${JSON.stringify(raw)}`);
  }
  return { maxLaunchesPerTick: value, limit: value === FREE_SLOTS ? Infinity : value, source, invalid };
}

/** One log line: the effective value and the layer that set it. */
export function formatBuilderLaunchPolicyLine(p) {
  const bad = p?.invalid?.length ? ` · ignored invalid: ${p.invalid.join('; ')}` : '';
  return `builder launch policy: maxLaunchesPerTick=${p?.maxLaunchesPerTick} (${p?.source ?? 'standard'})${bad}`;
}

/** IO: read the platform file and the tool settings layer. Never throws. */
export function loadBuilderLaunchPolicy({ platformPath = PLATFORM_PREFERENCES_PATH, toolSettings, env = process.env, readFile = readFileSync } = {}) {
  const readErrors = [];
  let platform;
  try { platform = JSON.parse(readFile(platformPath, 'utf8'))?.[BUILDER_POLICY_KEY]; }
  catch (e) { if (e?.code !== 'ENOENT') readErrors.push(`platform file unreadable: ${String(e?.message ?? e).split('\n')[0]}`); }
  let tool;
  try { tool = (toolSettings === undefined ? readSettings() : toolSettings)?.[BUILDER_POLICY_KEY]; }
  catch (e) { readErrors.push(`tool settings unreadable: ${String(e?.message ?? e).split('\n')[0]}`); }
  const policy = resolveBuilderLaunchPolicy({ platform, tool, env });
  return { ...policy, invalid: [...readErrors, ...policy.invalid] };
}
