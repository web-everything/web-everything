import { expect, it } from 'vitest';
import { resolve, relative } from 'node:path';
import { computeClosureScope, fixpointExtend, isExcludable } from '../daemon-rebuild/closure-scope.mjs';
import { smokeSurfaceEntries } from '../daemon-rebuild/skip-unrelated.mjs';

function reader(files = {}) {
  const root = resolve('virtual-scope');
  const contents = new Map(Object.entries(files));
  return { root, listFiles: () => [...contents.keys()],
    exists: p => contents.has(relative(root, resolve(root, p))),
    readFile(p) {
      const key = relative(root, resolve(root, p));
      if (!contents.has(key)) throw new Error('missing file');
      return contents.get(key);
    },
  };
}
function compute(files = {}, options = {}) {
  const surface = Object.fromEntries(smokeSurfaceEntries({}).map(p => [p, 'export {};']));
  return computeClosureScope({ reader: reader({ ...surface, 'entry.mjs': '', ...files }),
    entries: ['entry.mjs'], env: {}, ...options });
}

it('only excludes allowed files outside the run closure and protects smoke and mechanism paths', () => {
  const result = compute({ 'entry.mjs': "import './used.mjs';", 'used.mjs': '',
    'unused.mjs': '', 'data.bin': '' }, { mechanismPaths: ['mechanism/'] });
  expect(result.ok).toBe(true);
  expect(isExcludable('unused.mjs', result.scope)).toBe(true);
  expect(isExcludable('used.mjs', result.scope)).toBe(false);
  expect(isExcludable('backlog/card.md', result.scope)).toBe(true);
  expect(isExcludable('docs/note.md', result.scope)).toBe(true);
  expect(isExcludable('tests/thing.spec.mjs', result.scope)).toBe(true);
  expect(isExcludable('data.bin', result.scope)).toBe(false);
  expect(isExcludable('unnamed.json', result.scope)).toBe(true);
  expect(isExcludable('mechanism/new.mjs', result.scope)).toBe(false);
  for (const p of smokeSurfaceEntries({})) expect(result.scope.has(p)).toBe(true);
});

it('walks overlay changes on top of main including newly imported and spawned files', () => {
  const result = compute({}, { overlayChangedFiles: new Map([
    ['entry.mjs', "import './new.mjs';"], ['new.mjs', "spawn('node', ['./child.mjs']);"], ['child.mjs', ''],
  ]) });
  expect(result.ok).toBe(true);
  for (const p of ['entry.mjs', 'new.mjs', 'child.mjs']) expect(result.scope.has(p)).toBe(true);
});

it('protects manifests, lockfiles, configs, named JSON, runtime reads and executables unconditionally', () => {
  const result = compute({ 'entry.mjs': "const config = 'policy.json';", 'data/policy.json': '{}' });
  expect(result.ok).toBe(true);
  expect(result.scope.has('data/policy.json')).toBe(true);
  for (const p of ['package.json', 'package-lock.json', 'pnpm-lock.yaml', '.npmrc',
    'daemon-rebuild-settings.json', 'nested/package.json', 'skills-src/readme.md', '.claude/prompt.md',
    'run.sh', 'config.toml', 'unused.ts']) expect(isExcludable(p, result.scope), p).toBe(false);
  expect(isExcludable('other/policy.json', result.scope)).toBe(false);
});

it('fails closed on non-literal dynamic imports with a conflict-retaining fallback', () => {
  expect(compute({ 'entry.mjs': 'import(target);' })).toMatchObject({ ok: false, reason: 'closure-incomplete' });
});

it('fails closed when any requested entry is unreadable, even if other entries exist', () => {
  expect(compute({}, { entries: ['entry.mjs', 'missing.mjs'] })).toMatchObject({ ok: false, reason: 'entries-unreadable' });
});

it('fails closed on a missing relative dependency or an overlay deleting a reachable file', () => {
  expect(compute({ 'entry.mjs': "import './missing.mjs';" })).toMatchObject({ ok: false, reason: 'closure-incomplete' });
  expect(compute({ 'entry.mjs': "import './used.mjs';", 'used.mjs': '' }, {
    overlayChangedFiles: new Map([['used.mjs', null]]),
  })).toMatchObject({ ok: false, reason: 'closure-incomplete' });
});

it('protects default rebuild mechanism directory entries', () => {
  const result = compute();
  expect(isExcludable('scripts/lib/daemon-rebuild/new.mjs', result.scope)).toBe(false);
});

it('fails closed when the reader cannot list the snapshot', () => {
  expect(compute({}, { reader: { listFiles() { throw new Error('EIO'); } } }))
    .toMatchObject({ ok: false, reason: 'scope-unreadable' });
});

it('fails closed above 4000 closure files', () => {
  const files = { 'entry.mjs': Array.from({ length: 4000 }, (_, i) => `import './f${i}.mjs';`).join('\n') };
  for (let i = 0; i < 4000; i++) files[`f${i}.mjs`] = '';
  expect(compute(files)).toMatchObject({ ok: false, reason: 'closure-too-large' });
});

it('extends the fixpoint only by reachable excluded paths and never mutates its inputs', () => {
  const scope = new Set(['entry.mjs']);
  const add = fixpointExtend({ scope, excluded: ['a.mjs', 'b.mjs'],
    finalClosure: { complete: true, files: new Set(['entry.mjs', 'a.mjs', 'other.mjs']) } });
  expect(add).toEqual(['a.mjs']);
  expect([...scope]).toEqual(['entry.mjs']);
  expect(() => fixpointExtend({ scope, excluded: [], finalClosure: { complete: false, files: new Set() } })).toThrow();
});
