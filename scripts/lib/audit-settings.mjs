/**
 * Audit rubric settings (R528, AU1 PR-A). Pure resolution of named decisions through the shared policy cascade.
 * Trusted source only: the file is read from the RUNNING checkout (derived from this module's location), never
 * from a candidate diff or the cwd. Env may only TIGHTEN; any unreadable or invalid value resolves to the
 * strictest option. Inert: nothing in the runtime imports this yet (PR-C wires it).
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { assertProtectedPatterns } from './audit-path.mjs';
import { GUARD_FLOOR } from './protected-path-floor.mjs';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { cascadePolicy, LEGACY_PLATFORM_PREFERENCES_PATHS, operatorPreferencesPath, PLATFORM_PREFERENCES_ENV, PLATFORM_PREFERENCES_PATH,
  readPlatformPreferences } from './policy-cascade.mjs';

export const AUDIT_SETTINGS_PATH = fileURLToPath(new NodeURL('../settings/codex-audit.json', import.meta.url));
export { AUDITOR_FLOOR, GUARD_FLOOR, LOCK_API, LOCK_HOLDERS, LOCK_PRIMITIVES, LOCK_USERS, REVIEW_AUTH_FLOOR } from './protected-path-floor.mjs';

/** What an invalid or unreadable path list resolves to: the floor plus every path (`**` matches any path). */
const STRICTEST_PATHS = Object.freeze([...GUARD_FLOOR, '**']);

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
// Preserve strictest recovery for unreadable settings; a well-shaped list with a malformed
// path is a configuration error that must stop the whole load before verdict computation.
class MalformedProtectedPatterns extends Error {}
function assertConfiguredPatterns(patterns) {
  try { assertProtectedPatterns(patterns); }
  catch (cause) { throw new MalformedProtectedPatterns(cause.message, { cause }); }
}
const validPaths = v => Array.isArray(v) && v.length <= 256 && v.every(p => typeof p === 'string' && p.trim().length > 0 && p.length <= 512);
// The same record shape findAudit reads (scripts/operations/codex-audit.mjs resolvePriorQuestionHashes): one
// {hash, acceptUntil} object per prior question hash, the hash 64 lowercase hex characters. Two readers of one
// settings key must agree, so a bare-string list (or any other shape) is invalid here too (PR #6381 merge).
const HASH_64 = /^[a-f0-9]{64}(?![\s\S])/;
// Both fields must be strings BEFORE they reach a parser: `Date.parse` and `RegExp#test` convert their argument to
// text, and a JSON object such as `{"toString":0}` cannot be converted, so it would throw (PR #6381 red team). A
// non-string is invalid, which empties the list.
const validHashes = v => Array.isArray(v) && v.length <= 64
  && v.every(e => isObj(e) && typeof e.hash === 'string' && HASH_64.test(e.hash)
    && typeof e.acceptUntil === 'string' && Number.isFinite(Date.parse(e.acceptUntil)));
const validCount = v => Number.isInteger(v) && v >= 0 && v <= MAX_RECHECK;
const enumOf = key => v => RANKS[key].includes(v);
const VALID = Object.freeze({ verdictMode: enumOf('verdictMode'), preExistingMode: enumOf('preExistingMode'), releaseStage: enumOf('releaseStage'),
  recheckMax: validCount, baseRecheckMax: validCount, requireOnMain: v => typeof v === 'boolean', requirePayBy: v => typeof v === 'boolean' });

function readFile(path, read) {
  try {
    const v = JSON.parse(read(path, 'utf8'));
    return isObj(v) && isObj(v.audit) && auditVariants(v).length === 0 ? { tool: v.audit } : { tool: null, unreadable: true };
  } catch { return { tool: null, unreadable: true }; }
}
/**
 * Top-level keys that are not exactly `audit` but fold to it (`Audit`, `audit` plus a zero-width space, fullwidth
 * letters). The reader only ever reads `audit`, so such a key's settings would be dropped with no warning; the caller
 * treats the section as unreadable instead (PR #6381 judge). Folded like a setting key (`foldKey`).
 */
function auditVariants(obj) {
  return isObj(obj) ? Object.keys(obj).filter(k => k !== 'audit' && foldKey(k) === 'audit') : [];
}
// A key for a warning: JSON-quoted, with every non-printable-ASCII character escaped so an invisible one shows.
const showKey = k => JSON.stringify(k).replace(/[^\x20-\x7e]/gu, c => `\\u${c.codePointAt(0).toString(16).padStart(4, '0')}`);
const SECTION_PATHS = Object.freeze({ __proto__: null, verdictMode: ['verdict', 'mode'], preExistingMode: ['preExisting', 'mode'],
  baseRecheckMax: ['preExisting', 'baseRecheckMax'], recheckMax: ['recheck', 'max'], requireOnMain: ['cards', 'requireOnMain'],
  requirePayBy: ['cards', 'requirePayBy'] });
