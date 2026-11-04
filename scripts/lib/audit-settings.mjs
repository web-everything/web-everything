/**
 * Audit rubric settings (R528, AU1 PR-A). Pure resolution of named decisions through the shared policy cascade.
 * Trusted source only: the file is read from the RUNNING checkout (derived from this module's location), never
 * from a candidate diff or the cwd. Env may only TIGHTEN; any unreadable or invalid value resolves to the
 * strictest option. Inert: nothing in the runtime imports this yet (PR-C wires it).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { cascadePolicy, readPlatformPreferences } from './policy-cascade.mjs';

export const AUDIT_SETTINGS_PATH = fileURLToPath(new NodeURL('../settings/codex-audit.json', import.meta.url));
/** Built-in race-protected paths; settings and env can only ADD to these. */
export const GUARD_FLOOR = Object.freeze(['scripts/**/file-locks*', 'scripts/*file-locks*', 'scripts/**/lease*', 'scripts/*lease*',
  'scripts/**/slot*', 'scripts/*slot*', 'scripts/**/lock-reaper*', 'scripts/*lock-reaper*', 'scripts/**/lane-pool*', 'scripts/*lane-pool*',
  'scripts/**/merge*', 'scripts/*merge*', 'scripts/**/drain*', 'scripts/*drain*', 'scripts/**/mq*', 'scripts/*mq*']);

// Ordered strictest first; env may only move toward the front.
const RANKS = Object.freeze({
  verdictMode: ['shadow', 'model', 'computed'],
  preExistingMode: ['block', 'prove', 'allow'],
  releaseStage: ['prod', 'prerelease'],
});
export const AUDIT_SETTINGS_ENV = Object.freeze({
  verdictMode: 'WE_AUDIT_VERDICT_MODE', preExistingMode: 'WE_AUDIT_PREEXISTING_MODE', releaseStage: 'WE_AUDIT_RELEASE_STAGE',
  raceBlockPaths: 'WE_AUDIT_RACE_BLOCK_PATHS', guardFloorPaths: 'WE_AUDIT_GUARD_FLOOR_PATHS',
  recheckMax: 'WE_AUDIT_RECHECK_MAX', baseRecheckMax: 'WE_AUDIT_BASE_RECHECK_MAX',
  requireOnMain: 'WE_AUDIT_CARDS_REQUIRE_ON_MAIN', requirePayBy: 'WE_AUDIT_CARDS_REQUIRE_PAY_BY',
});
const MAX_RECHECK = 3;
const STRICTEST = Object.freeze({ verdictMode: 'shadow', preExistingMode: 'block', releaseStage: 'prod', recheckMax: 0, baseRecheckMax: 0,
  requireOnMain: true, requirePayBy: true });
const DEFAULTS = Object.freeze({ verdictMode: 'model', preExistingMode: 'block', releaseStage: 'prerelease', recheckMax: 1, baseRecheckMax: 3,
  requireOnMain: true, requirePayBy: true });

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const validPaths = v => Array.isArray(v) && v.length <= 256 && v.every(p => typeof p === 'string' && p.trim().length > 0 && p.length <= 512);
const validHashes = v => Array.isArray(v) && v.length <= 64 && v.every(h => typeof h === 'string' && /^[0-9a-f]{8,128}$/.test(h));
const validCount = v => Number.isInteger(v) && v >= 0 && v <= MAX_RECHECK;
const enumOf = key => v => RANKS[key].includes(v);
const VALID = Object.freeze({ verdictMode: enumOf('verdictMode'), preExistingMode: enumOf('preExistingMode'), releaseStage: enumOf('releaseStage'),
  recheckMax: validCount, baseRecheckMax: validCount, requireOnMain: v => typeof v === 'boolean', requirePayBy: v => typeof v === 'boolean' });

function readFile(path, read) {
  try { const v = JSON.parse(read(path, 'utf8')); return isObj(v) && isObj(v.audit) ? { tool: v.audit } : { tool: null, unreadable: true }; }
  catch { return { tool: null, unreadable: true }; }
}
const pathOf = key => ({ verdictMode: ['verdict', 'mode'], preExistingMode: ['preExisting', 'mode'], baseRecheckMax: ['preExisting', 'baseRecheckMax'],
  recheckMax: ['recheck', 'max'], requireOnMain: ['cards', 'requireOnMain'], requirePayBy: ['cards', 'requirePayBy'] }[key] ?? [key]);
