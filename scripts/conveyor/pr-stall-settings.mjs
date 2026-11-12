/** Stall-sweep policy reads shared by the feed and sweep, without dispatch dependencies. */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cascadePolicy, readPlatformPreferences, logCascadeSources } from '../lib/policy-cascade.mjs';
import { CLASSIFY_DEFAULTS, CLASSIFY_VALID } from './pr-stall-classify.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const STALL_SWEEP_MODES = Object.freeze(['off', 'shadow', 'on']);
export const STALL_SWEEP_MODE_ENV = 'WE_PR_STALL_SWEEP_MODE';
export const STALL_SWEEP_DIR_ENV = 'WE_PR_STALL_SWEEP_DIR';
/** The standard values; the classifier's policies are leaves of the same block, checked by its validators. */
export const STALL_SWEEP_DEFAULTS = Object.freeze({ mode: 'off', intervalMinutes: 15, maxActionsPerSweep: 3, maxActionsPerHour: 6,
  maxActionsPerPrHead: 1, digest: true, actionModes: Object.freeze({ 'restart-red-team': 'shadow' }), ...CLASSIFY_DEFAULTS });
const SCALARS = ['mode', 'digest', 'intervalMinutes', 'maxActionsPerSweep', 'maxActionsPerHour', 'maxActionsPerPrHead', 'maxRedTeamRestartsPerHead', 'staleHoldAutoResume', 'grantCeiling', 'maxFixListLines'];
const SETTINGS_FILE = join(ROOT, 'scripts/settings/pr-stall-sweep.json');
const envName = (k) => `WE_PR_STALL_SWEEP_${k.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`;
const msg = (e) => String(e?.message ?? e).split('\n')[0].slice(0, 200);

