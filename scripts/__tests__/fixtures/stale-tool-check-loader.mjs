// Existing CLI fixtures exercise lane operations with private repos, not the host checkout's
// freshness. Inject their check at the entry's parameter seam. Copied guard-entry fixtures
// are deliberately excluded so guard regressions exercise production behavior.
const entryUrl = new URL('../../lib/stale-tool-guard-entry.mjs', import.meta.url).href;

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (url !== entryUrl) return result;
  const source = String(result.source);
  const call = 'await runToolCheckoutGuard();';
  if (source.split(call).length !== 2) throw new Error('Missing test freshness-check injection seam');
  return { ...result, source: source.replace(call,
    'await runToolCheckoutGuard({ check: async () => undefined });') };
}
