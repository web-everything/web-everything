/**
 * @file The daemon-side PR-events client: flag-off identity, config, the one-call poll (and every failure it must
 * swallow), feed-health classification, relevance per role, and the event-aware sleep — early wake, the long
 * safety-net interval while healthy, and the automatic fall-back to the base interval when the feed is stale or
 * unreachable (including mid-sleep).
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  withPrEvents, resolvePrEventsConfig, pollEvents, classifyFeedHealth, effectiveIntervalMs, isRelevantEvent,
  createEventWaker, readPrEventsStatuses, makeDrainNudgeForward,
} from '../pr-events.mjs';

const quiet = { error: () => {} };
const MIN = 60_000;

describe('flag + config', () => {
  it('flag OFF returns the very same effects object', () => {
    const effects = { tickOnce: () => {}, sleep: () => {}, intervalMs: 120_000 };
    expect(withPrEvents(effects, { role: 'review', env: {}, log: quiet })).toBe(effects);
  });

  it('flag ON but unconfigured also keeps the plain interval, and says what is missing', () => {
    const lines = [];
    const effects = { sleep: () => {} };
    expect(withPrEvents(effects, { role: 'fix', env: { WE_PR_EVENTS: '1' }, log: { error: (l) => lines.push(l) } })).toBe(effects);
    expect(lines[0]).toMatch(/WE_PR_EVENTS_URL/);
  });

  it('flag ON + url + token file replaces only sleep', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-events-'));
    writeFileSync(join(dir, 'tok'), 'abc\n');
    const env = { WE_PR_EVENTS: '1', WE_PR_EVENTS_URL: 'https://w.test/', WE_PR_EVENTS_TOKEN_FILE: join(dir, 'tok'), WE_PR_EVENTS_STATE_DIR: dir };
    const cfg = resolvePrEventsConfig(env);
    expect(cfg).toMatchObject({ enabled: true, url: 'https://w.test', token: 'abc' });
    const tickOnce = () => {};
    const wrapped = withPrEvents({ tickOnce, sleep: () => 'plain', intervalMs: 5 }, { role: 'review', env, log: quiet });
    expect(wrapped.tickOnce).toBe(tickOnce);
    expect(wrapped.intervalMs).toBe(5);
    expect(wrapped.sleep).not.toBe(undefined);
    expect(wrapped.sleep()).not.toBe('plain');
  });
});

describe('pollEvents — one call, never throws', () => {
  const ok = (body) => async () => ({ ok: true, status: 200, json: async () => body });
  it('passes the cursor and bearer token and returns the page', async () => {
    let seen;
    const r = await pollEvents(4, { url: 'https://w', token: 't', fetchImpl: async (u, i) => { seen = { u, i }; return ok({ cursor: 6, events: [{ seq: 5 }, { seq: 6 }], more: false, lastDeliveryAt: 9 })(); } });
    expect(seen.u).toBe('https://w/events?limit=200&cursor=4');
    expect(seen.i.headers.authorization).toBe('Bearer t');
    expect(r).toMatchObject({ ok: true, cursor: 6, events: [{ seq: 5 }, { seq: 6 }], lastDeliveryAt: 9 });
  });
  it('maps HTTP errors, network errors, malformed bodies and timeouts to ok:false', async () => {
    expect(await pollEvents(0, { url: 'u', token: 't', fetchImpl: async () => ({ ok: false, status: 503 }) })).toEqual({ ok: false, error: 'HTTP 503' });
    expect(await pollEvents(0, { url: 'u', token: 't', fetchImpl: async () => { throw new Error('ENOTFOUND'); } })).toEqual({ ok: false, error: 'ENOTFOUND' });
    expect(await pollEvents(0, { url: 'u', token: 't', fetchImpl: ok({ nope: 1 }) })).toEqual({ ok: false, error: 'malformed response' });
    const hang = (u, i) => new Promise((_, rej) => { i.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); }); });
    expect(await pollEvents(0, { url: 'u', token: 't', fetchImpl: hang, timeoutMs: 5 })).toEqual({ ok: false, error: 'timeout after 5ms' });
    expect(await pollEvents(0, {})).toEqual({ ok: false, error: 'not configured' });
  });
});

describe('feed health', () => {
  it('unreachable / stale / healthy', () => {
    expect(classifyFeedHealth({ lastOkAt: null, now: 0 })).toBe('unreachable');
    expect(classifyFeedHealth({ lastOkAt: 10, lastFailAt: 20, lastDeliveryAt: 15, now: 30 })).toBe('unreachable');
    expect(classifyFeedHealth({ lastOkAt: 30, lastFailAt: 20, lastDeliveryAt: null, now: 30 })).toBe('stale');
    expect(classifyFeedHealth({ lastOkAt: 100 * MIN, lastDeliveryAt: 10 * MIN, now: 100 * MIN, staleAfterMs: 60 * MIN })).toBe('stale');
    expect(classifyFeedHealth({ lastOkAt: 100 * MIN, lastDeliveryAt: 90 * MIN, now: 100 * MIN, staleAfterMs: 60 * MIN })).toBe('healthy');
  });
  it('only healthy earns the long interval', () => {
    expect(effectiveIntervalMs('healthy', { baseIntervalMs: 2 * MIN, healthyIntervalMs: 10 * MIN })).toBe(10 * MIN);
    expect(effectiveIntervalMs('stale', { baseIntervalMs: 2 * MIN, healthyIntervalMs: 10 * MIN })).toBe(2 * MIN);
    expect(effectiveIntervalMs('unreachable', { baseIntervalMs: 2 * MIN, healthyIntervalMs: 10 * MIN })).toBe(2 * MIN);
  });
});

describe('relevance', () => {
  const e = (o) => ({ repo: 'a/b', prs: [1], ...o });
  it('review wakes on PR and check events; fix only on red/changes/labels; drain on land preconditions', () => {
    expect(isRelevantEvent(e({ type: 'pull_request', action: 'opened' }), 'review')).toBe(true);
    expect(isRelevantEvent(e({ type: 'check_run', action: 'completed', conclusion: 'success' }), 'fix')).toBe(false);
    expect(isRelevantEvent(e({ type: 'check_run', action: 'completed', conclusion: 'failure' }), 'fix')).toBe(true);
    expect(isRelevantEvent(e({ type: 'pull_request_review', action: 'submitted', state: 'changes_requested' }), 'fix')).toBe(true);
    expect(isRelevantEvent(e({ type: 'check_suite', action: 'completed', conclusion: 'success' }), 'drain')).toBe(true);
    expect(isRelevantEvent(e({ type: 'check_run', action: 'completed', conclusion: 'success' }), 'drain')).toBe(false);
    expect(isRelevantEvent(e({ type: 'pull_request', action: 'opened' }), 'review', { repos: ['x/y'] })).toBe(false);
  });
});

/** Fake clock + scripted feed. `feed(cursor)` returns a pollEvents-shaped result. */
function rig(feed, extra = {}) {
  let t = 0;
  const calls = [];
  const statuses = [];
  const waker = createEventWaker({
    role: 'review', url: 'u', token: 't', now: () => t,
    rawSleep: async (ms) => { t += ms; },
    poll: async (c) => { calls.push({ at: t, cursor: c }); return feed(c, t); },
    writeStatus: (s) => statuses.push(s), log: quiet, ...extra,
  });
  return { waker, calls, statuses, now: () => t, set: (v) => { t = v; } };
}
const page = (cursor, events = [], o = {}) => ({ ok: true, cursor, events, gap: false, reset: false, more: false, lastDeliveryAt: 0, lastEventAt: 0, ...o });

