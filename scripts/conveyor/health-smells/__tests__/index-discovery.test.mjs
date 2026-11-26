/**
 * @repo-scanning-test scope=full
 * @file index-discovery.test.mjs — proves `health-smells/index.mjs` builds its registry from the DIRECTORY, not
 * a hand-maintained import list (the #3729-style conflict this refactor removes): a new module file is picked
 * up with zero index edits, non-module entries (index.mjs itself, __tests__/) are excluded, discovery order is
 * deterministic, and a malformed module fails loudly instead of silently vanishing or crashing something far away.
 *
 * Imports only the generic `registry-discovery.mjs` and the smell-specific `shape.mjs` — mirrors
 * `soak/__tests__/breaks-index-discovery.test.mjs`'s reason for not importing the real `../index.mjs` directly
 * (its sibling breaks registry has real modules that need a real subprocess/env under the wrong vitest pool;
 * this file follows the same safe pattern for consistency even though no current smell module hits it). The one
 * check that needs the real, on-disk registry shells a plain `node` subprocess instead.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { discoverModuleFiles, loadModuleRegistry } from '../../registry-discovery.mjs';
import { validateSmellShape } from '../../health-smells-shape.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_SMELLS_DIR = join(HERE, '..');

const VALID_SMELL = `
export default {
  id: 'temp-smell',
  scope: 'host',
  cadence: 'every-tick',
  probes: [],
  openAfter: 1,
  closeAfter: 2,
  severity: 'medium',
  action: 'investigate',
  evaluate() { return []; },
};
`;

// Fixture dirs live INSIDE the project tree (this test file's own directory) — see the matching comment in
// `soak/__tests__/breaks-index-discovery.test.mjs` for why (Vite's dev-server-backed module loader flakily
// refuses `import()` of files under the OS tmpdir). Always removed in a `finally`.
function tempDir() {
  return mkdtempSync(join(HERE, '.tmp-fixture-'));
}

function loadSmells(dir) {
  return loadModuleRegistry(dir, validateSmellShape);
}

describe('health-smells/index.mjs — directory discovery', () => {
  it('picks up a new module file dropped into the directory with NO index edit', async () => {
    const dir = tempDir();
    try {
      writeFileSync(join(dir, 'temp-smell.mjs'), VALID_SMELL);
      expect(discoverModuleFiles(dir)).toEqual(['temp-smell.mjs']);
      const smells = await loadSmells(dir);
      expect(smells).toHaveLength(1);
      expect(smells[0].id).toBe('temp-smell');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('excludes index.mjs, *.test.mjs and the __tests__ directory, sorted for determinism', () => {
    const dir = tempDir();
    try {
      // Written out of alphabetical order on purpose — discovery must sort, not preserve fs order.
      writeFileSync(join(dir, 'zzz-smell.mjs'), VALID_SMELL);
      writeFileSync(join(dir, 'aaa-smell.mjs'), VALID_SMELL);
      writeFileSync(join(dir, 'index.mjs'), 'export const SMELLS = [];\n');
      mkdirSync(join(dir, '__tests__'));
      writeFileSync(join(dir, '__tests__', 'aaa-smell.test.mjs'), "import s from '../aaa-smell.mjs';\n");
      writeFileSync(join(dir, 'zzz-smell.test.mjs'), '// plain test\n');
      expect(discoverModuleFiles(dir)).toEqual(['aaa-smell.mjs', 'zzz-smell.mjs']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails LOUDLY when a module is missing required fields', async () => {
    const dir = tempDir();
    try {
      writeFileSync(join(dir, 'broken-smell.mjs'), "export default { id: 'broken-smell' };\n");
      await expect(loadSmells(dir)).rejects.toThrow(/broken-smell\.mjs.*missing required field/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails LOUDLY on an invalid enum field (scope/cadence/action)', async () => {
    const dir = tempDir();
    try {
      writeFileSync(join(dir, 'bad-scope.mjs'), VALID_SMELL.replace("scope: 'host'", "scope: 'planet'"));
      await expect(loadSmells(dir)).rejects.toThrow(/bad-scope\.mjs.*"scope"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails LOUDLY when a module has no default export at all', async () => {
    const dir = tempDir();
    try {
      writeFileSync(join(dir, 'no-default.mjs'), 'export const notDefault = 1;\n');
      await expect(loadSmells(dir)).rejects.toThrow(/no-default\.mjs.*default export must be an object/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails LOUDLY on a duplicate id across two module files', async () => {
    const dir = tempDir();
    try {
      writeFileSync(join(dir, 'aaa-smell.mjs'), VALID_SMELL.replace("id: 'temp-smell'", "id: 'dupe'"));
      writeFileSync(join(dir, 'zzz-smell.mjs'), VALID_SMELL.replace("id: 'temp-smell'", "id: 'dupe'"));
      await expect(loadSmells(dir)).rejects.toThrow(/duplicates/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the real registry (loaded in a plain node subprocess) has exactly one entry per discovered file on disk', () => {
    const files = discoverModuleFiles(REAL_SMELLS_DIR);
    expect(files.length).toBeGreaterThan(0);
    const out = execFileSync(
      process.execPath,
      ['-e', "import('./index.mjs').then((m) => process.stdout.write(String(m.SMELLS.length)))"],
      { cwd: REAL_SMELLS_DIR, encoding: 'utf8' },
    );
    expect(Number(out)).toBe(files.length);
  });
});
