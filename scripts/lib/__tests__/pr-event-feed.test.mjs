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

  it('a feed reset with a stored cursor marks a full sweep, persisted across a restart', async () => {
    const { feed, make } = setup();
    feed.push(labeled(1));
    const a = make(); await a.pollOnce(); a.ack(a.take()); // stored cursor = 1; boot sweep done
    expect(Object.keys(a.dirty())).toEqual([]);
    const resetPoll = async () => ({ ok: true, cursor: 0, events: [], reset: true, gap: false, more: false, lastDeliveryAt: 1, lastEventAt: 1 });
    const b = make({ poll: resetPoll });
    expect(b.resumedFrom).toBe(1); // the cursor is NOT null: only the reset flag can cause the sweep
    const r = await b.pollOnce();
    expect(r).toMatchObject({ reset: true, gap: false });
    expect(r.marked.map((m) => m.key)).toEqual([FULL_SWEEP_KEY]);
    expect(b.state().dirty[FULL_SWEEP_KEY].causes).toEqual(['feed reset (log recreated)']);
    const c = make(); // restart: the sweep owed is still owed
    expect(Object.keys(c.dirty())).toEqual([FULL_SWEEP_KEY]);
    expect(c.state().stats.fullSweeps).toBe(2); // the first start's, then the reset's
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

  it('two PRs sharing one head commit are both remembered: a sha-only CI event marks both', () => {
    const events = [
      { type: 'pull_request', action: 'opened', prs: [42], sha: 'abc', repo: REPO, seq: 1 },
      { type: 'pull_request', action: 'opened', prs: [43], sha: 'abc', repo: REPO, seq: 2 },
      { type: 'pull_request', action: 'synchronize', prs: [42], sha: 'abc', repo: REPO, seq: 3 }, // a repeat must not duplicate
      { ...green('abc'), repo: REPO, seq: 4 }];
    const { state, marked } = foldEvents(emptyFeedState('drain'), events, { relevant: (e) => e.type === 'check_suite', at: 1 });
    expect(state.shaPrs[`${REPO} abc`].sort()).toEqual([42, 43]);
    expect(marked.map((m) => m.key).sort()).toEqual([`${REPO}#42`, `${REPO}#43`]);
  });

  it('a PR event that lists several PRs, and a later one for the same head, keep the union', () => {
    let s = learnSha(emptyFeedState('drain'), { type: 'pull_request', repo: REPO, sha: 's', prs: [1, 2] });
    s = learnSha(s, { type: 'pull_request', repo: REPO, sha: 's', prs: [3] });
    expect(s.shaPrs[`${REPO} s`]).toEqual([1, 2, 3]);
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

  it('a parseable but malformed same-role state file is a first start, never a crash (table-driven)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-event-feed-'));
    const p = feedStatePath(dir, 'drain');
    mkdirSync(join(dir, 'feeds'), { recursive: true });
    const base = { v: 1, role: 'drain', cursor: 3, markSeq: 2, dirty: {}, shaPrs: {} };
    const entry = { repo: REPO, number: 1, mark: 1, firstAt: 1, lastAt: 1, causes: ['x'] };
    const bad = {
      'dirty null': { ...base, dirty: null },
      'dirty array': { ...base, dirty: [] },
      'dirty string': { ...base, dirty: 'x' },
      'shaPrs null': { ...base, shaPrs: null },
      'shaPrs array': { ...base, shaPrs: [] },
      'shaPrs value not an array': { ...base, shaPrs: { k: 5 } },
      'shaPrs value holds a non-PR number': { ...base, shaPrs: { k: ['x'] } },
      'cursor string': { ...base, cursor: 'x' },
      'cursor negative': { ...base, cursor: -1 },
      'cursor fraction': { ...base, cursor: 1.5 },
      'cursor NaN-ish (null is fine, undefined key is not a number)': { ...base, cursor: {} },
      'markSeq string': { ...base, markSeq: '2' },
      'markSeq negative': { ...base, markSeq: -1 },
      'mark entry null': { ...base, dirty: { k: null } },
      'mark entry has no numeric mark': { ...base, dirty: { k: { ...entry, mark: 'a' } } },
      'mark entry causes not an array': { ...base, dirty: { k: { ...entry, causes: 7 } } },
      'mark entry cause not a string': { ...base, dirty: { k: { ...entry, causes: [{}] } } },
      'mark entry number is a string': { ...base, dirty: { k: { ...entry, number: '1' } } },
      'mark entry firstAt not a number': { ...base, dirty: { k: { ...entry, firstAt: 'x' } } },
      'markSeq behind a stored mark (a new mark would be acked by an old snapshot)': { ...base, markSeq: 0, dirty: { k: entry } },
      'mark entry firstAt null (describeDirty would report a ~56-year wait)': { ...base, dirty: { k: { ...entry, firstAt: null } } },
      'mark entry keeps more causes than the bound': { ...base, dirty: { k: { ...entry, causes: ['a', 'b', 'c', 'd'] } } },
      'shaPrs list beyond the per-sha bound': { ...base, shaPrs: { k: Array.from({ length: 21 }, (_, i) => i + 1) } },
      'stats not an object': { ...base, stats: 5 },
      'stats counter not a number': { ...base, stats: { events: 'x' } },
      'updatedAt a string': { ...base, updatedAt: 'x' },
    };
    for (const [name, state] of Object.entries(bad)) {
      writeFileSync(p, JSON.stringify(state));
      const loaded = loadFeedState(p, 'drain');
      expect(loaded.loaded, name).toBe(false);
      expect(loaded.state.cursor, name).toBe(null);
      // and the consumer built on it works (first start) instead of throwing
      const { feed, make } = setup();
      feed.push(labeled(1));
      const c = make({ statePath: p });
      expect(() => c.take(), name).not.toThrow();
      expect(() => c.hasDirty(), name).not.toThrow();
      expect((await c.pollOnce()).ok, name).toBe(true);
    }
    writeFileSync(p, JSON.stringify({ ...base, dirty: { k: entry }, shaPrs: { 'r s': [4, 5] } })); // the well-formed shape still loads
    expect(loadFeedState(p, 'drain')).toMatchObject({ loaded: true, state: { cursor: 3 } });
    writeFileSync(p, JSON.stringify({ ...base, cursor: null }));
    expect(loadFeedState(p, 'drain').loaded).toBe(true);
  });

  it('what the consumer writes always loads back (untrusted event and mirror input round-trips)', async () => {
    const { feed, make, dir } = setup();
    const lines = [];
    const c = make({ log: { error: (l) => lines.push(l) }, resolveSha: async () => ['7', {}, 0, 8, 8] });
    await c.pollOnce(); // first start: the cursor is placed at the head
    feed.push({ type: 'pull_request', action: 'opened', prs: ['12', 0, -3, 1.5, {}, 9], sha: 's1' });
    feed.push({ type: 'pull_request', action: 'opened', prs: Array.from({ length: 100 }, (_, i) => i + 1), sha: 's2' });
    feed.push(green('s3'));
    await c.pollOnce();
    const p = feedStatePath(dir, 'drain');
    const loaded = loadFeedState(p, 'drain');
    expect(loaded.invalid).toBeUndefined();
    expect(loaded.loaded).toBe(true);
    expect(loaded.state.shaPrs[`${REPO} s1`]).toEqual([9]);
    expect(loaded.state.shaPrs[`${REPO} s2`].length).toBeLessThanOrEqual(20);
    expect(Object.keys(loaded.state.dirty)).toContain(`${REPO}#8`);
    expect(make().resumedFrom).toBe(loaded.state.cursor);
    expect(lines).toEqual([]);
  });

  it('a sha-only CI event marks the union of the PRs this consumer learned and the ones the mirror knows', async () => {
    const { feed, make } = setup();
    feed.push({ type: 'pull_request', action: 'opened', prs: [42], sha: 'abc' });
    const c = make({ resolveSha: async () => [42, 43] }); // 43 was opened before this consumer's cursor
    await c.pollOnce(); c.ack(c.take());
    feed.push(green('abc'));
    const r = await c.pollOnce();
    expect(r.marked.map((m) => m.key).sort()).toEqual([`${REPO}#42`, `${REPO}#43`]);
  });

  it('a rejected stored state is logged with its reason', () => {
    const { dir, make } = setup();
    const p = feedStatePath(dir, 'drain');
    mkdirSync(join(dir, 'feeds'), { recursive: true });
    writeFileSync(p, '{"v":1,"role":"drain","dirty":null}');
    const lines = [];
    make({ log: { error: (l) => lines.push(l) } });
    expect(lines[0]).toMatch(/stored state rejected \(dirty\)/);
  });

  it('a prototype-key mark in a stored state is not trusted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-event-feed-'));
    const p = feedStatePath(dir, 'drain');
    mkdirSync(join(dir, 'feeds'), { recursive: true });
    writeFileSync(p, '{"v":1,"role":"drain","cursor":1,"markSeq":1,"dirty":{"__proto__":{"mark":1,"causes":[]}},"shaPrs":{}}');
    expect(loadFeedState(p, 'drain').loaded).toBe(false);
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
