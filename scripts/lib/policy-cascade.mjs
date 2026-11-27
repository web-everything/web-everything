/**
 * @file scripts/lib/policy-cascade.mjs
 * @description THE policy cascade every delivery setting resolves through (agent-memory 151 "policy cascade = team
 *   practice"; card x5wnfcg #5600; operator go 2026-10-10). Generalised from the per-key resolver in PR #4708's
 *   `merge-delivery-policy.mjs`, so every setting shares one resolver instead of each re-implementing the layers:
 *
 *   Order: standard → platform default → company → org → team → repo → tool → env → operator override.
 *   The capacity-only operator store retains its historical `operator-db` source name at the final tier.
 *   File-backed owner blocks enter through `ownerFiles` (policy-keyed JSON), never an env-selected owner path.
 *   Personal preferences remain in the merged compatibility view but resolve as `operator`, distinct from platform.
 *   An env-selected file has no operator authority; safety values pass through tighten-only env validation.
 *
 *   SOURCE LOG: {@link cascadePolicy} prints one `policy-cascade · <policy>: leaf=value (layer), …` line per process
 *   per distinct effective set, so a long-running daemon logs each setting's source once (and again only if it
 *   changes). It logs only inside a daemon (one that ran `installDaemonLog()`, or whose entry is a `*-daemon.mjs`, so
 *   the line lands in the daemon's log) or when `WE_POLICY_CASCADE_LOG=1` — never into a short CLI's stderr that a caller may parse.
 *   `WE_POLICY_CASCADE_LOG=0` turns it off; silent under test unless `=1`.
 *
 *   A missing legacy platform file is "layer not set". Broken owner evidence makes safety values unresolved;
 *   provenance names the broken layer and requires repair before admission.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readOperatorOverrides, CAPACITY_LEAVES, failClosedCapacity } from './operator-override-reader.mjs';
import { isUnderTest } from './under-test.mjs';
import { classify, directionFor, isLoosening } from './settings-safe-direction.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PLATFORM_PREFERENCES_PATH = join(HERE, 'delivery-platform-preferences.json');
/** The older platform-layer file (deliveryPriority). Read under the main file; the main file wins per key. */
export const LEGACY_PLATFORM_PREFERENCES_PATHS = Object.freeze([join(HERE, 'delivery-priority-settings.json')]);
export const PLATFORM_PREFERENCES_ENV = 'WE_PLATFORM_PREFERENCES_FILE';
/** Operator-owned final platform layer; never written inside a checkout. */
export function operatorPreferencesPath(_env = process.env) {
  return join(homedir(), '.claude', 'platform-preferences.json');
}
export const POLICY_CASCADE_LOG_ENV = 'WE_POLICY_CASCADE_LOG';
export const CASCADE_LAYERS = Object.freeze(['standard', 'platform', 'company', 'org', 'team', 'repo', 'tool', 'env', 'operator', 'operator-db']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);

function mergeLeaves(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (UNSAFE.has(k)) continue;
    out[k] = isObj(out[k]) && isObj(v) ? mergeLeaves(out[k], v) : v;
  }
  return out;
}

/**
 * IO: every platform preference, keyed by policy. routingOverrides and findingClasses are operator-only;
 * repo platform copies are ignored with a warning. Never throws.
 * @returns {{prefs:object, errors:string[]}}
 */
