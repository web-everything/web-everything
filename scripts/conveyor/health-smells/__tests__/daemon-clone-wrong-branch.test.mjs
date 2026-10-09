import { describe, it, expect } from 'vitest';
import smell from '../daemon-clone-wrong-branch.mjs';
import { probeDaemonCloneBranches } from '../../../lib/daemon-clone-branch-probe.mjs';

describe('daemon-clone-wrong-branch', () => {
  it('is high severity and opens one episode per clone on an ops/* branch (2026-10-09 replay)', () => {
    expect(smell.severity).toBe('high');
    const [out] = smell.evaluate({ daemonCloneBranches: [{ cloneRoot: '/ws/wev-review-daemon', branch: 'ops/review-requests' }] });
    expect(out).toMatchObject({ subject: '/ws/wev-review-daemon', breach: true, measure: { branch: 'ops/review-requests' } });
    expect(out.recommendation).toContain('daemon-rebuild.mjs --clone=/ws/wev-review-daemon');
  });
  it('is quiet with no flagged clones', () => {
    expect(smell.evaluate({ daemonCloneBranches: [] })).toEqual([]);
    expect(smell.evaluate({})).toEqual([]);
  });
  it('probe flags only ops/* branches; main, lane branches, detached and unreadable clones are skipped', () => {
    const heads = { '/a': 'main\n', '/b': 'ops/review-requests\n', '/c': 'lane/mechanical-dispatcher\n', '/d': '' };
    const exec = (args) => { const r = args[1]; if (r === '/e') throw new Error('gone'); return heads[r]; };
    expect(probeDaemonCloneBranches({ roots: ['/a', '/b', '/c', '/d', '/e'], exec })).toEqual([{ cloneRoot: '/b', branch: 'ops/review-requests' }]);
  });
});
