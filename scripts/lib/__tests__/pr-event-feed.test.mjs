/**
 * @file The shared PR-events feed consumer (card xlta0x5): the cursor survives a restart, an event only marks its
 * PR dirty, a CI event with no PR number resolves through the head-commit map, a gap/reset/first start marks a
 * full sweep, and take/ack give at-least-once (a crash between them re-delivers; a re-mark survives the ack).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createFeedConsumer, resolveFeedSettings, foldEvents, emptyFeedState, takeSnapshot, ackSnapshot, markDirty,
  learnSha, describeDirty, feedStatePath, loadFeedState, FULL_SWEEP_KEY, FEED_SETTINGS_FILE,
} from '../pr-event-feed.mjs';
import { readPrEventsStatuses } from '../pr-events.mjs';

const quiet = { error: () => {} };
const REPO = 'web-everything/web-everything';

/** A fake Worker log with the real cursor rules (absent cursor → reset at head; pruned → gap). */
function fakeFeed() {
  const events = [];
  let oldest = 1;
  const calls = [];
  return {
    calls,
    push(e) { events.push({ repo: REPO, ...e, seq: events.length + 1 }); },
    prune(through) { oldest = through + 1; },
    poll: async (cursor, { limit = 200 } = {}) => {
      calls.push(cursor);
      const head = events.length;
      if (cursor == null || cursor > head) return { ok: true, cursor: head, events: [], reset: true, gap: false, more: false, lastDeliveryAt: 1, lastEventAt: 1 };
      const gap = cursor < oldest - 1;
      const rows = events.filter((e) => e.seq > cursor && e.seq >= oldest).slice(0, limit);
      const next = rows.length ? rows[rows.length - 1].seq : (gap ? head : cursor);
      return { ok: true, cursor: next, events: rows, reset: false, gap, more: next < head, lastDeliveryAt: 1, lastEventAt: 1 };
    },
  };
}

function setup(o = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pr-event-feed-'));
  const feed = o.feed || fakeFeed();
  const make = (extra = {}) => createFeedConsumer({ role: 'drain', url: 'u', token: 't', stateDir: dir, poll: feed.poll,
    resolveSha: async () => null, log: quiet, now: () => 1000, ...o, ...extra });
  return { dir, feed, make };
}

const green = (sha, prs = []) => ({ type: 'check_suite', action: 'completed', conclusion: 'success', sha, prs });
const labeled = (n, label = 'ready-to-merge') => ({ type: 'pull_request', action: 'labeled', label, prs: [n], sha: `h${n}` });

describe('persisted cursor', () => {
  it('a first start with no stored cursor marks a full sweep and stores the head', async () => {
    const { feed, make, dir } = setup();
    feed.push(labeled(1));
    const c = make();
    const r = await c.pollOnce();
    expect(r.marked.map((m) => m.key)).toEqual([FULL_SWEEP_KEY]);
    expect(r.cursor).toBe(1);
    expect(JSON.parse(readFileSync(feedStatePath(dir, 'drain'), 'utf8')).cursor).toBe(1);
  });

  it('a restart resumes from the stored cursor and reads every event it missed — no reset, no full sweep', async () => {
    const { feed, make } = setup();
    const first = make();
    await first.pollOnce();
    first.ack(first.take()); // the boot sweep ran
    feed.push(labeled(7));
    feed.push(green('h8', [8]));
    // process dies here; a new process starts on the same state file
    const second = make();
    expect(second.resumedFrom).toBe(0);
    const r = await second.pollOnce();
    expect(feed.calls.at(-1)).toBe(0);
    expect(r.reset).toBe(false);
    expect(r.marked.map((m) => m.key).sort()).toEqual([`${REPO}#7`, `${REPO}#8`]);
    expect(Object.keys(second.dirty())).not.toContain(FULL_SWEEP_KEY);
  });

  it('a gap after a long stop marks a full sweep (events were pruned before we read them)', async () => {
    const { feed, make } = setup();
    const a = make(); await a.pollOnce(); a.ack(a.take());
    for (let i = 0; i < 5; i += 1) feed.push(labeled(i + 1));
    feed.prune(3);
    const b = make();
    const r = await b.pollOnce();
    expect(r.gap).toBe(true);
    expect(Object.keys(b.dirty())).toContain(FULL_SWEEP_KEY);
  });

  it('pages through `more` and stores the cursor after each page', async () => {
    const feed = fakeFeed();
    const saves = [];
    const { make } = setup({ feed });
    const a = make({ save: (p, s) => saves.push(s.cursor) });
    await a.pollOnce();
    for (let i = 0; i < 450; i += 1) feed.push(labeled(1000 + i));
    const r = await a.pollOnce();
    expect(r.cursor).toBe(450);
    expect(saves.slice(1)).toEqual([200, 400, 450]);
  });
});

