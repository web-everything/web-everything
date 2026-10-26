import { resolve, dirname, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, lstatSync } from 'node:fs';
import { isReadOnlyOperation } from '../operations/registry.mjs';
import { collectImportClosure } from './import-closure.mjs';

const trustedRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Never execute head code. Only unchanged, already trusted declarations can supply read-only proof.
 * New operations, changed dependencies, incomplete graphs and exceeded bounds retain human review. */
export async function loadReadOnlyOps(root, { importModule = url => import(url), readFile = readFileSync, lstat = lstatSync } = {}) {
  const names = new Set();
  if (typeof root !== 'string' || !root) return names;
  try {
    const runner = await importModule(new URL('../operations/run.mjs', import.meta.url).href);
    const runnerSource = readFileSync(resolve(trustedRoot, 'scripts/operations/run.mjs'), 'utf8');
    const imports = [...runnerSource.matchAll(/\bimport\s+(?:[^;'"]*?\s+from\s*)?['"]([^'"\n]+)['"]/g)]
      .map(match => match[1]).filter(spec => spec.startsWith('./') || spec.startsWith('../'));
    for (const name of Object.keys(runner.OPERATIONS)) {
      try {
        if (!/^[a-z][a-z0-9-]*$/.test(name)) continue;
        const { declaration } = await runner.resolveOperation(name);
        if (!isReadOnlyOperation(declaration)) continue;
        const entries = new Set([`scripts/operations/${name}.mjs`]);
        // The runner can inject any imported IO module, regardless of the operation's name.
        for (const spec of imports) {
          if (basename(spec).endsWith('-io.mjs')) entries.add(relative(trustedRoot,
            resolve(trustedRoot, 'scripts/operations', spec)));
        }
        // Missing runner dependencies cannot be silently dropped by the closure walker.
        if ([...entries].some(file => file.startsWith('..') || !lstatSync(resolve(trustedRoot, file)).isFile())) continue;
        const graph = collectImportClosure({ root: trustedRoot, entries: [...entries] });
        if (!graph?.complete || graph.jsonNames.size || graph.files.size > 512) continue;
        const files = [...graph.files, 'package.json', 'package-lock.json'];
        let bytes = 0;
        const unchanged = files.every(file => {
          if (file.startsWith('..')) return false;
          const paths = [resolve(trustedRoot, file), resolve(root, file)];
          const stats = paths.map(path => lstat(path));
          if (stats.some(stat => !stat.isFile())) return false;
          bytes += stats.reduce((sum, stat) => sum + stat.size, 0);
          if (!Number.isSafeInteger(bytes) || bytes > 16000000) return false;
          const [trusted, head] = paths.map(path => Buffer.from(readFile(path)));
          return trusted.length === stats[0].size && head.length === stats[1].size && trusted.equals(head);
        });
        if (unchanged) names.add(name);
      } catch { /* this operation is unproven */ }
    }
  } catch { /* unreadable checkout */ }
  return names;
}
