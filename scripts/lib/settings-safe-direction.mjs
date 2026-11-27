/**
 * Safe-direction table for settings (D15, platform-decisions#operator-override-settings-layer rule 4).
 * Every gate key declares which way is TIGHTER. A higher layer may move a safety key only toward the safe
 * direction; the environment layer is checked against it (env may only tighten). PURE: no I/O.
 *
 * Entry kinds (`safe`):
 *   'true' | 'false'   the safe boolean value; anything else is looser
 *   'min' | 'max'      numbers; the safe direction is smaller / larger
 *   'subset'           arrays; a tighter value is a subset of the current one (an exemption list may only shrink)
 *   'enum:a,b,c'       ordered, tightest first
 * A key with no entry is `unclassed` (shadow-reported only in slice 1; counts as loosening once slice 5 lands).
 * Values that cannot be compared (type mismatch, missing current value) count as loosening: fail closed.
 */

/** Keyed `<policy>.<leaf>`; a scalar policy (empty leaf) is keyed by the policy alone. */
export const SAFE_DIRECTION = Object.freeze({
  'overlaySafety.auditEvidence': { kind: 'safety', safe: 'enum:refuse,warn' },
  'ciUnitRerun.enabled': { kind: 'safety', safe: 'false' },
  'ciUnitRerun.maxFiles': { kind: 'safety', safe: 'min' },
  'review.unattendedAcceptRequiresCleanReferrals': { kind: 'safety', safe: 'true' },
  'review.careExemptPaths': { kind: 'safety', safe: 'subset' },
  'redTeam.recheckReadsRepo': { kind: 'safety', safe: 'true' },
  'redTeam.skipCardOnly': { kind: 'safety', safe: 'false' },
});

const keyOf = (policy, leaf) => (leaf ? `${policy}.${leaf}` : String(policy));

/** `safety` (classed, direction known), `preference` (classed, no direction) or `unclassed`. */
export function classify(policy, leaf = '') {
  const entry = Object.hasOwn(SAFE_DIRECTION, keyOf(policy, leaf)) ? SAFE_DIRECTION[keyOf(policy, leaf)] : undefined;
  if (!entry) return 'unclassed';
  return entry.kind === 'safety' ? 'safety' : 'preference';
}

export function directionFor(policy, leaf = '') {
  return Object.hasOwn(SAFE_DIRECTION, keyOf(policy, leaf)) ? SAFE_DIRECTION[keyOf(policy, leaf)] : undefined;
}

/** True when moving `from` → `to` loosens a key whose safe direction is `entry.safe`. Equal values never loosen. */
export function isLoosening(entry, from, to) {
  const safe = typeof entry === 'string' ? entry : entry?.safe;
  if (typeof safe !== 'string') return true;
  // Validate both sides for the kind BEFORE the equality shortcut: equal malformed values are still loosening.
  if (safe === 'true' || safe === 'false') {
    if (typeof to !== 'boolean') return true;
    if (typeof from === 'boolean' && from === to) return false;
    return to !== (safe === 'true');
  }
  if (safe === 'min' || safe === 'max') {
    if (typeof from !== 'number' || typeof to !== 'number' || !Number.isFinite(from) || !Number.isFinite(to)) return true;
    return safe === 'min' ? to > from : to < from;
  }
  if (safe === 'subset') {
    if (!Array.isArray(from) || !Array.isArray(to)) return true;
    const have = new Set(from.map(x => JSON.stringify(x)));
    return !to.every(x => have.has(JSON.stringify(x)));
  }
  if (safe.startsWith('enum:')) {
    const order = safe.slice(5).split(',');
    const a = order.indexOf(from);
    const b = order.indexOf(to);
    return a < 0 || b < 0 || b > a;
  }
  return true;
}
