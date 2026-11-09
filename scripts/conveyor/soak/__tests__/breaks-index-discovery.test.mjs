/**
 * @file breaks-index-discovery.test.mjs — proves `breaks/index.mjs` builds its registry from the DIRECTORY,
 * not a hand-maintained import list (the #3729-style conflict this refactor removes): a new module file is
 * picked up with zero index edits, non-module entries (index.mjs itself, tests, fixtures) are excluded,
 * discovery order is deterministic, and a malformed module fails loudly instead of silently vanishing or
 * crashing something far away.
 *
 * Imports only the generic `registry-discovery.mjs` and the break-specific `shape.mjs` — deliberately NOT
 * `../breaks/index.mjs` itself, which eagerly dynamic-imports every REAL break module at import time. Some of
 * those need a real subprocess/env (why `vitest.soak.config.ts` isolates their own tests to a `forks`-pool run,
 * separate from this file's default `threads` pool) — importing the real index.mjs here would drag that in
 * under the wrong pool. The one check that needs the real, on-disk registry shells a plain `node` subprocess
 * instead (see the last test below), sidestepping that pool difference entirely.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { discoverModuleFiles, loadModuleRegistry } from '../../registry-discovery.mjs';
import { validateBreakShape } from '../breaks-shape.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_BREAKS_DIR = join(HERE, '..', 'breaks');

const VALID_BREAK = `
export default {
  id: 'temp-break',
  title: 'a temp break for the discovery test',
  card: 'test-only',
  fixedBy: { sha: 'deadbeef', where: 'main' },
  fixPresent() { return true; },
  async run() { return { violations: [] }; },
  judge() { return []; },
};
`;

// Fixture dirs live INSIDE the project tree (this test file's own directory), not under the OS tmpdir: Vite's
// dev-server-backed module loader (vite-node, what `vitest` uses for `import()`) restricts serving files from
// outside its allowed roots, which flakily/loudly refuses a dynamic `import()` of a file under `os.tmpdir()`
// ("Failed to load url ... Does the file exist?", even though it does) — a test-harness quirk, not a real fs
// problem. Always removed in a `finally`, so nothing is left behind (and nothing here is ever committed).
function tempDir() {
  return mkdtempSync(join(HERE, '.tmp-fixture-'));
}

function loadBreaks(dir) {
  return loadModuleRegistry(dir, validateBreakShape);
}

describe('soak/breaks/index.mjs — directory discovery', () => {
  it('picks up a new module file dropped into the directory with NO index edit', async () => {
    const dir = tempDir();
    try {
      writeFileSync(join(dir, 'temp-break.mjs'), VALID_BREAK);
      expect(discoverModuleFiles(dir)).toEqual(['temp-break.mjs']);
      const breaks = await loadBreaks(dir);
      expect(breaks).toHaveLength(1);
      expect(breaks[0].id).toBe('temp-break');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('excludes index.mjs, *.test.mjs/*.soak.test.mjs and non-.mjs entries, sorted for determinism', () => {
    const dir = tempDir();
    try {
      // Written out of alphabetical order on purpose — discovery must sort, not preserve fs order.
      writeFileSync(join(dir, 'zzz-break.mjs'), VALID_BREAK);
      writeFileSync(join(dir, 'aaa-break.mjs'), VALID_BREAK);
      writeFileSync(join(dir, 'index.mjs'), 'export const BREAKS = [];\n');
      writeFileSync(join(dir, 'aaa-break.soak.test.mjs'), "import b from './aaa-break.mjs';\n");
      writeFileSync(join(dir, 'zzz-break.test.mjs'), '// plain test\n');
      writeFileSync(join(dir, 'README.md'), '# not a module\n');
      expect(discoverModuleFiles(dir)).toEqual(['aaa-break.mjs', 'zzz-break.mjs']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails LOUDLY when a module is missing required fields', async () => {
    const dir = tempDir();
    try {
      writeFileSync(join(dir, 'broken-break.mjs'), "export default { id: 'broken-break' };\n");
      await expect(loadBreaks(dir)).rejects.toThrow(/broken-break\.mjs.*missing required field/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails LOUDLY when a module has no default export at all', async () => {
    const dir = tempDir();
    try {
      writeFileSync(join(dir, 'no-default.mjs'), 'export const notDefault = 1;\n');
      await expect(loadBreaks(dir)).rejects.toThrow(/no-default\.mjs.*default export must be an object/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails LOUDLY on a duplicate id across two module files', async () => {
    const dir = tempDir();
    try {
      writeFileSync(join(dir, 'aaa-break.mjs'), VALID_BREAK.replace("id: 'temp-break'", "id: 'dupe'"));
      writeFileSync(join(dir, 'zzz-break.mjs'), VALID_BREAK.replace("id: 'temp-break'", "id: 'dupe'"));
      await expect(loadBreaks(dir)).rejects.toThrow(/duplicates/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the real registry (loaded in a plain node subprocess) has exactly one entry per discovered file on disk', () => {
    const files = discoverModuleFiles(REAL_BREAKS_DIR);
    expect(files.length).toBeGreaterThan(0);
    const out = execFileSync(
      process.execPath,
      ['-e', "import('./index.mjs').then((m) => process.stdout.write(JSON.stringify(m.BREAKS.map(b => b.id))))"],
      { cwd: REAL_BREAKS_DIR, encoding: 'utf8' },
    );
    const ids = JSON.parse(out);
    expect(ids).toHaveLength(files.length);
    expect(ids.filter(id => id === 'clone-object-maintenance-borrowed-or-busy')).toHaveLength(1);
  });
});
