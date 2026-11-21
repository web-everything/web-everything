import { afterEach, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { readFileSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import * as advisory from '../daemon-rebuild/advisory-merge.mjs';
import { fixture, snapshot, DOC, CLOSURE } from './fixtures/generated-merge.mjs';

const fixtures = [];
const setup = opts => { const f = fixture(opts); fixtures.push(f); return f; };
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const f of fixtures.splice(0)) f.cleanup(); });

it('resolveAdvisoryConflicts regenerates docs/agent/settings-registry.md when both sides add a setting', () => {
  const f = setup(), before = snapshot(f);
  const result = advisory.resolveAdvisoryConflicts(f);
  expect(result).toMatchObject({ ok: true, via: 'advisory-merge' });
  expect(snapshot(f)).toEqual(before);
  f.ok(['read-tree', '--reset', '-u', result.tree]);
  const actual = readFileSync(join(f.root, DOC), 'utf8');
  f.generate('--write');
  expect(actual).toBe(readFileSync(join(f.root, DOC), 'utf8'));
  expect(actual).toContain('"a":1');
  expect(actual).toContain('"b":1');
  f.generate('--check');
});

it('worktree variant resolves a real doc-only merge and commits', () => {
  const f = setup();
  expect(f.git(['merge', '--no-edit', 'theirs']).status).toBe(1);
  expect(f.ok(['diff', '--name-only', '--diff-filter=U'])).toBe(DOC);
  expect(advisory.resolveAdvisoryInWorktree({ git: f.git, cwd: f.root })).toBe(true);
  expect(f.ok(['rev-parse', 'HEAD'])).not.toBe(f.cur);
  expect(f.ok(['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ')).toHaveLength(3);
  expect(f.ok(['diff', '--name-only', '--diff-filter=U'])).toBe('');
  f.generate('--check');
});

const negatives = [
  ['N1 input JSON conflicted', { conflict: 'scripts/settings/seed.json' }],
  ['N2 closure module conflicted', { conflict: CLOSURE[1] }],
  ['N3 bad metadata', {}, f => f.json('scripts/lib/settings-registry-metadata.json', {})],
  ['N4 generator hangs and is killed', {}, f => f.write(CLOSURE[0], 'setInterval(() => {}, 1000);')],
  ['N5 source conflict', { conflict: 'source.txt' }],
  ['N6 check disagrees', {}, f => f.write(CLOSURE[0], `import {writeFileSync} from 'node:fs';
if(process.argv.includes('--write')) writeFileSync('${DOC}', 'unchecked'); else process.exitCode=1;`)],
  ['N7 symlink input', {}, f => { rmSync(join(f.root, 'scripts/settings/seed.json')); symlinkSync('../dispatch-settings.json', join(f.root, 'scripts/settings/seed.json')); }],
  // Exit 23 = a GIT_* value leaked into the generator; 24 = clean env, then refuse anyway.
  ['N8 GIT_DIR and GIT_CONFIG do not leak', {}, f => f.write(CLOSURE[0],
    'process.exit(Object.keys(process.env).some(key => key.startsWith("GIT_")) ? 23 : 24);')],
  ['oversized generator output refuses with manual-resolution fallback', {}, f => f.write(CLOSURE[0], `process.stdout.write('x'.repeat(2 * 1024 * 1024));`)],
  ['missing closure refuses', {}, f => rmSync(join(f.root, CLOSURE[2]))],
  ['missing input refuses', {}, f => rmSync(join(f.root, 'scripts/lib/delivery-priority-settings.json'))],
  ['symlink closure refuses', {}, f => { rmSync(join(f.root, CLOSURE[2])); symlinkSync('settings-files.mjs', join(f.root, CLOSURE[2])); }],
];
for (const [name, options, mutate] of negatives) it(`${name}: both resolvers refuse without changing index or worktree`, () => {
  const f = setup(options);
  if (mutate) { mutate(f); f.cur = f.commit(name); }
  // Native ESM subprocesses exercise the actual builtin bindings, independently of Vitest's module cache.
  const probe = worktree => {
    const code = `
      import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      const actual = cp.spawnSync, calls = [];
      cp.spawnSync = (file, args, opts) => {
        if (file !== process.execPath || !args[0]?.endsWith('/scripts/lib/settings-registry.mjs')) return actual(file, args, opts);
        const result = actual(file, args, { ...opts, timeout: ${name.startsWith('N4') ? 100 : 30000} });
        calls.push({ args, opts, result: { status: result.status, signal: result.signal, error: { code: result.error?.code } } });
        return result;
      };
      syncBuiltinESMExports();
      const advisory = await import(${JSON.stringify(pathToFileURL(resolve('scripts/lib/daemon-rebuild/advisory-merge.mjs')).href)});
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
      Object.assign(env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
      const git = (args, opts = {}) => actual('git', args, { cwd: ${JSON.stringify(f.root)}, encoding: 'utf8',
        timeout: 10000, maxBuffer: 8 * 1024 * 1024, ...opts, env: { ...env, ...opts.env } });
      const result = ${worktree
        ? `advisory.resolveAdvisoryInWorktree({ git, cwd: ${JSON.stringify(f.root)} })`
        : `advisory.resolveAdvisoryConflicts({ git, cur: '${f.cur}', ovSha: '${f.ovSha}' })`};
      console.log(JSON.stringify({ result, calls }));`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_DIR: '/untrusted/repo', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'alias.bad',
        GIT_CONFIG_VALUE_0: 'bad', NODE_OPTIONS: '--no-warnings' },
    });
    expect(child.status, child.stderr).toBe(0);
    return JSON.parse(child.stdout);
  };
  const before = snapshot(f);
  const treeProbe = probe(false);
  expect(treeProbe.result).toBeNull();
  expect(snapshot(f)).toEqual(before);
  expect(f.git(['merge', '--no-edit', 'theirs']).status).toBe(1);
  const stopped = snapshot(f);
  const worktreeProbe = probe(true);
  expect(worktreeProbe.result).toBe(false);
  expect(snapshot(f)).toEqual(stopped);
  const generatorCalls = [...treeProbe.calls, ...worktreeProbe.calls];
  if (/^N[3468]|^oversized/.test(name)) expect(generatorCalls.length).toBeGreaterThan(0);
  for (const { args, opts, result } of generatorCalls) {
    expect(opts.timeout).toBe(30000);
    expect(opts.killSignal).toBe('SIGKILL');
    expect(Object.keys(opts.env).sort()).toEqual(['HOME', 'PATH', 'TMPDIR'].filter(key => process.env[key] !== undefined).sort());
    expect(opts.cwd).toBe(dirname(dirname(dirname(args[0]))));
    expect(opts.maxBuffer).toBe(1024 * 1024);
    if (name.startsWith('N4')) { expect(result.error?.code).toBe('ETIMEDOUT'); expect(result.signal).toBe('SIGKILL'); }
    if (name.startsWith('N8')) expect(result.status).toBe(24);
    if (name.startsWith('oversized')) expect(result.error?.code).toBe('ENOBUFS');
  }
});

it('closure drift guard follows every static local import and permits only node builtins', () => {
  const seen = new Set();
  const visit = path => {
    if (seen.has(path)) return;
    seen.add(path);
    const text = readFileSync(path, 'utf8');
    for (const match of text.matchAll(/(?:import|export)\s+(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]/g)) {
      if (match[1].startsWith('node:')) continue;
      expect(match[1]).toMatch(/^\./);
      visit(posix.normalize(posix.join(posix.dirname(path), match[1])));
    }
  };
  visit(CLOSURE[0]);
  expect([...seen].sort()).toEqual([...advisory.GENERATED_MERGE_PATHS[DOC].closure].sort());
  expect(advisory.GENERATED_MERGE_PATHS[DOC]).toEqual({ closure: CLOSURE,
    inputs: ['scripts/settings/', 'scripts/dispatch-settings.json', 'scripts/lib/settings-registry-metadata.json',
      'scripts/lib/delivery-platform-preferences.json', 'scripts/lib/delivery-priority-settings.json'], argv: ['--write'] });
  expect(Object.isFrozen(advisory.GENERATED_MERGE_PATHS)).toBe(true);
});
