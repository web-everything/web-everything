/** Shared raised-by format, deterministic paths, legacy merge and validation. */
export { parseRaisedBy, raisedByKey, mergeRaisedBy, raisedByFile, raisedByParentIds, readRaisedBy, validateRaisedBy, withRaisedBy } from './raised-by.cjs';

/** Stable collector identity for one immutable raise, distinct from its parent card. */
export function raisedByMemberId(path) {
  if (typeof path !== 'string') return null;
  const match = /^backlog\/raised-by\/(\d{1,5}|x[a-z0-9]{6})\/(\d+-[a-f0-9]{24})\.md$/.exec(path);
  return match ? `raised-by:${match[1]}:${match[2]}` : null;
}
