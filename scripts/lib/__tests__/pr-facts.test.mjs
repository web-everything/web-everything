// @vitest-environment node
/**
 * perf item C1b — the shared PR-facts reader over the #4281 webhook store. Every case runs the REAL Worker core
 * (`createEventLog` + `handleRequest` over in-memory storage) behind the injected fetch, so the mirror is tested
 * against the same fold and cursor rules the deployed Durable Object uses.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEventLog, createMemoryStorage, handleRequest, parseGithubEvent } from '../../conveyor/pr-events-worker/core.mjs';
import {
  PR_FACTS_DEFAULTS, lookupPrFacts, readPrFacts, readPrFactsFromGithub, readPrFactsOrGithub, readRepoFacts,
  resolvePrFactsConfig, compactMirror, seedMirror, applyDelta, lookupInMirror, refreshMirror, loadMirror, readMirrorFile, mirrorPath,
} from '../pr-facts.mjs';

const REPO = 'Web-Everything/web-everything';
const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const T0 = Date.parse('2026-10-06T12:00:00Z');

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pr-facts-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** A live-like Worker: real core, a settable clock, and a fetch that counts each route it serves. */
function worker({ maxEvents } = {}) {
  const clock = { t: T0 };
  const log = createEventLog(createMemoryStorage(), maxEvents ? { maxEvents } : {});
  const env = { PR_EVENTS_READ_TOKEN: 'read', PR_EVENTS_BOOTSTRAP_TOKEN: 'boot' };
  const hits = { prs: 0, events: 0 };
  const w = {
    clock, log, hits, down: false,
    fetchImpl: async (url, init) => {
      if (w.down) return new Response('{"error":"not found"}', { status: 404 });
      const path = new URL(url).pathname;
      if (path === '/prs') hits.prs += 1;
      if (path === '/events') hits.events += 1;
      return handleRequest(new Request(url, init), env, { getLog: () => log, now: () => clock.t });
    },
    deliver(name, payload) { return log.append(parseGithubEvent(name, payload, { receivedAt: clock.t }), clock.t); },
    bootstrap(prs, status = 'complete') {
      return log.bootstrap({ repo: REPO, importId: `i${clock.t}`, baseCursor: Number(log.read(null).head), status, prs }, clock.t);
    },
    opts: (extra = {}) => ({ repo: REPO, url: 'https://w.local', token: 'read', fetchImpl: w.fetchImpl, dir, now: () => w.clock.t, env: {}, ...extra }),
  };
  return w;
}

const repoPayload = { full_name: REPO };
const prPayload = (action, extra = {}) => ({
  action, number: 7, repository: repoPayload,
  pull_request: { number: 7, head: { sha: HEAD }, draft: false, state: 'open', labels: [{ name: 'review:pending' }], ...extra },
});
/** A real `labeled`/`unlabeled` delivery: the changed label plus the PR's full post-change label list. */
const labelEvent = (action, label, after) => ({ ...prPayload(action, { labels: after.map((name) => ({ name })) }), label: { name: label } });
const checkRun = (name, conclusion, sha = HEAD, id = 1) => ({
  action: 'completed', repository: repoPayload,
  check_run: { id, name, head_sha: sha, status: 'completed', conclusion, app: { slug: 'github-actions' }, pull_requests: [{ number: 7 }] },
});
const checkSuite = (conclusion, sha = HEAD, id = 1) => ({
  action: 'completed', repository: repoPayload,
  check_suite: { id, head_sha: sha, status: 'completed', conclusion, app: { slug: 'github-actions' }, pull_requests: [{ number: 7 }] },
});
const review = (state, sha = HEAD) => ({ action: 'submitted', repository: repoPayload, pull_request: { number: 7 }, review: { state, commit_id: sha } });

/** A covered, healthy repo with PR 7 opened after the bootstrap. */
function coveredWorker() {
  const w = worker();
  w.bootstrap([]);
  w.deliver('pull_request', prPayload('opened'));
  return w;
}

