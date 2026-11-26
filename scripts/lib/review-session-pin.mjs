/** A session's admission pin travels in Claude's settings env to every review CLI child. */
export const REVIEW_SESSION_PIN_ENV = 'WE_REVIEW_SESSION_PIN';

export function assertReviewSessionPin({ pr, repo, head }, env = process.env) {
  const encoded = env[REVIEW_SESSION_PIN_ENV];
  if (encoded === undefined) return; // Manual and job reviews have their own head binding.
  let pin;
  try { pin = JSON.parse(encoded); } catch { throw Error('review session head pin is unreadable'); }
  if (!pin || !Number.isSafeInteger(pin.pr) || pin.pr !== pr || pin.repo !== repo
    || !/^[a-f0-9]{40}$/i.test(pin.head ?? '') || typeof head !== 'string'
    || pin.head.toLowerCase() !== head.toLowerCase()) {
    throw Error('review session head pin mismatched or unknown');
  }
}
