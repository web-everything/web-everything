import { cascadePolicy, platformPreference } from './policy-cascade.mjs';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `review.referralDefault` — who rules first on a CONFIRMED mandatory referral (verdict CONFIRMED, impact broken or
 * unrecoverable). `operator` (the product default) parks the review and asks the operator. `auto-block` records a
 * `block` ruling as actor `auto-policy` and sends the PR back to the fixer. It never clears, accepts or cards
 * anything: a wrong auto-block is overridden by the operator's card / not-real ruling (supersede).
 *
 * review.noFixerOnClearedRuled defaults on: dispatch omits exact operator card/not-real rulings and
 * auto-only blocks on a human-cleared live head. False restores dispatch; gate results never change.
 *
 * review.autoBlockYieldsToReviewerNotReal defaults OFF in this health-watch build (main's policy-block precedence,
 * coordinator ruling 2026-10-21; operator to revisit); true opts in to the reviewer not-real yield.
 * Only a later, evidenced, independent mandatory-reviewer ruling on the exact live head/run/key qualifies. */
export const REFERRAL_DEFAULTS = Object.freeze(['operator', 'auto-block']);
/**
 * `review.scopedRereview` (card 5469, ruling P3) — the scoped re-review with a binding prior round. `off` (built-in,
 * today's behaviour): every round is a full review and nothing extra is recorded. `shadow`: the full review still
 * decides; each review also appends stable finding-identity rows to the ledger and journals what the scoped review +
 * binding prior round WOULD have decided (would-block / would-card). `on` (card 5470): as `shadow`, and a later round
 * the shadow says would not have blocked is accepted with its findings filed as a card
 * (we:scripts/lib/review-loop-policy.mjs#bindingPriorRoundDecision). The declared file stays `shadow` (P3 revised).
 */
export const SCOPED_REREVIEW_MODES = Object.freeze(['off', 'shadow', 'on']);
/**
 * `review.roundBudget` (card 5471, ruling P5) — K, the number of review rounds before a `changes` round whose findings
 * are all non-broken is accepted with those findings filed as a card (we:scripts/lib/review-loop-policy.mjs
 * #roundBudgetDecision). `off` (built-in) is today: no budget. A positive integer from the file, or its decimal string
 * from the env; anything else keeps the lower layer's value (fail closed: an unreadable file means `off`).
 */
export const ROUND_BUDGET_OFF = 'off';
/** The largest K any layer accepts (the round cap is 5, so a bigger K never acts; one bound keeps the layers in step). */
export const ROUND_BUDGET_MAX = 50;
/** THE ONE PREDICATE for a usable K, shared by the file, the env and every consumer of the resolved value. */
export const isValidRoundBudget = (v) => Number.isInteger(v) && v >= 1 && v <= ROUND_BUDGET_MAX;
/**
 * `review.takeoverReviewAttempts` — how many reviews a head pushed by a takeover earns beyond the round cap
 * (we:scripts/conveyor/takeover-review.mjs). Built-in 1: without it a takeover's work is never judged. 0 turns it off.
 * An integer 0..{@link TAKEOVER_REVIEW_ATTEMPTS_MAX} from the file, or its decimal string from the env.
 */
export const TAKEOVER_REVIEW_ATTEMPTS_MAX = 5;
/**
 * `review.rulingResolvesStandDown` — `on` (built-in) relays a later operator referral ruling as an answer
 * when no findings remain held and every explicit stand-down finding subject is ruled.
 * Unbound questions still require the explicit stand-down-answer ceremony; `off` requires it for all holds.
 * Env: WE_REVIEW_RULING_RESOLVES_STAND_DOWN.
 *
 * `review.standDownQueueSection` — `needs-you` (built-in) surfaces unresolved needs-judgment questions
 * under NEEDS YOU. `stood-down` keeps the legacy section. Env: WE_REVIEW_STAND_DOWN_QUEUE_SECTION.
 */
export const BUILT_IN_REVIEW_SETTINGS = Object.freeze({ referralDefault: 'operator', recheckCarriedReferrals: true, autoPolicyRespectsNotReal: true, autoBlockYieldsToReviewerNotReal: false, noFixerOnClearedRuled: true, scopedRereview: 'off', roundBudget: ROUND_BUDGET_OFF,
  takeoverReviewAttempts: 1, rulingResolvesStandDown: 'on', standDownQueueSection: 'needs-you' });
export const REVIEW_SETTINGS_ENV = Object.freeze({ referralDefault: 'WE_REVIEW_REFERRAL_DEFAULT', recheckCarriedReferrals: 'WE_REVIEW_RECHECK_CARRIED_REFERRALS',
  autoPolicyRespectsNotReal: 'WE_REVIEW_AUTO_POLICY_RESPECTS_NOT_REAL', autoBlockYieldsToReviewerNotReal: 'WE_REVIEW_AUTO_BLOCK_YIELDS_TO_REVIEWER_NOT_REAL', noFixerOnClearedRuled: 'WE_REVIEW_NO_FIXER_ON_CLEARED_RULED', scopedRereview: 'WE_REVIEW_SCOPED_REREVIEW',
  roundBudget: 'WE_REVIEW_ROUND_BUDGET', takeoverReviewAttempts: 'WE_REVIEW_TAKEOVER_REVIEW_ATTEMPTS',
  rulingResolvesStandDown: 'WE_REVIEW_RULING_RESOLVES_STAND_DOWN', standDownQueueSection: 'WE_REVIEW_STAND_DOWN_QUEUE_SECTION' });
