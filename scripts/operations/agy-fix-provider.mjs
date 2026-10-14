/** Gemini repair worker; fix-run owns staging, commits, pushes and review rearming. */
import { geminiDirectTask } from '../gemini-direct-task.mjs';
export const AGY_FIX_PROVIDER = Object.freeze({
  name: 'antigravity', vendor: 'antigravity',
  async spawn({ prompt, model, effort, sessionSlug }, { resolveLane, runTask = geminiDirectTask }) {
    const result = await runTask({ task: prompt, dir: resolveLane(), model, effort, gate: 'none' });
    const finalMessage = result.events?.finalResponse || result.events?.agentMessages?.at(-1) || '';
    if ((Object.hasOwn(result, 'exitCode') && result.exitCode !== 0) || result.timedOut) {
      throw Object.assign(new Error(`antigravity fix ${sessionSlug}: task failed (exit ${result.exitCode})`), { finalMessage, stdout: result.stdout ?? '' });
    }
    return { finalMessage, stdout: result.stdout ?? '' };
  },
});
