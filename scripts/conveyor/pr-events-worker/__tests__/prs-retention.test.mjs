import { it, expect } from 'vitest';
import * as core from '../core.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedMirror, applyDelta, lookupInMirror, refreshMirror, readPrFactsOrGithub, readRepoFacts, mirrorPath } from '../../../lib/pr-facts.mjs';

const T = 1_000_000_000_000, INTERVAL = 5 * 60_000, WEEK = 7 * 24 * 3600_000;
const key = (...parts) => JSON.stringify(parts);
const event = (number, action = 'opened', sha = `sha-${number}`) => ({
  repo: 'o/r', prs: [number], type: 'pull_request', action, sha, at: new Date(0).toISOString(),
});
const write = (log, now) => log.append({ repo: 'o/other', type: 'check_run', prs: [], sha: null }, now);
const seed = (baseCursor, importId = 'stale') => ({ repo: 'o/r', importId, baseCursor, status: 'complete',
  prs: [{ number: 1, sha: 'seed', draft: false, labels: [], state: 'open' }] });

it('rejects stale bootstrap with HTTP 409 after all tombstones expire and the log restarts, without applying it', async () => {
  const storage = core.createMemoryStorage(), options = { prRetentionMs: 0, tombstoneRetentionMs: 0 };
  let log = core.createEventLog(storage, options);
  log.append(event(1, 'closed'), T);
  log.append(event(2, 'closed'), T);
  log.append({ repo: 'o/r', prs: [2], sha: 'sha-2', type: 'check_run', name: 'ci' }, T);
  write(log, T + INTERVAL);
  write(log, T + 2 * INTERVAL);
  expect(storage.listProjection('tombstones')).toEqual([]);
  log = core.createEventLog(storage, options);
  expect(() => log.bootstrap(seed(0), T + 2 * INTERVAL)).toThrow('stale bootstrap');
  expect(Number(storage.getMeta('tombstoneHorizonSeq'))).toBe(2); // close clock, not last check's seq=3
  const response = await core.handleRequest(new Request('https://test/prs/bootstrap', { method: 'POST',
    headers: { authorization: 'Bearer boot' }, body: JSON.stringify(seed(0, 'http-stale')),
  }), { PR_EVENTS_BOOTSTRAP_TOKEN: 'boot' }, { getLog: () => log, now: () => T + 2 * INTERVAL });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: 'stale bootstrap' });
  expect(storage.listProjection('prs')).toEqual([]);
  expect(storage.listProjection('imports')).toEqual([]);
  log.bootstrap(seed(2, 'at-horizon'), T + 2 * INTERVAL);
  expect(log.readPrs().prs[0].state).toBe('open');
});

it('raises the permanent horizon for legacy tombstones as they expire and never lowers it', () => {
  const storage = core.createMemoryStorage(), log = core.createEventLog(storage, { tombstoneRetentionMs: 0 });
  storage.setMeta('tombstoneHorizonSeq', '2');
  storage.putProjection('tombstones', key('o/r', 1), { repo: 'o/r', number: 1, closedSeq: 7, prunedAt: T - INTERVAL });
  write(log, T);
  expect(Number(storage.getMeta('tombstoneHorizonSeq'))).toBe(7);
  write(log, T + INTERVAL);
  expect(Number(storage.getMeta('tombstoneHorizonSeq'))).toBe(7);
});

it('keeps an unserved tombstone with the close clock and rejects stale bootstrap after pruning and restart', () => {
  const storage = core.createMemoryStorage();
  let log = core.createEventLog(storage, { prRetentionMs: 0 });
  log.append(event(1), T);
  log.append({ ...event(1, 'closed'), merged: true }, T);
  log.append({ repo: 'o/r', prs: [1], sha: 'sha-1', type: 'check_run', name: 'ci' }, T);
  write(log, T + INTERVAL);
  expect(storage.getProjection('tombstones', key('o/r', 1))).toEqual({ repo: 'o/r', number: 1, state: 'closed',
    merged: true, closedSeq: 2, prunedAt: T + INTERVAL, evidenceLost: [
      { kind: 'checks', id: core.checkProjectionKey({ repo: 'o/r', sha: 'sha-1', type: 'check_run', name: 'ci' }) },
    ] });
  expect(log.readPrs().prs).toEqual([]);
  log = core.createEventLog(storage, { prRetentionMs: 0 });
  expect(() => log.bootstrap(seed(1), T + INTERVAL + 1)).toThrow('stale bootstrap');
  expect(log.readPrs().prs).toEqual([]);
  expect(storage.getProjection('prs', key('o/r', 1))).toBeNull();
});