const ALLOWED = Object.freeze({ referralDefault: REFERRAL_DEFAULTS, scopedRereview: SCOPED_REREVIEW_MODES,
  rulingResolvesStandDown: ['on', 'off'], standDownQueueSection: ['needs-you', 'stood-down'] });
/** Each key's parser: the valid value, or `undefined` to keep the lower layer. `fromEnv` reads a string. */
const parseBoolean = (v, { fromEnv = false } = {}) => fromEnv
  ? (v === 'true' ? true : v === 'false' ? false : undefined)
  : (typeof v === 'boolean' ? v : undefined);
const PARSERS = Object.freeze({
  recheckCarriedReferrals: parseBoolean, autoPolicyRespectsNotReal: parseBoolean, autoBlockYieldsToReviewerNotReal: parseBoolean, noFixerOnClearedRuled: parseBoolean,
  ...Object.fromEntries(Object.entries(ALLOWED).map(([key, allowed]) => [key, (v) => (allowed.includes(v) ? v : undefined)])),
  roundBudget: (v, { fromEnv = false } = {}) => {
    if (v === ROUND_BUDGET_OFF) return v;
    const k = fromEnv ? (typeof v === 'string' && /^[1-9]\d*$/.test(v) ? Number(v) : undefined) : v;
    return isValidRoundBudget(k) ? k : undefined;
  },
  takeoverReviewAttempts: (v, { fromEnv = false } = {}) => {
    const k = fromEnv ? (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : undefined) : v;
    return Number.isInteger(k) && k >= 0 && k <= TAKEOVER_REVIEW_ATTEMPTS_MAX ? k : undefined;
  },
});
/** The WE root RUNNING the daemon owns this file; a PR under review cannot weaken it. */
export const defaultReviewSettingsPath = () => resolve(dirname(fileURLToPath(import.meta.url)), '../review-settings.json');

/** Each key is validated alone; a malformed or missing one keeps the product default. */
export function validateReviewSettings(raw) {
  const config = { ...BUILT_IN_REVIEW_SETTINGS };
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [key, parse] of Object.entries(PARSERS)) {
      const value = parse(raw[key]);
      if (value !== undefined) config[key] = value;
    }
  }
  return Object.freeze(config);
}

export function loadReviewSettingsFile(path = defaultReviewSettingsPath()) {
  try { return validateReviewSettings(JSON.parse(readFileSync(path, 'utf8'))); }
  catch { return validateReviewSettings(null); }
}

const rawReviewSettings = () => { try { return JSON.parse(readFileSync(defaultReviewSettingsPath(), 'utf8')); } catch { return null; } };
const REFERRAL_SAFETY_KEYS = ['recheckCarriedReferrals', 'autoPolicyRespectsNotReal', 'autoBlockYieldsToReviewerNotReal', 'noFixerOnClearedRuled'];
/** New referral safeguards use the shared standard → platform → tool → env cascade, with provenance. */
export function resolveReferralSafetySettings({ fileConfig = rawReviewSettings(), platform, env = process.env, log } = {}) {
  const pick = value => Object.fromEntries(REFERRAL_SAFETY_KEYS.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
  return cascadePolicy('review', pick(fileConfig), {
    standard: { recheckCarriedReferrals: true, autoPolicyRespectsNotReal: true, autoBlockYieldsToReviewerNotReal: false, noFixerOnClearedRuled: true },
    platform: pick(platform === undefined ? platformPreference('review', { env }) : platform), env, log,
    valid: Object.fromEntries(REFERRAL_SAFETY_KEYS.map(key => [key, value => typeof value === 'boolean'])),
    envValues: Object.fromEntries(REFERRAL_SAFETY_KEYS.map(key => [key, parseBoolean(env?.[REVIEW_SETTINGS_ENV[key]], { fromEnv: true })])),
  });
}

/** Env wins over the file; an invalid override keeps the lower layer. */
export function resolveReviewSettings({ fileConfig = rawReviewSettings(), platform, env = process.env } = {}) {
  const values = { ...validateReviewSettings(fileConfig) };
  for (const [key, parse] of Object.entries(PARSERS)) {
    const override = parse(env?.[REVIEW_SETTINGS_ENV[key]], { fromEnv: true });
    if (override !== undefined) values[key] = override;
  }
  return { ...values, ...resolveReferralSafetySettings({ fileConfig, platform, env }).value };
}

/** Source of the winning valid layer, using raw file data so defaults never masquerade as file values. */
export function resolveReviewSettingSource(key, { fileRaw, platform, env = process.env } = {}) {
  if (REFERRAL_SAFETY_KEYS.includes(key)) return resolveReferralSafetySettings({ fileConfig: fileRaw, platform, env }).sources[key];
  const parse = PARSERS[key];
  if (!parse) throw new Error(`unknown review setting: ${key}`);
  if (parse(env?.[REVIEW_SETTINGS_ENV[key]], { fromEnv: true }) !== undefined) return 'env';
  if (fileRaw === undefined) {
    try { fileRaw = JSON.parse(readFileSync(defaultReviewSettingsPath(), 'utf8')); }
    catch { fileRaw = null; }
  }
  return parse(fileRaw?.[key]) !== undefined ? 'file' : 'built-in';
}
