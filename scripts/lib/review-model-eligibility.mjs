import { findEntry, isDispatchEligible, readRegistry, statusFor } from './model-probation-registry.mjs';

// Preserve the established review roster. Carbon still needs its separate promotion/shadow gate.
const ESTABLISHED = new Set([
  'gemini-3.1-pro', 'gemini-4-carbon-high',
  'sonnet', 'opus', 'claude-sonnet-4-6', 'claude-opus-4-6-thinking',
  ...['sonnet', 'opus'].flatMap(tier => ['', '-high', '-medium', '-low'].map(effort => `claude-${tier}-5-5${effort}`)),
  'default', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.6-terra',
]);
// Registry-governed identities (gemini-4-argon-high, gpt-6-astra) are deliberately NOT in ESTABLISHED:
// an empty or unreadable registry must fail closed for them, never re-admit a revoked/unvalidated model.

const SMALL_TIER = /hydrogen|neon|flash|haiku|luna/i;

/** Mandatory jurors and merge/land routes. Advisory probation never counts for these. */
export const requiresMandatoryReview = key => /(?:mandatory|merge|land)/i.test(String(key ?? ''));

/** Delivery probation never grants a review role. Small tiers cannot gain merge authority by override.
 *  `mandatory`: a registry-governed model needs `trusted` advisory-review; `probation` is advisory-only. */
export function reviewModelEligible(provider, model, registry, { mandatory = false } = {}) {
  if (typeof model !== 'string' || SMALL_TIER.test(model)) return false;
  provider = provider?.startsWith('agy-') ? 'antigravity' : provider;
  registry ??= readRegistry();
  // Carbon's empty roles are intentional: its existing shadow/promotion gate owns admission.
  if (model === 'gemini-4-carbon-high') return true;
  if (findEntry(registry, { provider, model })) {
    if (mandatory) return statusFor(registry, { provider, model, role: 'advisory-review' }) === 'trusted';
    return isDispatchEligible(registry, { provider, model, role: 'advisory-review' });
  }
  return ESTABLISHED.has(model);
}

/** An explicit judge pin goes through the same eligibility check as policy routes. Claude's own models are
 *  not registry-governed, so only the small-tier refusal applies to them. */
export function assertPinnedJudgeModel(provider, model, key) {
  if (typeof model !== 'string') return;
  if (SMALL_TIER.test(model) || provider !== 'claude') assertReviewModelEligible(provider, model, key);
}

export function assertReviewModelEligible(provider, model, key) {
  if (!reviewModelEligible(provider, model, undefined, { mandatory: requiresMandatoryReview(key) })) {
    throw new TypeError(`review model refused: ${provider}/${model} has no eligible review role or is a small tier; select an eligible review model or request operator review`);
  }
}

export const requiresReviewModel = key => /(?:review|juror|judge|red-team|merge|land)/i.test(key);
