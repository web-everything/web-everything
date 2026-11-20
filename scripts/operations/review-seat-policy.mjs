/** Shared operator seat configuration. Kept separate from the seat runner to avoid a
 * review-label → review-extra-seats → review-dispatch → review-label initialization cycle.
 */
import { REFERRAL_SEAT_PROVIDERS } from '../lib/jury-core.mjs';
import { ANTIGRAVITY_REVIEW_ENV_VAR, antigravityReviewFromEnv } from './review-pr.mjs';
import { carbonNonShadowAllowed } from '../lib/review-seat-settings.mjs';
import { ANTIGRAVITY_MODEL } from '../lib/antigravity-judge-spawn.mjs';

import { PROVIDER_CAP_ENV, resolveProviderCap } from '../lib/review-seat-caps.mjs';
export { DAILY_CAP_ENV, DEFAULT_DAILY_CAP, PROVIDER_CAP_ENV, PROVIDER_CAP_DEFAULT,
  resolveProviderCap, resolveRoutingProviderCap, resolveDailyCap } from '../lib/review-seat-caps.mjs';

/**
 * THE one definition of "this optional reviewer seat is disabled", used wherever a referral may be retired.
 * The Antigravity review seat runs on its own gate (`advisorySeats.antigravityReview` / `REVIEW_PR_ANTIGRAVITY_REVIEW`), which never
 * reads the Gemini cap, so its default cap of 0 alone must not disable it: only the flag being off, or an
 * operator who EXPLICITLY set the cap to 0, does. The direct `agy-*` finding seats are enforced by their
 * provider cap alone. Unpromoted Carbon, like the default zero cap, cannot retire prior referrals:
 * only an explicit operator disable may do that. Mandatory and unknown seats are never disabled. PURE.
 */
export function referralSeatDisabled(seat, env = process.env) {
  if (!Object.hasOwn(REFERRAL_SEAT_PROVIDERS, seat)) return false;
  const provider = REFERRAL_SEAT_PROVIDERS[seat];
  const capZero = resolveProviderCap(provider, env) === 0;
  if (seat !== 'judgeAntigravityReview') return capZero;
  const explicitZero = capZero && Number.isInteger(Number(env?.[PROVIDER_CAP_ENV[provider]])) && env[PROVIDER_CAP_ENV[provider]] !== '';
  if (explicitZero) return true;
  if (Object.hasOwn(env ?? {}, ANTIGRAVITY_REVIEW_ENV_VAR)) return env[ANTIGRAVITY_REVIEW_ENV_VAR] !== '1';
  // Execution eligibility is not retirement authority. Reuse the unset-cap hold for unpromoted Carbon.
  if (!carbonNonShadowAllowed(ANTIGRAVITY_MODEL, { env })) return false;
  return !antigravityReviewFromEnv(env);
}