describe('readPrFacts — served only when trustworthy', () => {
  it('healthy and covered → served from the store, with source and the normalized fields', async () => {
    const w = coveredWorker();
    w.deliver('check_run', checkRun('test', 'success'));
    const f = await readPrFacts({ ...w.opts(), number: 7 });
    expect(f).toMatchObject({
      repo: 'web-everything/web-everything', number: 7, headSha: HEAD, draft: false, state: 'open', merged: false,
      labels: ['review:pending'], checks: [{ name: 'test', app: 'github-actions', conclusion: 'success' }], source: 'store',
    });
    expect(Object.keys(f)).toEqual(expect.arrayContaining(['headSha', 'draft', 'state', 'merged', 'labels', 'checks', 'suites', 'review']));
  });

  it('a stale feed (no webhook delivery for staleAfterMs) → null', async () => {
    const w = coveredWorker();
    w.clock.t += PR_FACTS_DEFAULTS.staleAfterMs + 1;
    expect(await lookupPrFacts({ ...w.opts(), number: 7 })).toEqual({ facts: null, reason: 'feed-stale' });
  });

  it('no bootstrap baseline → null; a truncated one → null', async () => {
    const w = worker();
    w.deliver('pull_request', prPayload('opened'));
    expect(await lookupPrFacts({ ...w.opts(), number: 7 })).toEqual({ facts: null, reason: 'no-bootstrap' });
    const t = worker();
    t.bootstrap([], 'truncated');
    t.deliver('pull_request', prPayload('opened'));
    expect(await lookupPrFacts({ ...t.opts({ dir: join(dir, 'other') }), number: 7 })).toEqual({ facts: null, reason: 'bootstrap-truncated' });
  });

  it('a PR the store has no row for → null', async () => {
    const w = coveredWorker();
    expect(await lookupPrFacts({ ...w.opts(), number: 8 })).toEqual({ facts: null, reason: 'no-row' });
  });

  it('a row seen only through a check (no head/state yet) → null', async () => {
    const w = worker();
    w.bootstrap([]);
    w.deliver('check_run', checkRun('test', 'success'));
    expect(await lookupPrFacts({ ...w.opts(), number: 7 })).toEqual({ facts: null, reason: 'incomplete-row' });
  });

  it('the Worker unreachable (e.g. no /prs route deployed) → null', async () => {
    const w = coveredWorker();
    w.down = true;
    expect(await lookupPrFacts({ ...w.opts(), number: 7 })).toEqual({ facts: null, reason: 'feed-unreachable' });
  });

  it('a gap (events pruned before the mirror read them) forces a full /prs pull, never a partial fold', async () => {
    const w = worker({ maxEvents: 2 });
    w.bootstrap([]);
    w.deliver('pull_request', prPayload('opened'));
    expect(await readPrFacts({ ...w.opts(), number: 7 })).toBeTruthy();
    expect(w.hits.prs).toBe(1);
    const have = ['review:pending'];
    for (const l of ['a', 'b', 'c']) { have.push(l); w.deliver('pull_request', labelEvent('labeled', l, have)); }
    w.clock.t += PR_FACTS_DEFAULTS.refreshAfterMs;
    const f = await readPrFacts({ ...w.opts(), number: 7 });
    expect(w.hits.prs).toBe(2);
    expect(f.labels).toEqual(['a', 'b', 'c', 'review:pending']);
    // ...and a gap whose full pull then fails is not served.
    for (const l of ['d', 'e', 'f']) { have.push(l); w.deliver('pull_request', labelEvent('labeled', l, have)); }
    w.clock.t += PR_FACTS_DEFAULTS.refreshAfterMs;
    const realFetch = w.fetchImpl;
    const opts = w.opts({ fetchImpl: async (url, init) => (new URL(url).pathname === '/prs' ? new Response('', { status: 500 }) : realFetch(url, init)) });
    expect(await lookupPrFacts({ ...opts, number: 7 })).toEqual({ facts: null, reason: 'feed-unreachable' });
  });

  it('TTL passed (mirror cannot refresh) → null, and the fallback reader answers from GitHub and says so', async () => {
    const w = coveredWorker();
    expect(await readPrFacts({ ...w.opts(), number: 7 })).toBeTruthy();
    // The Worker stops answering /events but the last delivery is still recent: only the TTL guards the answer.
    const opts = w.opts({ fetchImpl: async () => { throw new Error('ECONNRESET'); }, refreshAfterMs: 10 ** 9 });
    w.clock.t += PR_FACTS_DEFAULTS.ttlMs - 1;
    expect((await lookupPrFacts({ ...opts, number: 7 })).reason).toBe('served');
    w.clock.t += 1;
    expect(await lookupPrFacts({ ...opts, number: 7 })).toEqual({ facts: null, reason: 'ttl-expired' });
    const r = await readPrFactsOrGithub({ ...opts, number: 7, exec: fakeGh(githubFixture()) });
    expect(r).toMatchObject({ source: 'github', reason: 'ttl-expired', facts: { number: 7, headSha: HEAD, source: 'github' } });
  });

  it('the TTL is a declared setting (WE_PR_FACTS_TTL_MS), default 120 s', () => {
    expect(PR_FACTS_DEFAULTS.ttlMs).toBe(120_000);
    expect(resolvePrFactsConfig({ WE_PR_FACTS_TTL_MS: '30000' }).ttlMs).toBe(30_000);
    expect(resolvePrFactsConfig({}).ttlMs).toBe(120_000);
    expect(resolvePrFactsConfig({ WE_PR_EVENTS_URL: 'https://x', WE_PR_EVENTS_TOKEN: 't', WE_PR_FACTS: '0' }).enabled).toBe(false);
    expect(resolvePrFactsConfig({ WE_PR_EVENTS_URL: 'https://x', WE_PR_EVENTS_TOKEN: 't' }).enabled).toBe(true);
  });
});

