/**
 * @file scripts/lib/review-seat-settings.mjs
 * @description The `review.*` seat settings, under the policy cascade (the same shape
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
 *   - `review.shadowSeats.antigravity.model` (built-in null; env `WE_REVIEW_SHADOW_AGY_MODEL`) — names the agy
 *     model ONLY for routing-policy `shadow` mandatory seats (advisory, never counted). Null uses the routing model.
 *     It never changes a seat's weight, mode or blocking role, never applies to a non-shadow `agy` seat, and never
 *     applies to the advisory agy-correctness seat.
 *   - `review.shadowSeats.antigravity.trialReviews` (built-in null; env `WE_REVIEW_SHADOW_AGY_TRIAL_REVIEWS`) — the
 *     trial length, in completed shadow reviews by that model; read by `we:scripts/lib/agy-shadow-trial-report.mjs`.
 *     Reporting only: reaching it never promotes the model.
 *
 *   Unknown values fall through to the next layer. `true`/`false` (booleans or strings) are accepted as on/off so a
 *   JSON settings file can use either spelling. PURE except the settings-file read.
 */
import { cascadePolicy, formatCascadeSourcesLine, platformPreference } from './policy-cascade.mjs';
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

export const SHADOW_AGY_MODEL_ENV = 'WE_REVIEW_SHADOW_AGY_MODEL';

/** Resolve the advisory shadow model: env > settings > null (routing policy). Never throws. */
export function resolveShadowSeatModel({ env = process.env, file = REVIEW_SETTINGS_FILE, readFile = (p) => readFileSync(p, 'utf8') } = {}) {
  const valid = (value) => typeof value === 'string' && /^[a-z][a-z0-9.-]{0,63}$/.test(value);
  try {
    const value = env?.[SHADOW_AGY_MODEL_ENV];
    if (valid(value)) return { value, source: 'env' };
  } catch { /* next layer */ }
  try {
    const value = JSON.parse(readFile(file))?.shadowSeats?.antigravity?.model;
    if (valid(value)) return { value, source: 'settings' };
  } catch { /* built-in */ }
  return { value: null, source: 'default' };
}

export const SHADOW_AGY_TRIAL_REVIEWS_ENV = 'WE_REVIEW_SHADOW_AGY_TRIAL_REVIEWS';

/**
 * `review.shadowSeats.antigravity.trialReviews` — how many completed shadow reviews the model named by
 * `shadowSeats.antigravity.model` must reach before its trial counts as complete (operator 2026-10-13: measure the
 * trial by review count, not days). env > settings > null (no trial target). A positive integer only; anything else
 * falls through. It is a REPORTING target: reaching it never promotes the model or changes any seat — promotion stays
 * the operator's call. Never throws.
 * @returns {{value: number|null, source: 'env'|'settings'|'default'}}
 */
export function resolveShadowTrialReviews({ env = process.env, file = REVIEW_SETTINGS_FILE, readFile = (p) => readFileSync(p, 'utf8') } = {}) {
  const valid = (v) => {
    const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN);
    return Number.isInteger(n) && n > 0 && n <= 100000 ? n : null;
  };
  const fromEnv = valid(env?.[SHADOW_AGY_TRIAL_REVIEWS_ENV]);
  if (fromEnv) return { value: fromEnv, source: 'env' };
  try {
    const f = valid(JSON.parse(readFile(file))?.shadowSeats?.antigravity?.trialReviews);
    if (f) return { value: f, source: 'settings' };
  } catch { /* built-in */ }
  return { value: null, source: 'default' };
}

/** Operational panel safeguards. Standard → platform review → tool review.json → env.
 * enabled: false; scope: high-care; dailyCap: 100 (New York day); sampleRate: 0.1 in [0,1) (1 is refused).
 * minNonClaudeSeats: positive integer, default 1.
 * Invalid layers fall through and are logged. Sources are logged even in the short review CLI.
 */