it('preserves the close clock when later check events recreate a pruned row, while genuine reopens retire the tombstone', () => {
  const storage = core.createMemoryStorage(), log = core.createEventLog(storage, { prRetentionMs: 0 });
  log.append(event(1, 'closed'), T);
  write(log, T + INTERVAL);
  log.append({ repo: 'o/r', prs: [1], sha: 'sha-1', type: 'check_run', name: 'ci' }, T + INTERVAL + 1);
  expect(() => log.bootstrap(seed(0), T + INTERVAL + 2)).toThrow('stale bootstrap');
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

it('reports coverage false for a repo whose pruned check evidence belongs to a reopened PR on the same SHA', () => {
  const storage = core.createMemoryStorage(), log = core.createEventLog(storage, { prRetentionMs: 0, tombstoneRetentionMs: 0 });
  log.bootstrap({ repo: 'o/r', importId: 'i', baseCursor: 0, status: 'complete', prs: [] }, T);
  log.append(event(1, 'opened', 'S'), T);
  log.append({ repo: 'o/r', prs: [1], sha: 'S', type: 'check_run', name: 'security', conclusion: 'failure' }, T);
  log.append(event(1, 'closed', 'S'), T);
  write(log, T + INTERVAL); // prunes the closed PR and its exclusive failing check
  expect(storage.listProjection('checks').filter((c) => c.repo === 'o/r')).toEqual([]);
  log.append(event(1, 'reopened', 'S'), T + INTERVAL + 1);
  const body = log.readPrs(null, 10, T + INTERVAL + 2);
  expect(body.prs.find((r) => r.number === 1)?.checks ?? []).toEqual([]);
  expect(body.repos['o/r'].coverage).toBe(false);
});


const evidenceEvents = {
  checks: { type: 'check_run', name: 'security', app: 'ci', conclusion: 'failure' },
  suites: { type: 'check_suite', app: 'ci', conclusion: 'failure' },
  review: { type: 'pull_request_review', action: 'submitted', state: 'changes_requested' },
  labels: { type: 'pull_request', action: 'labeled', labels: ['hold'] },
  labelChanges: { type: 'pull_request', action: 'labeled', label: 'hold' },
  draft: { type: 'pull_request', action: 'converted_to_draft', draft: true },
};

it('exports the exhaustive evidence registry', () => {
  expect(Object.keys(core.EVIDENCE_KINDS || {}).sort()).toEqual(Object.keys(evidenceEvents).sort());
});

it.each(Object.keys(core.EVIDENCE_KINDS || evidenceEvents))('fences pruned %s in snapshots and delta mirrors until actual redelivery', async (kind) => {
  const storage = core.createMemoryStorage(), log = core.createEventLog(storage, { prRetentionMs: 0 });
  log.bootstrap({ repo: 'o/r', importId: 'covered', baseCursor: 0, status: 'complete', prs: [] }, T);
  const deliver = { ...event(1), ...evidenceEvents[kind] };
  log.append(deliver, T);
  log.append(event(1, 'closed'), T);
  write(log, T + INTERVAL);
  const closed = log.readPrs(null, 100, T + INTERVAL);
  const previous = seedMirror({ repo: 'o/r', body: closed, nowMs: T + INTERVAL });
  log.append(event(1, 'reopened'), T + INTERVAL + 1);
  // Supply ordinary required fields without replacing the kind under test.
  if (kind !== 'draft') log.append({ ...event(1, 'synchronize'), draft: false }, T + INTERVAL + 2);
  if (kind !== 'labels' && kind !== 'labelChanges') log.append({ ...event(1, 'synchronize'), labels: [] }, T + INTERVAL + 2);
  const now = T + INTERVAL + 3, body = log.readPrs(null, 100, now);
  expect(body.repos['o/r'].coverage).toBe(false);
  expect(body.prs[0].evidenceLost).toContainEqual(expect.objectContaining({ kind }));
  const opts = { number: 1, nowMs: now };
  const snapshot = seedMirror({ repo: 'o/r', body, nowMs: now });
  const delta = applyDelta(previous, log.read(previous.cursor, 100).events);
  for (const mirror of [snapshot, delta]) {
    expect(lookupInMirror(mirror, opts)).toMatchObject({ facts: null, reason: 'evidence-lost' });
    const dir = mkdtempSync(join(tmpdir(), 'evidence-loss-'));
    try {
      writeFileSync(mirrorPath(dir, 'o/r'), JSON.stringify(mirror));
      expect(await readRepoFacts({ repo: 'o/r', dir, env: {}, url: 'https://test', token: 'r',
        now: () => now, refreshAfterMs: 10000 })).toBeNull();
      const calls = [];
      const result = await readPrFactsOrGithub({ repo: 'o/r', number: 1, dir, env: {},
        url: 'https://test', token: 'r', now: () => now, refreshAfterMs: 10000,
        exec: (_cmd, args) => {
          calls.push(args.at(-1));
          return JSON.stringify(args.at(-1).includes('/reviews?') ? [] : { number: 1, head: { sha: 'sha-1' }, labels: [] });
        } });
      expect(result).toMatchObject({ source: 'github', reason: 'evidence-lost' });
      expect(calls.length).toBe(4);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  const fetchImpl = async (url) => new Response(JSON.stringify(new URL(url).pathname === '/prs'
    ? body : log.read(previous.cursor, 100)), { status: 200 });
  const refreshed = await refreshMirror(previous, { repo: 'o/r', url: 'https://test', token: 'r', nowMs: now, fetchImpl });
  expect(lookupInMirror(refreshed.mirror, opts)).toMatchObject({ facts: null, reason: 'evidence-lost' });
  const full = await refreshMirror(null, { repo: 'o/r', url: 'https://test', token: 'r', nowMs: now, fetchImpl });
  expect(full.mode).toBe('failed');
  // A different check identity, or an unrelated kind, cannot restore this loss.
  log.append(kind === 'checks' || kind === 'suites' ? { ...deliver, app: 'other' }
    : { ...event(1), type: 'issue_comment', kind: 'ruling' }, now);
  expect(log.readPrs(null, 100, now).repos['o/r'].coverage).toBe(false);
  log.append(deliver, now + 1);
  const restored = log.readPrs(null, 100, now + 2);
  expect(restored.repos['o/r'].coverage).toBe(true);
  for (const mirror of [snapshot, delta]) {
    const healed = applyDelta(mirror, log.read(body.head, 100).events);
    expect(healed.buckets.prs[key('o/r', 1)].evidenceLost || []).toEqual([]);
    const complete = kind === 'labelChanges' ? applyDelta(healed, [{
      ...event(1, 'synchronize'), labels: ['hold'], seq: restored.head + 1,
    }]) : healed;
    expect(lookupInMirror(complete, { number: 1, nowMs: now + 2 }).facts).toMatchObject({ source: 'store' });
  }
});

it('classifies every own PR row field produced by every accepted event type', () => {
  const storage = core.createMemoryStorage();
  let seq = 0;
  for (const [type, actions] of Object.entries(core.ACCEPTED_EVENTS)) {
    for (const action of actions) core.foldObservation(storage, {
      ...event(1), type, action, seq: ++seq, draft: false, labels: ['hold'], label: 'hold',
      state: type === 'pull_request_review' ? 'changes_requested' : 'open', name: 'ci', app: 'ci', kind: 'ruling',
    }, T);
  }
  core.foldObservation(storage, { ...event(1), type: 'bootstrap', baseCursor: seq, seq: ++seq, draft: false, labels: [] }, T);
  const allowed = new Set([...Object.keys(core.EVIDENCE_KINDS || {}), ...(core.NON_EVIDENCE_FIELDS || [])]);
  expect(Object.keys(storage.listProjection('prs')[0]).filter((field) => !allowed.has(field))).toEqual([]);
});


it('retains review loss beyond tombstone expiry and across restart', () => {
  const storage = core.createMemoryStorage(), options = { prRetentionMs: 0, tombstoneRetentionMs: 0 };
  let log = core.createEventLog(storage, options);
  log.bootstrap({ repo: 'o/r', importId: 'i', baseCursor: 0, status: 'complete', prs: [] }, T);
  log.append({ ...event(1), ...evidenceEvents.review }, T);
  log.append(event(1, 'closed'), T);
  write(log, T + INTERVAL);
  write(log, T + 2 * INTERVAL);
  expect(storage.listProjection('tombstones')).toEqual([]);
  log = core.createEventLog(storage, options);
  log.append(event(1, 'reopened'), T + 2 * INTERVAL + 1);
  expect(log.readPrs(null, 100, T + 2 * INTERVAL + 2).repos['o/r'].coverage).toBe(false);
});

it('migrates persisted round-5 SHA markers and clears only the matching check', () => {
  const storage = core.createMemoryStorage();
  const check = { ...event(1), type: 'check_run', name: 'ci', app: 'ci' };
  storage.putProjection('prunedEvidence', core.checkProjectionKey(check), { repo: 'o/r', sha: check.sha });
  const before = core.createEventLog(storage);
  before.bootstrap({ repo: 'o/r', importId: 'i', baseCursor: 0, status: 'complete', prs: [] }, T);
  before.append(event(1, 'reopened'), T);
  // Simulate an already-open row persisted before the round-5 upgrade.
  storage.putProjection('prunedEvidence', core.checkProjectionKey(check), { repo: 'o/r', sha: check.sha });
  const persisted = storage.getProjection('prs', key('o/r', 1));
  delete persisted.evidenceLost;
  storage.putProjection('prs', key('o/r', 1), persisted);
  const log = core.createEventLog(storage);
  expect(log.readPrs(null, 100, T).repos['o/r'].coverage).toBe(false);
  expect(log.readPrs(null, 100, T).prs[0].evidenceLost).toHaveLength(1);
  expect(storage.listProjection('prunedEvidence')).toEqual([]);
  log.append(check, T + 1);
  expect(log.readPrs(null, 100, T + 1).repos['o/r'].coverage).toBe(true);
});

it.each([null, {}, 'lost', [{ kind: 'future' }]])('fails closed on unreadable or unknown markers (%j)', (evidenceLost) => {
  expect(core.evidenceCovered({ evidenceLost })).toBe(false);
});
