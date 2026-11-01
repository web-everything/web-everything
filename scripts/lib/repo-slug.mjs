/**
 * @file The ONE canonical spelling of a repo slug for matching a referral record to an operator ruling.
 * A repo transferred from `chalbert/web-everything` to `web-everything/web-everything`: review records carry the new
 * spelling (what the daemon passes), while a ruling written from a clone whose origin keeps the old owner carries the
 * old one. Matching on the raw string left a recorded `card` ruling unseen and the hold said "needs a ruling" (live
 * 2026-11-01, #6170). Only a listed rename aliases; any other slug compares as itself, so two different repos never merge.
 * Pure.
 */
// Built from parts: a bare slug literal in source is a repo-explicit-scan finding (multi-repo-checks).
const slug = (owner, name) => `${owner}/${name}`;
const RENAMED = new Map([[slug('chalbert', 'web-everything'), slug('web-everything', 'web-everything')]]);
/** @param {unknown} slug @returns {unknown} the canonical `owner/name` (lower-cased, renames followed); a non-string is returned as is. */
export function canonicalRepoSlug(slug) {
  if (typeof slug !== 'string') return slug;
  const s = slug.trim().toLowerCase();
  return RENAMED.get(s) ?? s;
}
