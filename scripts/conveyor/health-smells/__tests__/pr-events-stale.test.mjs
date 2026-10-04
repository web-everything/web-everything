/**
 * @file `pr-events-stale`: breaches when a waker cannot reach the feed, or when an open PR's check completed well
 * after the feed's last delivery (deliveries are not arriving); a merely QUIET feed and an abandoned status file
 * stay quiet.
 */
import { describe, it, expect } from 'vitest';
import smell, { newestCheckCompletion } from '../pr-events-stale.mjs';
import { SMELLS } from '../index.mjs';

const NOW = Date.parse('2026-09-27T12:00:00Z');
const ago = (m) => NOW - m * 60_000;
const iso = (m) => new Date(ago(m)).toISOString();
const status = (o) => ({ role: 'review', health: 'healthy', updatedAt: ago(1), lastDeliveryAt: ago(5), ...o });
const pr = (repo, number, completedMinAgo) => ({ repo, number, statusCheckRollup: [{ name: 'test', conclusion: 'SUCCESS', completedAt: iso(completedMinAgo) }] });
const run = (probes) => smell.evaluate(probes, { now: NOW });

describe('pr-events-stale', () => {
  it('is registered on the gh cadence with both probes', () => {
    const s = SMELLS.find((x) => x.id === 'pr-events-stale');
    expect(s).toBeTruthy();
    expect(s.cadence).toBe('gh');
    expect(s.probes).toEqual(['prEventsStatus', 'prs']);
  });

  it('emits nothing while the flag is off (no status files)', () => {
    expect(run({ prEventsStatus: [], prs: [pr('a/b', 1, 1)] })).toEqual([]);
  });

  it('healthy feed that saw the latest activity → no breach', () => {
    const [r] = run({ prEventsStatus: [status()], prs: [pr('a/b', 1, 10)] });
    expect(r.breach).toBe(false);
  });

  it('quiet feed with no newer activity → no breach (quiet is not stale)', () => {
    const [r] = run({ prEventsStatus: [status({ health: 'stale', lastDeliveryAt: ago(300) })], prs: [pr('a/b', 1, 400)] });
    expect(r.breach).toBe(false);
  });

  it('unreachable → breach naming the error', () => {
    const [r] = run({ prEventsStatus: [status({ health: 'unreachable', lastError: 'HTTP 401' })], prs: [] });
    expect(r.breach).toBe(true);
    expect(r.summary).toMatch(/unreachable \(HTTP 401\)/);
    expect(r.recommendation).toMatch(/read-token/);
  });

  it('a check completed well after the last delivery → breach (deliveries not arriving)', () => {
    const [r] = run({ prEventsStatus: [status({ lastDeliveryAt: ago(90) })], prs: [pr('frontier-ui/frontierui', 42, 20)] });
    expect(r.breach).toBe(true);
    expect(r.summary).toMatch(/MISSED — frontier-ui\/frontierui#42/);
    expect(r.recommendation).toMatch(/Recent Deliveries/);
  });

  it('respects the waker\'s own repo list and ignores an abandoned status file', () => {
    expect(run({ prEventsStatus: [status({ lastDeliveryAt: ago(90), repos: ['a/b'] })], prs: [pr('x/y', 1, 20)] })[0].breach).toBe(false);
    expect(run({ prEventsStatus: [status({ health: 'unreachable', updatedAt: ago(120) })], prs: [] })[0].breach).toBe(false);
  });

  it('newestCheckCompletion picks the latest completedAt', () => {
    expect(newestCheckCompletion([pr('a/b', 1, 30), pr('a/b', 2, 5)])).toMatchObject({ number: 2 });
    expect(newestCheckCompletion([])).toBeNull();
  });
});
