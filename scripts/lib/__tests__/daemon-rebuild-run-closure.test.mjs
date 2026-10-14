/** @file Per-walk filesystem caching for the rebuild's import and spawned-script closure. */
import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { collectRunClosure, decideSkipRebuild } from '../daemon-rebuild/skip-unrelated.mjs';

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
