/** Launch rosters shared by policy validation, operator overrides, and launchers. */
export const REVIEW_SEAT_PROVIDERS = Object.freeze(['codex', 'agy-claude', 'agy-gemini']);
const SETTINGS_SEAT_PROVIDERS = Object.freeze(['claude', 'agy-claude', 'agy-gemini']);

export const OPERATION_PROVIDER_ROSTERS = Object.freeze({
  // Extra-juror and advisory-lens seats resolve through the bare key and launch from this same roster.
  'review-seat': REVIEW_SEAT_PROVIDERS,
  'review-seat:red-team': REVIEW_SEAT_PROVIDERS,
  'review-seat:mandatory:correctness': SETTINGS_SEAT_PROVIDERS,
  'review-seat:mandatory:security': SETTINGS_SEAT_PROVIDERS,
  'review-seat:advisory:agy-correctness': SETTINGS_SEAT_PROVIDERS,
});

/** Exact settings-seat exceptions take precedence over the added-seat launcher roster. */
export function rosterForKey(key) {
  if (Object.hasOwn(OPERATION_PROVIDER_ROSTERS, key)) return OPERATION_PROVIDER_ROSTERS[key];
  return key.startsWith('review-seat:') ? REVIEW_SEAT_PROVIDERS : undefined;
}