describe('dirty marking', () => {
  const relevant = () => true;
  it('a CI event naming its PR marks that PR', () => {
    const { state, marked } = foldEvents(emptyFeedState('drain'), [{ ...green('s1', [5]), repo: REPO, seq: 1 }], { relevant, at: 1 });
    expect(marked.map((m) => m.key)).toEqual([`${REPO}#5`]);
    expect(state.dirty[`${REPO}#5`]).toMatchObject({ number: 5, firstAt: 1 });
  });

  it('a CI event with no PR number resolves through the head commit learned from a pull_request event', () => {
    const events = [{ type: 'pull_request', action: 'synchronize', prs: [42], sha: 'abc', repo: REPO, seq: 1 },
      { ...green('abc'), repo: REPO, seq: 2 }];
    const { state, marked } = foldEvents(emptyFeedState('drain'), events, { relevant: (e) => e.type === 'check_suite', at: 1 });
    expect(marked).toEqual([{ key: `${REPO}#42`, cause: 'check_suite.completed=success@2 via head commit' }]);
    expect(state.stats.resolvedBySha).toBe(1);
  });

  it('…or through the Durable Object map (the resolver) when this consumer never saw the push', async () => {
    const { feed, make } = setup();
    const seen = [];
    const c = make({ resolveSha: async (repo, sha) => { seen.push([repo, sha]); return sha === 'zzz' ? [77] : null; } });
    await c.pollOnce(); c.ack(c.take());
    feed.push(green('zzz'));
    feed.push(green('zzz')); // the same head again: looked up once per poll
    const r = await c.pollOnce();
    expect(r.marked.map((m) => m.key)).toEqual([`${REPO}#77`, `${REPO}#77`]);
    expect(seen).toEqual([[REPO, 'zzz']]);
  });

  it('a CI event that resolves to no PR marks `<repo>#?` — never silently dropped', () => {
    const { marked, state } = foldEvents(emptyFeedState('drain'), [{ ...green('nope'), repo: REPO, seq: 1 }], { relevant, at: 1 });
    expect(marked.map((m) => m.key)).toEqual([`${REPO}#?`]);
    expect(state.stats.unresolved).toBe(1);
  });

  it('an irrelevant event marks nothing but still teaches the head-commit map', () => {
    const e = { type: 'pull_request', action: 'synchronize', prs: [3], sha: 's3', repo: REPO, seq: 1 };
    const { marked, state } = foldEvents(emptyFeedState('drain'), [e], { relevant: () => false, at: 1 });
    expect(marked).toEqual([]);
    expect(state.shaPrs[`${REPO} s3`]).toEqual([3]);
  });

  it('the learned map is bounded, oldest first', () => {
    let s = emptyFeedState('drain');
    for (let i = 0; i < 5; i += 1) s = learnSha(s, { type: 'pull_request', repo: REPO, sha: `s${i}`, prs: [i + 1] }, { max: 3 });
    expect(Object.keys(s.shaPrs)).toEqual([`${REPO} s2`, `${REPO} s3`, `${REPO} s4`]);
  });
});

describe('take / ack (at least once)', () => {
  it('a crash between take and ack re-delivers the marks on the next start', async () => {
    const { feed, make } = setup();
    const a = make(); await a.pollOnce(); a.ack(a.take());
    feed.push(labeled(9));
    await a.pollOnce();
    a.take(); // the pass started … and the process died before ack
    const b = make();
    expect(Object.keys(b.dirty())).toEqual([`${REPO}#9`]);
  });

  it('a PR re-marked while the handler ran survives that handler\'s ack', () => {
    let s = markDirty(emptyFeedState('drain'), { key: 'k', cause: 'a', at: 1 });
    const snap = takeSnapshot(s);
    s = markDirty(s, { key: 'k', cause: 'b', at: 2 });
    s = markDirty(s, { key: 'j', cause: 'c', at: 2 });
    s = ackSnapshot(s, snap);
    expect(Object.keys(s.dirty).sort()).toEqual(['j', 'k']);
    expect(s.dirty.k.firstAt).toBe(1);
    expect(ackSnapshot(s, takeSnapshot(s)).dirty).toEqual({});
  });

  it('describeDirty reports how long the marks have waited', () => {
    let s = markDirty(emptyFeedState('drain'), { key: 'a', cause: 'x', at: 1000 });
    s = markDirty(s, { key: FULL_SWEEP_KEY, cause: 'y', at: 4000 });
    expect(describeDirty(s.dirty, 5000)).toMatchObject({ count: 2, full: true, oldestWaitMs: 4000 });
  });
});

