/** Per-seat vendor independence. Unknown identities hold the review for the operator. */
import { vendorOfModel } from './review-seat-provider.mjs';

export const INDEPENDENT_REVIEW_SEATS = Object.freeze(['correctness', 'security', 'red-team']);
export function isIndependentReviewSeat(seat, reviewer, builder) {
  if (!INDEPENDENT_REVIEW_SEATS.includes(seat)) return true;
  const a = vendorOfModel(reviewer), b = vendorOfModel(builder);
  return Boolean(a && b && a !== b);
}

/** Keep a valid assigned seat, otherwise select an independent fallback. Never manufacture an accept. */
export function independentReviewRequest(request, builder, available = ['claude', 'codex', 'agy-gemini']) {
  if (!INDEPENDENT_REVIEW_SEATS.includes(request.lens)) return request;
  const assigned = request.seatProvider?.mode === 'agy' ? request.seatProvider.model
    : request.providerName ?? 'claude';
  const provider = request.seatProvider?.mode === 'agy' ? (/^(gemini-|carbon)/.test(assigned) ? 'agy-gemini' : 'agy-claude')
    : request.providerName ?? 'claude';
  if (available.includes(provider) && isIndependentReviewSeat(request.lens, assigned, builder)) {
    return request;
  }
  const fallback = ['claude', 'codex'].find(p => available.includes(p) && isIndependentReviewSeat(request.lens, p, builder));
  if (!fallback) throw new Error(`WAIT: no cross-vendor ${request.lens} provider available; operator must restore an independent provider`);
  const { seatProvider, model, allowedTools, ...plain } = request;
  return fallback === 'codex' ? { ...plain, providerName: 'codex', model: 'gpt-6.1-sol' }
    : { ...plain, providerName: 'claude', model: 'claude-sonnet-5-5', ...(allowedTools ? { allowedTools } : {}) };
}
