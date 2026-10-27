/** Live ruling precedence, highest first. No IO or thread/authorship interpretation here.
 *
 * Operator blocks outrank clear-human regardless of recency; recency breaks
 * ties only within a rank. Clear-human clears only keys without a block.
 * Wire-format compatibility: NOT sent back / held lines (including those inside
 * operator-block records) are ordinary gate holds, not ranked operator blocks.
 * The reader retains them as fallback evidence; a release beats an unindexed
 * legacy hold. Only a human operator's send-back line creates a ranked block.
 * A later indexed gate hold retires earlier releases before ranking (existing
 * cap/send-back/restrictive-line tests), even operator releases. This is a
 * compatibility exception to “automation never overrides an operator rank”:
 * the old release is no longer live. Unindexed legacy holds do not retire it.
 * Trusted automation's restrictive lines still hold through that fallback.
 */
export const DISPOSITION_PRECEDENCE = Object.freeze([
  { kind: 'block', source: 'operator', state: 'held' },
  { kind: 'clear-human', source: 'operator', state: 'cleared' },
  { kind: 'not-real', source: 'operator', state: 'released not-real' },
  { kind: 'card', source: 'operator', state: 'released carded' },
  { kind: 'card', source: 'automatic', state: 'released carded' },
  { kind: 'not-real', source: 'automatic', state: 'released not-real' },
  { kind: null, source: null, state: 'open' },
].map(Object.freeze));

/**
 * Resolve validated, head/result-bound evidence for one key. `by` is the winning
 * input object (null for none). Missing keys means all keys; [] means no keys.
 * at is a finite order index, independent of input array order. Unknown kinds,
 * unsupported sources and malformed evidence throw: callers must inspect/retry
 * the evidence rather than accidentally granting a release. Inputs are untouched.
 */
export function resolveDisposition(findingKey, rulings) {
  if (!Array.isArray(rulings)) throw new TypeError('rulings must be an array');
  const ranked = rulings.map(by => {
    const rank = DISPOSITION_PRECEDENCE.findIndex(row => row.kind === by?.kind && row.source === by?.source && row.kind !== null);
    if (rank < 0 || !Number.isFinite(by.at) || (by.keys !== undefined && !Array.isArray(by.keys))) {
      throw new TypeError('invalid disposition ruling; inspect evidence before retrying');
    }
    return { by, rank };
  }).filter(({ by }) => by.keys === undefined || by.keys.includes(findingKey));
  const live = ranked;
  live.sort((a, b) => a.rank - b.rank || b.by.at - a.by.at);
  const winner = live[0];
  return { state: DISPOSITION_PRECEDENCE[winner?.rank ?? DISPOSITION_PRECEDENCE.length - 1].state, by: winner?.by ?? null };
}