describe('the mirror follows deltas', () => {
  it('a labeled delta updates labels without a full pull', async () => {
    const w = coveredWorker();
    expect((await readPrFacts({ ...w.opts(), number: 7 })).labels).toEqual(['review:pending']);
    w.deliver('pull_request', labelEvent('labeled', 'review:accepted', ['review:pending', 'review:accepted']));
    w.deliver('pull_request', labelEvent('unlabeled', 'review:pending', ['review:accepted']));
    w.clock.t += PR_FACTS_DEFAULTS.refreshAfterMs;
    expect((await readPrFacts({ ...w.opts(), number: 7 })).labels).toEqual(['review:accepted']);
    expect(w.hits.prs).toBe(1);
    expect(w.hits.events).toBe(1);
  });

  it('within refreshAfterMs the mirror is reused (no Worker call at all)', async () => {
    const w = coveredWorker();
    await readPrFacts({ ...w.opts(), number: 7 });
    await readPrFacts({ ...w.opts(), number: 7 });
    expect(w.hits).toEqual({ prs: 1, events: 0 });
  });

  it('a bootstrap racing a labeled event keeps the event (field clocks)', async () => {
    const w = worker();
    w.deliver('pull_request', prPayload('opened'));
    const base = Number(w.log.read(null).head);
    w.deliver('pull_request', labelEvent('labeled', 'review:accepted', ['review:pending', 'review:accepted']));
    // The listing was taken BEFORE the labeled event but imported after it.
    w.log.bootstrap({ repo: REPO, importId: 'race', baseCursor: base, status: 'complete',
      prs: [{ number: 7, sha: HEAD, draft: false, labels: ['review:pending'], state: 'open' }] }, w.clock.t);
    expect((await readPrFacts({ ...w.opts(), number: 7 })).labels).toEqual(['review:accepted', 'review:pending']);
  });

  it('a push moves the head: checks are the new head only', async () => {
    const w = coveredWorker();
    w.deliver('check_run', checkRun('test', 'failure'));
    await readPrFacts({ ...w.opts(), number: 7 });
    w.deliver('pull_request', prPayload('synchronize', { head: { sha: OLD } }));
    w.clock.t += PR_FACTS_DEFAULTS.refreshAfterMs;
    const f = await readPrFacts({ ...w.opts(), number: 7 });
    expect(f.headSha).toBe(OLD);
    expect(f.checks).toEqual([]);
  });

  it('readRepoFacts serves every complete row of a trustworthy repo', async () => {
    const w = coveredWorker();
    w.deliver('check_run', checkRun('test', 'success', HEAD, 2));
    const r = await readRepoFacts(w.opts());
    expect(r.prs.map((p) => [p.number, p.headSha])).toEqual([[7, HEAD]]);
    w.down = true;
    w.clock.t += PR_FACTS_DEFAULTS.refreshAfterMs;
    expect(await readRepoFacts(w.opts())).toBeNull();
  });
});

