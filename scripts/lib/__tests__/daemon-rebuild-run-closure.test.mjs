/** @file Per-walk filesystem caching for the rebuild's import and spawned-script closure. */
import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectRunClosure, decideSkipRebuild, makeSkipCheck } from '../daemon-rebuild/skip-unrelated.mjs';
import { collectImportClosure } from '../import-closure.mjs';

function fixture(contents) {
  const root = resolve('run-closure-fixture');
  const files = new Map(Object.entries(contents).map(([path, source]) => [resolve(root, path), source]));
  const reads = new Map();
  const checks = new Map();
  const options = {
    root, entries: ['scripts/daemon.mjs'], byName: () => [],
    readFile(path) {
      reads.set(path, (reads.get(path) || 0) + 1);
      const source = files.get(path);
      if (source === undefined) throw new Error('unreadable source');
      return source;
    },
    exists(path) {
      checks.set(path, (checks.get(path) || 0) + 1);
      return files.has(path);
    },
  };
  return { root, files, reads, checks, options };
}

describe('collectRunClosure filesystem reads', () => {
  it('keeps the registry reader closure complete when its child imports a base-ref copy', () => {
    const root = resolve(fileURLToPath(import.meta.url), '../../../..');
    const entry = 'scripts/lib/gate-config.mjs';
    const closure = collectImportClosure({ root, entries: [entry] });
    expect(closure.files.has(entry)).toBe(true);
    expect(closure.complete).toBe(true);
    expect(decideSkipRebuild({ closure, changedFiles: ['scripts/unrelated.mjs'] }).skip).toBe(true);
    expect(decideSkipRebuild({ closure, changedFiles: [entry] }).skip).toBe(false);
  });

  it('checks shared import targets once in a standalone import walk', () => {
    const f = fixture({
      'scripts/daemon.mjs': "import './shared.mjs';\nimport './worker.mjs';\n",
      'scripts/shared.mjs': 'export {};\n',
      'scripts/worker.mjs': "import './shared.mjs';\n",
    });
    const closure = collectImportClosure(f.options);
    expect(closure.complete).toBe(true);
    expect([...f.checks.values()].every(count => count === 1)).toBe(true);
    f.files.delete(resolve(f.root, 'scripts/shared.mjs'));
    expect(collectImportClosure(f.options).files.has('scripts/shared.mjs')).toBe(false);
  });

  it('uses the conservative fallback without scanning spawned scripts when imports are incomplete', () => {
    const f = fixture({
      'scripts/daemon.mjs': "await import(target);\nspawn(process.execPath, ['./worker.mjs']);\n",
      'scripts/worker.mjs': "spawn(process.execPath, ['./grandchild.mjs']);\n",
      'scripts/grandchild.mjs': 'export {};\n',
    });
    const check = makeSkipCheck({ ...f.options, env: {}, surface: () => [] });
    expect(check(['backlog/card.md']).skip).toBe(true);
    expect(check(['scripts/grandchild.mjs']).skip).toBe(false);
    expect(check(['scripts/unknown.mjs']).skip).toBe(false);
    expect(check(['config/settings.json']).skip).toBe(false);
    expect(f.reads.has(resolve(f.root, 'scripts/worker.mjs'))).toBe(false);
  });

  it('stops later spawn hops once a spawned import is incomplete', () => {
    const f = fixture({
      'scripts/daemon.mjs': "spawn(process.execPath, ['./worker.mjs']);\n",
      'scripts/worker.mjs': "await import(target);\nspawn(process.execPath, ['./grandchild.mjs']);\n",
      'scripts/grandchild.mjs': 'export {};\n',
    });
    const check = makeSkipCheck({ ...f.options, env: {}, surface: () => [] });
    expect(check(['backlog/card.md']).skip).toBe(true);
    expect(check(['scripts/grandchild.mjs']).skip).toBe(false);
    expect(f.reads.has(resolve(f.root, 'scripts/worker.mjs'))).toBe(true);
    expect(f.reads.has(resolve(f.root, 'scripts/grandchild.mjs'))).toBe(false);
  });

  it('parses shared sources once across spawn hops and preserves their dependency metadata', () => {
    const f = fixture({
      'scripts/daemon.mjs': "import './shared.mjs';\nspawn(process.execPath, ['./worker.mjs']);\n",
      'scripts/shared.mjs': "import 'a-package';\nexport const config = 'settings.json';\n",
      'scripts/worker.mjs': "import './shared.mjs';\nspawn(process.execPath, ['./grandchild.mjs']);\n",
      'scripts/grandchild.mjs': "import './shared.mjs';\n",
    });
    const parserReads = new Map();
    let passes = 0;
    const closure = collectRunClosure({
      ...f.options,
      importClosure(options) {
        passes++;
        return collectImportClosure({
          ...options,
          readFile(path) {
            parserReads.set(path, (parserReads.get(path) || 0) + 1);
            return options.readFile(path);
          },
        });
      },
    });
    expect(passes).toBe(3);
    expect([...parserReads.values()]).toEqual(Array(f.files.size).fill(1));
    expect(closure.complete).toBe(true);
    expect(closure.bareDeps).toBe(true);
    expect(closure.jsonNames.has('settings.json')).toBe(true);
    expect(closure.files.has('scripts/grandchild.mjs')).toBe(true);
    expect(decideSkipRebuild({ closure, changedFiles: ['config/settings.json'] }).skip).toBe(false);
  });

  it('preserves incomplete dynamic imports across later spawn hops', () => {
    const f = fixture({
      'scripts/daemon.mjs': "await import(target);\nspawn(process.execPath, ['./worker.mjs']);\n",
      'scripts/worker.mjs': "spawn(process.execPath, ['./grandchild.mjs']);\n",
      'scripts/grandchild.mjs': 'export {};\n',
    });
    const closure = collectRunClosure(f.options);
    expect(closure.files.has('scripts/grandchild.mjs')).toBe(true);
    expect(closure.complete).toBe(false);
    expect(decideSkipRebuild({ closure, changedFiles: ['scripts/unrelated.mjs'] }).skip).toBe(false);
  });

  it('reads each source and checks each path once across imports and multiple spawn hops', () => {
    const f = fixture({
      'scripts/daemon.mjs': "import './shared.mjs';\nspawn(process.execPath, ['./worker.mjs']);\n",
      'scripts/shared.mjs': "export const config = 'settings.json';\n",
      'scripts/worker.mjs': "import './shared.mjs';\nspawn(process.execPath, ['./grandchild.mjs']);\n",
      'scripts/grandchild.mjs': "import './shared.mjs';\n",
      'scripts/npm-worker.mjs': 'export {};\n',
      'package.json': '{"scripts":{"worker":"node scripts/npm-worker.mjs"}}',
    });
    const closure = collectRunClosure(f.options);
    expect(closure.complete).toBe(true);
    expect([...closure.files].sort()).toEqual([
      'scripts/daemon.mjs', 'scripts/grandchild.mjs', 'scripts/npm-worker.mjs',
      'scripts/shared.mjs', 'scripts/worker.mjs',
    ]);
    expect([...f.reads.values()]).toEqual(Array(f.files.size).fill(1));
    expect([...f.checks.values()].every(count => count === 1)).toBe(true);
    for (const path of ['scripts/grandchild.mjs', 'scripts/npm-worker.mjs', 'config/settings.json']) {
      expect(decideSkipRebuild({ closure, changedFiles: [path] }).skip).toBe(false);
    }
    expect(decideSkipRebuild({ closure, changedFiles: ['backlog/card.md'] }).skip).toBe(true);
  });

  it('sees changed sources and newly present files on the next walk', () => {
    const f = fixture({ 'scripts/daemon.mjs': 'export {};\n' });
    const before = collectRunClosure(f.options);
    f.files.set(resolve(f.root, 'scripts/daemon.mjs'), "import './added.mjs';\n");
    f.files.set(resolve(f.root, 'scripts/added.mjs'), 'export {};\n');
    const after = collectRunClosure(f.options);
    expect(before.files.has('scripts/added.mjs')).toBe(false);
    expect(after.files.has('scripts/added.mjs')).toBe(true);
    expect(f.reads.get(resolve(f.root, 'scripts/daemon.mjs'))).toBe(2);
  });

  it('keeps an unreadable import conservative and retries it on a later walk', () => {
    const f = fixture({
      'scripts/daemon.mjs': "import './broken.mjs';\n",
      'scripts/broken.mjs': undefined,
    });
    const broken = collectRunClosure(f.options);
    expect(broken.complete).toBe(false);
    expect(decideSkipRebuild({ closure: broken, changedFiles: ['scripts/other.mjs'] }).skip).toBe(false);
    f.files.set(resolve(f.root, 'scripts/broken.mjs'), 'export {};\n');
    expect(collectRunClosure(f.options).complete).toBe(true);
  });
});
