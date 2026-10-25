/**
 * @file scripts/operations/__tests__/live-work-io-real.test.mjs
 * @description Card x20lkf6 (epic #3931) — the fidelity qualifier (#2949) for `live-work-io.mjs`'s ONE new
 * primitive, `statMtimeMs`: proved against a REAL file on a real filesystem, not an injected `stat` double.
 * Every OTHER read this file's collector composes (`claude agents`, review jobs, the heavy-admission pool,
 * pid liveness) already has its own real-IO fidelity suite (`agent-activity-io-real.test.mjs`,
 * `heavy-queue-io-real.test.mjs`, `review-job-store.test.mjs`) — this suite proves the composition wiring
 * plus the new mtime read, using a REAL spawned child process for the pid-liveness half.
 */
import { spawn } from 'node:child_process';
import { writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { keepAliveScript } from '../../lib/test-keepalive.mjs';
import { it, expect } from 'vitest';
import { withRealRepo } from './helpers/real-repo.mjs';
import { statMtimeMs, createLiveWorkCollector } from '../live-work-io.mjs';

it('statMtimeMs reads a REAL file\'s own last-write time off a real filesystem', async () => {
  await withRealRepo(async ({ root }) => {
    const p = join(root, 'transcript.jsonl');
    writeFileSync(p, '{}\n');
    const stamp = new Date('2026-09-20T10:00:00.000Z');
    utimesSync(p, stamp, stamp);
    expect(statMtimeMs(p)).toBeCloseTo(stamp.getTime(), -2);
  });
});

it('statMtimeMs is null for a path that does not exist — never "just now"', () => {
  expect(statMtimeMs('/definitely/not/a/real/path.jsonl')).toBeNull();
});

it('statMtimeMs is null for a null/undefined path', () => {
  expect(statMtimeMs(null)).toBeNull();
  expect(statMtimeMs(undefined)).toBeNull();
});

it('createLiveWorkCollector composes readActivity + heavy-queue + a REAL pid probe into one snapshot', async () => {
  await withRealRepo(async ({ root }) => {
    const p = join(root, 'sess.jsonl');
    writeFileSync(p, '{}\n');
    // A real, short-lived child left running just long enough for a real `kill(pid, 0)` probe to see it alive.
    const child = spawn(process.execPath, ['-e', keepAliveScript({ maxLifetimeMs: 5000 })], { stdio: 'ignore' });
    try {
      const collect = createLiveWorkCollector({
        now: () => Date.parse('2026-09-26T12:00:00.000Z'),
        readActivity: () => ({ rows: [
          { id: 'live', sessionId: 'live', name: 'conveyor-9001', kind: 'background', pid: child.pid, cwd: '/x', transcriptPath: p },
          { id: 'gone', sessionId: 'gone', name: 'conveyor-9002', kind: 'background', pid: 999999, cwd: '/x', transcriptPath: null },
        ] }),
        collectQueue: () => ({ held: [], waiting: [], observedAt: '2026-09-26T12:00:00.000Z', cap: 1, heldCount: 0, freeCount: 1 }),
      });
      const out = collect();
      expect(out.rows.find((r) => r.id === 'live')).toMatchObject({ pidAlive: true });
      expect(out.rows.find((r) => r.id === 'live').lastActivityAt).toEqual(expect.any(Number));
      expect(out.rows.find((r) => r.id === 'gone')).toMatchObject({ pidAlive: false, lastActivityAt: null });
      expect(out.heavyQueue).toMatchObject({ cap: 1, freeCount: 1 });
    } finally {
      child.kill('SIGKILL');
    }
  });
});

it('createLiveWorkCollector: a row with no pid at all gets pidAlive: null — never guessed dead', () => {
  const collect = createLiveWorkCollector({
    now: () => Date.parse('2026-09-26T12:00:00.000Z'),
    readActivity: () => ({ rows: [{ id: 'chat', sessionId: 'chat', kind: 'interactive', pid: null, transcriptPath: null }] }),
    collectQueue: () => ({ held: [], waiting: [], observedAt: '2026-09-26T12:00:00.000Z', cap: 1, heldCount: 0, freeCount: 1 }),
  });
  expect(collect().rows[0]).toMatchObject({ pidAlive: null, lastActivityAt: null });
});
