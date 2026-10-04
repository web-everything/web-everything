/**
 * @file Local simulation: replay a REAL PR's event sequence (web-everything/web-everything#2708, rebuilt from its REST
 * timeline — see the fixture's `source`) through the receiver as signed webhook deliveries, then read it back
 * through the daemon client (`we:scripts/lib/pr-events.mjs`) wired to the same handler. Proves the end-to-end
 * contract: signed → stored in order → cursor-read → the right daemon wakes / the drain is nudged.
 */
import { describe, it, expect } from 'vitest';
import { createEventLog, createMemoryStorage, handleRequest, signBody } from '../core.mjs';
import { pollEvents, createEventWaker } from '../../../lib/pr-events.mjs';

import FIX from './pr-2708-replay.fixture.mjs';
const ENV = { GITHUB_WEBHOOK_SECRET: 'replay-secret', PR_EVENTS_READ_TOKEN: 'replay-read' };

function harness() {
  const log = createEventLog(createMemoryStorage());
  let clock = Date.parse('2026-09-26T01:17:00Z');
  const opts = { getLog: () => log, now: () => clock };
  const deliver = async (d) => {
    clock = Date.parse(d.at);
    const raw = JSON.stringify(d.payload);
    return handleRequest(new Request('https://we-pr-events.test/github/webhook', {
      method: 'POST', body: raw,
      headers: { 'x-github-event': d.event, 'x-github-delivery': d.delivery, 'x-hub-signature-256': await signBody(ENV.GITHUB_WEBHOOK_SECRET, raw) },
    }), ENV, opts);
  };
  const fetchImpl = (url, init) => handleRequest(new Request(url, init), ENV, opts);
  return { log, deliver, fetchImpl, setClock: (t) => { clock = t; }, now: () => clock };
}

describe('replay of PR #2708 (real event sequence)', () => {
  it('stores every accepted delivery in order with a strictly increasing seq', async () => {
    const h = harness();
    const statuses = [];
    for (const d of FIX.deliveries) statuses.push((await h.deliver(d)).status);
    expect(statuses.every((s) => s === 202)).toBe(true);
    const all = h.log.read(0, 500).events;
    expect(all).toHaveLength(FIX.deliveries.length);
    expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i + 1));
    expect(all[0]).toMatchObject({ type: 'pull_request', action: 'opened', prs: [2708] });
    expect(all.find((e) => e.action === 'closed')).toMatchObject({ type: 'pull_request', merged: true, prs: [2708] });
    // Real ordering: the post-merge push's check_suite completes AFTER the close (02:13:36 vs 02:13:32).
    expect(all.at(-1)).toMatchObject({ type: 'check_suite', action: 'completed' });
    const [pr] = h.log.readPrs().prs;
    expect(pr).toMatchObject({ number: 2708, state: 'closed', merged: true, labels: null,
      labelChanges: { 'review:pending': false, 'review:accepted': true, 'ready-to-merge': true } });
    expect(pr.checks).toContainEqual(expect.objectContaining({ name: 'review-gate', sha: pr.sha, conclusion: 'success' }));
    expect(pr.suites).toContainEqual(expect.objectContaining({ app: 'github-actions', sha: pr.sha, conclusion: 'success' }));
    expect(all.some((event) => event.sha === null)).toBe(true); // Keep missing historical SHAs unknown.
    expect(all.filter((e) => e.label === 'review:pending')).toHaveLength(2); // labeled + unlabeled
  });

  it('a full GitHub redelivery of the sequence adds nothing', async () => {
    const h = harness();
    for (const d of FIX.deliveries) await h.deliver(d);
    const before = h.log.read(0, 500).head;
    for (const d of FIX.deliveries) expect((await (await h.deliver(d)).json()).duplicate).toBe(true);
    expect(h.log.read(0, 500).head).toBe(before);
  });

  it('the daemon client reads it back page by page from its cursor', async () => {
    const h = harness();
    const first = await pollEvents(null, { url: 'https://we-pr-events.test', token: ENV.PR_EVENTS_READ_TOKEN, fetchImpl: h.fetchImpl });
    expect(first).toMatchObject({ ok: true, cursor: 0, events: [] });
    for (const d of FIX.deliveries) await h.deliver(d);
    let cursor = first.cursor;
    const seen = [];
    for (let i = 0; i < 10; i += 1) {
      const r = await pollEvents(cursor, { url: 'https://we-pr-events.test', token: ENV.PR_EVENTS_READ_TOKEN, fetchImpl: h.fetchImpl, limit: 20 });
      seen.push(...r.events); cursor = r.cursor;
      if (!r.more) break;
    }
    expect(seen.map((e) => e.id)).toEqual(FIX.deliveries.map((d) => d.delivery));
    const bad = await pollEvents(cursor, { url: 'https://we-pr-events.test', token: 'nope', fetchImpl: h.fetchImpl });
    expect(bad).toEqual({ ok: false, error: 'HTTP 401' });
  });

  it('wakes the review daemon on the first delivery and nudges the drain on its land preconditions', async () => {
    const h = harness();
    const nudges = [];
    const waker = createEventWaker({
      role: 'review', repos: ['web-everything/web-everything'], url: 'https://we-pr-events.test', token: ENV.PR_EVENTS_READ_TOKEN,
      poll: (c, o) => pollEvents(c, { ...o, fetchImpl: h.fetchImpl }), now: h.now, writeStatus: null,
      forward: [{ role: 'drain', send: (evs) => { nudges.push(evs.map((e) => `${e.type}.${e.action}${e.label ? `:${e.label}` : ''}`)); } }],
      rawSleep: async (ms) => { h.setClock(h.now() + ms); }, minWakeGapMs: 0, log: { error: () => {} },
    });
    await waker.pollOnce(); // initialise the cursor at head (empty log)
    await h.deliver(FIX.deliveries[0]); // opened
    const woke = await waker.sleep(120_000);
    expect(woke).toMatchObject({ woke: true });
    expect(woke.reason).toMatch(/web-everything\/web-everything#2708 pull_request\.opened/);
    for (const d of FIX.deliveries.slice(1)) await h.deliver(d);
    await waker.pollOnce();
    const flat = nudges.flat();
    expect(flat).toContain('pull_request.labeled:review:accepted');
    expect(flat).toContain('pull_request.closed');
    expect(flat).toContain('check_suite.completed');
    expect(flat.some((x) => x.startsWith('check_run'))).toBe(false); // drain ignores per-run noise
  });
});
