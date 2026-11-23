import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { parseSupersedes } from '../../conveyor/supersede-rule.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

// Walk static imports and reject non-indented startup package loads; indented function bodies may load lazily.
function packageImports(entry, read = (path) => readFileSync(resolve(root, path), 'utf8')) {
  const seen = new Set();
  const packages = [];
  function walk(path, chain) {
    if (seen.has(path)) return;
    seen.add(path);
    const text = read(path);
    for (const line of text.split('\n').filter(line => /^\S/.test(line) && !/^\/\//.test(line))) {
      for (const match of line.matchAll(/\b(?:require|import)\s*\(\s*(['"])([^'"]+)\1/g)) {
        const name = match[2];
        if (!name.startsWith('.') && !name.startsWith('node:') && !isBuiltin(name)) packages.push([...chain, path, name].join(' -> '));
      }
    }
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      const specifier = statement.moduleSpecifier;
      if (!specifier) continue;
      if (!ts.isStringLiteral(specifier)) throw new Error(`Unreadable import in ${path}`);
      const name = specifier.text;
      if (name.startsWith('.')) walk(posix.normalize(posix.join(posix.dirname(path), name)), [...chain, path]);
      else if (!name.startsWith('node:') && !isBuiltin(name)) packages.push([...chain, path, name].join(' -> '));
    }
  }
  walk(entry, []);
  return packages;
}

describe('deps job without installed packages', () => {
  it('has only Node builtins throughout its static import closure', () => {
    expect(packageImports('scripts/lib/daemon-rebuild/deps-job.mjs')).toEqual([]);
  });

  it('can statically import the supersede rule before packages are installed', () => {
    expect(packageImports('scripts/conveyor/supersede-rule.mjs')).toEqual([]);
  });

  it('walks multiline imports, re-exports and bare imports, including cycles, and names the package chain', () => {
    const files = {
      'entry.mjs': "import {\n x\n} from './child.mjs'; export * from './export.mjs'; import './bare.mjs';",
      'child.mjs': "import './entry.mjs'; import 'node:fs'; import 'fs';",
      'export.mjs': "export { x } from 'external';",
      'bare.mjs': "import 'another-package';",
    };
    expect(packageImports('entry.mjs', (path) => files[path])).toEqual([
      'entry.mjs -> export.mjs -> external', 'entry.mjs -> bare.mjs -> another-package',
    ]);
  });

  it.each([
    "const x = require('external');",
    "const x = await import('external');",
    "(() => { require('external'); })();",
  ])('rejects startup package loading: %s', (source) => {
    expect(packageImports('entry.mjs', () => source)).toEqual(['entry.mjs -> external']);
  });

  it('refuses an unreadable relative dependency instead of accepting an incomplete closure', () => {
    expect(() => packageImports('entry.mjs', (path) => {
      if (path === 'entry.mjs') return "import './missing.mjs';";
      throw new Error(`Cannot read ${path}`);
    })).toThrow('Cannot read missing.mjs');
  });

  it('still parses Supersedes markers while ignoring fenced examples', () => {
    expect(parseSupersedes('```md\nSupersedes: #99\n```\n### **Supersedes:** #12, #13 and #14')).toEqual([12, 13, 14]);
  });
});
