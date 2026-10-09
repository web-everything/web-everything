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
 * binding prior round WOULD have decided (would-block / would-card). `on` belongs to card 5470, after the shadow.
 */
export const SCOPED_REREVIEW_MODES = Object.freeze(['off', 'shadow']);
export const BUILT_IN_REVIEW_SETTINGS = Object.freeze({ referralDefault: 'operator', scopedRereview: 'off' });
export const REVIEW_SETTINGS_ENV = Object.freeze({ referralDefault: 'WE_REVIEW_REFERRAL_DEFAULT', scopedRereview: 'WE_REVIEW_SCOPED_REREVIEW' });
const ALLOWED = Object.freeze({ referralDefault: REFERRAL_DEFAULTS, scopedRereview: SCOPED_REREVIEW_MODES });
/** The WE root RUNNING the daemon owns this file; a PR under review cannot weaken it. */
export const defaultReviewSettingsPath = () => resolve(dirname(fileURLToPath(import.meta.url)), '../review-settings.json');

/** Each key is validated alone; a malformed or missing one keeps the product default. */
export function validateReviewSettings(raw) {
  const config = { ...BUILT_IN_REVIEW_SETTINGS };
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [key, allowed] of Object.entries(ALLOWED)) if (allowed.includes(raw[key])) config[key] = raw[key];
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
  for (const [key, allowed] of Object.entries(ALLOWED)) {
    const override = env?.[REVIEW_SETTINGS_ENV[key]];
    if (allowed.includes(override)) values[key] = override;
  }
  return values;
}