/** `prStallSweep` under the cascade. Every leaf's source is returned and logged. Never throws. */
export function resolveStallSweepSettings({ env = process.env, read = readFileSync, log = console.error } = {}) {
  const errors = [];
  let tool = {}; let layerUnreadable = false;
  try { const f = JSON.parse(read(SETTINGS_FILE, 'utf8')); if (!f || typeof f !== 'object' || Array.isArray(f)) throw new Error('settings root is not an object'); tool = 'prStallSweep' in f ? f.prStallSweep : {}; } catch (e) { errors.push(`settings: ${msg(e)}`); layerUnreadable = true; }
  const envValues = {};
  for (const k of SCALARS) {
    const d = STALL_SWEEP_DEFAULTS[k];
    const raw = env[envName(k)];
    if (raw === undefined) continue;
    envValues[k] = typeof d === 'boolean' ? (['1', 'true'].includes(raw) ? true : ['0', 'false'].includes(raw) ? false : raw)
      : typeof d === 'number' ? (k === 'maxRedTeamRestartsPerHead' && String(raw).trim() === '' ? raw : Number(raw)) : String(raw).trim().toLowerCase();
  }
  const valid = { ...CLASSIFY_VALID, actionModes: (v) => STALL_SWEEP_MODES.includes(v), mode: (v) => STALL_SWEEP_MODES.includes(v), digest: (v) => typeof v === 'boolean',
    ...Object.fromEntries(['intervalMinutes', 'maxActionsPerSweep', 'maxActionsPerHour', 'maxActionsPerPrHead'].map((k) => [k, (v) => Number.isSafeInteger(v) && v > 0])) };
  let platform = {};
  try { const p = readPlatformPreferences({ env, readFile: read }); errors.push(...p.errors); if (p.errors.length) layerUnreadable = true; platform = 'prStallSweep' in p.prefs ? p.prefs.prStallSweep : {}; }
  catch (e) { errors.push(`platform: ${msg(e)}`); layerUnreadable = true; }
  // A scalar of the wrong SHAPE (an object where a number belongs) is dropped from its layer before the cascade, so the
  // valid value beneath it (a stricter platform limit, say) still applies.
  const scalarsOnly = (layer, name) => (layer && typeof layer === 'object' && !Array.isArray(layer) ? Object.fromEntries(Object.entries(layer).filter(([k, v]) => {
    const ok = !SCALARS.includes(k) || k === 'mode' || valid[k](v); if (!ok) errors.push(`${name}.${k}=${JSON.stringify(v)} (wrong shape, ignored)`); return ok;
  })) : {});
  // A block that is present but not an object (`false`, `"off"`, `[]`) is unusable policy, not "no settings".
  const isBlock = (b) => !!b && typeof b === 'object' && !Array.isArray(b);
  if (!isBlock(tool) || !isBlock(platform)) { layerUnreadable = true; errors.push('a prStallSweep block is not an object'); }
  let invalidActionModes = false;
  const cleanActionModes = (layer, name) => {
    if (!isBlock(layer) || !Object.hasOwn(layer, 'actionModes')) return layer;
    const modes = layer.actionModes;
    if (!isBlock(modes) || Object.entries(modes).some(([k, v]) => k !== 'restart-red-team' || !STALL_SWEEP_MODES.includes(v))) {
      errors.push(`${name}.actionModes invalid; live actions disabled`);
      invalidActionModes = true;
      return { ...layer, actionModes: { 'restart-red-team': 'shadow' } };
    }
    return layer;
  };
  tool = cleanActionModes(tool, 'tool'); platform = cleanActionModes(platform, 'platform');
  // A present but invalid restart budget disables restarts at that layer, preserving its provenance.
  const closeRestartBudget = (layer, name) => {
    const k = 'maxRedTeamRestartsPerHead';
    if (isBlock(layer) && Object.hasOwn(layer, k) && !valid[k](layer[k])) {
      errors.push(`${name}.${k}=${JSON.stringify(layer[k])} (invalid; restarts disabled)`);
      return { ...layer, [k]: 0 };
    }
    return layer;
  };
  tool = closeRestartBudget(tool, 'tool'); platform = closeRestartBudget(platform, 'platform');
  Object.assign(envValues, closeRestartBudget(envValues, 'env'));
  tool = scalarsOnly(tool, 'tool'); platform = scalarsOnly(platform, 'platform');
  // The kill switch fails closed: a mode PRESENT in any layer but unusable (including `{}`, which the cascade's leaf
  // flattening would drop) turns the sweep OFF.
  const rawModes = [tool?.mode, platform?.mode].filter((m) => m !== undefined);
  // Suppress the intermediate log without consuming the shared logger's deduplication entry.
  const out = cascadePolicy('prStallSweep', tool, { standard: STALL_SWEEP_DEFAULTS, envValues, valid, platform, env: { ...env, WE_POLICY_CASCADE_LOG: '0' }, log: () => {} });
  const value = { ...out.value }; const sources = { ...out.sources }; const bad = [...out.invalid];
  if (invalidActionModes) {
    value.actionModes = { 'restart-red-team': 'shadow' };
    sources['actionModes.restart-red-team'] = 'invalid actionModes: shadow';
  }
  // A leaf check cannot see shape (`{maxActionsPerHour: {a: 5}}` has a valid leaf): every resolved scalar is checked
  // again, and a bad one falls back to the standard.
  for (const k of SCALARS) if (!valid[k](value[k])) { bad.push(`resolved ${k}=${JSON.stringify(value[k])}`); value[k] = STALL_SWEEP_DEFAULTS[k]; sources[k] = 'standard (resolved value unusable)'; }
  // The kill switch fails closed: an unusable mode in ANY layer (env, repo file, platform) turns the sweep OFF.
  // An unreadable settings layer is unknown policy: OFF, never a lower layer's `shadow`.
  const settingsUnreadable = layerUnreadable || (env[STALL_SWEEP_MODE_ENV] !== undefined && !STALL_SWEEP_MODES.includes(envValues.mode)) || rawModes.some((m) => !STALL_SWEEP_MODES.includes(m)) || bad.some((x) => /^(?:env|tool|platform|resolved)[ .]?mode\b/.test(x));
  if (settingsUnreadable) {
    value.mode = 'off'; sources.mode = 'unusable mode value: off';
    if (!errors.length && !bad.length) errors.push('unusable mode value: off');
  }
  // The FINAL values (after the fail-closed overrides) are what get logged, with each leaf's source.
  logCascadeSources('prStallSweep', { value, sources, invalid: bad }, { env, log });
  return { value, sources, settingsUnreadable, errors: [...errors, ...bad] };
}

