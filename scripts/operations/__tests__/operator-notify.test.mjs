/** @file Only the queue's NEEDS YOU bucket may push; failed delivery must retry. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planNotifications, runOperatorNotify, itemKey } from '../operator-notify.mjs';
import { readState, writeState } from '../operator-notify-io.mjs';
import { evaluatePr } from '../operator-queue.mjs';

const row = { repo: 'web-everything/web-everything', number: 2108, title: 'Review this PR' };
const now = '2026-09-20T12:00:00Z';
let dir, path, notify;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'notify-')); path = join(dir, 'state.json'); notify = vi.fn(() => ({ ok: true })); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const run = (ready = [], errors = []) => runOperatorNotify({ readQueue: () => ({ ready, errors }), readState: () => readState(path), writeState: (state) => writeState(path, state), notify, now });

describe('notification state', () => {
  it('notifies once, drops departed items, and notifies on return', async () => {
    expect((await run([row])).notified).toEqual([row]);
    expect(notify).toHaveBeenCalledWith({ title: 'Review needed: web-everything/web-everything#2108', body: row.title });
    expect(readState(path).notified[itemKey(row)]).toEqual({ title: row.title, notifiedAt: now });
    const before = readFileSync(path, 'utf8');
    expect((await run([row])).notified).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe(before);
    await run();
    expect(readState(path)).toEqual({ notified: {} });
    await run([row]);
    expect(notify).toHaveBeenCalledTimes(2);
  });
  it.each(['return', 'throw'])('surfaces %s failure and retries without losing successes or drops', async (mode) => {
    const old = { ...row, number: 1 }, success = { ...row, number: 2 };
    await run([old]);
    notify.mockImplementationOnce(() => { if (mode === 'throw') throw Error('delivery failed'); return { ok: false, error: 'delivery failed' }; });
    const result = await run([row, success]);
    expect(result).toMatchObject({ exitCode: 1, notified: [success], failed: [{ row, error: 'delivery failed' }] });
    expect(Object.keys(readState(path).notified)).toEqual([itemKey(success)]);
    expect((await run([row, success])).notified).toEqual([row]);
  });
  it('empty queue creates no state and makes no calls', async () => {
    expect((await run()).exitCode).toBe(0);
    expect(existsSync(path)).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });
  it('queue errors preserve missing entries while allowing new notifications', async () => {
    const other = { ...row, repo: 'other/repo' };
    await run([other]);
    expect(await run([row], ['other/repo: fetch failed'])).toMatchObject({ notified: [row], queueErrors: ['other/repo: fetch failed'], exitCode: 1 });
    expect(Object.keys(readState(path).notified)).toEqual([itemKey(other), itemKey(row)]);
    expect((await run([other, row])).notified).toEqual([]);
  });
  it('unreadable queue returns 2 without reading or writing state', async () => {
    const read = vi.fn(), write = vi.fn();
    expect(await runOperatorNotify({ readQueue: () => { throw Error('offline'); }, readState: read, writeState: write, notify, now })).toEqual({ notified: [], failed: [], queueErrors: ['offline'], exitCode: 2 });
    expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
  });
  it('does not write unchanged state, even if ready order changes', async () => {
    const other = { ...row, number: 2 };
    const state = planNotifications({ ready: [row, other], now }).nextState;
    const write = vi.fn();
    await runOperatorNotify({ readQueue: () => ({ ready: [other, row] }), readState: () => state, writeState: write, notify, now });
    expect(write).not.toHaveBeenCalled();
  });
  it.each([null, undefined, 3, 'garbage', [], { notified: [] }, { notified: { bad: null } }])('tolerates garbage state %j', (state) => {
    expect(planNotifications({ ready: [row], state, now }).toNotify).toEqual([row]);
  });
  it('is pure, preserves existing entries and input order', () => {
    const old = { ...row, number: 3 };
    const state = { notified: { [itemKey(old)]: { title: 'original', notifiedAt: 'before' } } };
    const before = structuredClone(state);
    const result = planNotifications({ ready: [row, old], state, now });
    expect(result.toNotify).toEqual([row]);
    expect(result.nextState.notified[itemKey(old)]).toEqual(before.notified[itemKey(old)]);
    expect(state).toEqual(before);
  });
  it('has no static node imports', () => {
    expect(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../operator-notify.mjs'), 'utf8')).not.toMatch(/(?:import|export)\s+(?:[^;]*?\s+from\s+)?['"]node:/);
  });
});

it('only NEEDS YOU notifies, using the authority’s real evaluator', async () => {
  const head = 'fd37ce270aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  // Same current-format advisory fixture as scripts/__tests__/operator-queue.test.mjs.
  const advisory = (outcome) => ({ body: `**Verdict:** 🚦 human review required\n**Advisory outcome:** \`${outcome}\` — x.\nNet basis: \`${'a'.repeat(40)}..${head}\``, createdAt: now });
  const pr = (number, overrides = {}) => ({ number, title: row.title, labels: [{ name: 'review:human' }, { name: 'advisory:accepted' }], comments: [advisory('accept')], headRefOid: head, mergeable: 'MERGEABLE', statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }], ...overrides });
  // Mirrors main's review:human filter and evaluatePr bucketing. UNKNOWN remains
  // UNKNOWN after fixture polling; no real gh or sleeps are needed here.
  const bucket = (prs) => {
    const report = { ready: [], pending: [], notReady: [], errors: [] };
    for (const fixture of prs.filter((p) => p.labels.some((l) => l.name === 'review:human'))) {
      const result = evaluatePr(fixture);
      const entry = { repo: row.repo, number: fixture.number, title: fixture.title };
      if (result.ready) report.ready.push(entry);
      else if (result.transient) report.pending.push(entry);
      else report.notReady.push({ ...entry, reasons: result.reasons });
    }
    return report;
  };
  const fixtures = [pr(2108, { labels: [{ name: 'review:changes' }], comments: [advisory('changes')] }), pr(2, { labels: [{ name: 'review:human' }, { name: 'review:pending' }] }), pr(3, { statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }] }), pr(4, { mergeable: 'UNKNOWN' })];
  const queue = bucket(fixtures);
  expect(queue.pending).toHaveLength(1); expect(queue.notReady).toHaveLength(2);
  await run(queue.ready); expect(notify).not.toHaveBeenCalled();
  fixtures.push(pr(5));
  const ready = bucket(fixtures).ready;
  expect((await run(ready)).notified).toHaveLength(1);
  expect((await run(ready)).notified).toEqual([]);
  expect(notify).toHaveBeenCalledTimes(1);
});
