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
export const BUILT_IN_REVIEW_SETTINGS = Object.freeze({ referralDefault: 'operator' });
export const REVIEW_SETTINGS_ENV = Object.freeze({ referralDefault: 'WE_REVIEW_REFERRAL_DEFAULT' });
/** The WE root RUNNING the daemon owns this file; a PR under review cannot weaken it. */
export const defaultReviewSettingsPath = () => resolve(dirname(fileURLToPath(import.meta.url)), '../review-settings.json');

/** Each key is validated alone; a malformed or missing one keeps the product default. */
export function validateReviewSettings(raw) {
  const config = { ...BUILT_IN_REVIEW_SETTINGS };
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && REFERRAL_DEFAULTS.includes(raw.referralDefault)) {
    config.referralDefault = raw.referralDefault;
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
  const override = env?.[REVIEW_SETTINGS_ENV.referralDefault];
  if (REFERRAL_DEFAULTS.includes(override)) values.referralDefault = override;
  return values;
}