describe('createEventWaker.sleep', () => {
  it('healthy and quiet → sleeps the long safety-net interval (10 min), polling every 15 s', async () => {
    const r = rig((c, t) => page(0, [], { lastDeliveryAt: t }));
    const out = await r.waker.sleep(2 * MIN);
    expect(out).toMatchObject({ woke: false, reason: 'interval', sleptMs: 10 * MIN });
    expect(r.calls.length).toBe(41); // t=0,15s,…,600s
  });

  it('a relevant event wakes the tick early (after the min gap), and the cursor advances past it', async () => {
    const r = rig((c, t) => (t >= 45_000 && c === 0 ? page(1, [{ seq: 1, repo: 'a/b', prs: [9], type: 'pull_request', action: 'labeled', label: 'review:pending' }], { lastDeliveryAt: t }) : page(c ?? 0, [], { lastDeliveryAt: t })));
    const out = await r.waker.sleep(2 * MIN);
    expect(out.woke).toBe(true);
    expect(out.sleptMs).toBe(45_000);
    expect(out.reason).toMatch(/a\/b#9 pull_request\.labeled\(review:pending\)/);
    expect(r.waker.state.cursor).toBe(1);
  });

  it('an irrelevant event does not wake (fix role ignores a green check)', async () => {
    const r = rig((c, t) => (c === 0 ? page(1, [{ seq: 1, repo: 'a/b', type: 'check_run', action: 'completed', conclusion: 'success' }], { lastDeliveryAt: t }) : page(c ?? 0, [], { lastDeliveryAt: t })), { role: 'fix' });
    await r.waker.pollOnce();
    const out = await r.waker.sleep(2 * MIN);
    expect(out.woke).toBe(false);
  });

  it('events that arrived during the tick wake the next sleep, but not faster than minWakeGapMs', async () => {
    const r = rig((c, t) => page(1, c === 0 ? [{ seq: 1, repo: 'a/b', type: 'pull_request', action: 'opened' }] : [], { lastDeliveryAt: t }));
    r.waker.state.cursor = 0; r.waker.state.initialized = true;
    const out = await r.waker.sleep(2 * MIN);
    expect(out).toMatchObject({ woke: true, sleptMs: 10_000 });
  });

  it('unreachable feed → falls back to the base interval (2 min) automatically', async () => {
    const r = rig(() => ({ ok: false, error: 'HTTP 503' }));
    const out = await r.waker.sleep(2 * MIN);
    expect(out).toMatchObject({ woke: false, sleptMs: 2 * MIN });
    expect(r.statuses.at(-1)).toMatchObject({ health: 'unreachable', lastError: 'HTTP 503', effectiveIntervalMs: 2 * MIN });
  });

  it('stale feed (reachable, nothing delivered for > staleAfterMs) → base interval', async () => {
    const r = rig(() => page(0, [], { lastDeliveryAt: null }));
    expect((await r.waker.sleep(2 * MIN)).sleptMs).toBe(2 * MIN);
    expect(r.statuses.at(-1).health).toBe('stale');
  });

  it('a feed that dies mid-sleep shortens that same sleep back to the base interval', async () => {
    const r = rig((c, t) => (t < 3 * MIN ? page(0, [], { lastDeliveryAt: t }) : { ok: false, error: 'ENOTFOUND' }));
    const out = await r.waker.sleep(2 * MIN);
    expect(out).toMatchObject({ woke: false });
    expect(out.sleptMs).toBe(3 * MIN); // healthy until 3 min, then the 2-min deadline was already past
  });

  it('a gap (events pruned before read) or a feed reset after init wakes — a full tick covers it', async () => {
    const g = rig((c, t) => page(5, [], { gap: true, lastDeliveryAt: t }));
    g.waker.state.initialized = true; g.waker.state.cursor = 1;
    expect((await g.waker.sleep(2 * MIN)).reason).toMatch(/gap/);
    const s = rig((c, t) => page(0, [], { reset: true, lastDeliveryAt: t }));
    await s.waker.pollOnce(); // first reset = initialisation, no wake
    expect((await s.waker.sleep(2 * MIN)).reason).toMatch(/reset/);
  });

  it('writes a status file the smell can read (never the token)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-events-status-'));
    const w = createEventWaker({ role: 'fix', url: 'u', token: 'SUPER-SECRET-TOKEN', stateDir: dir, poll: async () => page(3, [], { lastDeliveryAt: 1 }), now: () => 1, log: quiet });
    await w.pollOnce();
    const raw = readFileSync(join(dir, 'fix.json'), 'utf8');
    expect(raw).not.toMatch(/SUPER-SECRET/);
    expect(readPrEventsStatuses(dir)).toEqual([expect.objectContaining({ role: 'fix', health: 'healthy', cursor: 3 })]);
    expect(readPrEventsStatuses(join(dir, 'absent'))).toEqual([]);
  });

  it('forwards drain-relevant events to the drain nudge, and a failing forward never breaks the poll', async () => {
    const posts = [];
    const fwd = makeDrainNudgeForward({ port: 4599, fetchImpl: async (u, i) => { posts.push([u, i.method]); return { ok: true }; } });
    const r = rig(() => page(1, [{ seq: 1, repo: 'a/b', type: 'check_suite', action: 'completed', conclusion: 'success' }], { lastDeliveryAt: 0 }), {
      forward: [fwd, { role: 'drain', send: () => { throw new Error('boom'); } }],
    });
    const res = await r.waker.pollOnce();
    expect(posts).toEqual([['http://127.0.0.1:4599/nudge', 'POST']]);
    expect(res.wake).toBe(true);
  });
});

describe('PR comment wake relevance', () => {
  it.each(['advisory', 'ruling', 'other', undefined])('routes comment kind %s only to the fix role when relevant', (kind) => {
    const event = { type: 'issue_comment', action: 'created', repo: 'web-everything/web-everything', prs: [4624], ...(kind ? { kind } : {}) };
    expect(isRelevantEvent(event, 'fix')).toBe(kind === 'advisory' || kind === 'ruling');
    expect(isRelevantEvent(event, 'review')).toBe(false);
    expect(isRelevantEvent(event, 'drain')).toBe(false);
  });
});