export function readPlatformPreferences({ env = process.env, readFile = readFileSync, warn = message => console.error(message), operatorPath = operatorPreferencesPath(),
  platformPaths = [...LEGACY_PLATFORM_PREFERENCES_PATHS, PLATFORM_PREFERENCES_PATH] } = {}) {
  const override = String(env?.[PLATFORM_PREFERENCES_ENV] ?? '').trim();
  const paths = override ? [override] : [...platformPaths, operatorPath];
  const layers = { platform: {}, operator: {} };
  const prefs = {};
  const errors = [];
  for (const path of paths) {
    try {
      const data = JSON.parse(String(readFile(path, 'utf8')));
      if (!isObj(data)) { errors.push(`${path}: not a JSON object`); continue; }
      for (const [k, v] of Object.entries(data)) {
        if (['routingOverrides', 'findingClasses'].includes(k) && (override || path !== operatorPath
          || [...LEGACY_PLATFORM_PREFERENCES_PATHS, PLATFORM_PREFERENCES_PATH].some(repoPath => resolve(repoPath) === resolve(path)))) {
          warn(`policy-cascade: ${path}: ignoring ${k}; only the operator-owned preferences file may set it`);
          continue;
        }
        // Per-leaf merge: a later file (the operator's) overrides only the leaves it sets; it never drops the
        // earlier file's other leaves of the same policy (an operator `build.priority` must not erase `build.finalGate`).
        if (!UNSAFE.has(k) && !k.startsWith('$')) {
          prefs[k] = isObj(prefs[k]) && isObj(v) ? mergeLeaves(prefs[k], v) : v;
          const layer = !override && path === operatorPath ? layers.operator : layers.platform;
          layer[k] = isObj(layer[k]) && isObj(v) ? mergeLeaves(layer[k], v) : v;
        }
      }
    } catch (e) {
      if (e?.code !== 'ENOENT') errors.push(`${path}: ${String(e?.message ?? e).split('\n')[0]}`);
    }
  }
  // Preserve the public merged view for existing readers while the cascade retains owner provenance.
  return Object.defineProperty({ prefs, errors }, 'layers', { value: layers });
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

const loosenLogged = new Set();

function deleteLeaf(obj, parts) {
  let o = obj;
  for (const k of parts.slice(0, -1)) { if (!isObj(o?.[k])) return; o = o[k]; }
  if (o) delete o[parts.at(-1)];
}

function setLeaf(obj, parts, value) {
  let o = obj;
  for (const k of parts.slice(0, -1)) { if (!isObj(o[k])) o[k] = {}; o = o[k]; }
  o[parts.at(-1)] = value;
}

/**
 * PURE: resolve one policy through the declared owner layers. A null operatorOverride means the store is unreadable;
 * capacityLeaves retain the stricter lower-layer value or finite code fallback.
 * @param {{standard?:unknown, platform?:unknown, tool?:unknown, envValues?:Record<string,unknown>,
 *   valid?:Record<string,(v:unknown)=>boolean>|((v:unknown)=>boolean)}} layers
 *   Owner blocks have the same shape (or are scalars). `confirmations[layer][leaf]` lists affected lower owners;
 *   these are trusted reader inputs, never taken from env or candidate JSON. Unknown safety paths must be declared
 *   in `safetyLeaves`; a missing direction refuses their overrides. Legacy five-layer blocks retain their historical
 *   ownership until migrated to explicit owner blocks/confirmations. `layerErrors` refuses safety resolution.
 *   `standard` / `platform` / `tool` are blocks of the same shape (or scalars). `envValues` maps a TOP-LEVEL key ('' for
 *   a scalar policy) → an already parsed env value (undefined = env not set). `valid` is one predicate (scalar
 *   policy) or top-level key → predicate; a key with no predicate accepts any value.
 * @returns {{value:unknown, sources:Record<string,string>, leafValues:Record<string,unknown>, invalid:string[]}}
 *   `sources` names the layer of every effective leaf, keyed by its dotted path ('' for a scalar policy).
 */
export function resolveCascade({ standard, platform, company, org, team, repo, tool, operator,
  envValues = {}, valid = {}, operatorOverride, capacityLeaves, policy, safetyLeaves = [], confirmations,
  layerErrors = {}, log = console.error } = {}) {
  const shadow = [];
  const check = (path, v) => (typeof valid === 'function' ? valid(v) : ((valid?.[path.join('.')] ?? valid?.[path[0]])?.(v) ?? true));
  const eff = new Map();
  const at = (path) => (path.length ? `.${path.join('.')}` : '');
  const invalid = [];
  const history = new Map();
  const isSafety = leaf => safetyLeaves.includes(leaf) || classify(policy, leaf) === 'safety';
  // Historical five-layer settings remain reader-owned. Once owner layers/confirmations are supplied,
  // every ancestor participates; callers migrate persisted settings by supplying their owner confirmations.
  const ownerAware = confirmations !== undefined || [company, org, team, repo, operator].some(v => v !== undefined);
  const remember = (key, entry) => history.set(key, [...(history.get(key) ?? []), entry]);
  const apply = (name, layer) => {
    if (layer === undefined || layer === null) return;
    for (const [key, { path, v }] of leaves(layer)) {
      const leaf = path.join('.');
      if (path[0] === 'findingClasses' && name !== 'operator') {
        log(`policy-cascade: ignoring ${name} findingClasses; only the operator-owned preferences file may set it`);
        continue;
      }
      if (!check(path, v)) { invalid.push(`${name}${at(path)}=${JSON.stringify(v)}`); continue; }
      if (ownerAware && isSafety(leaf)) {
        const entry = directionFor(policy, leaf);
        if (entry && isLoosening(entry, v, v)) {
          invalid.push(`${name}${at(path)}: incomparable safety value; repair value`);
          continue;
        }
        const ancestors = history.get(key) ?? [];
        const missing = ancestors.filter(({ v: from, layer: owner }) => isLoosening(entry, from, v)
          && !(Array.isArray(confirmations?.[name]?.[leaf]) && confirmations[name][leaf].includes(owner)));
        if (missing.length || !entry) {
          invalid.push(`${name}${at(path)}: ${!entry ? 'unclassified safety; repair direction' : `${missing.map(e => e.layer).join(', ')} owner confirmation required`}`);
          continue;
        }
      }
      const entry = { path, v, layer: name };
      eff.set(key, entry); remember(key, entry);
    }
  };
  for (const [key, { path, v }] of leaves(standard)) { const entry = { path, v, layer: 'standard' }; eff.set(key, entry); remember(key, entry); }
  for (const [name, layer] of [['platform', platform], ['company', company], ['org', org], ['team', team], ['repo', repo], ['tool', tool]]) apply(name, layer);
  for (const [k, raw] of Object.entries(envValues ?? {})) {
    let v = raw;
    if (v === undefined) continue;
    if (k === 'findingClasses' || (k === '' && isObj(v) && Object.hasOwn(v, 'findingClasses'))) {
      console.error('policy-cascade: ignoring env findingClasses; only the operator-owned preferences file may set it');
      if (k === 'findingClasses') continue;
      const { findingClasses: _ignored, ...rest } = v;
      v = rest;
    }
    const path = k === '' ? [] : [k];
    if (!check(path, v)) { invalid.push(`env${at(path)}=${JSON.stringify(v)}`); continue; }
    if (policy || safetyLeaves.length) {
      // Unknown safety semantics refuse; unclassified non-safety preferences retain their legacy shadow notice.
      const refused = [];
      // An object under a classed leaf is judged as one value (it cannot be a safe boolean/list); else leaf by leaf.
      const probes = isObj(v) && classify(policy, path.join('.')) === 'unclassed' ? [...leaves(v).values()].map(l => l.path) : [[]];
      for (const rel of probes) {
        const full = [...path, ...rel];
        const leaf = full.join('.');
        if (classify(policy, leaf) === 'unclassed' && !isSafety(leaf)) { shadow.push(`env.${leaf || policy}`); continue; }
        const entry = directionFor(policy, leaf);
        const to = rel.length ? rel.reduce((o, p) => o?.[p], v) : v;
        const from = eff.get(full.join(SEP))?.v;
        if (isSafety(leaf) && isLoosening(entry, from, to)) {
          const text = `env.${leaf || policy}=${JSON.stringify(to)} (${!entry ? 'unclassified safety; repair direction; default retained' : 'loosens; env may only tighten'})`;
          invalid.push(text);
          if (!loosenLogged.has(text)) { loosenLogged.add(text); try { log(`policy-cascade: refused ${text}`); } catch { /* never throws */ } }
          refused.push({ rel, from });
        }
      }
      if (refused.some(r => !r.rel.length)) continue;
      if (refused.length) {
        v = structuredClone(v);
        for (const { rel, from } of refused) { if (from === undefined) deleteLeaf(v, rel); else setLeaf(v, rel, from); }
        if (!leaves(v).size) continue;
      }
    }
    // An env value replaces the whole top-level key (drop the nested leaves it shadows).
    for (const key of [...eff.keys()]) if (path.length && eff.get(key).path[0] === k) eff.delete(key);
    eff.set(path.join(SEP), { path, v, layer: 'env' });
    for (const { path: relative, v: leafValue } of leaves(v).values()) {
      const full = [...path, ...relative];
      remember(full.join(SEP), { path: full, v: leafValue, layer: 'env' });
    }
  }
  apply('operator', operator);
  const defaults = leaves(standard);
  const paths = capacityLeaves ?? [...defaults.values()].map(({ path }) => path.join('.')).filter(leaf =>
    Object.keys(CAPACITY_LEAVES).some(key => (key === leaf || key.endsWith(`.${leaf}`))));
  const specKeyFor = leaf => Object.keys(CAPACITY_LEAVES).find(key => key === leaf || key.endsWith(`.${leaf}`));
  const operatorEntries = [];
  let operatorInvalid = operatorOverride !== undefined && operatorOverride !== null && !isObj(operatorOverride);
  for (const { path: rawPath, v } of leaves(operatorOverride ?? undefined).values()) {
    // Preserve dotted schema keys used by flat readers; otherwise expand dotted override paths.
    const path = rawPath.flatMap(k => k.split('.'));
    const flat = rawPath.join('.');
    const actual = eff.has(flat) ? [flat] : path;
    const specKey = specKeyFor(flat);
    if (actual.some(k => UNSAFE.has(k)) || !paths.includes(flat) || !specKey || !CAPACITY_LEAVES[specKey].validate(v) || !check(actual, v)) {
      invalid.push(`operator-db${at(actual)}=${JSON.stringify(v)}`);
      operatorInvalid = true;
      continue;
    }
    operatorEntries.push({ actual, v });
  }
  if (!operatorInvalid) for (const { actual, v } of operatorEntries) {
    eff.set(actual.join(SEP), { path: actual, v, layer: 'operator-db' });
  }
  if (operatorOverride === null || operatorInvalid) {
    for (const leaf of paths) {
      const specKey = specKeyFor(leaf);
      if (!specKey) continue;
      const path = eff.has(leaf) ? [leaf] : leaf.split('.');
      const key = path.join(SEP);
      const entry = eff.get(key);
      const current = entry?.v ?? leaf.split('.').reduce((v, part) => v?.[part],
        Object.fromEntries([...eff.values()].filter(e => e.path.length === 1).map(e => [e.path[0], e.v])));
      const codeDefault = [...defaults.values()].find(e => e.path.join('.') === leaf)?.v;
      const v = failClosedCapacity(specKey, current, { codeDefault, log });
      eff.set(key, { path, v, layer: v === current ? entry?.layer ?? 'standard' : 'standard' });
    }
  }
  for (const [layer, reason] of Object.entries(layerErrors)) {
    invalid.push(`${layer}: ${reason}; repair layer before safety resolution`);
    for (const [key, entry] of eff) if (isSafety(entry.path.join('.'))) {
      eff.set(key, { ...entry, v: undefined, layer: `unresolved:${layer}` });
    }
    for (const leaf of safetyLeaves) {
      const path = leaf ? leaf.split('.') : [];
      eff.set(path.join(SEP), { path, v: undefined, layer: `unresolved:${layer}` });
    }
  }
  const sources = {};
  const leafValues = {};
  for (const { path, v, layer } of eff.values()) { sources[path.join('.')] = layer; leafValues[path.join('.')] = v; }
  if (eff.size === 1 && eff.has('')) return { value: eff.get('').v, sources, leafValues, invalid, shadow };
  if (eff.size === 0) return { value: isObj(standard) || isObj(platform) || isObj(tool) ? {} : undefined, sources, leafValues, invalid, shadow };
  const value = {};
  for (const { path, v } of eff.values()) if (path.length) setLeaf(value, path, v);
  return { value, sources, leafValues, invalid, shadow };
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
export function cascadePolicy(policy, tool, { standard, envValues, valid, platform, operatorOverride, company, org, team, repo, operator,
  safetyLeaves, confirmations, ownerFiles = {}, readFile = readFileSync, operatorPath, platformPaths,
  env = process.env, log } = {}) {
  const layers = { platform, company, org, team, repo, tool, operator };
  const layerErrors = {};
  for (const [name, path] of Object.entries(ownerFiles)) {
    if (!Object.hasOwn(layers, name)) { layerErrors[name] = 'unknown owner layer'; continue; }
    try {
      const data = JSON.parse(String(readFile(path, 'utf8')));
      if (!isObj(data)) throw new Error('not a JSON object');
      layers[name] = policy.split('.').reduce((v, key) => v?.[key], data);
    } catch (error) { layerErrors[name] = String(error?.message ?? error).split('\n')[0]; }
  }
  if (layers.platform === undefined) {
    const result = readPlatformPreferences({ env, readFile, ...(operatorPath ? { operatorPath } : {}), ...(platformPaths ? { platformPaths } : {}) });
    const block = data => policy.split('.').reduce((v, key) => v?.[key], data);
    layers.platform = block(result.layers.platform);
    if (layers.operator === undefined) layers.operator = block(result.layers.operator);
    if (env?.[PLATFORM_PREFERENCES_ENV]) {
      // The redirect is not owner evidence. Safety entries re-enter through tighten-only env validation.
      const redirected = layers.platform;
      layers.platform = undefined;
      const trusted = {};
      const untrusted = {};
      for (const { path, v } of leaves(redirected).values()) {
        if (classify(policy, path.join('.')) === 'safety' || safetyLeaves?.includes(path.join('.'))) {
          if (path.length) setLeaf(untrusted, path, v); else untrusted[''] = v;
        } else if (path.length) setLeaf(trusted, path, v);
        else layers.platform = v;
      }
      if (isObj(redirected)) layers.platform = trusted;
      envValues = { ...untrusted, ...envValues };
    }
    if (result.errors.length) layerErrors.platform = result.errors.join('; ');
  }
  tool = layers.tool;
  if (policy === 'findingClasses') {
    if (tool != null || Object.values(envValues ?? {}).some(v => v !== undefined))
      console.error('policy-cascade: ignoring tool/env findingClasses; only the operator-owned preferences file may set it');
    tool = undefined;
    envValues = {};
  }
  const plat = layers.platform;
  if (operatorOverride === undefined) operatorOverride = readOperatorPolicy(policy, { env, log });
  const capacityLeaves = capacityPolicyLeaves(policy);
  const shared = { ...layers, tool, valid, operatorOverride, capacityLeaves, policy, safetyLeaves, confirmations, layerErrors, log };
  const resolved = resolveCascade({ ...shared, standard, envValues });
  logCascadeSources(policy, resolved, { env, ...(log ? { log } : {}) });
  // `layered`: platform under tool only (no standard, no env) — the drop-in replacement for a reader's tool block.
  const layered = resolveCascade({ standard: operatorOverride === null && capacityLeaves.length ? standard : undefined,
    ...shared }).value;
  return { ...resolved, platform: plat, layered };
}

/** Read each call, filtering the exact policy prefix. Null means unreadable; {} means missing/empty.
 * Tests isolate the store through the explicit file seam, never environment flags. */
export function readOperatorPolicy(policy, { file, log } = {}) {
  const { readable, values, invalidPolicies = [] } = readOperatorOverrides({ ...(file !== undefined ? { file } : {}), ...(log ? { log } : {}) });
  if (!readable || invalidPolicies.includes(policy) || invalidPolicies.includes('*')) return null;
  const prefix = `${policy}.`;
  return Object.fromEntries(Object.entries(values).filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key.slice(prefix.length), value]));
}

