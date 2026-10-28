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
  expect(isExcludable('backlog/card.md', result.scope)).toBe(false);
  expect(isExcludable('docs/note.md', result.scope)).toBe(false);
  expect(isExcludable('tests/thing.spec.mjs', result.scope)).toBe(true);
  expect(isExcludable('data.bin', result.scope)).toBe(false);
  expect(isExcludable('unnamed.json', result.scope)).toBe(false);
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

it.each([
  'import /* load selected worker */ (process.env.TARGET)',
  'import // load selected worker\n (process.env.TARGET)',
  'import /* first */ /* second */ (process.env.TARGET)',
  'import // worker\u2028 (process.env.TARGET)',
  'import // worker\u2029 (process.env.TARGET)',
  'import\r\n(process.env.TARGET)',
  'import( /* load selected worker */ process.env.TARGET)',
  'import(\n process.env.TARGET\n)',
  'import("./" + process.env.TARGET)',
  'import(`./${process.env.TARGET}`)',
])('fails closed on unresolved dynamic import syntax: %s', expression => {
  expect(compute({ 'entry.mjs': `export async function tick(){ return ${expression}; }`,
    'worker.mjs': 'export function runOverlay() {}' }))
    .toMatchObject({ ok: false, reason: 'closure-incomplete' });
});

it.each(["'./prompt.md'", '"./prompt.md"', '`./prompt.md`'])('retains runtime Markdown read via URL literal %s', literal => {
  const result = compute({ 'entry.mjs': `import { readFileSync } from 'node:fs';
    export function tick(){return readFileSync(new URL(${literal}, import.meta.url), 'utf8');}`,
    'prompt.md': 'overlay prompt', 'docs/unrelated.md': 'unrelated' });
  expect(result.ok).toBe(true);
  expect(isExcludable('prompt.md', result.scope)).toBe(false);
});

it('retains Markdown even when runtime paths are computed or hidden in test/backlog directories', () => {
  const result = compute({ 'entry.mjs': "export function tick(){ return readFileSync(process.env.PROMPT, 'utf8'); }" });
  expect(result.ok).toBe(true);
  for (const path of ['prompt.md', 'docs/Prompt.MD', 'tests/prompt.md', 'backlog/prompt.md']) {
    expect(isExcludable(path, result.scope), path).toBe(false);
  }
});

it('retains JSON read through computed runtime paths, including test and backlog data', () => {
  const result = compute({ 'entry.mjs': 'export function tick(dir, name){ return readFileSync(`${dir}/${name}.json`, "utf8"); }',
    'data/foo.json': '{"value":"overlay"}' });
  expect(result.ok).toBe(true);
  for (const path of ['data/foo.json', 'data/FOO.JSON', 'tests/fixture.json', 'backlog/state.json']) {
    expect(isExcludable(path, result.scope), path).toBe(false);
  }
});

it.each([
  "import /* worker */ ('./worker.mjs')",
  "import( /* worker */ './worker.mjs')",
  'import(`./worker.mjs`)',
  "import('./work\\u0065r.mjs')",
])('walks literal dynamic imports without losing their dependencies: %s', expression => {
  const result = compute({ 'entry.mjs': `export const tick = () => ${expression};`,
    'worker.mjs': 'export function runOverlay() {}' });
  expect(result.ok).toBe(true);
  expect(isExcludable('worker.mjs', result.scope)).toBe(false);
});

it('ignores import-like prose in comments, strings and regular expressions', () => {
  const result = compute({ 'entry.mjs': `// import(target)
    /* import /* selected worker */
    const text = 'import /* selected worker */ (target)';
    const pattern = /import\\s*\\(target\\)/;
    export {};` });
  expect(result.ok).toBe(true);
});

it('fails closed when import syntax cannot be parsed', () => {
  expect(compute({ 'entry.mjs': 'export const tick = () => import /* worker */ (' }))
    .toMatchObject({ ok: false, reason: 'closure-incomplete' });
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
