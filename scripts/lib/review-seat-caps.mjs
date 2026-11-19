import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cascadePolicy, platformPreference, formatCascadeSourcesLine } from './policy-cascade.mjs';

const SETTINGS_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'settings', 'review.json');
/** Read on every resolution; injectable IO keeps callers and fixtures independent of host preferences. */
export function readReviewSeatPolicy({ env = process.env, readFile = readFileSync, platform, log } = {}) {
  let tool = {};
  try { tool = JSON.parse(String(readFile(SETTINGS_FILE, 'utf8'))); } catch { /* lower layers */ }
  const preference = platform ?? platformPreference('review', { env, readFile });
  return { tool, platform: preference ?? {}, log };
}

function seatPolicy(key, standard, valid, env, reader, envValues = {}) {
  let settings = {};
  try { settings = reader({ env }) ?? {}; } catch { /* defaults and env remain usable */ }
  const project = layer => Object.fromEntries(Object.keys(standard)
    .filter(k => valid(layer?.[k])).map(k => [k, layer[k]]));
  const result = cascadePolicy(`review.${key}`, project(settings.tool?.[key]), {
    standard, platform: project(settings.platform?.[key]), env, envValues, valid, log: settings.log,
  });
  settings.log?.(formatCascadeSourcesLine(`review.${key}`, result));
  return result.value;
}

export function redTeamRouteByBuilder(env = process.env, readSettings = readReviewSeatPolicy) {
  return seatPolicy('redTeam', { routeByBuilder: true }, v => typeof v === 'boolean', env, readSettings).routeByBuilder;
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
/** The default cap per provider when its own env var (and, for codex only, the legacy shared one) is unset.
 *  Codex's default is 600; agy-claude
 *  keeps its default of 300. Gemini is off by default under the operator ruling of 2026-10-02:
 *  Gemini too weak for review until Gemini 4; its own env cap can explicitly enable it. */
export const PROVIDER_CAP_DEFAULT = Object.freeze({ codex: 600, 'agy-claude': 300, 'agy-gemini': 0 });
/** The daily call cap for ONE provider: its own env var, else (codex only) the legacy shared env var, else its
 *  settings cascade, then its own default. Invalid settings fall through. Reads settings on every call. */
export function resolveProviderCap(provider, env = process.env, readSettings = readReviewSeatPolicy) {
  if (!Object.hasOwn(PROVIDER_CAP_DEFAULT, provider)) return DEFAULT_DAILY_CAP;
  const ownName = PROVIDER_CAP_ENV[provider];
  const own = Number(env?.[ownName]);
  const override = Number.isInteger(own) && own >= 0 ? own
    : provider === 'codex' && env?.[DAILY_CAP_ENV] !== undefined ? resolveDailyCap(env) : undefined;
  return seatPolicy('seatDailyCaps', PROVIDER_CAP_DEFAULT, v => Number.isSafeInteger(v) && v >= 0,
    env, readSettings, { [provider]: override })[provider];
}
/** Live operation controls may enable a default-disabled provider; explicit env caps always win. */
export function resolveRoutingProviderCap(provider, env = process.env, entry, readSettings = readReviewSeatPolicy) {
  if (entry?.disabledProviders?.includes(provider)) return 0;
  const cap = resolveProviderCap(provider, env, readSettings);
  return entry?.enabledProviders?.includes(provider) && cap === 0 && PROVIDER_CAP_DEFAULT[provider] === 0
    && env?.[PROVIDER_CAP_ENV[provider]] === undefined
    ? 300 : cap;
}
/** @returns {number} the configured daily call cap (a non-negative integer), else the default. PURE. */
export function resolveDailyCap(env = process.env) {
  const n = Number(env?.[DAILY_CAP_ENV]);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_DAILY_CAP;
}
