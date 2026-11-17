import { describe, it, expect } from 'vitest';
import { canonicalAcquireArgs } from '../lane-acquire-origin.mjs';

describe('canonicalAcquireArgs — origin anchor for internal lane-pool acquire calls', () => {
  it('passes the env canonical origin when set', () => {
    expect(canonicalAcquireArgs({ repoRoot: '/ws/.lanes/web-everything/lane-3', env: { LANE_POOL_CANONICAL_ORIGIN: ' git@github.com:o/r.git ' } }))
      .toEqual(['--origin=git@github.com:o/r.git']);
  });
  it('from inside a lane, passes --reference=<primary> found by pool name', () => {
    const findPrimary = ({ workspaceDir, poolName }) => (workspaceDir === '/ws' && poolName === 'web-everything' ? { path: '/ws/webeverything', origin: 'x' } : null);
    expect(canonicalAcquireArgs({ repoRoot: '/ws/.lanes/web-everything/lane-3', env: {}, findPrimary }))
      .toEqual(['--reference=/ws/webeverything']);
  });
  it('from a primary checkout adds nothing', () => {
    expect(canonicalAcquireArgs({ repoRoot: '/ws/webeverything', env: {}, findPrimary: () => { throw new Error('unused'); } })).toEqual([]);
  });
  it('inside a lane with no primary found adds nothing (lane-pool then reports its own refusal)', () => {
    expect(canonicalAcquireArgs({ repoRoot: '/ws/.lanes/web-everything/lane-3', env: {}, findPrimary: () => null })).toEqual([]);
  });
});
