import { findEntry, isDispatchEligible, readRegistry } from './model-probation-registry.mjs';

// Preserve the established review roster. Carbon still needs its separate promotion/shadow gate.
const ESTABLISHED = new Set([
  'gemini-3.1-pro', 'gemini-4-argon-high', 'gemini-4-carbon-high',
  'sonnet', 'opus', 'claude-sonnet-4-6', 'claude-opus-4-6-thinking',
  ...['sonnet', 'opus'].flatMap(tier => ['', '-high', '-medium', '-low'].map(effort => `claude-${tier}-5-5${effort}`)),
  'default', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.6-terra',
]);

/** Delivery probation never grants a review role. Small tiers cannot gain merge authority by override. */
export function reviewModelEligible(provider, model, registry) {
  if (typeof model !== 'string' || /hydrogen|neon|flash|haiku|luna/i.test(model)) return false;
  provider = provider?.startsWith('agy-') ? 'antigravity' : provider;
  registry ??= readRegistry();
  // Carbon's empty roles are intentional: its existing shadow/promotion gate owns admission.
  if (model === 'gemini-4-carbon-high') return true;
  if (findEntry(registry, { provider, model })) {
    return isDispatchEligible(registry, { provider, model, role: 'advisory-review' });
  }
  return ESTABLISHED.has(model);
}

export function assertReviewModelEligible(provider, model) {
  if (!reviewModelEligible(provider, model)) {
    throw new TypeError(`review model refused: ${provider}/${model} has no eligible review role or is a small tier; select an eligible review model or request operator review`);
  }
}

export const requiresReviewModel = key => /(?:review|juror|judge|red-team|merge|land)/i.test(key);
