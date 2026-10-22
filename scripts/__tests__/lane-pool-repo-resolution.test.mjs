/** Repository resolution must not spend a git spawn discovering an explicitly supplied branch. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { runInNewContext } from 'node:vm';
import { laneGitHardeningEnv } from '../lib/lane-git-hardening.mjs';

// Exercise the actual resolver without running the pool CLI or mutating git state.
const source = readFileSync(resolve(process.cwd(), 'scripts/lane-pool.mjs'), 'utf8');
const start = source.indexOf('function resolveRepo()');
const resolver = source.slice(start, source.indexOf('\n}', start) + 2);

function resolveWith(branch, remoteHead) {
  const calls = [];
  const repo = runInNewContext(`${resolver}\nresolveRepo();`, {
    flags: { reference: '/reference', origin: '/origin.git', branch },
    cmd: 'acquire',
    process: { cwd: () => '/checkout' },
    CWD_TOP_LEVEL: '/checkout', CHECKOUT_ROOT: '/checkout', POOL_ROOT: '/pool',
    LOCAL_GIT_TIMEOUT_MS: 1000,
    expandHome: (path) => path,
    resolve, basename, join, sep, resolveReal: resolve, laneGitHardeningEnv,
    fail: (message) => { throw new Error(message); },
    tryGit: (args) => {
      calls.push(args);
      if (args[0] === 'rev-parse') return '/reference';
      if (args[0] === 'symbolic-ref') return remoteHead;
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    },
  });
  return { repo, calls };
}

describe('lane-pool repository branch resolution', () => {
  it('uses an explicit branch without probing origin/HEAD', () => {
    const { repo, calls } = resolveWith('trunk', 'origin/main');
    expect(repo.branch).toBe('trunk');
    expect(calls.map((args) => args[0])).toEqual(['rev-parse']);
  });

  it.each([
    ['origin/trunk', 'trunk'],
    ['origin/release/stable', 'release/stable'],
    [null, 'main'],
  ])('infers %s as %s when no branch is supplied', (remoteHead, expected) => {
    const { repo, calls } = resolveWith(undefined, remoteHead);
    expect(repo.branch).toBe(expected);
    expect(calls).toContainEqual(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  });
});

// Keep this proof read-only: exercise the production resolver with a lane origin that
// would advertise unique work, without starting the pool CLI or writing Git metadata.
function resolveOrigin({ command = 'reclaim', cwd = '/pool/project/lane-1', flags = {},
  realPaths = {}, topLevel = null, env = {}, remote = 'https://attacker.example/project.git' } = {}) {
  const calls = [];
  const run = () => runInNewContext(`${resolver}\nresolveRepo();`, {
    flags: { branch: 'main', ...flags }, cmd: command,
    process: { cwd: () => cwd, env }, CWD_TOP_LEVEL: cwd, CHECKOUT_ROOT: cwd, POOL_ROOT: '/pool',
    LOCAL_GIT_TIMEOUT_MS: 1000, expandHome: p => p,
    resolve, basename, join, sep, resolveReal: p => realPaths[p] || resolve(p), laneGitHardeningEnv,
    fail: message => { throw new Error(message); },
    tryGit: (args, dir, options) => {
      calls.push({ args, dir, options });
      const effectiveEnv = options.env || env;
      if (args[0] === 'rev-parse') return effectiveEnv.GIT_WORK_TREE || topLevel || dir;
      if (args[0] === 'remote') return effectiveEnv.GIT_DIR ? 'https://attacker.example/project.git' : remote;
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    },
  });
  return { run, calls };
}

describe('canonical origin cannot be inferred from a lane', () => {
  const variants = [
    ['cwd', {}],
    ['cwd subdirectory', { cwd: '/pool/project/lane-1/scripts' }],
    ['explicit repo', { cwd: '/primary', flags: { repo: '/pool/project/lane-1' } }],
    ['explicit reference', { cwd: '/primary', flags: { reference: '/pool/project/lane-1' } }],
    ['other selected pool', { flags: { pool: 'other' } }],
    ['symlinked checkout', { cwd: '/alias', realPaths: { '/alias': '/pool/project/lane-1' } }],
    ['symlinked pool root', { cwd: '/actual/project/lane-1', realPaths: { '/pool': '/actual' } }],
    ['symlink out of pool', { realPaths: { '/pool/project/lane-1': '/elsewhere/checkout' } }],
    ['Git redirects the work tree', { topLevel: '/elsewhere/checkout' }],
    ['renamed checkout under pool root', { cwd: '/pool/project/checkout' }],
    ['another pool root', { cwd: '/other-pool/project/lane-2' }],
  ];
  for (const command of ['acquire', 'provision', 'refresh', 'remove', 'trim', 'reclaim', 'list']) {
    it.each(variants)(`${command} refuses an implicit lane origin via %s`, (_label, options) => {
      const { run, calls } = resolveOrigin({ ...options, command,
        flags: { ...options.flags, ...(command === 'list' ? { acquirable: true } : {}), 'dry-run': true } });
      expect(run).toThrow(/canonical origin.*--origin=/);
      expect(calls.some(({ args }) => args[0] === 'remote')).toBe(false);
    });
  }

  it('accepts an explicitly supplied canonical URL from a lane without reading its remote', () => {
    const { run, calls } = resolveOrigin({ flags: { origin: 'https://canonical.example/project.git' } });
    expect(run().originUrl).toBe('https://canonical.example/project.git');
    expect(calls.some(({ args }) => args[0] === 'remote')).toBe(false);
  });

  it('accepts a primary reference explicitly supplied from a lane', () => {
    const { run, calls } = resolveOrigin({ flags: { reference: '/primary' }, remote: '/canonical/project.git' });
    expect(run().originUrl).toBe('/canonical/project.git');
    expect(calls.find(({ args }) => args[0] === 'remote').dir).toBe('/primary');
  });

  it('retains origin inference outside lanes', () => {
    const { run } = resolveOrigin({ cwd: '/pool-neighbor/project', remote: '/canonical/project.git' });
    expect(run().originUrl).toBe('/canonical/project.git');
  });

  it('a primary reference wins over inherited lane repository context', () => {
    const env = { GIT_DIR: '/pool/project/lane-1/.git', GIT_COMMON_DIR: '/pool/project/lane-1/.git',
      GIT_WORK_TREE: '/primary', GIT_INDEX_FILE: '/pool/project/lane-1/.git/index',
      GIT_OBJECT_DIRECTORY: '/pool/project/lane-1/.git/objects', GIT_ALTERNATE_OBJECT_DIRECTORIES: '/lane/objects',
      GIT_CONFIG: '/pool/project/lane-1/.git/config', GIT_CONFIG_PARAMETERS: "'core.worktree=/primary'" };
    const { run, calls } = resolveOrigin({ flags: { reference: '/primary' }, env, remote: '/canonical/project.git' });
    expect(run().originUrl).toBe('/canonical/project.git');
    for (const { options } of calls) {
      for (const key of Object.keys(env)) expect(options.env[key]).toBeUndefined();
      expect(options.env.GIT_OPTIONAL_LOCKS).toBe('0');
    }
  });

  it.each(['status', 'list', 'path', 'release', 'keep', 'map', 'unmap', 'gc'])(
    'keeps metadata-only %s usable from a lane without an origin', command => {
      expect(resolveOrigin({ command, flags: { pool: 'project' }, remote: null }).run())
        .toMatchObject({ originUrl: null, poolDir: '/pool/project' });
    },
  );
});