describe('failures', () => {
  it('a failed poll keeps the cursor and the marks, and never throws', async () => {
    const { make } = setup();
    let ok = true;
    const base = fakeFeed();
    const c = make({ poll: async (cur, o) => (ok ? base.poll(cur, o) : { ok: false, error: 'HTTP 503' }) });
    await c.pollOnce();
    ok = false;
    const r = await c.pollOnce();
    expect(r).toMatchObject({ ok: false, error: 'HTTP 503', cursor: 0 });
    expect(c.health()).toBe('unreachable');
  });

  it('a state write failure is logged, not thrown, and the marks stay in memory', async () => {
    const lines = [];
    const { feed, make } = setup();
    feed.push(labeled(2));
    const c = make({ save: () => { throw new Error('EROFS'); }, log: { error: (l) => lines.push(l) } });
    await c.pollOnce();
    expect(lines[0]).toMatch(/state write failed/);
    expect(c.hasDirty()).toBe(true);
  });

  it('a corrupt or foreign state file is a first start', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-event-feed-'));
    const p = feedStatePath(dir, 'drain');
    mkdirSync(join(dir, 'feeds'), { recursive: true });
    writeFileSync(p, '{"v":1,"role":"review","dirty":{}}');
    expect(loadFeedState(p, 'drain').loaded).toBe(false);
    writeFileSync(p, 'not json');
    expect(loadFeedState(p, 'drain').state.cursor).toBe(null);
  });

  it('the state file sits outside the waker status probe; the status file joins it', async () => {
    const { make, dir } = setup();
    await make({ writeStatus: undefined }).pollOnce();
    expect(existsSync(feedStatePath(dir, 'drain'))).toBe(true);
    const statuses = readPrEventsStatuses(dir);
    expect(statuses.map((s) => s.role)).toEqual(['drain']);
    expect(statuses[0]).toMatchObject({ health: 'healthy', cursor: 0 });
  });
});

describe('settings', () => {
  const root = () => {
    const d = mkdtempSync(join(tmpdir(), 'pr-event-feed-root-'));
    mkdirSync(join(d, 'scripts', 'lib'), { recursive: true });
    return d;
  };
  it('reads the role from the settings file; env overrides the mode', () => {
    const d = root();
    writeFileSync(join(d, FEED_SETTINGS_FILE), JSON.stringify({ prEventFeed: { drain: { mode: 'shadow', pollEveryMs: 3000, healthyIntervalSec: 300 } } }));
    expect(resolveFeedSettings({ role: 'drain', root: d, env: {} })).toMatchObject({ mode: 'shadow', pollEveryMs: 3000, healthyIntervalSec: 300 });
    expect(resolveFeedSettings({ role: 'drain', root: d, env: { WE_PR_EVENT_FEED_DRAIN: 'on' } }).mode).toBe('on');
  });
  it('fails closed to off on an unknown mode or an unreadable file', () => {
    const d = root();
    expect(resolveFeedSettings({ role: 'drain', root: d, env: {} })).toMatchObject({ mode: 'off' });
    writeFileSync(join(d, FEED_SETTINGS_FILE), JSON.stringify({ prEventFeed: { drain: { mode: 'yes' } } }));
    expect(resolveFeedSettings({ role: 'drain', root: d, env: {} })).toMatchObject({ mode: 'off', error: expect.stringMatching(/unknown mode/) });
  });
  it('the shipped settings start the drain in shadow', () => {
    const repoRoot = join(import.meta.dirname, '..', '..', '..');
    expect(resolveFeedSettings({ role: 'drain', root: repoRoot, env: {} }).mode).toBe('shadow');
  });
});
