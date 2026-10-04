/** Shared operator seat configuration. Kept separate from the seat runner to avoid a
 * review-label → review-extra-seats → review-dispatch → review-label initialization cycle.
 */
import { REFERRAL_SEAT_PROVIDERS } from '../lib/jury-core.mjs';
import { antigravityReviewFromEnv } from './review-pr.mjs';

/** LEGACY — the old SHARED per-day cap on non-Claude seat CALLS, counted across every provider together. Card
 *  xn2wf9t (2026-09-27) replaced it with a cap PER PROVIDER ({@link PROVIDER_CAP_ENV}): Codex's own weekly
 *  allowance is comparatively tight while both antigravity backends are separate and generous, so one shared
 *  number let Codex's use starve antigravity's (474 seat calls skipped in one day on `daily-cap`, all three
 *  providers still well under their own real budget). Kept, for ONE release only, as Codex's OWN fallback when
 *  {@link PROVIDER_CAP_ENV}`.codex` is unset — see {@link resolveProviderCap} — so an operator who only ever set
 *  this env var keeps exactly today's Codex behavior until they move to the new name. */
export const DAILY_CAP_ENV = 'WE_REVIEW_EXTRA_SEATS_DAILY_CAP';
export const DEFAULT_DAILY_CAP = 40;
/** The per-PROVIDER daily call cap env var, one per {@link REVIEW_SEAT_PROVIDERS} entry. */
export const PROVIDER_CAP_ENV = Object.freeze({
  codex: 'WE_REVIEW_SEAT_CAP_CODEX',
  'agy-claude': 'WE_REVIEW_SEAT_CAP_AGY_CLAUDE',
  'agy-gemini': 'WE_REVIEW_SEAT_CAP_AGY_GEMINI',
});
/** The default cap per provider when its own env var (and, for codex only, the legacy shared one) is unset.
 *  Codex's default (80) matches the shared cap the operator had already raised the daemon plist to; agy-claude
 *  keeps its default of 300. Gemini is off by default under the operator ruling of 2026-10-02:
 *  Gemini too weak for review until Gemini 4; its own env cap can explicitly enable it. */
export const PROVIDER_CAP_DEFAULT = Object.freeze({ codex: 80, 'agy-claude': 300, 'agy-gemini': 0 });
/** The daily call cap for ONE provider: its own env var, else (codex only) the legacy shared env var, else its
 *  own default. Never throws; an unparseable or negative value is treated as unset. PURE. */
export function resolveProviderCap(provider, env = process.env) {
  const ownName = PROVIDER_CAP_ENV[provider];
  const own = ownName ? Number(env?.[ownName]) : Number.NaN;
  if (Number.isInteger(own) && own >= 0) return own;
  // codex's OWN env unset: fall back to the legacy shared one — reusing `resolveDailyCap` itself (rather than
  // re-parsing inline) so a garbage legacy value degrades to ITS OWN default (40, `DEFAULT_DAILY_CAP`), not
  // codex's new one — the one existing behavior this fallback is pinned to keep byte-identical for a release.
  if (provider === 'codex' && env?.[DAILY_CAP_ENV] !== undefined) return resolveDailyCap(env);
  return PROVIDER_CAP_DEFAULT[provider] ?? DEFAULT_DAILY_CAP;
}
/** @returns {number} the configured daily call cap (a non-negative integer), else the default. PURE. */
export function resolveDailyCap(env = process.env) {
  const n = Number(env?.[DAILY_CAP_ENV]);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_DAILY_CAP;
}

/**
 * THE one definition of "this optional reviewer seat is disabled", used wherever a referral may be retired.
 * The Antigravity review seat runs on its own gate (`REVIEW_PR_ANTIGRAVITY_REVIEW` / probation), which never
 * reads the Gemini cap, so its default cap of 0 alone must not disable it: only the flag being off, or an
 * operator who EXPLICITLY set the cap to 0, does. The direct `agy-*` finding seats are enforced by their
 * provider cap alone. Mandatory and unknown seats are never disabled. PURE.
 */
export function referralSeatDisabled(seat, env = process.env) {
  if (!Object.hasOwn(REFERRAL_SEAT_PROVIDERS, seat)) return false;
  const provider = REFERRAL_SEAT_PROVIDERS[seat];
  const capZero = resolveProviderCap(provider, env) === 0;
  if (seat !== 'judgeAntigravityReview') return capZero;
  const explicitZero = capZero && Number.isInteger(Number(env?.[PROVIDER_CAP_ENV[provider]])) && env[PROVIDER_CAP_ENV[provider]] !== '';
  return !antigravityReviewFromEnv(env) || explicitZero;
}

