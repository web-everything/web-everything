/**
 * @file scripts/lib/review-seat-settings.mjs
 * @description The two `review.*` seat-scheduling settings, under the policy cascade (the same shape
 *   `we:scripts/lib/red-main-hold.mjs` uses): standard default (built-in) → platform preference
 *   (`we:scripts/settings/review.json`) → tool override (env).
 *
 *   - `review.parallelSeats` (`on` | `off`, built-in `on`; env `WE_REVIEW_PARALLEL_SEATS`) — every juror seat of a
 *     `review-pr` run starts at once (`we:scripts/operations/parallel-judges.mjs`) instead of one after another.
 *     `off` = the sequential drive this setting replaced. The verdict is the same either way.
 *   - `review.seatsByTouchSet` (`on` | `off`, built-in `on`; env `WE_REVIEW_SEATS_BY_TOUCH_SET`) — the review
 *     daemon's driver (`we:scripts/operations/review-loop-cli.mjs`) chooses the seat list from the PR's touch-set
 *     BEFORE the run starts: an all-prose PR does not seat the security juror. `off` = always seat both.
 *
 *   Unknown values fall through to the next layer. `true`/`false` (booleans or strings) are accepted as on/off so a
 *   JSON settings file can use either spelling. PURE except the settings-file read.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REVIEW_SETTINGS_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'settings', 'review.json');

/** setting key → { env var, built-in default }. */
export const REVIEW_SEAT_SETTINGS = Object.freeze({
  parallelSeats: Object.freeze({ env: 'WE_REVIEW_PARALLEL_SEATS', builtIn: 'on' }),
  seatsByTouchSet: Object.freeze({ env: 'WE_REVIEW_SEATS_BY_TOUCH_SET', builtIn: 'on' }),
});

/** Normalise one layer's value to `on` | `off`, or `null` when it says nothing usable. PURE. */
export function normOnOff(v) {
  if (v === true) return 'on';
  if (v === false) return 'off';
  const x = String(v ?? '').trim().toLowerCase();
  if (x === 'on' || x === 'true' || x === '1') return 'on';
  if (x === 'off' || x === 'false' || x === '0') return 'off';
  return null;
}

/**
 * Resolve one seat setting. env > settings file > built-in.
 * @param {'parallelSeats'|'seatsByTouchSet'} key
 * @param {{env?: Record<string,string|undefined>, file?: string, readFile?: (p: string) => string}} [o]
 * @returns {{value: 'on'|'off', source: 'env'|'settings'|'default'}}
 */
export function resolveReviewSeatSetting(key, { env = process.env, file = REVIEW_SETTINGS_FILE, readFile = (p) => readFileSync(p, 'utf8') } = {}) {
  const spec = REVIEW_SEAT_SETTINGS[key];
  if (!spec) throw new Error(`review-seat-settings: unknown setting ${JSON.stringify(key)} (known: ${Object.keys(REVIEW_SEAT_SETTINGS).join(', ')})`);
  const fromEnv = normOnOff(env?.[spec.env]);
  if (fromEnv) return { value: fromEnv, source: 'env' };
  try {
    const f = normOnOff(JSON.parse(readFile(file))?.[key]);
    if (f) return { value: f, source: 'settings' };
  } catch { /* built-in */ }
  return { value: spec.builtIn, source: 'default' };
}

/** `review.parallelSeats` as a boolean. */
export function parallelSeatsEnabled(o) {
  return resolveReviewSeatSetting('parallelSeats', o).value === 'on';
}

/** `review.seatsByTouchSet` as a boolean. */
export function seatsByTouchSetEnabled(o) {
  return resolveReviewSeatSetting('seatsByTouchSet', o).value === 'on';
}
