/**
 * @file scripts/lib/card-batch-settings.mjs
 * @description The `cards.*` batch-filing settings (operator go 2026-10-10): mechanically-filed cards land in ONE
 *   rolling card-only PR instead of one PR each.
 *
 * POLICY CASCADE — each key resolves on its own; the highest layer that sets it VALIDLY wins, and `sources` names
 * that layer so callers can log it:
 *   1. standard — the `filing` block of `we:scripts/lib/card-batch-policy.json` (the committed card-batch defaults).
 *   2. platform — `cards` in `we:scripts/lib/delivery-platform-preferences.json`. A missing file means "no
 *      preference" (that file may exist only on an open PR).
 *   3. repo — `cards` in the declared settings (`we:scripts/settings/*.json`, read through `readSettings`).
 *   4. env — `WE_CARDS_BATCH_FILING` (`0`/`1`), `WE_CARDS_BATCH_MAX_CARDS`, `WE_CARDS_BATCH_MAX_MINUTES`.
 *   An invalid value in a layer (wrong type, zero, negative, non-integer) is ignored and reported in `invalid`;
 *   the layer below answers instead.
 *
 * Keys: `batchFiling` (boolean), `batchMaxCards` (positive integer), `batchMaxMinutes` (positive integer).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCardBatchPolicy } from './card-batch-policy.mjs';
import { readSettings } from './settings-files.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CARD_BATCH_POLICY_PATH = join(HERE, 'card-batch-policy.json');
export const PLATFORM_PREFERENCES_PATH = join(HERE, 'delivery-platform-preferences.json');
export const CARD_BATCH_SETTING_KEYS = Object.freeze(['batchFiling', 'batchMaxCards', 'batchMaxMinutes']);
export const CARD_BATCH_ENV = Object.freeze({
  batchFiling: 'WE_CARDS_BATCH_FILING', batchMaxCards: 'WE_CARDS_BATCH_MAX_CARDS', batchMaxMinutes: 'WE_CARDS_BATCH_MAX_MINUTES',
});

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const validValue = (key, value) => key === 'batchFiling' || key === 'filingEnabled'
  ? typeof value === 'boolean'
  : Number.isSafeInteger(value) && value > 0;

/** Env strings → typed values; anything unparseable stays a string so it fails validation by name. */
function envLayer(env, keys = CARD_BATCH_SETTING_KEYS, names = CARD_BATCH_ENV) {
  if (!isObject(env)) return undefined;
  const layer = {};
  for (const key of keys) {
    const raw = env[names[key]];
    if (raw === undefined || raw === '') continue;
    if (key === 'batchFiling' || key === 'filingEnabled') layer[key] = raw === '1' || raw === 'true' ? true : raw === '0' || raw === 'false' ? false : raw;
    else layer[key] = /^\d+$/.test(String(raw)) ? Number(raw) : raw;
  }
  return layer;
}

/**
 * PURE cascade. `standard` is the card-batch policy's `filing` block (`{enabled, maxCards, maxAgeMinutes}`).
 * @returns {{batchFiling:boolean, batchMaxCards:number, batchMaxMinutes:number,
 *   sources:Record<string,string>, invalid:string[]}}
 */
export function resolveCardBatchSettings({ standard, platform, repo, env } = {}) {
  if (!isObject(standard)) throw new TypeError('card batch settings: standard filing policy is required');
  const out = { batchFiling: standard.enabled, batchMaxCards: standard.maxCards, batchMaxMinutes: standard.maxAgeMinutes };
  const sources = Object.fromEntries(CARD_BATCH_SETTING_KEYS.map((k) => [k, 'standard']));
  const invalid = [];
  for (const [name, layer] of [['platform', platform], ['repo', repo], ['env', envLayer(env)]]) {
    if (!isObject(layer)) continue;
    for (const key of CARD_BATCH_SETTING_KEYS) {
      if (!Object.hasOwn(layer, key)) continue;
      if (!validValue(key, layer[key])) { invalid.push(`${name}.${key}`); continue; }
      out[key] = layer[key];
      sources[key] = name;
    }
  }
  return { ...out, sources, invalid };
}

