/**
 * Card xwu9oxh slice S1a: the same read set, order and errors as `ids.map(read).filter(keep)`, without holding
 * every parsed run at once. Each run is read, tested and dropped unless it matches.
 *
 * Behaviour matches the array form exactly:
 * - every id is read, in order, so a missing or corrupt run still throws the same error at the same id;
 * - a read error wins over a `keep` error, because `map` finishes every read before `filter` tests any run;
 * - the first `keep` error is rethrown only after every read succeeded, and later runs are not tested
 *   (`filter` stops at its first throw);
 * - the result is the matching runs (as returned by `project`) in id order, so a later stable sort agrees.
 *
 * @template T, R
 * @param {Iterable<string>} ids
 * @param {(id: string) => T} read
 * @param {(value: T) => boolean} keep
 * @param {(value: T, id: string) => R} [project] - what to keep for a matching run (default: the read value).
 * @returns {R[]}
 */
export function readFilteredInOrder(ids, read, keep, project = (value) => value) {
  const hits = [];
  let keepError = null;
  for (const id of ids) {
    const value = read(id);
    if (keepError) continue;
    let matched;
    try { matched = keep(value); } catch (error) { keepError = { error }; continue; }
    if (matched) hits.push(project(value, id));
  }
  if (keepError) throw keepError.error;
  return hits;
}
