import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { compareLedgerToGithub, readLedgerPrs, resolveLedgerMode } from '../pr-ledger-client.mjs';

const REPO = 'o/n';
const TOKEN = 'ledger-test-secret';
const NOW = Date.now();
const SHA = 'a'.repeat(40);
const row = (overrides = {}) => ({ repo: REPO, number: 1, sha: SHA, draft: false,
  labels: ['advisory:accepted'], state: 'open', merged: false, review: null,
  checks: [], suites: [], seq: 7, ...overrides });
const body = (overrides = {}) => ({ cursor: 7, head: 7, events: [], reset: false,
  gap: false, more: false, lastEventAt: NOW - 250, lastDeliveryAt: NOW - 250,
  now: NOW, stateCursor: 7, prs: [row()], coverage: {
    partial: true, observedSince: NOW - 1000, historyComplete: false,
    bootstrap: [{ repo: REPO, status: 'complete', baseCursor: 0, cursor: 7, importId: 'seed-1' }],
  }, ...overrides });
const githubPr = (number = 1, overrides = {}) => ({ number, headRefOid: SHA,
  isDraft: false, labels: [{ name: 'advisory:accepted' }], ...overrides });
const usable = (prs = [githubPr()]) => ({ ok: true, source: 'ledger', repo: REPO,
  prs, stateCursor: 7, lastDeliveryAt: NOW - 250, ageMs: 250 });

describe('readLedgerPrs — real HTTP fixture', () => {
  const servers = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    })));
  });

  async function serve(payload = body(), { status = 200, raw = false, hang = false } = {}) {
    const requests = [];
    const server = createServer((req, res) => {
      requests.push({ method: req.method, path: new URL(req.url, 'http://localhost').pathname,
        authorization: req.headers.authorization });
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401).end('unauthorized');
        return;
      }
      if (hang) return;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(raw ? payload : JSON.stringify(payload));
    });
    servers.push(server);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const url = `http://127.0.0.1:${server.address().port}`;
    const env = { WE_PR_EVENTS: '1', WE_PR_EVENTS_URL: url, WE_PR_EVENTS_TOKEN: TOKEN };
    return { url, env, requests };
  }

  function unavailable(result, reason, url) {
    expect(result).toEqual({ ok: false, source: 'unavailable', fallback: 'github', reason });
    expect(result.prs).not.toEqual([]);
    expect(result.reason).not.toContain(TOKEN);
    expect(result.reason).not.toContain(url);
  }

  it('GETs /prs with bearer auth and returns mapped OPEN rows of the requested repo, case-insensitively', async () => {
    const fixture = await serve(body({ prs: [row({ repo: 'O/N', draft: true }),
      row({ number: 2, repo: 'other/repo' }), row({ number: 3, state: 'closed' })] }));
    const result = await readLedgerPrs({ repo: REPO, env: fixture.env });
    expect(fixture.requests).toEqual([{ method: 'GET', path: '/prs', authorization: `Bearer ${TOKEN}` }]);
    expect(result).toEqual({ ...usable(), prs: [githubPr(1, { isDraft: true })] });
  });

  it('accepts explicit resolved config and a legitimately empty open-PR listing', async () => {
    const fixture = await serve(body({ prs: [row({ state: 'closed' })] }));
    const result = await readLedgerPrs({ repo: REPO, config: {
      enabled: true, flag: true, url: fixture.url, token: TOKEN,
    } });
    expect(result).toEqual(usable([]));
    expect(fixture.requests).toHaveLength(1);
  });

  it('rejects a wrong bearer token as unauthorized without exposing it', async () => {
    const fixture = await serve();
    const wrongToken = `${TOKEN}-wrong`;
    const result = await readLedgerPrs({ repo: REPO, env: { ...fixture.env, WE_PR_EVENTS_TOKEN: wrongToken } });
    unavailable(result, 'unauthorized', fixture.url);
    expect(result.reason).not.toContain(wrongToken);
    expect(fixture.requests[0].authorization).toBe(`Bearer ${wrongToken}`);
  });

  it('uses body.now to reject a stale delivery even when the local clock is fresh', async () => {
    const fixture = await serve(body({ now: NOW + 120_000, lastDeliveryAt: NOW }));
    unavailable(await readLedgerPrs({ repo: REPO, env: fixture.env, staleAfterMs: 60_000 }), 'stale', fixture.url);
  });

  it.each([
    ['missing repo bootstrap', []],
    ['another repo bootstrap', [{ repo: 'other/repo', status: 'complete' }]],
    ['truncated bootstrap', [{ repo: REPO, status: 'truncated' }]],
    ['failed bootstrap', [{ repo: REPO, status: 'failed' }]],
  ])('fails closed with coverage-gap for %s', async (_name, bootstrap) => {
    const fixture = await serve(body({ coverage: { ...body().coverage, bootstrap } }));
    unavailable(await readLedgerPrs({ repo: REPO, env: fixture.env }), 'coverage-gap', fixture.url);
  });

  it.each([
    ['null SHA', { sha: null }], ['null labels', { labels: null }],
    ['fractional number', { number: 1.5 }], ['string number', { number: '1' }],
  ])('rejects a malformed open row (%s) rather than returning an incomplete listing', async (_name, invalid) => {
    const fixture = await serve(body({ prs: [row(), row({ number: 2, ...invalid })] }));
    unavailable(await readLedgerPrs({ repo: REPO, env: fixture.env }), 'malformed', fixture.url);
  });

  it.each(['{', 'null', '[]', '"text"'])('rejects malformed JSON or a non-object body: %s', async raw => {
    const fixture = await serve(raw, { raw: true });
    unavailable(await readLedgerPrs({ repo: REPO, env: fixture.env }), 'malformed', fixture.url);
  });

  it.each([
    ['wrong-repo', { repo: 'other/repo' }], ['gap', { gap: true }],
  ])('rejects %s evidence', async (reason, overrides) => {
    const fixture = await serve(body(overrides));
    unavailable(await readLedgerPrs({ repo: REPO, env: fixture.env }), reason, fixture.url);
  });

  it('returns http-500 without leaking the response body', async () => {
    const fixture = await serve({ error: TOKEN }, { status: 500 });
    unavailable(await readLedgerPrs({ repo: REPO, env: fixture.env }), 'http-500', fixture.url);
  });

  it.each(['disabled', 'missing URL', 'missing token'])('makes no request when not configured: %s', async missing => {
    const fixture = await serve();
    const env = { ...fixture.env };
    if (missing === 'disabled') env.WE_PR_EVENTS = '0';
    if (missing === 'missing URL') delete env.WE_PR_EVENTS_URL;
    if (missing === 'missing token') delete env.WE_PR_EVENTS_TOKEN;
    let fetchCalls = 0;
    const fetchImpl = (...args) => { fetchCalls++; return fetch(...args); };
    unavailable(await readLedgerPrs({ repo: REPO, env, fetchImpl }), 'not-configured', fixture.url);
    expect(fetchCalls).toBe(0);
    expect(fixture.requests).toEqual([]);
  });

  it('returns too-large with an explicit GitHub fallback for a body exceeding maxBytes', async () => {
    const fixture = await serve(body({ padding: 'x'.repeat(4096) }));
    unavailable(await readLedgerPrs({ repo: REPO, env: fixture.env, maxBytes: 1024 }), 'too-large', fixture.url);
  });

  it('bounds an unresponsive server with timeout and a GitHub fallback', async () => {
    const fixture = await serve(body(), { hang: true });
    unavailable(await readLedgerPrs({ repo: REPO, env: fixture.env, timeoutMs: 50 }), 'timeout', fixture.url);
  });

  it('maps network exceptions to a fixed reason, hiding token and URL in the error', async () => {
    const fixture = await serve();
    const fetchImpl = async () => { throw new Error(`failed ${fixture.url} Bearer ${TOKEN}`); };
    unavailable(await readLedgerPrs({ repo: REPO, env: fixture.env, fetchImpl }), 'network', fixture.url);
  });
});

