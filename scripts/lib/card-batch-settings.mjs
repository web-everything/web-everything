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
const validValue = (key, value) => key === 'batchFiling'
  ? typeof value === 'boolean'
  : Number.isSafeInteger(value) && value > 0;

/** Env strings → typed values; anything unparseable stays a string so it fails validation by name. */
function envLayer(env) {
  if (!isObject(env)) return undefined;
  const layer = {};
  for (const key of CARD_BATCH_SETTING_KEYS) {
    const raw = env[CARD_BATCH_ENV[key]];
    if (raw === undefined || raw === '') continue;
    if (key === 'batchFiling') layer[key] = raw === '1' || raw === 'true' ? true : raw === '0' || raw === 'false' ? false : raw;
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

/** The full card-batch policy with the `filing` kind overlaid by the effective `cards.*` settings. */
export function effectiveCardBatchPolicy(settings = loadCardBatchSettings()) {
  return loadCardBatchPolicy({
    filing: { enabled: settings.batchFiling, maxCards: settings.batchMaxCards, maxAgeMinutes: settings.batchMaxMinutes },
  });
}
