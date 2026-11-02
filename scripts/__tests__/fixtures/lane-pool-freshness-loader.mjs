/** Test-only adapter for native lane-pool fixture children. Production never imports
 * this module. Inject the check parameter at the one canonical bootstrap call;
 * copied guard fixtures keep the real check so they can prove refusal behavior.
 */
import { register } from 'node:module';
import { isMainThread } from 'node:worker_threads';

const tool = new URL('../../lane-pool.mjs', import.meta.url).href;
if (isMainThread) register(import.meta.url);

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (url !== tool) return result;
  const source = String(result.source);
  const call = 'await guardToolEntry();';
  if (source.split(call).length !== 2) throw new Error('Lane-pool fixture guard injection site changed');
  return { ...result, source: source.replace(call, 'await guardToolEntry({ check: async () => undefined });') };
}
