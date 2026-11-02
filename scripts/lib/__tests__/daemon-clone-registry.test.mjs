import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { DAEMON_CLONE_SEED, daemonCloneRoots, isDaemonCloneRealpath } from '../daemon-clone-registry.mjs';

const WORKSPACE = path.join(path.sep, 'ws', 'webeverything');

describe('wev-pass-readers daemon clone', () => {
  it('is in the seed, named by basename like the other daemon clones', () => {
    expect(DAEMON_CLONE_SEED).toContain('wev-pass-readers');
  });
  it('is recognized as a daemon clone root', () => {
    const roots = daemonCloneRoots(WORKSPACE, { env: { WE_DAEMON_OVERLAY_DIR: path.join(path.sep, 'nonexistent-overlay-dir') } });
    const real = path.join(path.dirname(WORKSPACE), 'wev-pass-readers');
    expect(isDaemonCloneRealpath(real, roots)).toBe(true);
    expect(isDaemonCloneRealpath(path.join(real, 'scripts'), roots)).toBe(true);
  });
  it('leaves the existing seed entries unchanged', () => {
    for (const name of ['wev-review-daemon', 'wev-fix-daemon', 'wev-merge-daemon', 'wev-health-watch', 'wev-health-responder', 'wev-host-sampler', 'plateau-drain-daemon']) {
      expect(DAEMON_CLONE_SEED).toContain(name);
    }
    expect(DAEMON_CLONE_SEED).toContain(path.join('.lanes', 'we-drain-daemon', 'lane-1'));
    expect(DAEMON_CLONE_SEED).toContain(path.join('.lanes', 'we-drain-daemon', 'code'));
  });
});
