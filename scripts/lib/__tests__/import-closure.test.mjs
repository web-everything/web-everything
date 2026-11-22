import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectImportClosure, closureHits } from '../import-closure.mjs';

const unsupported = [
  ["require", "require('./worker.cjs');"],
  ["createRequire", "const req = createRequire(import.meta.url);"],
  ["spawn", "spawn(process.execPath, ['./worker.mjs']);"],
  ["exec", "exec('node worker.mjs');"],
  ["execFile", "execFile(process.execPath, ['./worker.mjs']);"],
  ["fork", "fork('./worker.mjs');"],
  ["aliased spawn", "import { spawn as launch } from 'node:child_process'; launch('node', ['worker.mjs']);"],
  ["absolute import", "import '/outside.mjs';"],
  ["file URL import", "export { x } from 'file:///outside.mjs';"],
  ["concatenated dynamic target", "await import('./child.mjs' + suffix);"],
  ["dynamic expression", "await import(target);"],
  ["multiline dynamic expression", "await import(\n target);"],
];
function closure(source, strict = true) {
  const root = resolve('import-closure-fixture');
  const files = new Map([
    [resolve(root, 'entry.mjs'), "import './child.mjs';"],
    [resolve(root, 'child.mjs'), source],
  ]);
  return collectImportClosure({ root, entries: ['entry.mjs'], requireResolvedImports: strict,
    exists: p => files.has(p), readFile: p => files.get(p) });
}
describe('strict import closure evidence', () => {
  it.each(unsupported)('%s in a dependency makes strict evidence incomplete', (_name, source) => {
    const result = closure(source);
    expect(result.complete).toBe(false);
    expect(closureHits({ closure: result, changedFiles: ['unrelated.mjs'] })).toBeNull();
  });
  it('keeps the real stale-guard scanner dependency complete without matching its detection vocabulary', () => {
    const root = resolve(fileURLToPath(import.meta.url), '../../../..');
    const parsed = new Map();
    const guard = collectImportClosure({ root, entries: ['scripts/lib/main-staleness.mjs'],
      requireResolvedImports: true, parsed });
    expect(guard.files.has('scripts/lib/import-closure.mjs')).toBe(true);
    expect(parsed.get(resolve(root, 'scripts/lib/import-closure.mjs')).complete).toBe(true);
    // The guard itself really executes Git and imports child_process: that edge must still refuse.
    expect(parsed.get(resolve(root, 'scripts/lib/main-staleness.mjs')).complete).toBe(false);
    expect(guard.complete).toBe(false);
    const scanner = collectImportClosure({ root, entries: ['scripts/lib/import-closure.mjs'],
      requireResolvedImports: true });
    expect(scanner.complete).toBe(true);
    expect(closureHits({ closure: scanner, changedFiles: ['unrelated.mjs'] })).toEqual([]);
  });
  it('ignores unsupported-edge vocabulary in comments, strings, regexes and template text', () => {
    expect(closure(`
      // require('missing'); createRequire(); spawn('node'); import(target);
      /* import '/missing.mjs'; */
      const text = "child_process createRequire require('missing') import(target)";
      const re = /child_process|createRequire|require\\(|import\\(/;
      const template = \`spawn('node'); import(target);\`;
    `).complete).toBe(true);
  });
  it('refuses unsupported edges executed inside template substitutions', () => {
    expect(closure('const x = `text ${require("./worker.cjs")}`;').complete).toBe(false);
  });
  it('refuses malformed syntax as incomplete evidence', () => {
    expect(closure('export const x = ;').complete).toBe(false);
  });
  it('keeps whitespace around a literal dynamic import complete', () => {
    expect(closure("await import( './entry.mjs' );").complete).toBe(true);
  });
  it('keeps resolved relative imports and builtins complete', () => {
    expect(closure("import { join } from 'node:path'; export const x = 1;").complete).toBe(true);
  });
  it('keeps the non-strict spawned-script walk available to existing callers', () => {
    expect(closure("spawn(process.execPath, ['./worker.mjs']);", false).complete).toBe(true);
  });
});
