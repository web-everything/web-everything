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

/** Unrelated helper that already relied on parseDecision before this change. */
export function describeRule(rule) {
  return `Rule ${rule.id} (${parseDecision(rule.text) ? 'allow' : 'deny'}): ${rule.name}`;
}