const loggedSafeguards = new Set();
export function resolveReviewSeatSafeguards({ env = process.env, file = REVIEW_SETTINGS_FILE,
  readFile = (p) => readFileSync(p, 'utf8'), platform, log = (m) => console.error(m) } = {}) {
  let tool = {};
  try { tool = JSON.parse(readFile(file)); } catch { /* standard/platform still apply */ }
  const valid = {
    shadowEnabled: (v) => typeof v === 'boolean',
    sampleRate: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1,
    scope: (v) => ['high-care', 'sampled'].includes(v),
    dailyCap: (v) => Number.isSafeInteger(v) && v >= 0,
    minNonClaudeSeats: (v) => Number.isSafeInteger(v) && v >= 1,
  };
  const invalid = [];
  // These settings are scalars: reject the entire value before the cascade flattens objects into leaves.
  const project = (v, layer) => Object.fromEntries(Object.entries({
    shadowEnabled: v?.shadowSeats?.antigravity?.enabled,
    sampleRate: v?.shadowSeats?.antigravity?.sampleRate,
    scope: v?.shadowSeats?.antigravity?.scope,
    dailyCap: v?.shadowSeats?.antigravity?.dailyCap,
    minNonClaudeSeats: v?.minNonClaudeSeats,
  }).filter(([key, value]) => {
    if (value === undefined) return false;
    if (valid[key](value)) return true;
    invalid.push(`${layer}.${key}=${JSON.stringify(value)}`);
    return false;
  }));
  const plat = platform ?? platformPreference('review', { env });
  const platformValues = project(plat, 'platform');
  const toolValues = project(tool, 'tool');
  const numeric = (v) => typeof v === 'string' && v.trim() ? Number(v) : v;
  const result = cascadePolicy('review.seatSafeguards', toolValues, {
    standard: { shadowEnabled: false, scope: 'high-care', dailyCap: 100, sampleRate: 0.1, minNonClaudeSeats: 1 },
    platform: platformValues, env,
    envValues: {
      shadowEnabled: env.WE_REVIEW_SHADOW_AGY_ENABLED === undefined ? undefined : normOnOff(env.WE_REVIEW_SHADOW_AGY_ENABLED) === 'on'
        ? true : normOnOff(env.WE_REVIEW_SHADOW_AGY_ENABLED) === 'off' ? false : env.WE_REVIEW_SHADOW_AGY_ENABLED,
      sampleRate: numeric(env.WE_REVIEW_SHADOW_AGY_SAMPLE_RATE),
      minNonClaudeSeats: numeric(env.WE_REVIEW_MIN_NON_CLAUDE_SEATS),
      scope: env.WE_REVIEW_SHADOW_AGY_SCOPE,
      dailyCap: numeric(env.WE_REVIEW_SHADOW_AGY_DAILY_CAP),
    },
    valid,
  });
  result.invalid.unshift(...invalid);
  const line = formatCascadeSourcesLine('review.seatSafeguards', result).replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ');
  if (!loggedSafeguards.has(line)) { loggedSafeguards.add(line); log(line); }
  return result;
}

/** Card-only review: standard → platform review → tool review.json → env. */
export function resolveCardOnlyReviewSettings({ env = process.env, platform,
  file = REVIEW_SETTINGS_FILE, readFile = p => readFileSync(p, 'utf8'), log = m => console.error(m) } = {}) {
  let tool = {};
  try { tool = JSON.parse(readFile(file))?.cardOnly ?? {}; } catch { /* absent layer */ }
  const project = value => Object.fromEntries(['lightLane', 'claudeSeat']
    .filter(key => typeof value?.[key] === 'boolean').map(key => [key, value[key]]));
  const parse = value => normOnOff(value) === 'on' ? true : normOnOff(value) === 'off' ? false : undefined;
  const result = cascadePolicy('review.cardOnly', project(tool), {
    standard: { lightLane: true, claudeSeat: false },
    platform: project(platform ?? platformPreference('review', { env })?.cardOnly), env,
    envValues: { lightLane: parse(env.WE_REVIEW_CARD_ONLY_LIGHT_LANE), claudeSeat: parse(env.WE_REVIEW_CARD_ONLY_CLAUDE_SEAT) },
    valid: { lightLane: v => typeof v === 'boolean', claudeSeat: v => typeof v === 'boolean' },
  });
  log(formatCascadeSourcesLine('review.cardOnly', result));
  return result;
}

export const EXTRA_SEATS_PAUSED_LENSES_ENV = 'WE_REVIEW_EXTRA_SEATS_PAUSED_LENSES';

/**
 * `review.extraSeats.pausedLenses` - advisory lenses whose extra (non-Claude) seat is NOT called. Standard `[]`;
 * resolves standard -> platform -> tool (`extraSeats.pausedLenses` in `we:scripts/settings/review.json`) -> env
 * (JSON array or comma list), through the policy cascade. Never touches mandatory seats or verdicts. Never throws.
 * @returns {{value: string[], source: string}} source is the winning layer ('setting' for the tool file).
 */
export function resolveExtraSeatsPausedLenses({ env = process.env, file = REVIEW_SETTINGS_FILE,
  readFile = (p) => readFileSync(p, 'utf8'), platform, log } = {}) {
  const valid = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim());
  // Project the WHOLE array per layer before the cascade flattens objects into leaves: a malformed layer
  // (an object, a non-string member) is dropped, never half-applied, and can never throw.
  const project = (block) => (valid(block?.pausedLenses) ? { pausedLenses: block.pausedLenses } : undefined);
  try {
    let tool;
    try { tool = project(JSON.parse(readFile(file))?.extraSeats); } catch { /* standard/platform still apply */ }
    let plat = platform;
    if (plat === undefined) { try { plat = platformPreference('review.extraSeats', { env }); } catch { plat = undefined; } }
    let envValue;
    const raw = env?.[EXTRA_SEATS_PAUSED_LENSES_ENV];
    if (raw !== undefined && raw !== '') {
      try { envValue = JSON.parse(raw); } catch { envValue = String(raw).split(',').map((x) => x.trim()).filter(Boolean); }
    }
    const r = cascadePolicy('review.extraSeats', tool, {
      standard: { pausedLenses: [] }, platform: project(plat) ?? {}, env, ...(log ? { log } : {}),
      envValues: { pausedLenses: envValue }, valid: { pausedLenses: valid },
    });
    const list = r.value?.pausedLenses;
    if (!valid(list)) return { value: [], source: 'standard' };
    const layer = r.sources?.pausedLenses ?? 'standard';
    return { value: [...new Set(list.map((x) => x.trim()))], source: layer === 'tool' ? 'setting' : layer };
  } catch { return { value: [], source: 'standard' }; }
}
