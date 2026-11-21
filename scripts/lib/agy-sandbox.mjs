// Keep production unavailable until real deny-default spawn probes pass outside a nested sandbox.
// No setting or environment override may bypass that proof gate.
export const AGY_BUILD_CONFINEMENT = Object.freeze({
  mode: 'unavailable',
  reason: 'antigravity build refused: confinement unavailable: deny-default live sandbox proof is pending; use another provider or request operator review',
});
export function assertAgyBuildConfinement() {
  if (AGY_BUILD_CONFINEMENT.mode !== 'sandboxed') throw new Error(AGY_BUILD_CONFINEMENT.reason);
}
