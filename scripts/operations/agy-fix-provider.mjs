/** Gemini repair port; production launches fail closed until file and shell access are confined. */
export const AGY_FIX_CONFINEMENT = Object.freeze({
  mode: 'unavailable', reason: 'confined Antigravity fix adapter is unavailable',
});
// geminiDirectTask is a manual escape hatch. Its shell-only sandbox does not protect native file tools
// from attacker-controlled PR/CI input, so it must never be the default worker behind this port.
async function unavailableConfinedTask() { throw new Error(AGY_FIX_CONFINEMENT.reason); }
export const AGY_FIX_PROVIDER = Object.freeze({
  name: 'antigravity', vendor: 'antigravity', confinement: AGY_FIX_CONFINEMENT,
  async spawn({ prompt, model, effort, sessionSlug }, { resolveLane, runTask = unavailableConfinedTask }) {
    const result = await runTask({ task: prompt, dir: resolveLane(), model, effort, gate: 'none' });
    const finalMessage = result.events?.finalResponse || result.events?.agentMessages?.at(-1) || '';
    if ((Object.hasOwn(result, 'exitCode') && result.exitCode !== 0) || result.timedOut) {
      throw Object.assign(new Error(`antigravity fix ${sessionSlug}: task failed (exit ${result.exitCode})`), { finalMessage, stdout: result.stdout ?? '' });
    }
    return { finalMessage, stdout: result.stdout ?? '' };
  },
});
