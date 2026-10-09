import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `review.referralDefault` — who rules first on a CONFIRMED mandatory referral (verdict CONFIRMED, impact broken or
 * unrecoverable). `operator` (the product default) parks the review and asks the operator. `auto-block` records a
 * `block` ruling as actor `auto-policy` and sends the PR back to the fixer. It never clears, accepts or cards
 * anything: a wrong auto-block is overridden by the operator's card / not-real ruling (supersede).
 */
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
export const BUILT_IN_REVIEW_SETTINGS = Object.freeze({ referralDefault: 'operator', scopedRereview: 'off', roundBudget: ROUND_BUDGET_OFF });
export const REVIEW_SETTINGS_ENV = Object.freeze({ referralDefault: 'WE_REVIEW_REFERRAL_DEFAULT', scopedRereview: 'WE_REVIEW_SCOPED_REREVIEW',
  roundBudget: 'WE_REVIEW_ROUND_BUDGET' });
const ALLOWED = Object.freeze({ referralDefault: REFERRAL_DEFAULTS, scopedRereview: SCOPED_REREVIEW_MODES });
/** Each key's parser: the valid value, or `undefined` to keep the lower layer. `fromEnv` reads a string. */
const PARSERS = Object.freeze({
  ...Object.fromEntries(Object.entries(ALLOWED).map(([key, allowed]) => [key, (v) => (allowed.includes(v) ? v : undefined)])),
  roundBudget: (v, { fromEnv = false } = {}) => {
    if (v === ROUND_BUDGET_OFF) return v;
    const k = fromEnv ? (typeof v === 'string' && /^[1-9]\d*$/.test(v) ? Number(v) : undefined) : v;
    return isValidRoundBudget(k) ? k : undefined;
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

/** Env wins over the file; an invalid override keeps the file/default value. */
export function resolveReviewSettings({ fileConfig = loadReviewSettingsFile(), env = process.env } = {}) {
  const values = { ...validateReviewSettings(fileConfig) };
  for (const [key, parse] of Object.entries(PARSERS)) {
    const override = parse(env?.[REVIEW_SETTINGS_ENV[key]], { fromEnv: true });
    if (override !== undefined) values[key] = override;
  }
  return values;
}
