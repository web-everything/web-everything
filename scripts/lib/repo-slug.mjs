/**
 * @file The ONE canonical spelling of a repo slug for matching a referral record to an operator ruling.
 * The 2026-10-03 org move left old-owner slugs behind: review records carry the current name (what the daemon passes),
 * while a ruling written from a clone whose origin keeps the old owner carries the old one. Matching on the raw string
 * left a recorded `card` ruling unseen and the hold said "needs a ruling" (live 2026-11-01, #6170). The rename table is
 * the constellation's own (`canonicalizeSlug`), not a copy: only a legacy owner of a KNOWN repo aliases, any other slug
 * compares as itself, so two different repos never merge. Pure.
 */
import { canonicalizeSlug } from './constellation-repos.mjs';

/** @param {unknown} slug @returns {unknown} the canonical `owner/name` (trimmed, lower-cased, legacy owner followed); a non-string is returned as is. */
export function canonicalRepoSlug(slug) {
  if (typeof slug !== 'string') return slug;
  const s = slug.trim().toLowerCase();
  return canonicalizeSlug(s).toLowerCase();
}
