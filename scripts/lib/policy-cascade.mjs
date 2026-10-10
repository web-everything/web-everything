/**
 * @file scripts/lib/policy-cascade.mjs
 * @description THE policy cascade every delivery setting resolves through (agent-memory 151 "policy cascade = team
 *   practice"; card x5wnfcg #5600; operator go 2026-10-10). Generalised from the per-key resolver in PR #4708's
 *   `merge-delivery-policy.mjs`, so every setting shares one resolver instead of each re-implementing the layers:
 *
 *     1. STANDARD default (Ship Evermore) — the reader's own built-in value.
 *     2. PLATFORM preference (Platform Forever, team level, shared by every tool) — the policy's key in
 *        `we:scripts/lib/delivery-platform-preferences.json` (PR #4708's home until Platform Forever has its own
 *        store), over the legacy platform file `we:scripts/lib/delivery-priority-settings.json`. Env
 *        `WE_PLATFORM_PREFERENCES_FILE` replaces both (tests, a one-off live proof).
 *     3. TOOL / repo override (Longshore settings) — the reader's settings file block (`we:scripts/settings/*.json`
 *        or its own per-feature file). Only when this repo deliberately differs from the team.
 *     4. ENV — the reader's existing env override (unchanged; each reader keeps its own env parsing).
 *
 *   Each LEAF resolves independently: the tool value when it is set AND valid, else the platform's, else the
 *   reader's standard default. An invalid value never overrides a lower layer; it is named in `invalid`.
 *
 *   SOURCE LOG: {@link cascadePolicy} prints one `policy-cascade · <policy>: leaf=value (layer), …` line per process
 *   per distinct effective set, so a long-running daemon logs each setting's source once (and again only if it
 *   changes). It logs only inside a daemon (one that ran `installDaemonLog()`, or whose entry is a `*-daemon.mjs`, so
 *   the line lands in the daemon's log) or when `WE_POLICY_CASCADE_LOG=1` — never into a short CLI's stderr that a caller may parse.
 *   `WE_POLICY_CASCADE_LOG=0` turns it off; silent under test unless `=1`.
 *
 *   Never throws. A missing platform file is "layer not set"; an unreadable one is skipped and named in `errors`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isUnderTest } from './under-test.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PLATFORM_PREFERENCES_PATH = join(HERE, 'delivery-platform-preferences.json');
/** The older platform-layer file (deliveryPriority). Read under the main file; the main file wins per key. */
export const LEGACY_PLATFORM_PREFERENCES_PATHS = Object.freeze([join(HERE, 'delivery-priority-settings.json')]);
export const PLATFORM_PREFERENCES_ENV = 'WE_PLATFORM_PREFERENCES_FILE';
export const POLICY_CASCADE_LOG_ENV = 'WE_POLICY_CASCADE_LOG';
export const CASCADE_LAYERS = Object.freeze(['standard', 'platform', 'tool', 'env']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * IO: every platform preference, keyed by policy. Never throws.
 * @returns {{prefs:object, errors:string[]}}
 */
export function readPlatformPreferences({ env = process.env, readFile = readFileSync } = {}) {
  const override = String(env?.[PLATFORM_PREFERENCES_ENV] ?? '').trim();
  const paths = override ? [override] : [...LEGACY_PLATFORM_PREFERENCES_PATHS, PLATFORM_PREFERENCES_PATH];
  const prefs = {};
  const errors = [];
  for (const path of paths) {
    try {
      const data = JSON.parse(String(readFile(path, 'utf8')));
      if (!isObj(data)) { errors.push(`${path}: not a JSON object`); continue; }
      for (const [k, v] of Object.entries(data)) if (!UNSAFE.has(k) && !k.startsWith('$')) prefs[k] = v;
    } catch (e) {
      if (e?.code !== 'ENOENT') errors.push(`${path}: ${String(e?.message ?? e).split('\n')[0]}`);
    }
  }
  return { prefs, errors };
}

/** IO: one policy's platform preference (`undefined` when the team set none). Never throws. */
export function platformPreference(policy, o) {
  return readPlatformPreferences(o).prefs[policy];
}

/** PURE: leaf path arrays → values of a plain object (arrays and scalars are leaves; a key may contain dots, e.g.
 *  `enabled["review-daemon.mjs"]`). A non-object is the single leaf `[]`. Keyed by the NUL-joined path. */
const SEP = '\u0000';
function leaves(v, prefix = [], out = new Map()) {
  if (!isObj(v)) { if (v !== undefined) out.set(prefix.join(SEP), { path: prefix, v }); return out; }
  for (const [k, x] of Object.entries(v)) {
    if (UNSAFE.has(k)) continue;
    const p = [...prefix, k];
    if (isObj(x)) leaves(x, p, out); else if (x !== undefined) out.set(p.join(SEP), { path: p, v: x });
  }
  return out;
}

function setLeaf(obj, parts, value) {
  let o = obj;
  for (const k of parts.slice(0, -1)) { if (!isObj(o[k])) o[k] = {}; o = o[k]; }
  o[parts.at(-1)] = value;
}

/**
 * PURE: resolve one policy through the four layers.
 * @param {{standard?:unknown, platform?:unknown, tool?:unknown, envValues?:Record<string,unknown>,
 *   valid?:Record<string,(v:unknown)=>boolean>|((v:unknown)=>boolean)}} layers
 *   `standard` / `platform` / `tool` are blocks of the same shape (or scalars). `envValues` maps a TOP-LEVEL key ('' for
 *   a scalar policy) → an already parsed env value (undefined = env not set). `valid` is one predicate (scalar
 *   policy) or top-level key → predicate; a key with no predicate accepts any value.
 * @returns {{value:unknown, sources:Record<string,string>, leafValues:Record<string,unknown>, invalid:string[]}}
 *   `sources` names the layer of every effective leaf, keyed by its dotted path ('' for a scalar policy).
 */
export function resolveCascade({ standard, platform, tool, envValues = {}, valid = {} } = {}) {
  const check = (path, v) => (typeof valid === 'function' ? valid(v) : (valid?.[path[0]] ? valid[path[0]](v) : true));
  const eff = new Map();
  const at = (path) => (path.length ? `.${path.join('.')}` : '');
  const invalid = [];
  for (const [key, { path, v }] of leaves(standard)) eff.set(key, { path, v, layer: 'standard' });
  for (const [name, layer] of [['platform', platform], ['tool', tool]]) {
    if (layer === undefined || layer === null) continue;
    for (const [key, { path, v }] of leaves(layer)) {
      if (!check(path, v)) { invalid.push(`${name}${at(path)}=${JSON.stringify(v)}`); continue; }
      eff.set(key, { path, v, layer: name });
    }
  }
  for (const [k, v] of Object.entries(envValues ?? {})) {
    if (v === undefined) continue;
    const path = k === '' ? [] : [k];
    if (!check(path, v)) { invalid.push(`env${at(path)}=${JSON.stringify(v)}`); continue; }
    // An env value replaces the whole top-level key (drop the nested leaves it shadows).
    for (const key of [...eff.keys()]) if (path.length && eff.get(key).path[0] === k) eff.delete(key);
    eff.set(path.join(SEP), { path, v, layer: 'env' });
  }
  const sources = {};
  const leafValues = {};
  for (const { path, v, layer } of eff.values()) { sources[path.join('.')] = layer; leafValues[path.join('.')] = v; }
  if (eff.size === 1 && eff.has('')) return { value: eff.get('').v, sources, leafValues, invalid };
  if (eff.size === 0) return { value: isObj(standard) || isObj(platform) || isObj(tool) ? {} : undefined, sources, leafValues, invalid };
  const value = {};
  for (const { path, v } of eff.values()) if (path.length) setLeaf(value, path, v);
  return { value, sources, leafValues, invalid };
}

const fmt = (v) => { const s = JSON.stringify(v); return s && s.length > 60 ? `${s.slice(0, 57)}...` : s; };

/** PURE: the one source line for a resolved policy. */
export function formatCascadeSourcesLine(policy, { value, sources = {}, leafValues, invalid = [] } = {}) {
  const parts = Object.entries(sources).map(([leaf, layer]) => {
    let v = value;
    if (leafValues && Object.hasOwn(leafValues, leaf)) v = leafValues[leaf];
    else if (leaf) for (const k of leaf.split('.')) v = isObj(v) ? v[k] : undefined;
    return `${leaf || 'value'}=${fmt(v)} (${layer})`;
  });
  const bad = invalid.length ? ` · ignored invalid: ${invalid.join('; ')}` : '';
  return `policy-cascade · ${policy}: ${parts.join(', ') || '(no value)'}${bad}`;
}

const logged = new Map();
/** The marker `installDaemonLog()` (skills-src/conveyor/daemon-log.mjs) sets on `console` in every daemon. */
const DAEMON_LOG_INSTALLED = Symbol.for('we.daemonLog.installed');
/** In a daemon: its log is installed, or (a read at import time, before `installDaemonLog()` runs) its entry script is
 *  a `*-daemon.mjs`. */
const inDaemon = () => !!console[DAEMON_LOG_INSTALLED] || /-daemon\.mjs$/.test(String(process.argv?.[1] ?? ''));
/**
 * Log a policy's source line once per process per distinct line (console.error → the daemon's log). Only inside a
 * daemon or with `WE_POLICY_CASCADE_LOG=1`; never under test unless `=1`. Never throws.
 */
export function logCascadeSources(policy, resolved, { env = process.env, log = (l) => console.error(l) } = {}) {
  try {
    const on = env?.[POLICY_CASCADE_LOG_ENV];
    if (on === '0') return;
    if (on !== '1' && (isUnderTest(env) || !inDaemon())) return;
    const line = formatCascadeSourcesLine(policy, resolved);
    if (logged.get(policy) === line) return;
    logged.set(policy, line);
    log(line);
  } catch { /* logging never breaks a reader */ }
}

/**
 * THE call-site helper: resolve `policy` from the platform preference + the reader's tool block (+ optional standard
 * default and env values), log its sources, and return the result. A reader that keeps its own default/env handling
 * uses `.layered` (platform under tool, valid leaves only) as its new tool block — with no platform preference set,
 * `.layered` equals the tool block's valid leaves, so behaviour is unchanged. `standard` / `envValues` only make
 * `.value` and the source log complete.
 * @param {string} policy  the key in the platform preference file (same name as the tool block)
 * @param {unknown} tool   the reader's tool-layer block (or scalar)
 * @param {{standard?:unknown, envValues?:Record<string,unknown>, valid?:object|Function, platform?:unknown,
 *   env?:object, log?:Function}} [o]
 */
export function cascadePolicy(policy, tool, { standard, envValues, valid, platform, env = process.env, log } = {}) {
  let plat = platform;
  if (plat === undefined) { try { plat = platformPreference(policy, { env }); } catch { plat = undefined; } }
  const resolved = resolveCascade({ standard, platform: plat, tool, envValues, valid });
  logCascadeSources(policy, resolved, { env, ...(log ? { log } : {}) });
  // `layered`: platform under tool only (no standard, no env) — the drop-in replacement for a reader's tool block.
  const layered = resolveCascade({ platform: plat, tool, valid }).value;
  return { ...resolved, platform: plat, layered };
}

/** Test seam: forget what was logged. @test-only-export-ok */
export function resetCascadeLogForTest() { logged.clear(); }
