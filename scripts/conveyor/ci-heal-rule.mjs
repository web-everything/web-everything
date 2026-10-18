/** Pure CI-heal ownership shared by reconcile (including review) and the conveyor tick.
 * Only definitive red rollup evidence authorizes healing. CLEAN describes merging, not CI.
 * Callers retain their claims, liveness, main-red, escalation and lane guards; caps come from
 * their existing resolved CI-heal settings. A null cap asks only whether CI needs repair.
 */
export function ciHealOwed({ state = 'OPEN', labels = [], ci, phase = null, attempts = 0, cap = null } = {}) {
  const names = (Array.isArray(labels) ? labels : []).map(l => typeof l === 'string' ? l : l?.name);
  if (String(state ?? 'OPEN').toUpperCase() !== 'OPEN' || names.includes('review:changes')) return false;
  if (cap !== null && !(attempts < cap)) return false;
  return ['red', 'fail'].includes(ci);
}
