import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectRunClosure, decideSkipRebuild } from '../daemon-rebuild/skip-unrelated.mjs';

describe('collectRunClosure across spawned-script hops', () => {
  function fixture() {
    const root = resolve('virtual-closure');
    const files = new Map(Object.entries({
      'entry.mjs': "import './shared.mjs';\nspawn('node', ['./child.mjs']);\n",
      'child.mjs': "import './shared.mjs';\nspawn('node', ['./grandchild.mjs']);\n",
      'grandchild.mjs': "import './shared.mjs';\nspawn('node', ['./entry.mjs']);\n",
      'shared.mjs': "import 'a-package';\nconst config = 'policy.json';\n",
    }).map(([name, body]) => [resolve(root, name), body]));
    const reads = new Map();
    const probes = new Map();
    const walk = () => collectRunClosure({
      root, entries: ['entry.mjs'], byName: () => [],
      readFile(p) {
        reads.set(p, (reads.get(p) ?? 0) + 1);
        if (!files.has(p)) throw new Error('unreadable source');
        return files.get(p);
      },
      exists(p) {
        probes.set(p, (probes.get(p) ?? 0) + 1);
        return files.has(p);
      },
    });
    return { root, files, reads, probes, walk };
  }

  it('reads and probes each path once while retaining nested spawns, cycles and dependency metadata', () => {
    const f = fixture();
    const closure = f.walk();
    expect(closure.files).toEqual(new Set(['entry.mjs', 'child.mjs', 'grandchild.mjs', 'shared.mjs']));
    expect(closure.complete).toBe(true);
    expect(closure.bareDeps).toBe(true);
    expect(closure.jsonNames).toContain('policy.json');
    expect(closure.spawnedNames).toContain('grandchild.mjs');
    expect([...f.reads.values()]).toEqual([1, 1, 1, 1]);
    expect([...f.probes.values()].every(count => count === 1)).toBe(true);
    for (const path of ['grandchild.mjs', 'package-lock.json', 'policy.json']) {
      expect(decideSkipRebuild({ changedFiles: [path], closure }).skip).toBe(false);
    }
    expect(decideSkipRebuild({ changedFiles: ['backlog/card.md'], closure }).skip).toBe(true);
  });

  it('does not retain cached source or path existence across walks', () => {
    const f = fixture();
    f.walk();
    f.files.set(resolve(f.root, 'shared.mjs'), "import './added.mjs';\n");
    f.files.set(resolve(f.root, 'added.mjs'), 'export {};\n');
    f.files.delete(resolve(f.root, 'grandchild.mjs'));
    const closure = f.walk();
    expect(closure.files).toContain('added.mjs');
    expect(closure.files).not.toContain('grandchild.mjs');
    expect(closure.bareDeps).toBe(false);
    expect(closure.jsonNames).not.toContain('policy.json');
    // A deleted spawn target still needs the smoke if a later change adds it back.
    expect(decideSkipRebuild({ changedFiles: ['grandchild.mjs'], closure }).skip).toBe(false);
    expect(f.reads.get(resolve(f.root, 'shared.mjs'))).toBe(2);
  });

  it('keeps an unreadable dependency conservative', () => {
    const f = fixture();
    f.files.set(resolve(f.root, 'shared.mjs'), undefined);
    const closure = collectRunClosure({
      root: f.root, entries: ['entry.mjs'], byName: () => [],
      exists: p => f.files.has(p),
      readFile(p) {
        if (p === resolve(f.root, 'shared.mjs')) throw new Error('EIO');
        return f.files.get(p);
      },
    });
    expect(closure.complete).toBe(false);
    expect(decideSkipRebuild({ changedFiles: ['unrelated.mjs'], closure }).skip).toBe(false);
  });
});
