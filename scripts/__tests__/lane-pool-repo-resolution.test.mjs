/** Repository resolution must not spend a git spawn discovering an explicitly supplied branch. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

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
    resolve, basename, join,
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