// A null-prototype map: a polluted Object.prototype can never turn a setting name into an inherited path.
const pathOf = key => SECTION_PATHS[key] ?? [key];
const get = (tool, key) => {
  const [a, b] = pathOf(key);
  return b === undefined ? tool?.[a] : tool?.[a]?.[b];
};
/** A setting's value in one raw layer, own keys only (as the cascade reads a layer); undefined when it is not set. */
const ownGet = (layer, key) => {
  const [a, b] = pathOf(key);
  if (!isObj(layer) || !Object.hasOwn(layer, a)) return undefined;
  if (b === undefined) return layer[a];
  return isObj(layer[a]) && Object.hasOwn(layer[a], b) ? layer[a][b] : undefined;
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
 * A key that differs from a setting only by letter case, compatibility form, whitespace or an invisible character
 * (`ReleaseStage`, `recheck.Max`, `"releaseStage "`, a zero-width space, fullwidth or long-s letters) is an explicit
 * choice the cascade cannot see: it would read as omitted and earn the default. It fails that setting closed instead.
 * Other misspellings (`verdicts`) cannot be mapped to a setting; they are only named by `unknownKeys`.
 */
// Control (Cc) and format (Cf) characters and braille cells (the blank one is invisible) fold away too (PR #6381
// self-review). Written as property classes: a raw invisible character in source is refused by check:standards.
const foldKey = s => s.normalize('NFKC').replace(/[\s\p{Default_Ignorable_Code_Point}\p{Cc}\p{Cf}\p{Script=Braille}]/gu, '').toLowerCase();
function caseShadowed(layer, key) {
  if (!isObj(layer)) return false;
  const [a, b] = pathOf(key);
  const fold = foldKey;
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
// The value a setting takes effect as: preExisting mode allow is never trusted and resolves to block.
const effective = (key, v) => (key === 'preExistingMode' && v === 'allow' ? 'block' : v);
/** Is `candidate` at least as strict as `current`? Compared as they take effect, so allow ranks with block. */
function tighter(key, candidate, current) {
  if (RANKS[key]) return RANKS[key].indexOf(effective(key, candidate)) <= RANKS[key].indexOf(effective(key, current));
  if (key === 'recheckMax' || key === 'baseRecheckMax') return candidate <= current;
  return candidate === true || current === false;
}

/**
 * Under a platform-file override, each single-value setting the default chain sets validly is a floor: the override's
 * value is kept only when it is at least as strict, else the chain's value is used (where the override omits it too).
 * An invalid override value is left in place, so it fails that setting closed as usual.
 */
function tightenToChain(over, chain) {
  const out = structuredClone(over);
  for (const key of Object.keys(DEFAULTS)) {
    const c = get(chain, key);
    if (c === undefined || !VALID[key](c)) continue;
    const o = get(out, key);
    if (o !== undefined && (!VALID[key](o) || tighter(key, o, c))) continue;
    const [a, b] = pathOf(key);
    if (b === undefined) { out[a] = c; continue; }
    if (out[a] === undefined) out[a] = {};
    if (isObj(out[a])) out[a][b] = c;
  }
  return out;
}

/**
 * Resolve the audit settings. `fileRead`/`path`/`platform`/`platformRead` are test seams; production passes none.
 * Malformed protected patterns throw and abort the load. Other resolution failures (a value a parser cannot convert, an environment
 * object that throws on read) resolves EVERY setting to its strictest option, with a warning (PR #6381 red team).
 * @returns {{value: object, sources: Record<string,string>, warnings: string[]}}
 */
export function resolveAuditSettings(options = {}) {
  // Shared with the resolution, so warnings it logged before a throw stay in the returned list (log and list agree).
  const warnings = [];
  try { return resolveUnguarded(options ?? {}, warnings); } catch (err) {
    if (err instanceof MalformedProtectedPatterns) throw err;
    let reason = 'unknown error';
    try { if (typeof err?.message === 'string') reason = err.message.slice(0, 200); } catch { /* keep the generic reason */ }
    const warning = `audit settings could not be resolved (${reason}); every setting resolves to its strictest option`;
    try { (options?.log ?? (() => {}))(warning); } catch { /* never throws */ }
    const value = { ...STRICTEST, raceBlockPaths: STRICTEST_PATHS, guardFloorPaths: STRICTEST_PATHS, priorQuestionHashes: Object.freeze([]) };
    warnings.push(warning);
    return { value: Object.freeze(value), sources: Object.fromEntries(Object.keys(value).map(k => [k, 'strictest'])), warnings };
  }
}
function resolveUnguarded({ path = AUDIT_SETTINGS_PATH, fileRead = readFileSync, platform, platformRead = readFileSync, env = process.env, log } = {}, warnings) {
  const warn = m => { warnings.push(m); try { (log ?? (() => {}))(m); } catch { /* never throws */ } };
  const { tool, unreadable } = readFile(path, fileRead);
  // The platform layer is read HERE, not inside the cascade, so its read errors and an explicit `"audit": null`
  // stay visible: the cascade drops both and they would read as "no platform preference".
  // `chainPlat` is the default platform chain's audit preference, read only when an override replaces that chain:
  // the override may ADD protected paths, never remove the chain's (PR #6381 judge).
  // `chainFiles` is each default-chain file's own audit preference. The reader merges the chain leaf by leaf and an
  // array is one leaf, so a later file's path list REPLACES an earlier one's; the lists are unioned per file instead,
  // so no chain file can remove another's protected paths (PR #6381 self-review).
  let plat = platform; let platUnreadable = false; let chainPlat; let chainFiles = [];
  if (plat === undefined) {
    try {
      // The reader skips a missing file silently. That is right for the default paths, but an EXPLICITLY configured
      // file that is missing is a choice we cannot read: it fails closed (PR #6381 judge). It is checked before AND
      // after the read so a file that appears or vanishes in between is not read as unset. A relative path would
      // resolve against whatever cwd the process has, so it fails closed too.
      // One snapshot of env feeds every read below, so the override cannot read as unset here and as set in the reader.
      const snap = { ...env };
      const configured = String(snap[PLATFORM_PREFERENCES_ENV] ?? '').trim();
      const configuredBad = () => configured !== '' && (!isAbsolute(configured) || !existsSync(configured));
      const before = configuredBad();
      const { prefs, errors } = readPlatformPreferences({ env: snap, readFile: platformRead, warn: () => {} });
      plat = prefs.audit;
      // A key that only folds to `audit` (`Audit`, `audit` plus a zero-width space) is a section the reader drops
      // unseen: every platform read below fails closed on one, with a warning naming it (PR #6381 judge).
      const variantSeen = new Set();
      const shadowed = obj => {
        const keys = auditVariants(obj);
        // At most 5 keys are named, each cut to 64 characters: the section fails closed whatever the count.
        for (const k of keys) if (!variantSeen.has(k) && variantSeen.size < 5) { variantSeen.add(k); warn(`audit platform preference key ${showKey(k.slice(0, 64))} is a variant of "audit"; the section is unreadable`); }
        return keys.length > 0;
      };
      platUnreadable = before || configuredBad() || errors.length > 0 || (Object.hasOwn(prefs, 'audit') && prefs.audit === null) || shadowed(prefs);
      // The default chain env: the override removed. Each chain file is read on its own through the same reader.
      const chainEnv = { ...snap }; delete chainEnv[PLATFORM_PREFERENCES_ENV];
      for (const p of [...LEGACY_PLATFORM_PREFERENCES_PATHS, PLATFORM_PREFERENCES_PATH, operatorPreferencesPath(chainEnv)]) {
        const one = readPlatformPreferences({ env: { ...chainEnv, [PLATFORM_PREFERENCES_ENV]: p }, readFile: platformRead, warn: () => {} });
        // A file unreadable here, or one whose present `audit` is not an object, is a choice we cannot read.
        if (one.errors.length > 0 || (Object.hasOwn(one.prefs, 'audit') && !isObj(one.prefs.audit)) || shadowed(one.prefs)) platUnreadable = true;
        if (isObj(one.prefs.audit)) chainFiles.push(one.prefs.audit);
      }
      if (configured !== '') {
        // An explicitly configured file with no object `audit` (absent, null or not an object — a package.json, `{}`)
        // sets no audit preference, yet it replaces the whole default chain: its protected paths would vanish with no
        // warning. That is a choice we cannot read, so it fails closed (PR #6381 judge).
        if (!isObj(prefs.audit)) platUnreadable = true;
        // The default chain, read with the override removed from env, supplies path lists the override adds to.
        const chain = readPlatformPreferences({ env: chainEnv, readFile: platformRead, warn: () => {} });
        chainPlat = chain.prefs.audit;
        // Read as it would be with no override: an unreadable chain or a present non-object `audit` fails closed.
        if (chain.errors.length > 0 || (Object.hasOwn(chain.prefs, 'audit') && !isObj(chainPlat)) || shadowed(chain.prefs)) platUnreadable = true;
        // The chain's single-value settings are a floor too: the override may only tighten them (PR #6381 self-review).
        if (!platUnreadable && isObj(chainPlat)) plat = tightenToChain(plat, chainPlat);
      }
    } catch { plat = undefined; chainPlat = undefined; chainFiles = []; platUnreadable = true; }
  }
  // A platform preference that is present but not an object flattens to one root leaf and reads as all-omitted.
  const platBad = platUnreadable || (plat !== undefined && plat !== null && !isObj(plat));
  if (platBad) warn(`audit platform preference ${platUnreadable ? 'unreadable' : 'is not an object'}; every setting resolves to its strictest option`);
  // The cascade still runs (it logs each policy's sources, and a layer it cannot survive fails closed), but no value is
  // read from its merge: it keys each leaf by its NUL-joined path, so an unknown key `"verdict" + NUL + "mode"` takes the
  // slot of `verdict.mode` and drops it, and an explicit shadow mode read as omitted (PR #6381 judge). Each setting is
  // read from the RAW layers instead, own keys only, the file over the platform, as the cascade layers them.
  let cascade;
  try { cascade = cascadePolicy('audit', tool, { standard: undefined, platform: plat === undefined ? null : plat, env, log }); } catch { cascade = null; }
  for (const [name, layer] of [['platform chain', chainPlat], ['platform', plat], ['file', tool]]) {
    const unknown = unknownKeys(layer);
    if (unknown.length) warn(`audit ${name} layer has unknown setting(s) ${JSON.stringify(unknown.slice(0, 20))}; ignored (check the spelling)`);
  }
  // Malformed RAW entries in any layer (raw only: the platform-level fault above is reported once, not per key). The
  // default chain read under an override counts: a malformed chain entry fails that setting closed.
  const malformed = (key, valid) => [...chainFiles, chainPlat, plat, tool].some(layer => rawMalformed(layer, key, valid) || caseShadowed(layer, key));
  const value = {}; const sources = {};
  for (const key of Object.keys(DEFAULTS)) {
    // The source names the layer the value came from: the cascade layers the file over the platform (PR #6381 send-back).
    const fromFile = ownGet(tool, key); const fromPlat = ownGet(plat, key);
    let v = fromFile !== undefined ? fromFile : fromPlat;
    let src = fromFile !== undefined ? 'file' : fromPlat !== undefined ? 'platform' : 'built-in';
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
      // An env value that does not parse or is not a known option is an explicit choice we cannot read: strictest.
      if (e === undefined || !VALID[key](e)) {
        warn(`env ${AUDIT_SETTINGS_ENV[key]}=${JSON.stringify(envRaw)} invalid; using strictest ${JSON.stringify(STRICTEST[key])}`);
        v = STRICTEST[key]; src = 'strictest';
      } else if (key === 'preExistingMode' && e === 'allow') {
        // allow is never trusted, from any layer: it resolves to block (PR #6381 judge).
        warn(`env ${AUDIT_SETTINGS_ENV[key]}=allow resolves to block (the model label is never trusted)`); v = 'block'; src = 'env';
      } else if (tighter(key, e, v)) { v = e; src = 'env'; }
      else warn(`env ${AUDIT_SETTINGS_ENV[key]}=${JSON.stringify(envRaw)} ignored (env may only tighten)`);
    }
    value[key] = v; sources[key] = src;
  }
  // Path lists only ever ADD to the built-in floor. An unreadable layer or an invalid list (file, platform or env) is
  // an explicit choice we cannot read, so it resolves to the strictest list: the floor plus every path.
  // Each layer's list is read RAW and the lists are unioned: the cascade would let the file list REPLACE a platform
  // list, silently dropping the platform's extra protected paths (PR #6381 judge).
  // Under a platform-file override the default chain's lists are unioned in first, so the override only adds.
  for (const key of ['raceBlockPaths', 'guardFloorPaths']) {
    let strictest = unreadable || !cascade || platBad;
    const own = layer => (isObj(layer) ? layer[key] : undefined);
    const layerLists = [...chainFiles.map(own), own(chainPlat), own(plat), own(tool)].filter(l => l !== undefined);
    for (const patterns of layerLists) if (validPaths(patterns)) assertConfiguredPatterns(patterns);
    let platList = []; let list = [];
    if (!layerLists.every(validPaths) || malformed(key, validPaths)) { warn(`audit setting ${key} invalid; every path protected`); strictest = true; }
    else {
      platList = [...chainFiles.flatMap(f => own(f) ?? []), ...(own(chainPlat) ?? []), ...(own(plat) ?? [])];
      list = [...platList, ...(own(tool) ?? [])];
    }
    let envList = [];
    const raw = env?.[AUDIT_SETTINGS_ENV[key]];
    if (raw !== undefined) {
      let p; try { p = JSON.parse(raw); } catch { p = undefined; }
      if (validPaths(p)) { assertConfiguredPatterns(p); envList = p; }
      else { warn(`env ${AUDIT_SETTINGS_ENV[key]} invalid; every path protected`); strictest = true; }
    }
    value[key] = Object.freeze([...new Set([...(strictest ? STRICTEST_PATHS : GUARD_FLOOR), ...list, ...envList])]);
    assertConfiguredPatterns(value[key]);
    sources[key] = strictest ? 'strictest' : envList.length ? 'env' : list.length > platList.length ? 'file' : platList.length ? 'platform' : 'built-in';
  }
  // Prior question hashes only widen what is ACCEPTED, so only the trusted file may set them: no env route, and the
  // platform layer is ignored (as findAudit's reader ignores it — the team platform file must never widen acceptance).
  // A bad list is empty. Any unreadable layer accepts none (strictest), like every single-value setting above.
  if (isObj(plat) && Object.keys(plat).some(k => foldKey(k) === foldKey('priorQuestionHashes'))) {
    warn('audit platform preference priorQuestionHashes ignored; only the trusted settings file may accept prior hashes');
  }
  // Own keys only, as the cascade reads them: an inherited (prototype) value is never a setting.
  const hashes = isObj(tool) && Object.hasOwn(tool, 'priorQuestionHashes') ? tool.priorQuestionHashes : undefined;
  const hashesInvalid = rawMalformed(tool, 'priorQuestionHashes', validHashes) || caseShadowed(tool, 'priorQuestionHashes')
    || (hashes !== undefined && !validHashes(hashes));
  if (unreadable || !cascade || platBad || hashesInvalid) {
    if (hashesInvalid) warn('audit setting priorQuestionHashes invalid; none accepted');
    value.priorQuestionHashes = Object.freeze([]); sources.priorQuestionHashes = 'strictest';
  } else {
    value.priorQuestionHashes = Object.freeze(hashes === undefined ? [] : [...hashes]);
    sources.priorQuestionHashes = hashes === undefined ? 'built-in' : 'file';
  }
  return { value: Object.freeze(value), sources, warnings };
}


/** Changed-hunk context is deliberately small (0–3 lines). Environment may only reduce it.
 * Invalid/unreadable evidence uses zero context; operators can repair settings or request human review.
 */
export function resolveHunkContextSettings({ readFile = readFileSync, platformRead = readFileSync,
  env = process.env, platform, log = console.error } = {}) {
  const valid = v => Number.isInteger(v) && v >= 0 && v <= 3;
  const fallback = () => {
    log('audit scope: hunkContextLines=0 (fallback; retry settings or request human review)');
    return 0;
  };
  try {
    const data = JSON.parse(readFile(AUDIT_SETTINGS_PATH, 'utf8'));
    if (!isObj(data) || !isObj(data.audit)) return fallback();
    let plat = platform;
    if (plat === undefined) {
      const resolved = readPlatformPreferences({ env, readFile: platformRead });
      if (resolved.errors.length) return fallback();
      if (env[PLATFORM_PREFERENCES_ENV]) {
        // An explicit missing file is unreadable policy, not an absent preference.
        platformRead(env[PLATFORM_PREFERENCES_ENV], 'utf8');
      }
      plat = resolved.prefs.audit;
    }
    if (plat !== undefined && plat !== null && !isObj(plat)) return fallback();
    if (plat === null && platform === undefined) return fallback();
    if ([data.audit, plat].some(layer => layer && Object.hasOwn(layer, 'hunkContextLines') && !valid(layer.hunkContextLines))) return fallback();
    const resolved = cascadePolicy('audit', data.audit, {
      standard: { hunkContextLines: 3 }, platform: plat ?? null, env, log,
      valid: { hunkContextLines: valid },
    });
    let value = resolved.value.hunkContextLines;
    let source = resolved.sources.hunkContextLines;
    const raw = env.WE_AUDIT_HUNK_CONTEXT_LINES;
    if (raw !== undefined) {
      if (!/^[0-3]$/.test(raw)) return fallback();
      const tightened = Math.min(value, Number(raw));
      if (tightened < value) source = 'env';
      value = tightened;
    }
    if (!valid(value)) return fallback();
    log(`audit scope: hunkContextLines=${value} (${source})`);
    return value;
  } catch { return fallback(); }
}