// ── contract: the store's answer and GitHub's answer agree on a fixture PR ─────────────────────────────────

function githubFixture() {
  return {
    [`repos/${REPO}/pulls/7`]: { number: 7, state: 'open', draft: false, merged: false, head: { sha: HEAD },
      labels: [{ name: 'review:pending' }, { name: 'size:s' }] },
    [`repos/${REPO}/commits/${HEAD}/check-runs?per_page=100`]: { check_runs: [
      { id: 10, name: 'test', head_sha: HEAD, status: 'completed', conclusion: 'failure', app: { slug: 'github-actions' } },
      { id: 11, name: 'test', head_sha: HEAD, status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } }, // re-run wins
      { id: 12, name: 'lint', head_sha: HEAD, status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } },
      { id: 13, name: 'e2e', head_sha: HEAD, status: 'in_progress', conclusion: null, app: { slug: 'github-actions' } }, // not stored
    ] },
    [`repos/${REPO}/commits/${HEAD}/check-suites?per_page=100`]: { check_suites: [
      { id: 20, head_sha: HEAD, status: 'completed', conclusion: 'success', app: { slug: 'github-actions' } },
    ] },
    [`repos/${REPO}/pulls/7/reviews?per_page=100`]: [
      { id: 30, state: 'COMMENTED', commit_id: OLD, submitted_at: '2026-10-06T10:00:00Z' },
      { id: 31, state: 'APPROVED', commit_id: HEAD, submitted_at: '2026-10-06T11:00:00Z' },
    ],
  };
}

function fakeGh(fixture, calls = []) {
  return (file, args) => {
    const path = args[args.length - 1];
    calls.push(path);
    if (!(path in fixture)) throw new Error(`unexpected gh api ${path}`);
    return JSON.stringify(fixture[path]);
  };
}

