/** Test-only adapter for native lane-pool fixture children. Production never imports
 * this module. Inject the check parameter at the one canonical bootstrap call;
 * copied guard fixtures keep the real check so they can prove refusal behavior.
 */
import { register } from 'node:module';
import { isMainThread } from 'node:worker_threads';
import { realpathSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function fileUrl(path) {
  // Node resolves entry symlinks before passing the module URL to load(). Match
  // that identity for both argv and the explicitly selected simulator tool.
  // An unrelated child's argv (e.g. -e) need not name an existing file.
  try { return pathToFileURL(realpathSync(path)).href; }
  catch { return pathToFileURL(resolve(path)).href; }
}

// A simulator explicitly names its private copy and candidate directory here.
// Do not register for other children: async hooks move ESM reads off-thread,
// hiding them from the runtime tracer and changing stdout pipe behavior.
const params = new URL(import.meta.url).searchParams;
const selected = params.get('tool');
const tool = fileUrl(selected ? fileURLToPath(selected)
  : resolve(dirname(fileURLToPath(import.meta.url)), '../../lane-pool.mjs'));
if (isMainThread && process.argv[1]) {
  const entry = fileUrl(process.argv[1]);
  const candidates = params.get('candidates');
  let hook = entry === tool ? import.meta.url : null;
  if (entry !== tool && candidates) {
    const root = fileURLToPath(fileUrl(fileURLToPath(candidates)));
    const parts = relative(root, fileURLToPath(entry)).split(sep);
    if (parts.length === 3 && parts[0].includes('.candidate-')
      && parts[1] === 'scripts' && parts[2] === 'lane-pool.mjs') {
      // Each rebuild candidate is disposable. Select only its pool CLI, then
      // pass that exact URL to the hook thread; never register for its daemons.
      const selectedHook = new URL(import.meta.url);
      selectedHook.searchParams.set('tool', entry);
      hook = selectedHook.href;
    }
  }
  if (hook) register(hook);
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (url !== tool) return result;
  const source = String(result.source);
  const call = 'await guardToolEntry();';
  if (source.split(call).length !== 2) throw new Error('Lane-pool fixture guard injection site changed');
  return { ...result, source: source.replace(call, 'await guardToolEntry({ check: async () => undefined });') };
}
