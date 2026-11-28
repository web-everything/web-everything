/** Pure renderer shared by the recovery producer and synchronous acceptance readers. */
export const EXHAUSTED_RETRY_RECOVERED_MARKER = '<!-- we:exhausted-retry-recovered -->';
// exhaustionFacts' two kinds plus ci-red-recovery-watch's wrongSpent fallback.
export const EXHAUSTED_RETRY_RECOVERED_KINDS = Object.freeze([
  'ci-heal-exhausted', 'fix-loop-exhausted', 'exhaustion',
]);

export function buildExhaustedRetryRecoveredComment({ kind, headSha }) {
  return `${EXHAUSTED_RETRY_RECOVERED_MARKER}\nthe automatic retry after ${kind} went green on ${headSha?.slice(0, 7)}; the exhaustion and automatic retry budgets remain spent\nhead: ${headSha}`;
}
