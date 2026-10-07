/**
 * @file scripts/__tests__/undeclared-deps.test.mjs
 * @description Guard against phantom dependencies: every bare package imported by a tracked
 * scripts/ or src/ file must be declared in package.json (dependencies, devDependencies,
 * optionalDependencies or peerDependencies). Phantom deps only work while npm happens to hoist
 * them from another package, and break under pnpm's isolated layout (pnpm trial, 2026-10-07).
 * node: builtins are allowed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { builtinModules } from 'node:module';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const declared = new Set(
  ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].flatMap((k) => Object.keys(pkg[k] ?? {})),
);
const builtins = new Set(builtinModules.map((m) => m.replace(/^node:/, '').split('/')[0]));

// Names that only appear as import text inside test fixture strings (template literals), never executed.
const FIXTURE_ONLY = new Set(['react', '@frontierui/blocks']);

const IMPORT_RE = /^\s*(?:import|export)\s+(?:[^'"`;]*?\sfrom\s+)?['"]([^'"\n]+)['"]|^[^\n'"`/*]*?\b(?:const|let|var)\s[^\n=]*=\s*(?:await\s+)?(?:require|import)\(\s*['"]([^'"\n]+)['"]\s*\)/gm;

/** Reduce an import specifier to its package name, or null when it is not a bare package. */
export function bareName(spec) {
  if (/^(\.|\/|[a-z]+:|#)/.test(spec)) return null;
  const parts = spec.split('/');
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  return builtins.has(name) ? null : name;
}

function trackedSources() {
  const out = execFileSync('git', ['ls-files', 'scripts', 'src'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\n').filter((f) => /\.(mjs|cjs|js|ts)$/.test(f) && !/(^|\/)(fixtures?|node_modules)\//.test(f));
}

describe('bareName', () => {
  it('ignores relative, node: and builtin specifiers; keeps scopes', () => {
    expect(bareName('./x.mjs')).toBeNull();
    expect(bareName('node:fs')).toBeNull();
    expect(bareName('fs/promises')).toBeNull();
    expect(bareName('@scope/pkg/deep')).toBe('@scope/pkg');
    expect(bareName('gray-matter')).toBe('gray-matter');
  });
});

describe('undeclared dependencies', () => {
  it('every bare import in scripts/ and src/ is declared in package.json', () => {
    const missing = new Map();
    for (const file of trackedSources()) {
      let text;
      try { text = readFileSync(file, 'utf8'); } catch { continue; }
      for (const m of text.matchAll(IMPORT_RE)) {
        const name = bareName(m[1] ?? m[2]);
        if (name && !declared.has(name) && !FIXTURE_ONLY.has(name)) {
          if (!missing.has(name)) missing.set(name, new Set());
          missing.get(name).add(file);
        }
      }
    }
    const report = [...missing].map(([n, fs]) => `${n}: ${[...fs].slice(0, 3).join(', ')}`);
    expect(report, 'declare these in package.json').toEqual([]);
  });
});
