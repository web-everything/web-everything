/**
 * @file scripts/operations/__tests__/heavy-queue-io.test.mjs
 * @description Card xb0iuxq — `heavy-queue-io.mjs` proof, split the same way `daemon-status-io.test.mjs` /
 *   `daemon-status-io-real.test.mjs` are: injected-fakes shape proof here (no real ps/git — every seam
 *   overridden), a REAL fidelity check in `heavy-queue-io-real.test.mjs` (real ps of this test's own pid, real
 *   git ancestry against this actual checkout).
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tryAcquireSlot, markWaiting, admissionStatus } from '../../readiness/heavy-admission.mjs';
import { collectHeavyQueue, repoFromOwner } from '../heavy-queue-io.mjs';
import { assessHeavyQueue } from '../heavy-queue.mjs';

describe('repoFromOwner — strips the `run` wrapper\'s `<repo>#<pid>` suffix', () => {
  it('strips a trailing #<pid>', () => expect(repoFromOwner('/a/b/lane-3#12345')).toBe('/a/b/lane-3'));
  it('leaves a bare repo path (verify-lane.mjs\'s own direct-acquire owner) untouched', () => expect(repoFromOwner('/a/b/lane-3')).toBe('/a/b/lane-3'));
  it('is total over a null/undefined owner', () => expect(repoFromOwner(null)).toBe(''));
});

describe('collectHeavyQueue — the real admissionStatus() export, everything else injected', () => {
  it('joins held + waiting rows with injected command/lease/ancestry reads', () => {
    const T0 = Date.parse('2026-09-25T12:00:00.000Z');
    const commands = { 111: 'node scripts/verify-lane.mjs run --repo=.', 222: 'npm run check:standards' };
    const leases = { '/lanes/lane-21': { purpose: 'conveyor-fix', session: 'fix-2668' }, '/lanes/lane-13': null };
    const ancestryCalls = [];

    const read = collectHeavyQueue({
      readBaseline: null, // card xkyw1x4 — no host queue read in a unit test
      repo: '/whatever', env: {}, now: () => T0 + 120_000,
      readAdmission: ({ cap }) => ({
        cap, heldCount: 1, freeCount: cap - 1, staleWaiting: 0,
        held: [{ owner: '/lanes/lane-21#111', pid: 111, heartbeatAt: new Date(T0).toISOString(), meta: null }],
        waiting: [{ owner: '/lanes/lane-13', repo: '/lanes/lane-13', pid: 222, lane: '13', requestedAt: new Date(T0 + 60_000).toISOString() }],
      }),
      readCommand: (pid) => commands[pid] ?? null,
      isAncestor: (repo, sha) => { ancestryCalls.push([repo, sha]); return repo === '/lanes/lane-21'; },
      readLease: (repo) => leases[repo] ?? null,
    });

    expect(read.heldCount).toBe(1);
    expect(read.held).toHaveLength(1);
    expect(read.held[0]).toMatchObject({
      repo: '/lanes/lane-21', lane: '21', command: commands[111], isSelectedBase: true,
      lease: { purpose: 'conveyor-fix' },
    });
    expect(read.waiting).toHaveLength(1);
    expect(read.waiting[0]).toMatchObject({
      repo: '/lanes/lane-13', lane: '13', command: commands[222], isSelectedBase: false, lease: null,
    });
    // Ancestry is memoized per repo — even with more rows sharing a repo it would still be one call each.
    expect(ancestryCalls).toEqual([['/lanes/lane-21', '14a3d0dff'], ['/lanes/lane-13', '14a3d0dff']]);
  });

  it('a gone pid / unreadable command degrades to null rather than throwing', () => {
    const read = collectHeavyQueue({
      readBaseline: null, // card xkyw1x4 — no host queue read in a unit test
      repo: '/whatever', env: {}, now: () => Date.now(),
      readAdmission: () => ({
        cap: 1, heldCount: 1, freeCount: 0, staleWaiting: 0,
        held: [{ owner: '/lanes/lane-9#999', pid: 999, heartbeatAt: new Date().toISOString() }],
        waiting: [],
      }),
      readCommand: () => null, // simulates a vanished pid
      isAncestor: () => false,
      readLease: () => null,
    });
    expect(read.held[0].command).toBeNull();
  });

  it('tags each waiting row live/not-live with the ranking rule, and the envelope skips dead ones', () => {
    const T0 = Date.parse('2026-09-25T12:00:00.000Z');
    const read = collectHeavyQueue({
      readBaseline: null, // card xkyw1x4 — no host queue read in a unit test
      repo: '/whatever', env: {}, now: () => T0,
      readAdmission: () => ({
        cap: 1, heldCount: 1, freeCount: 0, staleWaiting: 0,
        held: [{ owner: '/lanes/lane-9#1', pid: 1, heartbeatAt: new Date(T0 - 7 * 60_000).toISOString() }],
        waiting: [
          { owner: '/lanes/lane-8', repo: '/lanes/lane-8', pid: 2, requestedAt: new Date(T0 - 60_000).toISOString() },
          { owner: '/lanes/lane-7', repo: '/lanes/lane-7', pid: 3, requestedAt: new Date(T0 - 30_000).toISOString() },
        ],
      }),
      readCommand: (pid) => (pid === 3 ? null : 'npm run check:standards'),
      isAncestor: () => false, readLease: () => null,
      isLiveWaiter: (m) => m.pid !== 3, // pid 3 crashed
    });
    expect(read.waiting.map((w) => w.live)).toEqual([true, false]);
    const env = assessHeavyQueue(read);
    // Seeds (card xkyw1x4): the standards holder is past its 0.25m standard (0 left) + ONE live standards waiter
    // (0.25m, shown rounded to 0.3); the crashed "other" (5m) is not counted.
    expect(env.projectedWaitMinutesForNewJob).toBe(0.3);
  });
});

describe('collectHeavyQueue — against a REAL (temp) admission lock root, real admissionStatus()', () => {
  it('reads live tryAcquireSlot/markWaiting state through the real admissionStatus export', () => {
    const lockRoot = mkdtempSync(join(tmpdir(), 'heavy-queue-io-'));
    try {
      const T0 = Date.parse('2026-09-25T12:00:00.000Z');
      tryAcquireSlot({ lockRoot, cap: 2, owner: '/lanes/lane-21#111', pid: 111, nowMs: T0, nowIso: new Date(T0).toISOString() });
      markWaiting({ lockRoot, owner: '/lanes/lane-13', repo: '/lanes/lane-13', pid: 222, lane: '13', nowIso: new Date(T0 + 60_000).toISOString() });

      const read = collectHeavyQueue({
      readBaseline: null, // card xkyw1x4 — no host queue read in a unit test
        repo: '/anything', env: { WE_HEAVY_ADMISSION_CAP: '2' }, now: () => T0 + 120_000,
        // The lock-root resolution seam isn't exposed on `collectHeavyQueue` directly, so bind the REAL
        // `admissionStatus` export to this temp root via closure — proving the real function's shape flows
        // through untouched (the injected-fakes test above already proves the row-building math independently).
        readAdmission: (opts) => admissionStatus({ ...opts, lockRoot, pidLiveness: () => 'alive' }), // fake pid 222 must read as a live waiter
        readCommand: () => 'node scripts/verify-lane.mjs run --repo=.',
        isAncestor: () => true,
        readLease: () => null,
      });
      expect(read.heldCount).toBe(1);
      expect(read.waiting).toHaveLength(1);
      expect(read.waiting[0].lane).toBe('13');
    } finally {
      rmSync(lockRoot, { recursive: true, force: true });
    }
  });
});
