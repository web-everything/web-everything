import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cascadePolicy, readPlatformPreferences, formatCascadeSourcesLine } from './policy-cascade.mjs';

const SETTINGS_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'settings', 'review.json');
/** Read on every resolution; injectable IO keeps callers and fixtures independent of host preferences. */
export function readReviewSeatPolicy({ env = process.env, readFile = readFileSync, platform, log } = {}) {
  let tool = {};
  const warn = log ?? console.error;
  let failed = false;
  try {
    tool = JSON.parse(String(readFile(SETTINGS_FILE, 'utf8')));
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) throw new Error('expected a settings object');
  } catch (error) {
    warn(`WARNING review seat settings unreadable/malformed: ${error.message}; ignoring tool layer, using remaining settings or repo defaults`);
    tool = {}; failed = true;
  }
  const preferences = platform === undefined ? readPlatformPreferences({ env, readFile }) : { prefs: { review: platform }, errors: [] };
  if (preferences.prefs.review !== undefined && (!preferences.prefs.review || typeof preferences.prefs.review !== 'object' || Array.isArray(preferences.prefs.review))) {
    preferences.errors.push('review: expected a settings object');
    delete preferences.prefs.review;
  }
  if (preferences.errors.length) {
    warn(`WARNING review seat platform settings unreadable/malformed: ${preferences.errors.join('; ')}; ignoring invalid layers, using remaining settings or repo defaults`);
    failed = true;
  }
  return { tool, platform: preferences.prefs.review ?? {}, log, failed };
}

function seatPolicy(key, standard, valid, env, reader, envValues = {}) {
  let settings = {};
  try { settings = reader({ env }) ?? {}; } catch (error) {
    console.error(`WARNING review seat settings unreadable: ${error.message}; using repo defaults`);
    settings = { failed: true };
  }
  const invalid = new Set();
  const project = layer => {
    if (layer !== undefined && (!layer || typeof layer !== 'object' || Array.isArray(layer))) {
      (settings.log ?? console.error)(`WARNING review.${key}: malformed settings block; ignoring block, using remaining settings or repo defaults`);
      Object.keys(standard).forEach(k => invalid.add(k));
      return {};
    }
    return Object.fromEntries(Object.keys(standard)
    .filter(k => layer?.[k] !== undefined).flatMap(k => {
      if (valid(layer[k])) return [[k, layer[k]]];
      (settings.log ?? console.error)(`WARNING review.${key}.${k}: malformed setting; ignoring entry, using remaining settings or repo default ${standard[k]}`);
      invalid.add(k);
      return [];
    }));
  };
  const platform = project(settings.platform?.[key]);
  const tool = project(settings.tool?.[key]);
  const result = cascadePolicy(`review.${key}`, tool, {
    standard, platform, env, envValues, valid, log: settings.log,
  });
  settings.log?.(formatCascadeSourcesLine(`review.${key}`, result));
  return { ...result, failed: settings.failed, invalidSettings: invalid };
}

export function redTeamRouteByBuilder(env = process.env, readSettings = readReviewSeatPolicy) {
  return seatPolicy('redTeam', { routeByBuilder: true }, v => typeof v === 'boolean', env, readSettings).value.routeByBuilder;
}

/** Provider-cap policy shared by routing validation and review launchers. */
/** LEGACY — the old SHARED per-day cap on non-Claude seat CALLS, counted across every provider together. Card
 *  xn2wf9t (2026-09-27) replaced it with a cap PER PROVIDER ({@link PROVIDER_CAP_ENV}): Codex's own weekly
 *  allowance is comparatively tight while both antigravity backends are separate and generous, so one shared
 *  number let Codex's use starve antigravity's (474 seat calls skipped in one day on `daily-cap`, all three
 *  providers still well under their own real budget). Kept, for ONE release only, as Codex's OWN fallback when
 *  {@link PROVIDER_CAP_ENV}`.codex` is unset — see {@link resolveProviderCap} — so an operator who only ever set
 *  this env var keeps exactly today's Codex behavior until they move to the new name. */
export const DAILY_CAP_ENV = 'WE_REVIEW_EXTRA_SEATS_DAILY_CAP';
export const DEFAULT_DAILY_CAP = 40;
/** The per-PROVIDER daily call cap env var, one per launch roster entry. */
export const PROVIDER_CAP_ENV = Object.freeze({
  codex: 'WE_REVIEW_SEAT_CAP_CODEX',
  'agy-claude': 'WE_REVIEW_SEAT_CAP_AGY_CLAUDE',
  'agy-gemini': 'WE_REVIEW_SEAT_CAP_AGY_GEMINI',
});
/** Independent Carbon shadow seat switch; zero disables only Carbon in shadow mode. */
export const CARBON_SHADOW_CAP_ENV = 'WE_REVIEW_SEAT_CAP_CARBON_SHADOW';
export function resolveCarbonShadowCap(env = process.env) {
  const value = env?.[CARBON_SHADOW_CAP_ENV];
  // Unset or blank = the default (1, on). Anything else that is not a non-negative integer fails CLOSED (0, off).
  if (value == null || (typeof value === 'string' && value.trim() === '')) return 1;
  const n = typeof value === 'boolean' ? NaN : Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}
/** Standard daily caps: Codex 80, Gemini 0 (operator ruling 2026-10-02; opt-in only), agy-claude 10 (red-team emergency only). */
export const PROVIDER_CAP_DEFAULT = Object.freeze({ codex: 80, 'agy-claude': 10, 'agy-gemini': 0 });
/** The daily call cap for ONE provider: its own env var, else (codex only) the legacy shared env var, else its
 *  settings cascade, then its own default. Invalid entries/layers warn and are skipped. Reads settings on every call. */
function providerCapPolicy(provider, env, readSettings) {
  const ownName = PROVIDER_CAP_ENV[provider];
  const own = Number(env?.[ownName]);
  const override = Number.isInteger(own) && own >= 0 ? own
    : provider === 'codex' && env?.[DAILY_CAP_ENV] !== undefined ? resolveDailyCap(env) : undefined;
  return seatPolicy('seatDailyCaps', PROVIDER_CAP_DEFAULT, v => Number.isSafeInteger(v) && v >= 0,
    env, readSettings, { [provider]: override });
}
export function resolveProviderCap(provider, env = process.env, readSettings = readReviewSeatPolicy) {
  if (!Object.hasOwn(PROVIDER_CAP_DEFAULT, provider)) return DEFAULT_DAILY_CAP;
  return providerCapPolicy(provider, env, readSettings).value[provider];
}
/** Live controls may enable an unset default-disabled provider; explicit caps always win. */
export function resolveRoutingProviderCap(provider, env = process.env, entry, readSettings = readReviewSeatPolicy) {
  if (entry?.disabledProviders?.includes(provider)) return 0;
  if (!Object.hasOwn(PROVIDER_CAP_DEFAULT, provider)) return DEFAULT_DAILY_CAP;
  const resolved = providerCapPolicy(provider, env, readSettings);
  const cap = resolved.value[provider];
  return entry?.enabledProviders?.includes(provider) && cap === 0 && PROVIDER_CAP_DEFAULT[provider] === 0
    && resolved.sources[provider] === 'standard' && !resolved.failed && !resolved.invalidSettings.has(provider)
    && env?.[PROVIDER_CAP_ENV[provider]] === undefined
    ? 300 : cap;
}
/** @returns {number} the configured daily call cap (a non-negative integer), else the default. PURE. */
export function resolveDailyCap(env = process.env) {
  const n = Number(env?.[DAILY_CAP_ENV]);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_DAILY_CAP;
}
