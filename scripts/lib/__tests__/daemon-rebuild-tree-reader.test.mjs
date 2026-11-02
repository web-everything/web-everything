import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { treeReader, collectRunClosure } from '../daemon-rebuild/skip-unrelated.mjs';
import { collectImportClosure } from '../import-closure.mjs';
import { computeClosureScope } from '../daemon-rebuild/closure-scope.mjs';
import { smokeSurfaceEntries } from '../daemon-rebuild/skip-unrelated.mjs';
import { makeGit } from '../daemon-rebuild/shared.mjs';

let dir;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'tree-reader-'));
  const git = makeGit({ cwd: dir, env: process.env, timeoutMs: 10000,
    run: (args, opts) => spawnSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...opts }) });
  const must = args => { const r = git(args); expect(r.status, String(r.stderr)).toBe(0); return r.stdout.trim(); };
  must(['init', '-q']); must(['config', 'user.name', 'Fixture']); must(['config', 'user.email', 'fixture@example.invalid']);
  const commit = () => { must(['add', '.']); must(['commit', '-qm', 'fixture']); return must(['rev-parse', 'HEAD']); };
  return { git, must, commit };
}

it('reads a commit with NUL filenames and byte-framed UTF-8 blobs, without reading the worktree', () => {
  const f = fixture();
  writeFileSync(join(dir, 'entry.mjs'), "import './space name.mjs';\nspawn('node', ['./child.mjs']);");
  writeFileSync(join(dir, 'space name.mjs'), '// café 🐢\n');
  writeFileSync(join(dir, 'child.mjs'), '');
  writeFileSync(join(dir, 'tab\tline\n.txt'), 'binary\0payload');
  const sha = f.commit();
  writeFileSync(join(dir, 'entry.mjs'), 'import(bad);');
  const r = treeReader(f.git, sha);
  expect(r.listFiles()).toContain('tab\tline\n.txt');
  expect(r.readFile('space name.mjs')).toBe('// café 🐢\n');
  expect(r.readFile('tab\tline\n.txt')).toBe('binary\0payload');
  expect(() => r.readFile('missing')).toThrow();
  expect(collectImportClosure({ root: r.root, entries: ['entry.mjs'], readFile: r.readFile, exists: r.exists }).files)
    .toEqual(new Set(['entry.mjs', 'space name.mjs']));
  expect(collectRunClosure({ root: r.root, entries: ['entry.mjs'], reader: r }).files)
    .toEqual(new Set(['entry.mjs', 'space name.mjs', 'child.mjs']));
});

it('caps each cat-file batch at 32 objects and reads every script across batches', () => {
  const f = fixture();
  const files = Array.from({ length: 70 }, (_, i) => [`script-${i}.mjs`, `// café 🐢 ${i}\n`]);
  for (const [name, source] of files) writeFileSync(join(dir, name), source);
  const sha = f.commit();
  const batches = [];
  const reader = treeReader((args, opts) => {
    if (args[0] === 'cat-file' && args[1] === '--batch') {
      const objects = opts.input.trimEnd().split('\n');
      expect(objects.length).toBeLessThanOrEqual(32);
      batches.push(objects);
    }
    return f.git(args, opts);
  }, sha);
  for (const [name, source] of files) expect(reader.readFile(name), name).toBe(source);
  expect(batches.map(batch => batch.length)).toEqual([32, 32, 6]);
  expect(new Set(batches.flat()).size).toBe(files.length);
  for (const [name, source] of files) expect(reader.readFile(name), name).toBe(source);
  expect(batches).toHaveLength(3);
});

it('resolves bare spawned basenames from the snapshot, excluding checkout-only decoys', () => {
  const f = fixture();
  mkdirSync(join(dir, 'snapshot'));
  writeFileSync(join(dir, 'entry.mjs'), "spawn('node', ['worker.mjs']);\nspawn('node', ['decoy.mjs']);");
  writeFileSync(join(dir, 'snapshot/worker.mjs'), 'export {};');
  const sha = f.commit();
  rmSync(join(dir, 'snapshot'), { recursive: true });
  mkdirSync(join(dir, 'checkout'));
  writeFileSync(join(dir, 'checkout/worker.mjs'), 'export {};');
  writeFileSync(join(dir, 'checkout/decoy.mjs'), 'export {};');
  f.commit();
  const snapshot = treeReader(f.git, sha);
  // Anchor the reader at the checkout so an accidental tracked-index fallback sees
  // the decoys; all source reads still come from the original snapshot.
  const reader = { ...snapshot, root: dir, byName: vi.fn(snapshot.byName),
    readFile: path => snapshot.readFile(relative(dir, path)),
    exists: path => snapshot.exists(relative(dir, path)),
  };
  const closure = collectRunClosure({ root: dir, entries: ['entry.mjs'], reader });
  expect(reader.byName).toHaveBeenCalledWith('worker.mjs');
  expect(reader.byName).toHaveBeenCalledWith('decoy.mjs');
  expect(closure.files).toEqual(new Set(['entry.mjs', 'snapshot/worker.mjs']));
  expect(closure.files.has('checkout/worker.mjs')).toBe(false);
  expect(closure.files.has('checkout/decoy.mjs')).toBe(false);
  expect(closure.complete).toBe(true);
});

it('fails closed on git read errors and truncated batch output', () => {
  expect(() => treeReader(() => ({ status: 1 }), 'bad')).toThrow();
  expect(() => treeReader(args => ({ status: 0, stdout: args[0] === 'ls-tree'
    ? `100644 blob ${'a'.repeat(40)}\tentry.mjs\0` : `${'a'.repeat(40)} blob 100\nx\n` }), 'sha').readFile('entry.mjs')).toThrow();
});

it('lays changed overlay tree files over main without checking out either tree', () => {
  const f = fixture();
  writeFileSync(join(dir, 'entry.mjs'), '');
  const mainSha = f.commit();
  writeFileSync(join(dir, 'entry.mjs'), "import './added.mjs';");
  writeFileSync(join(dir, 'added.mjs'), '');
  const sha = f.commit();
  // Supply a minimal smoke reader separately; git trees here only hold the exercised graph.
  const smoke = Object.fromEntries(smokeSurfaceEntries({}).map(p => [p, '']));
  const result = computeClosureScope({ git: f.git, mainSha, overlays: [{ sha, changedFiles: ['entry.mjs', 'added.mjs'] }],
    overlayChangedFiles: new Map(Object.entries(smoke)), entries: ['entry.mjs'], env: {} });
  expect(result.ok).toBe(true);
  expect(result.scope.has('added.mjs')).toBe(true);
  expect(f.must(['rev-parse', 'HEAD'])).toBe(sha);
});
