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
  resolvePrFactsConfig,
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
    w.deliver('pull_request', prPayload('closed', { state: 'closed', merged: true, labels: [{ name: 'review:pending' }, { name: 'size:s' }] }));
    const strip = ({ source, asOfMs, cursor, ...facts }) => facts;
    const store = await readPrFacts({ ...w.opts(), number: 7 });
    expect(strip(store)).toEqual(strip(readPrFactsFromGithub({ repo: REPO, number: 7, exec: fakeGh(fx) })));
    expect(store).toMatchObject({ state: 'closed', merged: true });
  });
});
