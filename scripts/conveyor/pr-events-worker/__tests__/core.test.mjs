/**
 * @file The PR-events receiver core: signature verification (incl. GitHub's published test vector), event
 * parsing (kept/ignored, no user text stored), cursor semantics, and the HTTP routing + fail-closed auth.
 */
import { describe, it, expect } from 'vitest';
import {
  verifySignature, signBody, parseGithubEvent, createEventLog, createMemoryStorage, handleRequest, timingSafeEqual,
} from '../core.mjs';

const REPO = { full_name: 'web-everything/web-everything' };

describe('verifySignature', () => {
  it('matches GitHub\'s documented test vector', async () => {
    // docs.github.com "Validating webhook deliveries" — secret + payload → expected header.
    const header = 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';
    expect(await verifySignature("It's a Secret to Everybody", 'Hello, World!', header)).toBe(true);
    expect(await signBody("It's a Secret to Everybody", 'Hello, World!')).toBe(header);
  });

  it('rejects a tampered body, a wrong secret, a malformed or missing header, and a missing secret', async () => {
    const good = await signBody('s3cret', '{"a":1}');
    expect(await verifySignature('s3cret', '{"a":1}', good)).toBe(true);
    expect(await verifySignature('s3cret', '{"a":2}', good)).toBe(false);
    expect(await verifySignature('other', '{"a":1}', good)).toBe(false);
    expect(await verifySignature('s3cret', '{"a":1}', good.replace('sha256=', 'sha1='))).toBe(false);
    expect(await verifySignature('s3cret', '{"a":1}', null)).toBe(false);
    expect(await verifySignature('', '{"a":1}', good)).toBe(false);
  });

  it('verifies over raw bytes, identical to the string form', async () => {
    const bytes = new TextEncoder().encode('{"x":"é"}');
    expect(await verifySignature('k', bytes, await signBody('k', '{"x":"é"}'))).toBe(true);
  });

  it('timingSafeEqual compares exactly', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('parseGithubEvent', () => {
  const at = Date.parse('2026-09-27T12:00:00Z');
  it('keeps pull_request lifecycle actions with ids only — never title/body/login', () => {
    const r = parseGithubEvent('pull_request', {
      action: 'labeled', number: 12, label: { name: 'review:pending' }, repository: REPO,
      pull_request: { number: 12, title: 'SECRET TITLE', body: 'SECRET BODY', head: { sha: 'abc' }, user: { login: 'someone' } },
      sender: { login: 'someone' },
    }, { deliveryId: 'd1', receivedAt: at });
    expect(r).toEqual({ id: 'd1', at: '2026-09-27T12:00:00.000Z', type: 'pull_request', action: 'labeled', repo: 'web-everything/web-everything', prs: [12], sha: 'abc', label: 'review:pending' });
    expect(JSON.stringify(r)).not.toMatch(/SECRET|someone/);
  });

  it('records merged on closed and the check conclusion/name on check events', () => {
    expect(parseGithubEvent('pull_request', { action: 'closed', number: 3, repository: REPO, pull_request: { merged: true, head: { sha: 'h' } } }).merged).toBe(true);
    const cr = parseGithubEvent('check_run', { action: 'completed', repository: REPO, check_run: { name: 'test', head_sha: 'h', conclusion: 'failure', pull_requests: [{ number: 3 }] } });
    expect(cr).toMatchObject({ type: 'check_run', prs: [3], sha: 'h', conclusion: 'failure', name: 'test' });
    const cs = parseGithubEvent('check_suite', { action: 'completed', repository: REPO, check_suite: { head_sha: 'h', conclusion: 'success', app: { slug: 'github-actions' }, pull_requests: [] } });
    expect(cs).toMatchObject({ type: 'check_suite', prs: [], conclusion: 'success', app: 'github-actions' });
    const rv = parseGithubEvent('pull_request_review', { action: 'submitted', repository: REPO, pull_request: { number: 3 }, review: { state: 'CHANGES_REQUESTED', commit_id: 'h', body: 'x' } });
    expect(rv).toMatchObject({ type: 'pull_request_review', prs: [3], state: 'changes_requested' });
  });

  it('ignores events and actions outside the accepted set', () => {
    expect(parseGithubEvent('pull_request', { action: 'edited', number: 1, repository: REPO, pull_request: {} })).toBeNull();
    expect(parseGithubEvent('check_run', { action: 'created', repository: REPO, check_run: {} })).toBeNull();
    expect(parseGithubEvent('issues', { action: 'opened', repository: REPO })).toBeNull();
    expect(parseGithubEvent('ping', { zen: 'x', repository: REPO })).toBeNull();
    expect(parseGithubEvent('pull_request', { action: 'opened', number: 1 })).toBeNull(); // no repository
  });
});

describe('event log cursor semantics', () => {
  const rec = (i) => ({ id: `d${i}`, type: 'pull_request', action: 'opened', repo: 'r', prs: [i] });

  it('a fresh reader (no cursor) starts at head with no replay', () => {
    const log = createEventLog(createMemoryStorage());
    log.append(rec(1), 1000); log.append(rec(2), 2000);
    expect(log.read(null)).toMatchObject({ cursor: 2, events: [], reset: true, head: 2 });
  });

  it('returns only seq > cursor, oldest first, strictly increasing', () => {
    const log = createEventLog(createMemoryStorage());
    for (let i = 1; i <= 5; i += 1) log.append(rec(i), i * 1000);
    const r = log.read(2);
    expect(r.events.map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(r).toMatchObject({ cursor: 5, gap: false, reset: false, more: false, lastEventAt: 5000, lastDeliveryAt: 5000 });
    expect(log.read(5)).toMatchObject({ cursor: 5, events: [] });
  });

  it('pages with `more` when the limit cuts the answer short', () => {
    const log = createEventLog(createMemoryStorage());
    for (let i = 1; i <= 5; i += 1) log.append(rec(i), i);
    const p1 = log.read(0, 2);
    expect(p1.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(p1.more).toBe(true);
    const p2 = log.read(p1.cursor, 2);
    expect(p2.events.map((e) => e.seq)).toEqual([3, 4]);
    expect(log.read(p2.cursor, 2)).toMatchObject({ cursor: 5, more: false });
  });

  it('stores a redelivery (same delivery id) once, but still counts it as a delivery', () => {
    const log = createEventLog(createMemoryStorage());
    expect(log.append(rec(1), 1000)).toEqual({ seq: 1, duplicate: false });
    expect(log.append(rec(1), 9000)).toEqual({ seq: null, duplicate: true });
    expect(log.read(0)).toMatchObject({ head: 1, lastDeliveryAt: 9000, lastEventAt: 1000 });
  });

  it('flags a gap when events the reader never saw were pruned, and never reuses a seq', () => {
    const log = createEventLog(createMemoryStorage(), { maxEvents: 3 });
    for (let i = 1; i <= 6; i += 1) log.append(rec(i), i);
    const r = log.read(1);
    expect(r.gap).toBe(true);
    expect(r.events.map((e) => e.seq)).toEqual([4, 5, 6]);
    expect(log.read(3).gap).toBe(false); // 3 = oldest-1: nothing missed
    log.append(rec(7), 7);
    expect(log.read(6).events.map((e) => e.seq)).toEqual([7]);
  });

  it('prunes by age too', () => {
    const log = createEventLog(createMemoryStorage(), { retentionMs: 120 }); // cutoff at t=160 is 40
    log.append(rec(1), 0); log.append(rec(2), 50); log.append(rec(3), 160);
    expect(log.read(0).events.map((e) => e.seq)).toEqual([2, 3]);
  });

  it('a cursor beyond head (log recreated) answers reset', () => {
    const log = createEventLog(createMemoryStorage());
    log.append(rec(1), 1);
    expect(log.read(99)).toMatchObject({ cursor: 1, events: [], reset: true });
  });
});

describe('handleRequest', () => {
  const env = { GITHUB_WEBHOOK_SECRET: 'whsec', PR_EVENTS_READ_TOKEN: 'readtok' };
  const setup = () => { const log = createEventLog(createMemoryStorage()); return { log, opts: { getLog: () => log, now: () => 1_000 } }; };
  const hook = async (body, { event = 'pull_request', delivery = 'd1', secret = 'whsec' } = {}) => {
    const raw = JSON.stringify(body);
    return new Request('https://x/github/webhook', { method: 'POST', body: raw, headers: { 'x-github-event': event, 'x-github-delivery': delivery, 'x-hub-signature-256': await signBody(secret, raw) } });
  };
  const opened = { action: 'opened', number: 7, repository: REPO, pull_request: { number: 7, head: { sha: 's' } } };

  it('stores a signed accepted event (202) and ignores a signed ping (200, counted as a delivery)', async () => {
    const { log, opts } = setup();
    const r = await handleRequest(await hook(opened), env, opts);
    expect(r.status).toBe(202);
    expect(await r.json()).toMatchObject({ stored: true, seq: 1 });
    const p = await handleRequest(await hook({ zen: 'z', repository: REPO }, { event: 'ping', delivery: 'p1' }), env, opts);
    expect(p.status).toBe(200);
    expect(log.read(0).events).toHaveLength(1);
  });

  it('refuses a bad signature (401) and fails closed when the secret is not configured (503)', async () => {
    const { log, opts } = setup();
    expect((await handleRequest(await hook(opened, { secret: 'wrong' }), env, opts)).status).toBe(401);
    expect((await handleRequest(await hook(opened), { ...env, GITHUB_WEBHOOK_SECRET: undefined }, opts)).status).toBe(503);
    expect(log.read(0).events).toHaveLength(0);
  });

  it('serves /events only with the read token, never with the webhook secret', async () => {
    const { opts } = setup();
    await handleRequest(await hook(opened), env, opts);
    const get = (auth) => handleRequest(new Request('https://x/events?cursor=0', { headers: auth ? { authorization: auth } : {} }), env, opts);
    expect((await get(null)).status).toBe(401);
    expect((await get('Bearer whsec')).status).toBe(401);
    const ok = await get('Bearer readtok');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ cursor: 1, events: [{ seq: 1, prs: [7] }] });
    expect((await handleRequest(new Request('https://x/events'), { ...env, PR_EVENTS_READ_TOKEN: '' }, opts)).status).toBe(503);
  });

  it('answers /health without data and 404 elsewhere', async () => {
    const { opts } = setup();
    expect(await (await handleRequest(new Request('https://x/health'), {}, opts)).json()).toEqual({ ok: true });
    expect((await handleRequest(new Request('https://x/'), env, opts)).status).toBe(404);
  });
});

it('reads signed lifecycle evidence through the authenticated PR snapshot', async () => {
  const log = createEventLog(createMemoryStorage());
  const env = { GITHUB_WEBHOOK_SECRET: 'test', PR_EVENTS_READ_TOKEN: 'read' };
  const body = JSON.stringify({ repository: REPO, action: 'opened', number: 4281,
    pull_request: { head: { sha: 'head' }, draft: false, labels: [], state: 'open' } });
  await handleRequest(new Request('https://test/github/webhook', { method: 'POST', body,
    headers: { 'x-github-event': 'pull_request', 'x-hub-signature-256': await signBody('test', body) } }), env, { getLog: () => log });
  const response = await handleRequest(new Request('https://test/prs?cursor=0', { headers: { authorization: 'Bearer read' } }), env, { getLog: () => log });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ cursor: 1, stateCursor: 1, prs: [{ number: 4281, sha: 'head', draft: false, labels: [], state: 'open' }] });
});

const lifecycle = (action, pr = {}, repo = 'o/r', number = 1) => parseGithubEvent('pull_request', {
  repository: { full_name: repo }, number, action, pull_request: pr,
});
const check = (sha, prs = [], repo = 'o/r', type = 'check_run', conclusion = 'success') => ({
  repo, type, sha, prs, name: 'ci', app: 'app', conclusion, action: 'completed',
});

it('folds lifecycle, explicit false, label snapshots/deltas, unknown legacy fields and reviews', () => {
  const log = createEventLog(createMemoryStorage());
  const state = () => log.readPrs().prs[0];
  log.append(lifecycle('opened', { head: { sha: 'a' }, draft: true, labels: [{ name: 'one' }] }));
  log.append(lifecycle('ready_for_review', { draft: false }));
  expect(state().draft).toBe(false);
  log.append(lifecycle('converted_to_draft', { draft: true }));
  log.append({ ...lifecycle('labeled'), label: 'two' });
  log.append({ ...lifecycle('unlabeled'), label: 'one' });
  expect(state()).toMatchObject({ sha: 'a', draft: true, labels: ['two'] });
  log.append(lifecycle('synchronize', { head: { sha: 'b' } }));
  log.append({ repo: 'o/r', type: 'pull_request_review', prs: [1], sha: 'a', state: 'approved', action: 'submitted' });
  log.append({ repo: 'o/r', type: 'pull_request_review', prs: [1], sha: 'a', state: 'dismissed', action: 'dismissed' });
  expect(state()).toMatchObject({ sha: 'b', review: { sha: 'a', state: 'dismissed', seq: 8 } });
  log.append(lifecycle('closed', { merged: false }));
  expect(state()).toMatchObject({ state: 'closed', merged: false });
  log.append(lifecycle('reopened'));
  expect(state()).toMatchObject({ state: 'open', merged: false });
  log.append(lifecycle('closed', { merged: true, labels: [] }));
  expect(state()).toMatchObject({ state: 'closed', merged: true, labels: [] });
  const legacy = createEventLog(createMemoryStorage());
  legacy.append({ ...lifecycle('labeled'), label: 'partial' });
  expect(legacy.readPrs().prs[0]).toMatchObject({ sha: null, labels: null, draft: null, state: null, labelChanges: { partial: true } });
});

it('associates late, empty and multiple checks by repo/SHA, separates suites/runs and never guesses null SHAs', () => {
  const log = createEventLog(createMemoryStorage(), { maxEvents: 2 });
  log.append(check('a')); // unmatched until lifecycle arrives
  log.append(lifecycle('opened', { head: { sha: 'a' } }));
  log.append(lifecycle('opened', { head: { sha: 'a' } }, 'o/r', 2));
  log.append(lifecycle('opened', { head: { sha: 'a' } }, 'other/r'));
  log.append(lifecycle('synchronize', { head: { sha: 'b' } }));
  log.append(check('b', [1], 'o/r', 'check_run', 'failure'));
  log.append(check('a', [], 'o/r', 'check_suite'));
  log.append(check(null));
  log.append(check('explicit', [1, 2]));
  log.append({ ...check('a'), id: 'dedup' });
  expect(log.append({ ...check('a', [], 'o/r', 'check_run', 'failure'), id: 'dedup' }).duplicate).toBe(true);
  const rows = log.readPrs(0).prs;
  expect(rows[0]).toMatchObject({ sha: 'b', checks: [expect.objectContaining({ sha: 'a', conclusion: 'success' }), expect.objectContaining({ sha: 'b', conclusion: 'failure' }), expect.objectContaining({ sha: 'explicit' })], suites: [expect.objectContaining({ sha: 'a' })] });
  expect(rows[1].checks.map((c) => c.sha)).toEqual(['a', 'explicit']);
  expect(rows[2].checks).toEqual([]);
  expect(log.readPrs(0).gap).toBe(true);
  expect(rows.flatMap((r) => r.checks).some((c) => c.sha === null)).toBe(false);
});

it('exposes snapshot coverage with independent delta positions and fails closed on read/write credentials', async () => {
  const log = createEventLog(createMemoryStorage(), { maxEvents: 2 });
  const env = { PR_EVENTS_READ_TOKEN: 'read', PR_EVENTS_BOOTSTRAP_TOKEN: 'write' };
  const request = (path, token = 'read', method = 'GET', bindings = env) => handleRequest(new Request(`https://test${path}`, {
    method, headers: token ? { authorization: `Bearer ${token}` } : {},
  }), bindings, { getLog: () => log, now: () => 123 });
  for (let i = 0; i < 4; i++) log.append(lifecycle('synchronize', { head: { sha: String(i) } }));
  for (const query of ['', '?cursor=bad', '?cursor=999']) {
    expect(await (await request(`/prs${query}`)).json()).toMatchObject({ cursor: 4, stateCursor: 4, head: 4, events: [], reset: true, gap: false, more: false, now: 123,
      prs: [{ sha: '3', draft: null, labels: null, review: null, checks: [], suites: [] }],
      coverage: { partial: true, historyComplete: false, observedSince: 1, retainedReplayBoundary: null, bootstrap: [] } });
  }
  expect(await (await request('/prs?cursor=0&limit=1')).json()).toMatchObject({ cursor: 3, stateCursor: 4, gap: true, more: true, reset: false, events: [{ seq: 3 }] });
  expect((await request('/prs', null)).status).toBe(401);
  expect((await request('/prs', 'bad')).status).toBe(401);
  expect((await request('/prs', 'read', 'GET', {})).status).toBe(503);
  expect((await request('/prs/bootstrap', 'read', 'POST')).status).toBe(401);
  expect((await request('/prs/bootstrap', 'write', 'POST', {})).status).toBe(503);
  expect((await request('/prs/bootstrap', 'write', 'POST')).status).toBe(400);
});


it('retains explicit check associations without lifecycle evidence and does not join null heads', () => {
  const log = createEventLog(createMemoryStorage());
  log.append(check('unseen', [4]));
  log.append(check('unseen', [], 'o/r', 'check_run', 'failure'));
  log.append(check(null, [5]));
  log.append(check(null, [], 'o/r', 'check_run', 'failure'));
  expect(log.readPrs().prs).toMatchObject([
    { number: 4, sha: null, checks: [{ sha: 'unseen', conclusion: 'failure' }] },
    { number: 5, sha: null, checks: [{ sha: null, conclusion: 'success' }] },
  ]);
});

it('keeps same-name check runs from different apps independent (and records the run app)', () => {
  const run = parseGithubEvent('check_run', { action: 'completed', repository: REPO,
    check_run: { name: 'ci', head_sha: 'a', conclusion: 'failure', app: { slug: 'app-one' }, pull_requests: [{ number: 1 }] } });
  expect(run).toMatchObject({ type: 'check_run', name: 'ci', app: 'app-one' });
  const log = createEventLog(createMemoryStorage());
  log.append(lifecycle('opened', { head: { sha: 'a' } }));
  log.append({ ...check('a', [1], 'o/r', 'check_run', 'failure'), app: 'app-one' });
  log.append({ ...check('a', [1], 'o/r', 'check_run', 'success'), app: 'app-two' });
  expect(log.readPrs().prs[0].checks.map((c) => [c.app, c.conclusion]).sort()).toEqual([['app-one', 'failure'], ['app-two', 'success']]);
  log.append({ ...check('a', [1], 'o/r', 'check_run', 'success'), app: 'app-one' });
  expect(log.readPrs().prs[0].checks.map((c) => [c.app, c.conclusion]).sort()).toEqual([['app-one', 'success'], ['app-two', 'success']]);
});

it('migrates legacy-shaped lifecycle events (no draft field) to a correct or null draft', () => {
  const legacy = (action) => ({ repo: 'o/r', type: 'pull_request', action, prs: [1], sha: 'a' });
  const log = createEventLog(createMemoryStorage());
  log.append({ ...legacy('opened'), draft: true });
  log.append(legacy('ready_for_review'));
  expect(log.readPrs().prs[0].draft).toBe(false);
  log.append(legacy('converted_to_draft'));
  expect(log.readPrs().prs[0].draft).toBe(true);
  const unknown = createEventLog(createMemoryStorage());
  unknown.append(legacy('synchronize'));
  expect(unknown.readPrs().prs[0].draft).toBeNull();
});

it('reads /prs with SQL lookups bounded by distinct SHAs, not PRs x checks', () => {
  const base = createMemoryStorage();
  let reads = 0;
  const storage = { ...base, getProjection: (...a) => { reads += 1; return base.getProjection(...a); } };
  const log = createEventLog(storage);
  for (let pr = 1; pr <= 40; pr += 1) log.append(lifecycle('opened', { head: { sha: `s${pr % 4}` } }, 'o/r', pr));
  for (let i = 0; i < 100; i += 1) log.append({ ...check(`s${i % 4}`), name: `job-${i}` });
  reads = 0;
  const { prs } = log.readPrs();
  expect(reads).toBeLessThanOrEqual(8);
  expect(prs).toHaveLength(40);
  expect(prs.every((p) => p.checks.length === 25)).toBe(true);
});
