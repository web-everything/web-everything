import { deriveAgyFixAdmission } from '../lib/agy-fix-admission.mjs';
import { AGY_BUILD_CONFINEMENT, assertAgyBuildConfinement } from '../lib/agy-sandbox.mjs';
const refuseTask = async () => { throw new Error(AGY_BUILD_CONFINEMENT.reason); };
/** Gemini repair port stays unavailable until the worker's full boundary is enforced. */
export const AGY_FIX_CONFINEMENT = AGY_BUILD_CONFINEMENT;
export const AGY_FIX_PROVIDER = Object.freeze({
  name: 'antigravity', vendor: 'antigravity', confinement: AGY_FIX_CONFINEMENT,
  async spawn({ prompt, model, effort, sessionSlug, kind, size, scope }, { resolveLane, runTask = refuseTask }) {
    assertAgyBuildConfinement();
    const admission = deriveAgyFixAdmission({}, { taskKind: kind, size, scope });
    if (!admission)
      throw new Error('antigravity fix refused: kind/size/scope unavailable or outside repair admission; use the next fix provider');
    const result = await runTask({ task: prompt, laneDir: resolveLane(), model, effort, kind, size, scope: admission.scope });
    const finalMessage = result.finalMessage || result.events?.finalResponse || result.events?.agentMessages?.at(-1) || '';
    if (result.status !== 'ok' || (Object.hasOwn(result, 'exitCode') && result.exitCode !== 0) || result.timedOut) {
      throw Object.assign(new Error(`antigravity fix ${sessionSlug}: task ${result.status ?? 'failed'}: ${(result.reasons ?? []).join('; ')}`), { finalMessage, stdout: result.stdout ?? '' });
    }
    return { finalMessage, stdout: result.stdout ?? '' };
  },
});
