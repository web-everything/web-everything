/**
 * @file scripts/lib/__tests__/daemon-rebuild-settings.test.mjs
 * @description Card 310 — health-watch self-sync opts into detached rebuild jobs.
 */
import { describe, it, expect } from 'vitest';

import { loadRebuildAsJobSettings } from '../daemon-rebuild/rebuild-job.mjs';
import { resolveSelfSyncRebuildAsJob } from '../daemon-self-sync.mjs';

describe('shipped detached rebuild settings', () => {
  it('lists the health-watch pass daemon', () => {
    expect(loadRebuildAsJobSettings().entries).toContain('pass-daemon.mjs');
  });

  it('resolves health-watch self-sync to a detached rebuild by entry basename', () => {
    expect(resolveSelfSyncRebuildAsJob({
      entries: ['/any/clone/skills-src/conveyor/pass-daemon.mjs'], env: {},
    })).toBe(true);
  });

  it('allows health-watch to opt back into inline rebuilds', () => {
    expect(resolveSelfSyncRebuildAsJob({
      entries: ['/any/clone/skills-src/conveyor/pass-daemon.mjs'],
      env: { WE_DAEMON_REBUILD_AS_JOB: '0' },
    })).toBe(false);
  });

  it.each([
    'merge-ai-prs.mjs',
    'review-daemon.mjs',
    'build-dispatch-daemon.mjs',
    'reconcile-fix-dispatch-daemon.mjs',
  ])('keeps %s opted into detached rebuilds', (entry) => {
    expect(loadRebuildAsJobSettings().entries).toContain(entry);
  });
});