describe('contract: store answer = GitHub answer', () => {
  it('the same fixture PR, delivered as webhooks and read from REST, gives identical facts', async () => {
    const fx = githubFixture();
    const w = worker();
    w.bootstrap([]);
    // The same history GitHub holds, as the webhooks that reported it.
    w.deliver('pull_request', prPayload('opened', { labels: [{ name: 'review:pending' }] }));
    w.deliver('pull_request', labelEvent('labeled', 'size:s', ['review:pending', 'size:s']));
    for (const c of fx[`repos/${REPO}/commits/${HEAD}/check-runs?per_page=100`].check_runs.filter((r) => r.status === 'completed')) {
      w.deliver('check_run', { action: 'completed', repository: repoPayload, check_run: { ...c, pull_requests: [{ number: 7 }] } });
    }
    w.deliver('check_suite', checkSuite('success', HEAD, 20));
    w.deliver('pull_request_review', review('commented', OLD));
    w.deliver('pull_request_review', review('approved', HEAD));

    const store = await readPrFacts({ ...w.opts(), number: 7 });
    const calls = [];
    const gh = readPrFactsFromGithub({ repo: REPO, number: 7, exec: fakeGh(fx, calls) });
    const strip = ({ source, asOfMs, cursor, ...facts }) => facts;
    expect(store.source).toBe('store');
    expect(gh.source).toBe('github');
    expect(strip(store)).toEqual(strip(gh));
    expect(strip(store)).toMatchObject({ labels: ['review:pending', 'size:s'], review: { sha: HEAD, state: 'approved' },
      checks: [{ name: 'lint', app: 'github-actions', conclusion: 'success' }, { name: 'test', app: 'github-actions', conclusion: 'success' }] });
    expect(calls).toHaveLength(4);
  });

  it('a merged PR agrees too', async () => {
    const fx = githubFixture();
    fx[`repos/${REPO}/pulls/7`] = { ...fx[`repos/${REPO}/pulls/7`], state: 'closed', merged: true };
    fx[`repos/${REPO}/commits/${HEAD}/check-runs?per_page=100`] = { check_runs: [] };
    fx[`repos/${REPO}/commits/${HEAD}/check-suites?per_page=100`] = { check_suites: [] };
    fx[`repos/${REPO}/pulls/7/reviews?per_page=100`] = [];
    const w = worker();
    w.bootstrap([]);
    w.deliver('pull_request', prPayload('opened', { labels: [{ name: 'review:pending' }, { name: 'size:s' }] }));
    await readPrFacts({ ...w.opts(), number: 7 }); // observe the closure through a delta, not an undated full seed
    w.deliver('pull_request', prPayload('closed', { state: 'closed', merged: true, labels: [{ name: 'review:pending' }, { name: 'size:s' }] }));
    w.clock.t += PR_FACTS_DEFAULTS.refreshAfterMs;
    const strip = ({ source, asOfMs, cursor, ...facts }) => facts;
    const store = await readPrFacts({ ...w.opts(), number: 7 });
    expect(strip(store)).toEqual(strip(readPrFactsFromGithub({ repo: REPO, number: 7, exec: fakeGh(fx) })));
    expect(store).toMatchObject({ state: 'closed', merged: true });
  });
});

it('suppresses real state with WE_UNDER_TEST alone', () => {
  expect(resolvePrFactsConfig({ WE_UNDER_TEST: '1' })).toMatchObject({ enabled: false, disabledReason: 'test run' });
});

