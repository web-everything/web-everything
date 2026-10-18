/**
 * Review-stringency definition data — xdstsoh, ruling xugqjw1 and
 * docs/agent/platform-decisions.md#review-stringency-classified-outcomes.
 *
 * Class IDs use kebab-case versions of the ruled names. Separately named guard,
 * loss/scope/package and PR-body cases remain explicit; delivery stability covers
 * timeouts, slow/quadratic code, races, recovery and flaky tests. The evidence
 * section's historical clusters are examples, not additional ratified table rows.
 *
 * These are baseline mappings onto jury-core's existing vocabulary, not the
 * class-by-release-level outcome table. In particular expedite is a future table
 * outcome, never a jury disposition. No evaluator or release-level policy lives
 * here. Guard classes apply equally to source, docs, config and data changes.
 */
import { DISPOSITIONS, IMPACT_LEVELS, frozenLookup } from './jury-core.mjs';

export const REVIEW_STRINGENCY_CLASSES = Object.freeze([
  'delivery-stability',
  'weakened-guard',
  'fail-open-guard',
  'stale-state-treated-as-current',
  'irreversible-data-loss',
  'scope-violation',
  'nonexistent-package',
  'exposed-secret',
  'missing-test-on-guard-or-delivery-code',
  'missing-test-elsewhere',
  'high-severity-security',
  'lower-severity-security',
  'standards-conformance',
  'pr-description-wrong-about-change',
  'doc-or-card-drift',
  'pr-body-drift',
  'simplicity-and-style',
]);

const mapping = (impact, disposition) => Object.freeze({ impact, disposition });

// Always-block classes use broken or unrecoverable impact and blocker. Other
// rows use broken for high-severity security, degraded for actionable debt and
// cosmetic for style; release-level escalation belongs to the settings table.
// @impact-partial Keyed by finding class, not by impact level; class totality is validated below.
export const REVIEW_STRINGENCY_CLASS_MAPPINGS = frozenLookup({
  'delivery-stability': mapping(IMPACT_LEVELS.BROKEN, DISPOSITIONS.BLOCKER),
  'weakened-guard': mapping(IMPACT_LEVELS.BROKEN, DISPOSITIONS.BLOCKER),
  'fail-open-guard': mapping(IMPACT_LEVELS.BROKEN, DISPOSITIONS.BLOCKER),
  'stale-state-treated-as-current': mapping(IMPACT_LEVELS.BROKEN, DISPOSITIONS.BLOCKER),
  'irreversible-data-loss': mapping(IMPACT_LEVELS.UNRECOVERABLE, DISPOSITIONS.BLOCKER),
  'scope-violation': mapping(IMPACT_LEVELS.BROKEN, DISPOSITIONS.BLOCKER),
  'nonexistent-package': mapping(IMPACT_LEVELS.BROKEN, DISPOSITIONS.BLOCKER),
  'exposed-secret': mapping(IMPACT_LEVELS.UNRECOVERABLE, DISPOSITIONS.BLOCKER),
  'missing-test-on-guard-or-delivery-code': mapping(IMPACT_LEVELS.BROKEN, DISPOSITIONS.BLOCKER),
  'missing-test-elsewhere': mapping(IMPACT_LEVELS.DEGRADED, DISPOSITIONS.CARVE_OUT),
  'high-severity-security': mapping(IMPACT_LEVELS.BROKEN, DISPOSITIONS.BLOCKER),
  'lower-severity-security': mapping(IMPACT_LEVELS.DEGRADED, DISPOSITIONS.CARVE_OUT),
  'standards-conformance': mapping(IMPACT_LEVELS.DEGRADED, DISPOSITIONS.CARVE_OUT),
  'pr-description-wrong-about-change': mapping(IMPACT_LEVELS.DEGRADED, DISPOSITIONS.CARVE_OUT),
  'doc-or-card-drift': mapping(IMPACT_LEVELS.DEGRADED, DISPOSITIONS.CARVE_OUT),
  'pr-body-drift': mapping(IMPACT_LEVELS.DEGRADED, DISPOSITIONS.CARVE_OUT),
  'simplicity-and-style': mapping(IMPACT_LEVELS.COSMETIC, DISPOSITIONS.NIT),
});

export const DISPOSITION_OUTCOMES = frozenLookup({
  [DISPOSITIONS.BLOCKER]: 'block',
  [DISPOSITIONS.CARVE_OUT]: 'debt',
  [DISPOSITIONS.NIT]: 'advisory',
});

/**
 * Validate a complete class list and mapping table; true on success, throws on
 * any gap or unknown value. Callers must refuse on error, never fall back to an
 * advisory. No coercion, inherited membership, mutation or IO. Optional inputs
 * let authoring tools validate candidate data without changing the frozen data.
 *
 * @param {string[]} [classes]
 * @param {Record<string, {impact: string, disposition: string}>} [mappings]
 * @returns {true}
 */
export function validateReviewStringencyClasses(
  classes = REVIEW_STRINGENCY_CLASSES,
  mappings = REVIEW_STRINGENCY_CLASS_MAPPINGS,
) {
  if (!Array.isArray(classes)) throw new Error('Invalid class list: expected an array');
  if (!mappings || typeof mappings !== 'object' || Array.isArray(mappings)) {
    throw new Error('Invalid mapping table: expected an object');
  }
  const seen = new Set();
  for (const name of classes) {
    if (!REVIEW_STRINGENCY_CLASSES.includes(name)) throw new Error('Unknown class in class list');
    if (seen.has(name)) throw new Error(`Duplicate class: ${name}`);
    seen.add(name);
  }
  for (const name of Reflect.ownKeys(mappings)) {
    if (!REVIEW_STRINGENCY_CLASSES.includes(name)) throw new Error('Unknown class in mapping table');
  }
  for (const name of REVIEW_STRINGENCY_CLASSES) {
    if (!seen.has(name)) throw new Error(`Missing class: ${name}`);
    if (!Object.hasOwn(mappings, name)) throw new Error(`Missing mapping: ${name}`);
    const entry = mappings[name];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || !Object.hasOwn(entry, 'impact') || !Object.values(IMPACT_LEVELS).includes(entry.impact)
      || !Object.hasOwn(entry, 'disposition') || !Object.values(DISPOSITIONS).includes(entry.disposition)
      || !Object.hasOwn(DISPOSITION_OUTCOMES, entry.disposition)) {
      throw new Error(`Invalid mapping: ${name} requires an existing impact level and disposition`);
    }
  }
  return true;
}

// Fail at load as well as at an explicit validation call if definition data drifts.
validateReviewStringencyClasses();
