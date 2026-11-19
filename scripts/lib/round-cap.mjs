/**
 * we:scripts/lib/round-cap.mjs#resolveRoundCap — the ONE reader of the review round cap (card 8062, class K9:
 * divergent predicates for one state). The fix daemon (reconcile-core), the mechanical-round counter and the
 * red-team gate all read the cap here, so a setting (`WE_REVIEW_ROUND_CAP`) moves every reader together and a
 * per-PR extension (operator grants) is applied on the same base. PURE; a malformed setting keeps the default.
 */
import { NEGOTIATION_ROUND_CAP } from './jury-core.mjs';
import { gateRoundCap } from './red-team-gate.mjs';

/** Positive integer cap override; malformed or absent configuration keeps the shared default. */
export function resolveRoundCap(env = {}) {
  const value = env?.WE_REVIEW_ROUND_CAP;
  return typeof value === 'string' && /^\d+$/.test(value.trim())
    && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : NEGOTIATION_ROUND_CAP;
}

/** The cap for one PR: the shared base plus its per-PR extension grants (same anchor rule as the gate). */
export function effectiveRoundCap({ env = {}, grants = [], roundAt } = {}) {
  return gateRoundCap({ cap: resolveRoundCap(env), grants, roundAt });
}
