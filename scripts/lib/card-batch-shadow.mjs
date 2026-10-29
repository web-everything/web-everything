/**
 * @file scripts/lib/card-batch-shadow.mjs
 * @description Card xafcvmh (#6636), SHADOW only: "widen the creation-time batch". A card-only filing that adds
 *   raised-by sidecar files to existing cards still opens its own PR today (only brand-new cards join the rolling
 *   batch). In shadow mode we LOG what the batch would have held and change nothing else: no PR, no batch write.
 *
 * SETTING `cardBatchWiden.mode` = off | shadow | on, through the same per-layer cascade as the other card-batch
 *   settings (standard → platform → repo → env), each layer's winner named in `source`:
 *   1. standard — `off`.   2. platform — `cardBatchWiden` in delivery-platform-preferences.json.
 *   3. repo — `cardBatchWiden` in `scripts/settings/card-batch-widen.json` (this repo ships `shadow`).
 *   4. env — `WE_CARD_BATCH_WIDEN` (off|shadow|on). Invalid values are ignored and named in `invalid`.
 *   `on` is NOT built yet: it behaves as shadow, and the log line says so.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSettings } from './settings-files.mjs';

// Defined here (not imported from card-batch-settings.mjs) so this module reads no policy file at import time.
const PLATFORM_PREFERENCES_PATH = join(dirname(fileURLToPath(import.meta.url)), 'delivery-platform-preferences.json');

export const WIDEN_MODES = Object.freeze(['off', 'shadow', 'on']);
export const WIDEN_ENV = 'WE_CARD_BATCH_WIDEN';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** PURE cascade. @returns {{mode:'off'|'shadow'|'on', source:string, invalid:string[]}} */
export function resolveWidenMode({ platform, repo, env } = {}) {
  let mode = 'off';
  let source = 'standard';
  const invalid = [];
  const envRaw = isObject(env) && env[WIDEN_ENV] !== '' ? env[WIDEN_ENV] : undefined;
  for (const [name, layer] of [['platform', platform], ['repo', repo], ['env', envRaw]]) {
    if (layer === undefined || layer === null) continue;
    const value = isObject(layer) ? layer.mode : layer;
    if (value === undefined) continue;
    if (!WIDEN_MODES.includes(value)) { invalid.push(`${name}.mode`); continue; }
    mode = value;
    source = name;
  }
  return { mode, source, invalid };
}

/** IO: read every layer. Never throws for a missing or unreadable optional layer. */
export function loadWidenMode({
  env = process.env, read = readFileSync, platformPath = PLATFORM_PREFERENCES_PATH,
  repo = (() => { try { return readSettings()?.cardBatchWiden; } catch { return undefined; } })(),
} = {}) {
  let platform;
  try { platform = JSON.parse(read(platformPath, 'utf8'))?.cardBatchWiden; } catch { /* no preference */ }
  return resolveWidenMode({ platform, repo, env });
}

/**
 * PURE. The shadow log line for one card-only filing, or null when the mode is off or the filing touches no card.
 * `cards` are the card ids this filing writes (a new card first, then the existing cards that got sidecars).
 */
export function describeWouldBatch({ widen, cards = [], paths = [], window = null } = {}) {
  if (!widen || widen.mode === 'off') return null;
  const ids = [...new Set(cards.filter(Boolean).map(String))];
  if (!ids.length) return null;
  const [first, ...rest] = ids;
  const what = rest.length ? `would batch #${first} with ${rest.map((id) => `#${id}`).join(', ')}` : `would batch #${first}`;
  const note = widen.mode === 'on' ? 'on is not built yet, logging only' : 'shadow';
  const bits = [`${paths.length} path(s)`, window ? `window ${window}` : null].filter(Boolean).join(', ');
  const bad = widen.invalid?.length ? `; ignored invalid: ${widen.invalid.join(', ')}` : '';
  return `card-batch-widen (${note}, source ${widen.source}): ${what} (${bits}) instead of opening its own PR${bad}`;
}

/**
 * Emit the shadow line through `write`. NEVER throws: a failing settings load, formatter or writer is swallowed, and a
 * second guard covers the case where the guard itself fails. Returns true only when a line was written.
 */
export function emitWouldBatch({ loadWiden, cards, paths, write } = {}) {
  try {
    const line = describeWouldBatch({ widen: loadWiden(), cards, paths });
    if (!line) return false;
    write(line);
    return true;
  } catch { return false; }
}
