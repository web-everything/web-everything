import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { DAEMON_CLONE_SEED, daemonCloneRoots, isDaemonCloneRealpath } from '../daemon-clone-registry.mjs';
import * as registry from '../daemon-clone-registry.mjs';

const WORKSPACE = path.join(path.sep, 'ws');

describe('daemonCloneForLabel', () => {
  const helperLabels = [
    'com.we.conveyor-pass-daemon.advisory-label-sweep-we',
    'com.we.conveyor-pass-daemon.ci-red-recovery-watch-we',
    'com.we.conveyor-pass-daemon.load-flake-reverify',
    'com.we.conveyor-pass-daemon.pr-merge-watch',
    'com.we.lane-pool-health-watch-we',
    'com.we.lane-pool-health-watch-frontierui',
    'com.we.lane-pool-health-watch-plateau-app',
    'com.we.parked-pr-conflict-watch-we',
    'com.we.parked-pr-conflict-watch-frontierui',
    'com.we.parked-pr-conflict-watch-plateau-app',
    'com.we.lease-reaper',
  ];

  it.each(helperLabels)('maps helper %s to wev-pass-readers', (label) => {
    expect(registry.daemonCloneForLabel).toBeTypeOf('function');
    expect(registry.daemonCloneForLabel(label)).toBe('wev-pass-readers');
  });

  it('exports the pure label map used by the resolver', () => {
    expect(registry.DAEMON_CLONE_BY_LABEL).toEqual(expect.objectContaining(Object.fromEntries([
      ...helperLabels.map((label) => [label, 'wev-pass-readers']),
      ['com.we.conveyor-pass-daemon.merge-orphan-sweep', 'wev-merge-daemon'],
      ['com.we.review-daemon', 'wev-review-daemon'],
    ])));
  });

  it.each([
    ['com.we.conveyor-pass-daemon.merge-orphan-sweep', 'wev-merge-daemon'],
    ['com.we.review-daemon', 'wev-review-daemon'],
  ])('keeps %s on its dedicated clone', (label, clone) => {
    expect(registry.daemonCloneForLabel).toBeTypeOf('function');
    expect(registry.daemonCloneForLabel(label)).toBe(clone);
  });

  it.each(['com.we.unknown-daemon', 'com.we.conveyor-pass-daemon.unknown', '', 'toString', '__proto__'])('returns null for unknown label %j', (label) => {
    expect(registry.daemonCloneForLabel).toBeTypeOf('function');
    expect(registry.daemonCloneForLabel(label)).toBeNull();
  });
});

describe('wev-pass-readers daemon clone', () => {
  it('is in the seed, named by basename like the other daemon clones', () => {
    expect(DAEMON_CLONE_SEED).toContain('wev-pass-readers');
  });
  it('is recognized as a daemon clone root', () => {
    const roots = daemonCloneRoots(WORKSPACE, { env: { WE_DAEMON_OVERLAY_DIR: path.join(path.sep, 'nonexistent-overlay-dir') } });
    const real = path.join(WORKSPACE, 'wev-pass-readers');
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
