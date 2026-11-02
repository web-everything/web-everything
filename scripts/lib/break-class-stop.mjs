/** Pure, fail-closed break-class history classifier (R407). */

/** Full structured identity; invalid findings have no class key. */
export function classKey(f) {
  if (!f || typeof f.category !== 'string' || !f.category.trim() ||
      typeof f.path !== 'string' || !f.path.trim() ||
      (f.mechanism !== undefined && typeof f.mechanism !== 'string')) return null;
  const path = f.path.trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^(\.\/)+/, '');
  if (!path) return null;
  return JSON.stringify([f.category, path, f.mechanism ?? '']);
}

/** Shared wire-record validation, including unconfirmed findings. */
export function validRoundRecord(r) {
  return !!r && r.schema === 1 && Number.isSafeInteger(r.pr) && r.pr > 0 &&
    typeof r.head === 'string' && !!r.head.trim() &&
    Number.isSafeInteger(r.round) && r.round > 0 &&
    typeof r.resultId === 'string' && !!r.resultId.trim() &&
    typeof r.source === 'string' && !!r.source.trim() && r.complete === true &&
    Array.isArray(r.findings) && r.findings.length <= 100000 && Array.from(r.findings).every(f =>
      classKey(f) !== null && typeof f.confirmed === 'boolean');
}

/** Total classifier: hostile input and accessor failures become observable UNKNOWNs. */
export function classify(records, options = {}) {
  let malformed = 0;
  const unknown = reason => ({ verdict: 'UNKNOWN', consecutive: 0, newClasses: [], malformed, reason });
  try {
    const { threshold = 3, malformed: supplied = 0, complete = true } = options;
    if (!Number.isSafeInteger(supplied) || supplied < 0) return unknown('invalid malformed count');
    malformed = supplied;
    if (!Array.isArray(records)) return unknown('records must be an array');
    if (records.length > 100000) return unknown('history exceeds inspection limit; operator review required');
    if (!Number.isSafeInteger(threshold) || threshold < 1) return unknown('invalid threshold');
    const sorted = Array.from(records);
    for (const r of sorted) if (!validRoundRecord(r)) malformed++;
    if (malformed > 0) return unknown('malformed ledger evidence');
    if (complete !== true) return unknown('incomplete ledger evidence');
    if (!sorted.length) return unknown('no round evidence');
    sorted.sort((a, b) => a.round - b.round);
    if (sorted.some((r, i) => r.round !== i + 1 || r.pr !== sorted[0].pr)) return unknown('rounds must be contiguous 1..n for one PR');
    const seen = new Set();
    let consecutive = 0, stopped = false, newClasses = [];
    for (const r of sorted) {
      newClasses = [];
      for (const f of r.findings) {
        if (!f.confirmed) continue;
        const key = classKey(f);
        if (!seen.has(key)) { seen.add(key); newClasses.push(key); }
      }
      consecutive = newClasses.length ? consecutive + 1 : 0;
      if (consecutive >= threshold) stopped = true;
    }
    return { verdict: stopped ? 'STOP' : 'CONTINUE', consecutive, newClasses, malformed,
      reason: stopped ? 'new-class streak reached threshold' : 'new-class streak below threshold' };
  } catch (error) {
    return unknown('classifier input could not be inspected');
  }
}
