/**
 * @file model-settings.mjs - reads `model-settings.json`, the per-use model SETTINGS for cheap advisory jobs (card xb0ld4v).
 * Precedence at each call site: CLI flag > env > this file > the code default (the product default, unchanged).
 * Only the keys in ALLOWED are honoured, so a build/fix/ci-heal/mandatory-review-seat model can never be set from here.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MODEL_SETTINGS_FILE = join(dirname(fileURLToPath(import.meta.url)), 'model-settings.json');
export const ALLOWED = Object.freeze({ coroner: ['sampleModel'], velocity: ['estimateModel'], prepReview: ['model'] });
const MODEL_RE = /^[a-z][a-z0-9.-]{0,63}$/;

/** The parsed settings, or `{}` for a missing/torn/foreign file (fail toward the product default). Unknown keys and bad ids are dropped. */
export function readModelSettings(file = MODEL_SETTINGS_FILE) {
  let raw;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; }
  const out = {};
  for (const [group, keys] of Object.entries(ALLOWED)) {
    for (const key of keys) {
      const v = raw?.[group]?.[key];
      if (typeof v === 'string' && MODEL_RE.test(v)) (out[group] ??= {})[key] = v;
    }
  }
  return out;
}

/** One setting, or `fallback` (the product default) when unset. */
export function modelSetting(group, key, fallback, settings = readModelSettings()) {
  return settings?.[group]?.[key] ?? fallback;
}
