/** Test-only adapter for native lane-pool fixture children. Production never imports
 * this module. Inject the check parameter at the one canonical bootstrap call;
 * copied guard fixtures keep the real check so they can prove refusal behavior.
 */
import { register } from 'node:module';
import { isMainThread } from 'node:worker_threads';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// A simulator explicitly names its private copy in this test-only preload URL.
// Do not register for other children: async hooks move ESM reads off-thread,
// hiding them from the runtime tracer and changing stdout pipe behavior.
const tool = new URL(import.meta.url).searchParams.get('tool')
  ?? pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), '../../lane-pool.mjs')).href;
if (isMainThread && process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === tool) {
  register(import.meta.url);
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (url !== tool) return result;
  const source = String(result.source);
  const call = 'await guardToolEntry();';
  if (source.split(call).length !== 2) throw new Error('Lane-pool fixture guard injection site changed');
  return { ...result, source: source.replace(call, 'await guardToolEntry({ check: async () => undefined });') };
}
