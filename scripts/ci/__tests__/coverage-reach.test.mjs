import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createReach, makeIsCovered, planeDirsFromInclude } from '../coverage-reach.mjs';

function withRepo(files, fn) {
  const root = mkdtempSync(join(tmpdir(), 'cov-reach-'));
  try {
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const isCovered = makeIsCovered(['blocks'], ['scripts/lib/tier.mjs']);

describe('coverage-reach (card 12)', () => {
  it('derives plane directories from coverage.include globs', () => {
    expect(planeDirsFromInclude(['scripts/lib/x.mjs', 'blocks/**/*.ts', 'guard/**/*.ts'])).toEqual(['blocks', 'guard']);
  });

  it('a test importing a trust-chain tier file directly or transitively reaches coverage', () => {
    withRepo({
      'scripts/lib/tier.mjs': 'export const x = 1;',
      'scripts/lib/helper.mjs': "export * from './tier.mjs';",
      'scripts/__tests__/a.test.mjs': "import { x } from '../lib/tier.mjs';",
      'scripts/__tests__/b.test.mjs': "import { x } from '../lib/helper.mjs';",
    }, (root) => {
      const reach = createReach({ repoRoot: root, isCovered });
      expect(reach('scripts/__tests__/a.test.mjs').reaches).toBe(true);
      expect(reach('scripts/__tests__/b.test.mjs')).toEqual({ reaches: true, via: 'scripts/lib/tier.mjs' });
    });
  });

  it('a test that only loads uncovered modules does not reach coverage', () => {
    withRepo({
      'scripts/lib/plain.mjs': 'export const y = 2;',
      'scripts/__tests__/c.test.mjs': "import { y } from '../lib/plain.mjs';",
    }, (root) => {
      expect(createReach({ repoRoot: root, isCovered })('scripts/__tests__/c.test.mjs').reaches).toBe(false);
    });
  });

  it('a repo-relative path literal and a plane directory count as an edge', () => {
    withRepo({
      'blocks/b/b.ts': 'export const b = 1;',
      'scripts/__tests__/d.test.mjs': "const p = 'blocks/b/b.ts';",
    }, (root) => {
      expect(createReach({ repoRoot: root, isCovered })('scripts/__tests__/d.test.mjs').reaches).toBe(true);
    });
  });

  it('a runtime-computed load (even in a helper) is treated as possibly reaching coverage', () => {
    withRepo({
      'scripts/lib/loader.mjs': 'export const load = (p) => import(p);',
      'scripts/__tests__/e.test.mjs': "import { load } from '../lib/loader.mjs';",
    }, (root) => {
      expect(createReach({ repoRoot: root, isCovered })('scripts/__tests__/e.test.mjs').reaches).toBe(true);
    });
  });
});