describe('compareLedgerToGithub', () => {
  it('agrees on matching PRs regardless of PR or label ordering and saves one list call', () => {
    const a = githubPr(1, { labels: [{ name: 'bug' }, { name: 'advisory:accepted' }] });
    const b = githubPr(2);
    expect(compareLedgerToGithub([a, b], usable([b, { ...a, labels: [...a.labels].reverse() }]))).toEqual({
      ok: true, agree: true, onlyGithub: [], onlyLedger: [], disagreements: [], savedListCalls: 1, fallbackReason: null,
    });
  });

  it.each([
    ['missing-in-ledger', [githubPr()], [], [1], []],
    ['missing-in-github', [], [githubPr()], [], [1]],
    ['head-differs', [githubPr()], [githubPr(1, { headRefOid: 'b'.repeat(40) })], [], []],
    ['labels-differ', [githubPr()], [githubPr(1, { labels: [] })], [], []],
  ])('reports %s for the affected PR while counting a usable ledger', (reason, github, ledger, onlyGithub, onlyLedger) => {
    expect(compareLedgerToGithub(github, usable(ledger))).toEqual({ ok: true, agree: false,
      onlyGithub, onlyLedger, disagreements: [{ number: 1, reason }], savedListCalls: 1, fallbackReason: null });
  });

  it('agrees on two complete empty listings', () => {
    expect(compareLedgerToGithub([], usable([]))).toMatchObject({ ok: true, agree: true, savedListCalls: 1 });
  });

  it('preserves the fallback reason and saves no call for an unavailable ledger', () => {
    expect(compareLedgerToGithub([githubPr()], {
      ok: false, source: 'unavailable', fallback: 'github', reason: 'coverage-gap',
    })).toEqual({ ok: false, agree: false, onlyGithub: [], onlyLedger: [], disagreements: [],
      savedListCalls: 0, fallbackReason: 'coverage-gap' });
  });
});

describe('resolveLedgerMode', () => {
  it('defaults to shadow with default provenance', () => {
    expect(resolveLedgerMode({})).toEqual({ mode: 'shadow', source: 'default' });
  });
  it.each(['off', 'shadow'])('accepts explicit %s with env provenance', mode => {
    expect(resolveLedgerMode({ WE_LABEL_SWEEP_LEDGER: mode })).toEqual({ mode, source: 'env' });
  });
  it.each(['', 'on', 'SHADOW', ' shadow ', 'github'])('fails closed for invalid mode %j', mode => {
    expect(resolveLedgerMode({ WE_LABEL_SWEEP_LEDGER: mode })).toEqual({ mode: 'off', source: 'invalid' });
  });
});
