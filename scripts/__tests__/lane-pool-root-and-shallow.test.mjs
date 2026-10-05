/**
 * #3265 — the two defects that between them left a cloud VM with NO writable surface at all: the primary is
 * denied by `guard-lane.mjs` (committed hook) and no lane could be provisioned to work in instead.
 *
 * Both are about a path being ASSUMED rather than derived, so both are pinned here as pure functions.
 */
import { describe, it, expect } from 'vitest';
import { join, sep } from 'node:path';
import { workspaceFor, defaultPoolRoot, referenceArgs } from '../lib/lane-pool-paths.mjs';

describe('referenceArgs — a shallow reference is FATAL, not a lost optimisation', () => {
  it('omits --reference when the reference repo is shallow', () => {
    // `git clone --reference <shallow>` exits 128 with `fatal: reference repository '<path>' is shallow`.
    // Every cloud checkout arrives --depth 1, so passing the flag meant NO lane could ever clone.
    expect(referenceArgs('/home/user/web-everything', true)).toEqual([]);
  });

  it('keeps --reference when the reference repo is full', () => {
    expect(referenceArgs('/ws/webeverything', false)).toEqual(['--reference', '/ws/webeverything']);
  });

  it('keeps --reference when the probe could not answer', () => {
    // null = `git rev-parse` failed. Unknown must NOT read as shallow, or one failed probe silently
    // drops object sharing on every clone thereafter.
    expect(referenceArgs('/ws/webeverything', null)).toEqual(['--reference', '/ws/webeverything']);
    expect(referenceArgs('/ws/webeverything', undefined)).toEqual(['--reference', '/ws/webeverything']);
  });

  it('treats only a strict `true` as shallow, never a truthy string', () => {
    // Guards the seam: the probe returns a STRING from git; a caller passing it raw must not
    // accidentally read 'false' (truthy!) as shallow.
    expect(referenceArgs('/ws/x', 'false')).toEqual(['--reference', '/ws/x']);
    expect(referenceArgs('/ws/x', 'true')).toEqual(['--reference', '/ws/x']);
  });
});

describe('workspaceFor — where the siblings and the pool actually sit', () => {
  it.each([
    [['ws', '.operations', 'dispatch', 'abc-123'], ['ws']],
    [['ws', '.operations'], ['ws']],
    [['ws', '.lanes', 'web-everything', 'lane-5'], ['ws']],
    [['ws', 'webeverything'], ['ws']],
    [['opt', 'somewhere', 'project'], ['opt', 'somewhere']],
    [['ws', 'my.operations-x', 'repo'], ['ws', 'my.operations-x']],
    [['ws', '.operations', 'dispatch', '.lanes', 'we', 'lane-5'], ['ws']],
    [['ws', '.lanes', 'we', 'lane-5', '.operations', 'dispatch'], ['ws']],
    [['ws', '.operations', 'dispatch', '.operations'], ['ws']],
  ])('uses the outermost marker for %j (coroner #32)', (input, expected) => {
    expect(workspaceFor(join(sep, ...input))).toBe(join(sep, ...expected));
  });

  it('is the parent of a primary checkout', () => {
    expect(workspaceFor('/home/user/web-everything')).toBe('/home/user');
    expect(workspaceFor('/Users/nic/workspace/webeverything')).toBe('/Users/nic/workspace');
  });

  it('resolves a LANE to the workspace above `.lanes`, not to the lane pool directory', () => {
    // The load-bearing case: a caller standing in a lane must find the SAME pool as one in the primary.
    expect(workspaceFor('/home/user/.lanes/web-everything/lane-1')).toBe('/home/user');
  });

  it('resolves a subdirectory of a lane the same way', () => {
    expect(workspaceFor('/home/user/.lanes/web-everything/lane-9/scripts')).toBe('/home/user');
  });

  it('takes the OUTERMOST .lanes, so a nested pool cannot re-root the answer', () => {
    expect(workspaceFor(`/ws/.lanes/we/lane-1/.lanes/x/lane-2`)).toBe('/ws');
  });
});

describe('defaultPoolRoot — derived from the checkout, never from $HOME', () => {
  it('resolves dispatch cwd beside the workspace and preserves the override (coroner #32)', () => {
    const cwd = join(sep, 'ws', '.operations', 'dispatch', 'abc-123');
    const env = { HOME: join(sep, 'home', 'x') };
    expect(defaultPoolRoot(cwd, env)).toBe(join(sep, 'ws', '.lanes'));
    expect(defaultPoolRoot(cwd, { ...env, LANE_POOL_ROOT: join(sep, 'custom', '.lanes') }))
      .toBe(join(sep, 'custom', '.lanes'));
  });

  it('puts the pool beside the checkout when $HOME disagrees (the cloud VM)', () => {
    // $HOME=/root, checkouts under /home/user — the exact split that resolved to a phantom
    // /root/workspace/.lanes and made provisioning impossible.
    expect(defaultPoolRoot('/home/user/web-everything', { HOME: '/root' })).toBe('/home/user/.lanes');
  });

  it('is unchanged on a laptop, where $HOME and the checkouts agree', () => {
    expect(defaultPoolRoot('/Users/nic/workspace/webeverything', { HOME: '/Users/nic' }))
      .toBe(join('/Users/nic/workspace', '.lanes'));
  });

  it('resolves the same pool from inside a lane as from the primary', () => {
    const env = { HOME: '/root' };
    expect(defaultPoolRoot('/home/user/.lanes/web-everything/lane-1', env))
      .toBe(defaultPoolRoot('/home/user/web-everything', env));
  });

  it('LANE_POOL_ROOT still wins, and still expands ~', () => {
    expect(defaultPoolRoot('/home/user/web-everything', { LANE_POOL_ROOT: '/custom/.lanes' }))
      .toBe('/custom/.lanes');
    expect(defaultPoolRoot('/anywhere', { HOME: '/root', LANE_POOL_ROOT: '~/pool' }))
      .toBe(join('/root', 'pool'));
  });

  it('never returns a path under $HOME merely because $HOME exists', () => {
    expect(defaultPoolRoot('/srv/checkouts/web-everything', { HOME: '/root' }).startsWith('/root')).toBe(false);
  });

  it('never puts the pool INSIDE the checkout — the contract is a checkout ROOT', () => {
    // The round-2 regression: handed `<checkout>/scripts` this returned `<checkout>/.lanes`, i.e. a pool
    // nested in the very repo it is meant to sit beside. The CALLER resolves the root (`rev-parse
    // --show-toplevel`); a pure function cannot tell a root from a subdirectory. This pins the contract:
    // given the root, the pool is always a SIBLING of the checkout.
    const root = '/home/user/web-everything';
    expect(defaultPoolRoot(root, { HOME: '/root' })).toBe('/home/user/.lanes');
    expect(defaultPoolRoot(root, { HOME: '/root' }).startsWith(`${root}/`)).toBe(false);
  });

  it('resolves a lane from ANY depth without normalising — .lanes is the anchor', () => {
    const env = { HOME: '/root' };
    for (const p of [
      '/home/user/.lanes/web-everything/lane-1',
      '/home/user/.lanes/web-everything/lane-1/scripts',
      '/home/user/.lanes/web-everything/lane-1/scripts/__tests__',
    ]) expect(defaultPoolRoot(p, env)).toBe('/home/user/.lanes');
  });
});
