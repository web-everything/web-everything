/** Regression tests for the capability graph's source parsing; fixture modules are never executed. */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importGraph } from './import-graph.mjs';

const roots = [];
function fixture(source, modules = {}) {
  const root = mkdtempSync(join(tmpdir(), 'operation-import-graph-'));
  roots.push(root);
  for (const [name, body] of Object.entries({ 'entry.mjs': source, ...modules })) {
    writeFileSync(join(root, name), body);
  }
  return join(root, 'entry.mjs');
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('importGraph source parsing', () => {
  it.each([
    ['line comment after regex quotes', `const re = /['"]/;
// from './missing.mjs', import('./also-missing.mjs')
import 'node:fs';`],
    ['block comment after regex quotes', `const re = /['"]/;
/* import('./missing.mjs') */
export * from 'node:fs';`],
    ['quoted source example', `const example = "from './missing.mjs'";
import 'node:fs';`],
    ['regex source example', `const example = /from 'node:child_process'/;
import 'node:fs';`],
    ['template source example', "const example = `from './missing.mjs'`;\nimport 'node:fs';"],
  ])('ignores %s and retains the real writer import', (_name, source) => {
    const entry = fixture(source);
    expect(importGraph(entry)).toEqual({ files: [entry], external: ['node:fs'] });
  });

  it('follows static, side-effect, re-export and dynamic imports through cycles', () => {
    const entry = fixture(`import { value } from './static.mjs';
import './side-effect.mjs';
export { value } from './re-export.mjs';
export * from './star.mjs';
async function load() { return import('./dynamic.mjs'); }`, {
      'static.mjs': "export const value = 1; import './entry.mjs';",
      'side-effect.mjs': "import 'node:fs';",
      're-export.mjs': "export const value = 2;",
      'star.mjs': "export * from 'node:child_process';",
      'dynamic.mjs': "import 'node:http';",
    });
    expect(importGraph(entry)).toEqual({
      files: ['dynamic.mjs', 'entry.mjs', 're-export.mjs', 'side-effect.mjs', 'star.mjs', 'static.mjs']
        .map(name => join(entry, '..', name)).sort(),
      external: ['node:child_process', 'node:fs', 'node:http'],
    });
  });

  it('finds literal dynamic imports inside template expressions and template specifiers', () => {
    const entry = fixture('const text = `result: ${import("node:fs")}`;\nimport(`node:child_process`);');
    expect(importGraph(entry).external).toEqual(['node:child_process', 'node:fs']);
  });

  it('decodes escaped literal specifiers', () => {
    const entry = fixture(String.raw`import 'node:\u0066s';`);
    expect(importGraph(entry).external).toEqual(['node:fs']);
  });

  it('refuses an unreadable real dependency instead of returning a partial graph', () => {
    const entry = fixture("import './missing.mjs';");
    expect(() => importGraph(entry)).toThrow(/ENOENT/);
  });

  it('refuses malformed source instead of certifying an incomplete graph', () => {
    const entry = fixture("import { writer from 'node:fs';");
    expect(() => importGraph(entry)).toThrow(SyntaxError);
  });
});
