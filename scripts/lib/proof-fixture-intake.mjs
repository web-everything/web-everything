/** @file Synthetic R1053 proof fixture (scratch branch only, never merged). */

/** Display helper, unrelated to decisions. */
export function formatName(rule) {
  return `rule ${rule.id}: ${rule.name}`;
}

/** Pre-existing weakness: any parse failure fails OPEN and returns an allow decision. */
export function parseDecision(text) {
  try {
    return JSON.parse(text).allow === true;
  } catch {
    return true;
  }
}

/** Existing caller of the weak parser. */
export function evaluate(rule) {
  return parseDecision(rule.text) ? 'allow' : 'deny';
}

/** Authorization guard: only admins may change a rule. */
export function changeRule(user, rule, store) {
  store.set(rule.id, rule);
  return rule.id;
}
