/**
 * @file scripts/conveyor/prep-review-record.mjs
 * @description The two facts the DRAIN needs about the light prep review (card x5f2daz) and nothing else, so
 * `merge-ai-prs.mjs` can read the record without loading the reviewer (no schema file read, no model code).
 * Dependency-free on purpose.
 */

/** The durable-record headline `merge-ai-prs.mjs#REVIEW_RECORD_HEADLINES` reads (kind `prep-advised`). */
export const PREP_REVIEW_HEADLINE = '🔎 review — prep advisory (single reviewer)';

/** The item number of a prepare PR head ref `lane/<n>-prepare-item-...`, or `null`. The one spelling of that rule. */
export function prepareItemFromRef(ref) {
  return /^lane\/([a-z0-9]+)-prepare-item-/.exec(ref ?? '')?.[1] ?? null;
}
