import { it, expect } from 'vitest';
import * as core from '../core.mjs';

const T = 1_000_000_000_000, INTERVAL = 5 * 60_000, WEEK = 7 * 24 * 3600_000;
const key = (...parts) => JSON.stringify(parts);
const event = (number, action = 'opened', sha = `sha-${number}`) => ({
  repo: 'o/r', prs: [number], type: 'pull_request', action, sha, at: new Date(0).toISOString(),
});
const write = (log, now) => log.append({ repo: 'o/other', type: 'check_run', prs: [], sha: null }, now);
const seed = (baseCursor, importId = 'stale') => ({ repo: 'o/r', importId, baseCursor, status: 'complete',
  prs: [{ number: 1, sha: 'seed', draft: false, labels: [], state: 'open' }] });

it('keeps an unserved tombstone with the close clock and rejects stale bootstrap after pruning and restart', () => {
  const storage = core.createMemoryStorage();
  let log = core.createEventLog(storage, { prRetentionMs: 0 });
  log.append(event(1), T);
  log.append({ ...event(1, 'closed'), merged: true }, T);
  log.append({ repo: 'o/r', prs: [1], sha: 'sha-1', type: 'check_run', name: 'ci' }, T);
  write(log, T + INTERVAL);
  expect(storage.getProjection('tombstones', key('o/r', 1))).toEqual({ repo: 'o/r', number: 1, state: 'closed',
    merged: true, closedSeq: 2, prunedAt: T + INTERVAL });
  expect(log.readPrs().prs).toEqual([]);
  log = core.createEventLog(storage, { prRetentionMs: 0 });
  log.bootstrap(seed(1), T + INTERVAL + 1);
  expect(log.readPrs().prs).toEqual([]);
  expect(storage.getProjection('prs', key('o/r', 1))).toBeNull();
});

it('preserves the close clock when later check events recreate a pruned row, while genuine reopens retire the tombstone', () => {
  const storage = core.createMemoryStorage(), log = core.createEventLog(storage, { prRetentionMs: 0 });
  log.append(event(1, 'closed'), T);
  write(log, T + INTERVAL);
  log.append({ repo: 'o/r', prs: [1], sha: 'sha-1', type: 'check_run', name: 'ci' }, T + INTERVAL + 1);
  log.bootstrap(seed(0), T + INTERVAL + 2);
  expect(log.readPrs().prs[0]).toMatchObject({ number: 1, state: 'closed' });
  log.append(event(1, 'reopened'), T + INTERVAL + 3);
  expect(log.readPrs().prs[0].state).toBe('open');
  expect(storage.getProjection('tombstones', key('o/r', 1))).toBeNull();
});

it('permits a fresh bootstrap after the close clock and removes its obsolete tombstone', () => {
  const storage = core.createMemoryStorage(), log = core.createEventLog(storage, { prRetentionMs: 0 });
  log.append(event(1, 'closed'), T);
  write(log, T + INTERVAL);
  log.bootstrap(seed(2, 'fresh'), T + INTERVAL + 1);
  expect(log.readPrs().prs[0].state).toBe('open');
  expect(storage.getProjection('tombstones', key('o/r', 1))).toBeNull();
});

it.each([undefined, INTERVAL])('expires tombstones on writes after their retention period (%s), even without another PR to prune', (tombstoneRetentionMs) => {
  const storage = core.createMemoryStorage(), log = core.createEventLog(storage, { prRetentionMs: 0, tombstoneRetentionMs });
  log.append(event(1, 'closed'), T);
  write(log, T + INTERVAL);
  const duration = tombstoneRetentionMs ?? 30 * 24 * 3600_000;
  write(log, T + INTERVAL + duration);
  expect(storage.getProjection('tombstones', key('o/r', 1))).not.toBeNull();
  write(log, T + 2 * INTERVAL + duration);
  expect(storage.getProjection('tombstones', key('o/r', 1))).toBeNull();
});

it('defaults to seven days, records write time, expires closed/merged and legacy rows, and preserves open/recent rows', () => {
  const storage = core.createMemoryStorage(), log = core.createEventLog(storage);
  log.append(event(1), T);
  log.append({ ...event(1, 'closed'), merged: true }, T);
  log.append(event(2), T);
  expect(storage.getProjection('prs', key('o/r', 1)).updatedAt).toBe(T);
  storage.putProjection('prs', key('o/r', 3), { repo: 'o/r', number: 3, state: 'closed', seq: 0 });
  storage.putProjection('prs', key('o/r', 4), { repo: 'o/r', number: 4, state: 'closed', seq: 0, updatedAt: T + WEEK });
  write(log, T + WEEK + 1);
  expect(storage.listProjection('prs').map((r) => r.number).sort()).toEqual([2, 4]);
});

it('removes historical SHA/check/suite entries and expired attachments while preserving evidence shared with an open PR', () => {
  const storage = core.createMemoryStorage(), log = core.createEventLog(storage, { prRetentionMs: 1000 });
  log.append(event(1, 'opened', 'old'), T);
  log.append({ repo: 'o/r', prs: [1], sha: 'old', type: 'check_run', name: 'old', seq: 0 }, T);
  log.append({ repo: 'o/r', prs: [1], sha: 'old', type: 'check_suite', app: 'old' }, T);
  log.append(event(1, 'synchronize', 'shared'), T);
  log.append(event(2, 'opened', 'shared'), T);
  log.append({ repo: 'o/r', prs: [1, 2], sha: 'shared', type: 'check_run', name: 'shared' }, T);
  log.append(event(1, 'closed', 'shared'), T);
  write(log, T + INTERVAL);
  expect(storage.getProjection('prs', key('o/r', 1))).toBeNull();
  expect(storage.getProjection('shas', key('o/r', 'old'))).toBeNull();
  expect(storage.getProjection('shas', key('o/r', 'shared'))).toEqual([2]);
  const checks = storage.listProjection('checks').filter((c) => c.repo === 'o/r');
  expect(checks).toMatchObject([{ name: 'shared', prs: [2] }]);
  expect(log.readPrs().prs[0].checks).toMatchObject([{ name: 'shared' }]);
});

it('throttles pruning until the injected clock crosses the interval, including after restart', () => {
  const storage = core.createMemoryStorage();
  let log = core.createEventLog(storage, { prRetentionMs: 0 });
  write(log, T);
  storage.putProjection('prs', key('o/r', 1), { repo: 'o/r', number: 1, state: 'closed', seq: 0 });
  write(log, T + INTERVAL - 1);
  expect(storage.getProjection('prs', key('o/r', 1))).not.toBeNull();
  log = core.createEventLog(storage, { prRetentionMs: 0 });
  write(log, T + INTERVAL);
  expect(storage.getProjection('prs', key('o/r', 1))).toBeNull();
  expect(Number(storage.getMeta('lastProjectionPruneAt'))).toBe(T + INTERVAL);
});

it('refreshes last-event time on a closed row and never expires a reopened PR', () => {
  const storage = core.createMemoryStorage(), log = core.createEventLog(storage, { prRetentionMs: INTERVAL });
  log.append(event(1, 'closed'), T);
  log.append(event(2, 'closed'), T);
  log.append(event(1, 'synchronize'), T + INTERVAL - 1);
  log.append(event(2, 'reopened'), T + INTERVAL - 1);
  write(log, T + INTERVAL);
  expect(storage.getProjection('prs', key('o/r', 1)).updatedAt).toBe(T + INTERVAL - 1);
  write(log, T + 2 * INTERVAL);
  expect(storage.listProjection('prs').map((r) => r.number)).toEqual([2]);
});
