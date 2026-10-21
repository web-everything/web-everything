/**
 * @file scripts/lib/claim-similarity.mjs
 * @description THE SHARED WORDING MATCHER — normalized word tokens, IDF weights and weighted Jaccard. Moved here
 *   verbatim from `we:scripts/lib/card-dedupe.mjs` (which re-exports every name, so its callers are unchanged) so a
 *   second, READ-ONLY caller — `we:scripts/lib/related-items-core.mjs`, the `related-items` operation — can reuse the
 *   exact same tokenization without importing card-dedupe's `fs`/`gh` readers.
 *
 * PURE. No fs, no clock, no process, no network.
 */

const STOP = new Set(('a an and are as at be by can could does each every for from has have if in into is it its '
  + 'it\'s may must no not of on one or should so such than that the their them then there these this those to '
  + 'was were when where which while will with would add adds also any new make makes ensure ensures same both '
  + 'only via use uses using like eg e.g i.e e g better instead so that before after').split(/\s+/));

/** Light stemming: `-ing`/`-ed` off longer words, then a plural `-s` (never `-ss`), so rule/rules and test/tests meet. */
export const stem = (w) => {
  let s = w.length > 5 ? w.replace(/(?:ing|ed)$/, '') : w;
  if (s.length > 3 && s.endsWith('s') && !s.endsWith('ss')) s = s.slice(0, -1);
  return s;
};

/** PURE. Normalized claim tokens: lowercase words ≥3 chars, no stopwords, no bare numbers, light stemming. */
export function claimTokens(text) {
  const words = String(text ?? '').toLowerCase()
    .replace(/`[^`]*`/g, (m) => m.replace(/[/.:#-]/g, ' '))
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));
  return new Set(words.map(stem));
}

/**
 * PURE. Token weights for {@link claimSimilarity}: inverse document frequency over a set of documents (each one's
 * token set is one document). A word every document uses weighs little; a word naming the specific thing weighs a lot.
 * @param {Iterable<{tokens: Set<string>}>} items
 * @returns {(token: string) => number}
 */
export function buildIdf(items) {
  const df = new Map();
  let n = 0;
  for (const it of items) {
    n += 1;
    for (const t of it.tokens) df.set(t, (df.get(t) ?? 0) + 1);
  }
  // Smoothed (`1 +`), so a token every document shares still weighs something in a small corpus (two cards).
  return (t) => Math.log(1 + (n + 1) / ((df.get(t) ?? 0) + 1));
}

/** PURE. Weighted Jaccard similarity of two claims' token sets (0 when either is empty); unweighted with no `idf`. */
export function claimSimilarity(a, b, idf = () => 1) {
  const A = a instanceof Set ? a : claimTokens(a);
  const B = b instanceof Set ? b : claimTokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  let union = 0;
  for (const t of new Set([...A, ...B])) {
    const w = idf(t);
    union += w;
    if (A.has(t) && B.has(t)) inter += w;
  }
  return union ? inter / union : 0;
}
