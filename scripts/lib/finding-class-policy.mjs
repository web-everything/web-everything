/** Finding classification is evidence; actions are always derived from the live operator map. */
import { platformPreference, resolveCascade, logCascadeSources } from './policy-cascade.mjs';

export const FINDING_CLASSES = Object.freeze([
  'live-reproduced', 'correctness-in-normal-use', 'security-reachable-today',
  'theoretical-race', 'attacker-same-user', 'coverage-or-style',
]);
const DEFAULT_ACTIONS = Object.freeze(Object.fromEntries(FINDING_CLASSES.map((key, i) =>
  [key, i < 3 ? 'fix-now' : 'defer-card'])));

export function classAction(finding, policy = {}) {
  const cls = finding?.findingClass;
  if (!FINDING_CLASSES.includes(cls)) return 'fix-now';
  // A tie may retain another class, but security evidence must survive later policy changes.
  if (finding.securityReachableToday === true && cls !== 'security-reachable-today'
    && classAction({ ...finding, findingClass: 'security-reachable-today' }, policy) !== 'defer-card') return 'fix-now';
  const action = policy != null && Object.hasOwn(policy, cls) ? policy[cls] : DEFAULT_ACTIONS[cls];
  if (action !== 'defer-card') return 'fix-now';
  if (cls === 'security-reachable-today' && policy?.allowSecurityDefer !== true) return 'fix-now';
  return typeof finding.classBasis === 'string' && finding.classBasis.trim() ? 'defer-card' : 'fix-now';
}

/** Unclassified evidence wins even over a valid fix-now class; ties retain the first valid class. */
export function stricterClass(a, b, policy = readFindingClassPolicy()) {
  if (!FINDING_CLASSES.includes(a)) return a;
  if (!FINDING_CLASSES.includes(b)) return b;
  const action = findingClass => classAction({ findingClass, classBasis: 'classification comparison' }, policy);
  return action(a) === 'defer-card' && action(b) === 'fix-now' ? b : a;
}

export function readFindingClassPolicy(opts = {}) {
  const platform = platformPreference('findingClasses', opts);
  const resolved = resolveCascade({ standard: DEFAULT_ACTIONS,
    platform: platform && typeof platform === 'object' && !Array.isArray(platform) ? platform : undefined });
  logCascadeSources('findingClasses', resolved, opts);
  return platform && typeof platform === 'object' && !Array.isArray(platform) ? platform : {};
}