describe('mirror compaction', () => {
  const key = (n) => JSON.stringify([REPO.toLowerCase(), n]);
  const shaKey = (sha) => JSON.stringify([REPO.toLowerCase(), sha]);
  const check = (sha, prs = [7], at = T0) => ({ type: 'check_run', repo: REPO.toLowerCase(), sha, prs,
    name: 'test', app: 'github-actions', conclusion: 'success', seq: 2, at: new Date(at).toISOString() });
  const row = (number, state = 'open') => ({ repo: REPO, number, sha: HEAD, state, draft: false, labels: ['review:pending'],
    checks: [check(HEAD), check(OLD)], suites: [] });
  const body = (prs = [row(7)]) => ({ prs, stateCursor: 10, lastDeliveryAt: T0,
    coverage: { bootstrap: [{ repo: REPO, status: 'complete' }] } });
  const seed = (prs) => seedMirror({ repo: REPO, body: body(prs), nowMs: T0 });
  const compact = (m, retentionMs = 1000, nowMs = T0) => compactMirror(m, { nowMs, retentionMs });
  const lookup = (m, number = 7) => lookupInMirror(m, { number, nowMs: T0 });

  it('preserves open facts, removes stale-head checks, and keeps historical open SHA mappings', () => {
    const m = seed();
    m.buckets.shas[shaKey(OLD)] = [7];
    const before = structuredClone(m);
    const next = compact(m);
    expect(lookup(next)).toEqual(lookup(m));
    expect(lookup(next).facts.checks).toHaveLength(1);
    // Old heads keep their checks: a head that returns to an old sha must still see its failures.
    expect(Object.values(next.buckets.checks).map((c) => c.sha).sort()).toEqual([HEAD, OLD].sort());
    expect(next.buckets.shas).toEqual(m.buckets.shas);
    expect(m).toEqual(before);
    expect(compact(next)).toEqual(next);
  });

  it.each([false, true])('retains all checks for a recently closed PR (merged=%s), then expires at the boundary', (merged) => {
    const m = seed([{ ...row(7, 'closed'), merged }]);
    m.closedSeen = { 7: T0 - 999 };
    const next = compact(m);
    expect(next.buckets.prs).toEqual(m.buckets.prs);
    expect(next.buckets.checks).toEqual(m.buckets.checks);
    expect(lookup(next).facts).toMatchObject({ state: 'closed', merged });
    const expired = compact(next, 1000, T0 + 1);
    expect(expired.buckets).toEqual({ prs: {}, checks: {}, shas: {} });
    expect(expired.closedSeen).toEqual({});
    expect(lookup(expired)).toEqual({ facts: null, reason: 'no-row' });
    expect(compact(expired)).toEqual(expired);
  });

  it('prunes evicted PRs from shared SHA entries and retains checks shared with an open current head', () => {
    const m = seed([row(7), row(8, 'closed')]);
    m.closedSeen = { 8: T0 - 1000 };
    m.buckets.shas[shaKey(OLD)] = [8];
    const next = compact(m);
    expect(next.buckets.shas).toEqual({ [shaKey(HEAD)]: [7] });
    expect(Object.values(next.buckets.checks).map((c) => c.sha).sort()).toEqual([HEAD, OLD].sort());
    expect(lookup(next)).toEqual(lookup(m));
  });

  it('a PR reopened after eviction is never served from the mirror', () => {
    const m = seed([row(7, 'closed')]);
    m.closedSeen = { 7: T0 - 1000 };
    const next = compact(m);
    expect(next.evicted).toEqual([7]);
    const reopened = applyDelta(next, [{ seq: 11, repo: REPO.toLowerCase(), type: 'pull_request', action: 'reopened', number: 7, sha: HEAD, draft: false, labels: [] }]);
    expect(lookup(reopened).facts).toBeNull();
    expect(lookup({ ...reopened, evicted: [] }).reason).not.toBe('evicted');
    expect(lookup(compact(reopened, 10 ** 9)).facts).toBeNull();
  });

  it('keeps a current-head check joined to an open PR only through the sha bucket', () => {
    const m = seed();
    const c = check(HEAD, [], T0);
    m.buckets.checks = { x: c };
    const next = compact(m);
    expect(Object.keys(next.buckets.checks)).toEqual(['x']);
    expect(lookup(next)).toEqual(lookup(m));
  });

  it('keeps only recent unattached checks; unknown, old and future dates are dropped', () => {
    const m = seed([]);
    m.buckets.checks = Object.fromEntries([T0, T0 - 1000, T0 + 1, NaN].map((at, i) => [i,
      { ...check(HEAD, [], T0), at: Number.isNaN(at) ? null : new Date(at).toISOString() }]));
    expect(Object.keys(compact(m).buckets.checks)).toEqual(['0']);
  });

  it('honours zero and large retention values without clamping, including legacy mirrors', () => {
    const m = seed([row(7, 'closed'), row(8)]);
    delete m.closedSeen;
    expect(compact(m, 0).buckets.prs).toEqual({ [key(8)]: m.buckets.prs[key(8)] });
    const next = compact(m, 10 ** 12);
    expect(next.closedSeen).toEqual({});
    expect(next.buckets.prs).toEqual({ [key(8)]: m.buckets.prs[key(8)] });
    const dated = { ...m, closedSeen: { 7: T0 } };
    expect(compact(dated, 10 ** 12, T0 + 10 ** 11).buckets.prs).toEqual(m.buckets.prs);
    expect(compact(m, 1000).buckets.prs).toEqual({ [key(8)]: m.buckets.prs[key(8)] });
  });

  it('a reopened PR loses its closure timestamp', () => {
    const m = seed();
    m.closedSeen = { 7: T0 - 1000, 99: T0 };
    expect(compact(m).closedSeen).toEqual({});
  });

  it('late delta events create bounded skeletons for evicted PRs', () => {
    const evicted = compact(seed([row(7, 'closed')]));
    const event = { ...parseGithubEvent('pull_request_review', review('approved'), { receivedAt: T0 }), seq: 11 };
    const next = compact(applyDelta(evicted, [event]));
    expect(next.closedSeen).toEqual({ 7: T0 });
    expect(lookup(next)).toEqual({ facts: null, reason: 'evicted' });
    expect(compact(next, 1000, T0 + 1000).buckets.prs).toEqual({});
    expect(compact(applyDelta(evicted, [event]), 0).buckets.prs).toEqual({});
  });

  it('full seeds expire unknown closures and carry known closure timestamps from the previous mirror', () => {
    const b = body([row(7, 'closed'), row(8, 'closed')]);
    const m = seedMirror({ repo: REPO, body: b, nowMs: T0, retentionMs: 1000, prev: { closedSeen: { 7: T0 - 500 } } });
    expect(compact(m).closedSeen).toEqual({ 7: T0 - 500 });
    expect(compact(seedMirror({ repo: REPO, body: b, nowMs: T0, retentionMs: 10 ** 12 }), 10 ** 12).buckets.prs).toEqual({});
  });

  it.each(['full', 'full:gap', 'full:reset', 'full:backlog', 'delta'])('compacts successful refresh mode %s', async (mode) => {
    const prev = seed([row(7, 'closed'), row(8)]);
    prev.closedSeen = { 7: T0 - 1000 };
    const fetchImpl = async (url) => new Response(JSON.stringify(url.endsWith('/prs') ? body([row(7, 'closed'), row(8)]) :
      { cursor: 11, events: [], gap: mode === 'full:gap', reset: mode === 'full:reset', more: mode === 'full:backlog' }));
    const r = await refreshMirror(mode === 'full' ? null : prev, { repo: REPO, url: 'https://w.local', nowMs: T0,
      retentionMs: 1000, maxDeltaPages: 1, fetchImpl });
    expect(r.mode).toBe(mode);
    expect(Object.values(r.mirror.buckets.prs).map((p) => p.number)).toEqual([8]);
    expect(r.mirror.closedSeen).toEqual({});
    expect(Object.values(r.mirror.buckets.checks).map((c) => c.sha).sort()).toEqual([HEAD, OLD].sort());
  });

  it('does not compact failed refreshes', async () => {
    const prev = seed([row(7, 'closed')]);
    const r = await refreshMirror(prev, { repo: REPO, url: 'https://w.local', nowMs: T0, retentionMs: 0,
      fetchImpl: async () => { throw new Error('offline'); } });
    expect(r.mode).toBe('failed');
    expect(r.mirror.buckets).toEqual(prev.buckets);
    expect(r.mirror.closedSeen).toEqual(prev.closedSeen);
  });

  it('declares 24h retention, resolves invalid settings, and writes compacted deltas using the environment setting', async () => {
    expect(PR_FACTS_DEFAULTS.closedRetentionMs).toBe(86_400_000);
    for (const value of [undefined, '', '-1', 'bad', 'Infinity']) {
      expect(resolvePrFactsConfig({ WE_PR_FACTS_CLOSED_RETENTION_MS: value }).closedRetentionMs).toBe(86_400_000);
    }
    expect(resolvePrFactsConfig({ WE_PR_FACTS_CLOSED_RETENTION_MS: '1000000000000' }).closedRetentionMs).toBe(10 ** 12);
    const w = coveredWorker();
    await loadMirror(w.opts());
    w.deliver('pull_request', prPayload('closed', { state: 'closed' }));
    w.clock.t += PR_FACTS_DEFAULTS.refreshAfterMs;
    const { mirror } = await loadMirror(w.opts({ env: { WE_PR_FACTS_CLOSED_RETENTION_MS: '0' } }));
    expect(mirror.buckets).toEqual({ prs: {}, checks: {}, shas: {} });
    expect(readMirrorFile(mirrorPath(dir, REPO))).toEqual(mirror);
  });
});
