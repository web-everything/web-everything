import { isAdmissibleTargetPath } from './agy-fix-admission.mjs';
import { normalizeScopePath } from './dispatch-task-type.mjs';
import { SIZE_TO_ESTIMATED_LOC } from './dispatch-contracts.mjs';
import { isWithinProvenEnvelope } from './provider-routing.mjs';
import { criticalWorkVerdict } from './critical-work.mjs';
import { isDispatchEligible, readRegistry } from './model-probation.mjs';

// Keep production unavailable until real deny-default spawn probes pass outside a nested sandbox.
// No setting or environment override may bypass that proof gate.
export const AGY_BUILD_CONFINEMENT = Object.freeze({
  mode: 'unavailable',
  reason: 'antigravity build refused: confinement unavailable: deny-default live sandbox proof is pending; use another provider or request operator review',
});
export function assertAgyBuildConfinement() {
  if (AGY_BUILD_CONFINEMENT.mode !== 'sandboxed') throw new Error(AGY_BUILD_CONFINEMENT.reason);
}

/** Live admission for Hydrogen delivery. Unknown evidence advances to another provider/operator. */
export function assertAgyHydrogenBuildAdmission(dispatch, model) {
  const refuse = reason => { throw new Error(`Hydrogen build refused: ${reason}; use another provider or request operator review`); };
  if (!isDispatchEligible(readRegistry(), { provider: 'antigravity', model, role: 'delivery' }))
    refuse('model is not eligible for delivery');
  const paths = Array.isArray(dispatch.scopePaths) ? dispatch.scopePaths.map(normalizeScopePath) : [];
  if (criticalWorkVerdict({ ...dispatch, filesTouched: paths }).critical) refuse('critical or human-required scope');
  if (dispatch.kind !== 'build' || dispatch.taskType !== 'doc-fix') refuse('only documentation builds are admitted');
  if (dispatch.simple !== true) refuse('simple task evidence is missing');
  const estimatedLoc = SIZE_TO_ESTIMATED_LOC[dispatch.size];
  if (!Number.isInteger(dispatch.size) || !Number.isFinite(estimatedLoc) || !isWithinProvenEnvelope('doc-fix', estimatedLoc, paths.length)) refuse('size exceeds or lacks the 100-LOC, two-file documentation envelope');
  if (!paths.length || !paths.every(isAdmissibleTargetPath)) refuse('scope requires admissible documentation files');
  assertAgyBuildConfinement();
}