const get = (tool, key) => {
  const [a, b] = pathOf(key);
  return b === undefined ? tool?.[a] : tool?.[a]?.[b];
};
/**
 * Malformed explicit entries the cascade's leaf flattening hides (PR #6381): an empty object at a setting has no
 * leaves, so `releaseStage: {}` vanishes and reads as omitted; a non-object where a section belongs
 * (`verdict: "shadow"`) makes `verdict.mode` read as omitted. Checked on each RAW layer so such an entry fails
 * closed instead of earning the default. An empty section (`verdict: {}`) sets nothing and stays omitted.
 */
function rawMalformed(layer, key, valid) {
  if (!isObj(layer)) return false;
  const [a, b] = pathOf(key);
  if (!Object.hasOwn(layer, a)) return false;
  if (b === undefined) return !valid(layer[a]);
  if (!isObj(layer[a])) return true;
  return Object.hasOwn(layer[a], b) && !valid(layer[a][b]);
}
/**
 * A key that differs from a setting only by letter case (`ReleaseStage`, `recheck.Max`, `Verdict.mode`) is an explicit
 * choice the cascade cannot see: it would read as omitted and earn the default. It fails that setting closed instead.
 * Other misspellings (`verdicts`) cannot be mapped to a setting; they are only named by `unknownKeys`.
 */
function caseShadowed(layer, key) {
  if (!isObj(layer)) return false;
  const [a, b] = pathOf(key);
  const fold = s => s.toLowerCase();
  for (const [ka, x] of Object.entries(layer)) {
    if (fold(ka) !== fold(a)) continue;
    if (b === undefined) { if (ka !== a) return true; continue; }
    if (!isObj(x)) { if (ka !== a) return true; continue; }
    for (const kb of Object.keys(x)) if (fold(kb) === fold(b) && (ka !== a || kb !== b)) return true;
  }
  return false;
}
const KNOWN = (() => {
  const m = new Map();
  for (const key of [...Object.keys(STRICTEST), 'raceBlockPaths', 'guardFloorPaths', 'priorQuestionHashes']) {
    const [a, b] = pathOf(key);
    if (!m.has(a)) m.set(a, new Set());
    if (b !== undefined) m.get(a).add(b);
  }
  return m;
})();
/** Misspelled keys (`verdicts`, `ReleaseStage`, `recheck.Max`) read as omitted: name them ($-prefixed notes skipped). */
function unknownKeys(layer) {
  if (!isObj(layer)) return [];
  const out = [];
  for (const [a, x] of Object.entries(layer)) {
    if (a.startsWith('$')) continue;
    if (!KNOWN.has(a)) { out.push(a); continue; }
    if (KNOWN.get(a).size && isObj(x)) for (const b of Object.keys(x)) if (!b.startsWith('$') && !KNOWN.get(a).has(b)) out.push(`${a}.${b}`);
  }
  return out;
}
const parseEnv = (key, raw) => {
  if (typeof raw !== 'string') return undefined;
  if (['recheckMax', 'baseRecheckMax'].includes(key)) return /^\d+$/.test(raw) ? Number(raw) : undefined;
  if (['requireOnMain', 'requirePayBy'].includes(key)) return raw === 'true' ? true : raw === 'false' ? false : undefined;
  return raw;
};
/** Is `candidate` at least as strict as `current`? */
function tighter(key, candidate, current) {
  if (RANKS[key]) return RANKS[key].indexOf(candidate) <= RANKS[key].indexOf(current);
  if (key === 'recheckMax' || key === 'baseRecheckMax') return candidate <= current;
  return candidate === true || current === false;
}

/**
 * Resolve the audit settings. `fileRead`/`path`/`platform` are test seams; production passes none.
 * @returns {{value: object, sources: Record<string,string>, warnings: string[]}}
 */