/** Test seam: forget what was logged. @test-only-export-ok */
export function resetCascadeLogForTest() { logged.clear(); }

/** Card naming policy (#6121). Shadow keeps the current rename path authoritative. */
export function resolveCardNumbering({ env = process.env, readFile = readFileSync, tool, platform, log } = {}) {
  if (tool === undefined) {
    try { tool = JSON.parse(readFile(join(HERE, '../settings/card-numbering.json'), 'utf8'))?.backlog?.cardNumbering; }
    catch { tool = {}; }
  }
  return cascadePolicy('backlog.cardNumbering', tool, {
    standard: { mode: 'rename-after-land', ledgerAuth: 'none', shadow: true, readMaxBytes: 8 * 1024 * 1024, historyBudget: 256 },
    platform, env, log,
    envValues: { mode: env.WE_CARD_NUMBERING_MODE, ledgerAuth: env.WE_CARD_LEDGER_AUTH,
      shadow: env.WE_CARD_LEDGER_SHADOW === undefined ? undefined : ({ true: true, false: false, '1': true, '0': false })[env.WE_CARD_LEDGER_SHADOW] ?? env.WE_CARD_LEDGER_SHADOW },
    valid: { mode: v => ['rename-before-enqueue', 'rename-after-land', 'ledger-only'].includes(v),
      ledgerAuth: v => ['none', 'signed'].includes(v), shadow: v => typeof v === 'boolean',
      readMaxBytes: v => Number.isSafeInteger(v) && v > 0 && v <= 64 * 1024 * 1024,
      historyBudget: v => Number.isSafeInteger(v) && v > 0 && v <= 4096 },
  });
}

/** The closed capacity paths for a policy (relative dotted keys). */
export function capacityPolicyLeaves(policy) {
  return Object.keys(CAPACITY_LEAVES).filter(key => key.startsWith(`${policy}.`)).map(key => key.slice(policy.length + 1));
}
