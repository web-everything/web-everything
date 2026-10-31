/** Launch rosters shared by policy validation, operator overrides, and launchers. */
export const REVIEW_SEAT_PROVIDERS = Object.freeze(['codex', 'agy-claude', 'agy-gemini']);
const SETTINGS_SEAT_PROVIDERS = Object.freeze(['claude', 'agy-claude', 'agy-gemini']);

export const OPERATION_PROVIDER_ROSTERS = Object.freeze({
  'review-seat:red-team': REVIEW_SEAT_PROVIDERS,
  'review-seat:mandatory:correctness': SETTINGS_SEAT_PROVIDERS,
  'review-seat:mandatory:security': SETTINGS_SEAT_PROVIDERS,
  'review-seat:advisory:agy-correctness': SETTINGS_SEAT_PROVIDERS,
});