/** One log line naming each effective value and the layer that set it. */
export function formatCardBatchSettings(settings) {
  const parts = CARD_BATCH_SETTING_KEYS.map((k) => `cards.${k}=${settings[k]} (${settings.sources?.[k] ?? 'standard'})`);
  if (settings.invalid?.length) parts.push(`ignored invalid: ${settings.invalid.join(', ')}`);
  return `card-batch settings: ${parts.join(', ')}`;
}

const readCards = (path, read) => {
  try { return JSON.parse(read(path, 'utf8'))?.cards; } catch { return undefined; }
};

/** IO: read every layer. Never throws for a missing or unreadable optional layer. */
export function loadCardBatchSettings({
  env = process.env, read = readFileSync, platformPath = PLATFORM_PREFERENCES_PATH,
  repo = (() => { try { return readSettings()?.cards; } catch { return undefined; } })(),
} = {}) {
  const standard = loadCardBatchPolicy().filing;
  return resolveCardBatchSettings({ standard, platform: readCards(platformPath, read), repo, env });
}

/**
 * Prevention uses the same per-key cascade as cards: standard prevention policy → platform.prevention →
 * declared repo prevention → env. The standard window is 120 minutes; the operator's 60-minute default
 * lives in scripts/settings/prevention-batch.json. Lease waiting defaults to 15 minutes here, independently
 * of the policy overlay. Invalid optional values retain the lower layer.
 */
const PREVENTION_BATCH_SETTING_KEYS = Object.freeze(['batchFiling', 'batchWindowMinutes', 'batchMaxCards', 'batchLeaseWaitMinutes', 'filingEnabled']);
const PREVENTION_BATCH_ENV = Object.freeze({
  batchFiling: 'WE_PREVENTION_BATCH_FILING',
  batchWindowMinutes: 'WE_PREVENTION_BATCH_WINDOW_MINUTES',
  batchMaxCards: 'WE_PREVENTION_BATCH_MAX_CARDS',
  batchLeaseWaitMinutes: 'WE_PREVENTION_BATCH_LEASE_WAIT_MINUTES',
  filingEnabled: 'WE_PREVENTION_FILING_ENABLED',
});

/** PURE: resolve boolean batchFiling and positive integer window/count/lease wait, retaining each source. */
export function resolvePreventionBatchSettings({ standard, platform, repo, env } = {}) {
  if (!isObject(standard)) throw new TypeError('prevention batch settings: standard prevention policy is required');
  const out = { batchFiling: standard.enabled, batchWindowMinutes: standard.maxAgeMinutes,
    batchMaxCards: standard.maxCards, batchLeaseWaitMinutes: 15, filingEnabled: true };
  const sources = Object.fromEntries(PREVENTION_BATCH_SETTING_KEYS.map((k) => [k, 'standard']));
  const invalid = [];
  for (const [name, layer] of [['platform', platform], ['repo', repo],
    ['env', envLayer(env, PREVENTION_BATCH_SETTING_KEYS, PREVENTION_BATCH_ENV)]]) {
    if (!isObject(layer)) continue;
    for (const key of PREVENTION_BATCH_SETTING_KEYS) {
      if (!Object.hasOwn(layer, key)) continue;
      if (!validValue(key, layer[key])) { invalid.push(`${name}.${key}`); continue; }
      out[key] = layer[key];
      sources[key] = name;
    }
  }
  return { ...out, sources, invalid };
}

/** One log line naming every prevention value, source and ignored invalid setting. */
export function formatPreventionBatchSettings(settings) {
  const parts = PREVENTION_BATCH_SETTING_KEYS.map((k) => `prevention.${k}=${settings[k]} (${settings.sources?.[k] ?? 'standard'})`);
  if (settings.invalid?.length) parts.push(`ignored invalid: ${settings.invalid.join(', ')}`);
  return `prevention-batch settings: ${parts.join(', ')}`;
}

/** IO: optional platform/repo layers may be missing or unreadable. */
export function loadPreventionBatchSettings({
  env = process.env, read = readFileSync, platformPath = PLATFORM_PREFERENCES_PATH,
  repo = (() => { try { return readSettings()?.prevention; } catch { return undefined; } })(),
} = {}) {
  let platform;
  try { platform = JSON.parse(read(platformPath, 'utf8'))?.prevention; } catch { /* no preference */ }
  return resolvePreventionBatchSettings({ standard: loadCardBatchPolicy().prevention, platform, repo, env });
}