export function resolveAuditSettings({ path = AUDIT_SETTINGS_PATH, fileRead = readFileSync, platform, env = process.env, log } = {}) {
  const warnings = [];
  const warn = m => { warnings.push(m); try { (log ?? (() => {}))(m); } catch { /* never throws */ } };
  const { tool, unreadable } = readFile(path, fileRead);
  // The platform layer is read HERE, not inside the cascade, so its read errors and an explicit `"audit": null`
  // stay visible: the cascade drops both and they would read as "no platform preference".
  let plat = platform; let platUnreadable = false;
  if (plat === undefined) {
    try {
      const { prefs, errors } = readPlatformPreferences({ env, warn: () => {} });
      plat = prefs.audit;
      platUnreadable = errors.length > 0 || (Object.hasOwn(prefs, 'audit') && prefs.audit === null);
    } catch { plat = undefined; platUnreadable = true; }
  }
  // A platform preference that is present but not an object flattens to one root leaf and reads as all-omitted.
  const platBad = platUnreadable || (plat !== undefined && plat !== null && !isObj(plat));
  if (platBad) warn(`audit platform preference ${platUnreadable ? 'unreadable' : 'is not an object'}; every setting resolves to its strictest option`);
  let cascade;
  try { cascade = cascadePolicy('audit', tool, { standard: undefined, platform: plat === undefined ? null : plat, env, log }); } catch { cascade = null; }
  const layered = cascade?.layered ?? {};
  for (const [name, layer] of [['platform', plat], ['file', tool]]) {
    const unknown = unknownKeys(layer);
    if (unknown.length) warn(`audit ${name} layer has unknown setting(s) ${JSON.stringify(unknown.slice(0, 20))}; ignored (check the spelling)`);
  }
  // Malformed RAW entries in either layer (raw only: the platform-level fault above is reported once, not per key).
  const malformed = (key, valid) => [plat, tool].some(layer => rawMalformed(layer, key, valid) || caseShadowed(layer, key));
  const value = {}; const sources = {};
  for (const key of Object.keys(DEFAULTS)) {
    let v = get(layered, key); let src = 'file';
    const bad = platBad || malformed(key, VALID[key]);
    if (v === undefined && !unreadable && cascade && !bad) { v = DEFAULTS[key]; src = 'built-in'; }
    if (unreadable || !cascade || bad || !VALID[key](v)) {
      if (!platBad && (unreadable || bad || v !== undefined)) { warn(`audit setting ${key} unreadable or invalid; using strictest ${JSON.stringify(STRICTEST[key])}`); }
      v = STRICTEST[key]; src = 'strictest';
    }
    // allow is never trusted: it resolves to block.
    if (key === 'preExistingMode' && v === 'allow') { warn('audit.preExisting.mode=allow resolves to block (the model label is never trusted)'); v = 'block'; }
    const envRaw = env?.[AUDIT_SETTINGS_ENV[key]];
    if (envRaw !== undefined) {
      const e = parseEnv(key, envRaw);
      if (e !== undefined && VALID[key](e) && !(key === 'preExistingMode' && e === 'allow') && tighter(key, e, v)) { v = e; src = 'env'; }
      else warn(`env ${AUDIT_SETTINGS_ENV[key]}=${JSON.stringify(envRaw)} ignored (env may only tighten)`);
    }
    value[key] = v; sources[key] = src;
  }
  // Path lists only ever ADD to the built-in floor; a bad list contributes nothing (the floor remains).
  for (const [key, layerVal] of [['raceBlockPaths', get(layered, 'raceBlockPaths')], ['guardFloorPaths', get(layered, 'guardFloorPaths')]]) {
    let list = layerVal === undefined ? [] : layerVal;
    // A malformed raw entry warns; the valid layered list (if any) still adds, since more protected paths is stricter.
    if (!validPaths(list)) { warn(`audit setting ${key} invalid; built-in floor only`); list = []; }
    else if (malformed(key, validPaths)) warn(`audit setting ${key} has a malformed entry; it adds nothing`);
    let envList = [];
    const raw = env?.[AUDIT_SETTINGS_ENV[key]];
    if (raw !== undefined) {
      try { const p = JSON.parse(raw); if (validPaths(p)) envList = p; else warn(`env ${AUDIT_SETTINGS_ENV[key]} invalid; ignored`); } catch { warn(`env ${AUDIT_SETTINGS_ENV[key]} invalid; ignored`); }
    }
    value[key] = Object.freeze([...new Set([...GUARD_FLOOR, ...list, ...envList])]);
    sources[key] = envList.length ? 'env' : list.length ? 'file' : 'built-in';
  }
  // Prior question hashes only widen what is ACCEPTED, so no env route exists; a bad list is empty.
  // Any unreadable layer accepts none (strictest), like every single-value setting above.
  const hashes = get(layered, 'priorQuestionHashes');
  const hashesInvalid = malformed('priorQuestionHashes', validHashes) || (hashes !== undefined && !validHashes(hashes));
  if (unreadable || !cascade || platBad || hashesInvalid) {
    if (hashesInvalid) warn('audit setting priorQuestionHashes invalid; none accepted');
    value.priorQuestionHashes = Object.freeze([]); sources.priorQuestionHashes = 'strictest';
  } else {
    value.priorQuestionHashes = Object.freeze(hashes === undefined ? [] : [...hashes]);
    sources.priorQuestionHashes = hashes === undefined ? 'built-in' : 'file';
  }
  return { value: Object.freeze(value), sources, warnings };
}
