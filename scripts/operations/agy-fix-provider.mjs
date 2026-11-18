import { runConfinedAgyBuild } from '../lib/agy-confined-build.mjs';
/** Gemini repair port: macOS sandbox-exec confines native file tools, then the launcher audits patches. */
export const AGY_FIX_CONFINEMENT = Object.freeze({
  mode: 'sandboxed', boundary: 'workspace', mechanism: 'sandbox-exec',
});
export const AGY_FIX_PROVIDER = Object.freeze({
  name: 'antigravity', vendor: 'antigravity', confinement: AGY_FIX_CONFINEMENT,
  async spawn({ prompt, model, effort, sessionSlug, kind, size, scope }, { resolveLane, runTask = runConfinedAgyBuild }) {
    const result = await runTask({ task: prompt, laneDir: resolveLane(), model, effort, kind, size, scope });
    const finalMessage = result.finalMessage || result.events?.finalResponse || result.events?.agentMessages?.at(-1) || '';
    if (result.status !== 'ok' || (Object.hasOwn(result, 'exitCode') && result.exitCode !== 0) || result.timedOut) {
      throw Object.assign(new Error(`antigravity fix ${sessionSlug}: task ${result.status ?? 'failed'}: ${(result.reasons ?? []).join('; ')}`), { finalMessage, stdout: result.stdout ?? '' });
    }
    return { finalMessage, stdout: result.stdout ?? '' };
  },
});