/**
 * Minutes to wait before re-arming a seal whose verify did not RUN (host capacity, not a code failure). Same layers as
 * the keys above (standard 15 → platform → repo → env `WE_CARDS_BATCH_VERIFY_RETRY_MINUTES`); invalid layers are skipped.
 */
export const DEFAULT_VERIFY_RETRY_MINUTES = 15;
export function resolveVerifyRetryMinutes({ platform, repo, env, now = Date.now() } = {}) {
  let minutes = DEFAULT_VERIFY_RETRY_MINUTES;
  const raw = env?.WE_CARDS_BATCH_VERIFY_RETRY_MINUTES;
  for (const layer of [platform, repo, raw === undefined || raw === '' ? undefined : { batchVerifyRetryMinutes: /^\d+$/.test(String(raw)) ? Number(raw) : raw }]) {
    if (!isObject(layer)) continue;
    const candidate = layer.batchVerifyRetryMinutes;
    // A safe integer in minutes can still overflow Date's range after conversion and addition.
    if (validValue('batchVerifyRetryMinutes', candidate)
      && Number.isFinite(new Date(now + candidate * 60_000).getTime())) minutes = candidate;
  }
  return minutes;
}
export function loadVerifyRetryMinutes({ env = process.env, read = readFileSync, platformPath = PLATFORM_PREFERENCES_PATH, now = Date.now(),
  repo = (() => { try { return readSettings()?.cards; } catch { return undefined; } })() } = {}) {
  return resolveVerifyRetryMinutes({ platform: readCards(platformPath, read), repo, env, now });
}

/**
 * `prevention.alsoRaised.route` — where an "also raised" note (a raised-by sidecar for an EXISTING open card) goes:
 *   `batch` (standard) — into the rolling prevention batch PR, or the pending spool when the batch cannot take it now;
 *   `single` — the kill switch: the old one-PR-per-filing path (`lane/<id>-prevention-card`).
 * Cascade: standard → platform `prevention.alsoRaised.route` → repo `prevention.alsoRaised.route` → env
 * `WE_PREVENTION_ALSO_RAISED_ROUTE`. An unknown value is ignored (reported in `invalid`); the layer below answers.
 */
export const ALSO_RAISED_ROUTES = Object.freeze(['batch', 'single']);
export function resolveAlsoRaisedRoute({ platform, repo, env } = {}) {
  let route = 'batch';
  let source = 'standard';
  const invalid = [];
  const raw = env?.WE_PREVENTION_ALSO_RAISED_ROUTE;
  for (const [name, value] of [['platform', platform?.alsoRaised?.route], ['repo', repo?.alsoRaised?.route],
    ['env', raw === '' ? undefined : raw]]) {
    if (value === undefined) continue;
    if (!ALSO_RAISED_ROUTES.includes(value)) { invalid.push(`${name}.alsoRaised.route`); continue; }
    route = value;
    source = name;
  }
  return { route, source, invalid };
}
export function formatAlsoRaisedRoute({ route, source, invalid = [] }) {
  return `prevention.alsoRaised.route=${route} (${source})${invalid.length ? `, ignored invalid: ${invalid.join(', ')}` : ''}`;
}
export function loadAlsoRaisedRoute({
  env = process.env, read = readFileSync, platformPath = PLATFORM_PREFERENCES_PATH,
  repo = (() => { try { return readSettings()?.prevention; } catch { return undefined; } })(),
} = {}) {
  let platform;
  try { platform = JSON.parse(read(platformPath, 'utf8'))?.prevention; } catch { /* no preference */ }
  return resolveAlsoRaisedRoute({ platform, repo, env });
}

/** The full policy with independent filing and prevention settings overlays. */
export function effectiveCardBatchPolicy(settings = loadCardBatchSettings(), prevention = loadPreventionBatchSettings()) {
  return loadCardBatchPolicy({
    filing: { enabled: settings.batchFiling, maxCards: settings.batchMaxCards, maxAgeMinutes: settings.batchMaxMinutes },
    prevention: { enabled: prevention.batchFiling, maxCards: prevention.batchMaxCards, maxAgeMinutes: prevention.batchWindowMinutes },
  });
}
