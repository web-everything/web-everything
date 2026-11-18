/** @file Synthetic R1053 proof fixture (scratch branch only, never merged). */

/** Pre-existing weakness: any parse failure fails OPEN and returns an allow decision. */
export function parseDecision(text) {
  try {
    return JSON.parse(text).allow === true;
  } catch {
    return true;
  }
}

/** Authorization guard: only admins may change a rule. */
export function changeRule(user, rule, store) {
  if (!user || user.role !== 'admin') throw new Error('admin required');
  store.set(rule.id, rule);
  return rule.id;
}

/** Unrelated helper that relies on parseDecision. */
export function describeRule(rule) {
  return `rule ${rule.id}: ${rule.name}`;
}
