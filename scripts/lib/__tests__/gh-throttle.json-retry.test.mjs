/**
 * @file scripts/lib/__tests__/gh-throttle.json-retry.test.mjs
 * @description Live 2026-10-10 (wev-fix-daemon): the reconcile smoke's `gh pr list … --json …` failed ~1 in 3 with gh's
 *   own `unexpected end of JSON input` (GitHub cut the response off) and nothing retried it. A READ whose failure is a
 *   cut-off JSON response is retried once (policy `ghJsonParseRetry`), logged as `outcome:'retry'` with its reason;
 *   a write is never retried.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGhSync, runGhCliPassthrough, ghThrottleLogPath, resolveGhJsonParseRetry, isRetryableGhJsonFailure, ghTransientRetryReason } from '../gh-throttle.mjs';

const made = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'gh-json-retry-')); made.push(d); return d; };
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const TRUNC = 'unexpected end of JSON input\n';
const LIST = ['pr', 'list', '--repo', 'web-everything/web-everything', '--state', 'open', '--json', 'number,files'];
const ghFail = (stderr) => Object.assign(new Error(`Command failed: gh ${LIST.join(' ')}`), { status: 1, stderr, stdout: '' });
const logLines = (lockRoot) => readFileSync(ghThrottleLogPath(lockRoot), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

function syncOpts(lockRoot, exec, env = {}, sleeps = []) {
  return { encoding: 'utf8', throttle: { lockRoot, cap: 4, sleep: (ms) => sleeps.push(ms), env, maxAttempts: 3, retryBaseMs: 1, exec, shimRouted: false } };
}

describe('resolveGhJsonParseRetry — cascade setting', () => {
  it('standard is one retry after 2s; the env layer overrides and names its source', () => {
    expect(resolveGhJsonParseRetry({})).toMatchObject({ retries: 1, backoffMs: 2000 });
    const r = resolveGhJsonParseRetry({ WE_GH_JSON_RETRIES: '0', WE_GH_JSON_RETRY_BACKOFF_MS: '50' });
    expect(r).toMatchObject({ retries: 0, backoffMs: 50, source: { retries: 'env', backoffMs: 'env' } });
    expect(resolveGhJsonParseRetry({ WE_GH_JSON_RETRIES: 'lots' }).retries).toBe(1);
  });
  it('isRetryableGhJsonFailure: reads with a cut-off JSON response only', () => {
    expect(isRetryableGhJsonFailure(LIST, TRUNC)).toBe(true);
    expect(isRetryableGhJsonFailure(['api', 'repos/o/n'], "invalid character '<' looking for beginning of value")).toBe(true);
    expect(isRetryableGhJsonFailure(['pr', 'create', '--title', 't'], TRUNC)).toBe(false);
    expect(isRetryableGhJsonFailure(['api', '--method', 'POST', 'repos/o/n/issues'], TRUNC)).toBe(false);
    expect(isRetryableGhJsonFailure(LIST, 'HTTP 404: Not Found')).toBe(false);
  });
});

describe('runGhSync — truncated JSON on a read', () => {
  it('retries once after the backoff, then returns the good answer; the retry is a calls.jsonl line with its reason', () => {
    const lockRoot = tmp(); const sleeps = []; let calls = 0;
    const out = runGhSync(LIST, syncOpts(lockRoot, () => { calls += 1; if (calls === 1) throw ghFail(TRUNC); return '[]'; }, {}, sleeps));
    expect(out).toBe('[]');
    expect(calls).toBe(2);
    expect(sleeps).toEqual([2000]);
    expect(logLines(lockRoot).filter((l) => l.outcome === 'retry')).toEqual([expect.objectContaining({ reason: 'truncated-json', attempt: 1, w: false })]);
  });
  it('retries only `retries` times — a second cut-off response surfaces unchanged', () => {
    const lockRoot = tmp(); let calls = 0;
    expect(() => runGhSync(LIST, syncOpts(lockRoot, () => { calls += 1; throw ghFail(TRUNC); }))).toThrow(/Command failed/);
    expect(calls).toBe(2);
  });
  it('never retries a write, and honours retries=0 from the env layer', () => {
    const lockRoot = tmp(); let calls = 0;
    expect(() => runGhSync(['pr', 'create', '--title', 't'], syncOpts(lockRoot, () => { calls += 1; throw ghFail(TRUNC); }))).toThrow();
    expect(calls).toBe(1);
    calls = 0;
    expect(() => runGhSync(LIST, syncOpts(lockRoot, () => { calls += 1; throw ghFail(TRUNC); }, { WE_GH_JSON_RETRIES: '0' }))).toThrow();
    expect(calls).toBe(1);
  });
});

// Live 2026-10-10 23:31Z: the same heavy read also came back `HTTP 504: 504 Gateway Timeout (https://api.github.com/graphql)`.
describe('transient server errors on a read (same setting)', () => {
  it('ghTransientRetryReason names the reason; writes and 4xx never qualify', () => {
    expect(ghTransientRetryReason(LIST, TRUNC)).toBe('truncated-json');
    expect(ghTransientRetryReason(LIST, 'HTTP 504: 504 Gateway Timeout (https://api.github.com/graphql)')).toBe('server-5xx');
    expect(ghTransientRetryReason(LIST, 'HTTP 502: Bad Gateway')).toBe('server-5xx');
    expect(ghTransientRetryReason(LIST, 'HTTP 503: Service Unavailable')).toBe('server-5xx');
    expect(ghTransientRetryReason(LIST, 'GraphQL: Something went wrong while executing your query. This may be the result of a timeout')).toBe('server-5xx');
    expect(ghTransientRetryReason(LIST, 'HTTP 500: Internal Server Error')).toBe(null);
    expect(ghTransientRetryReason(LIST, 'HTTP 422: Unprocessable')).toBe(null);
    expect(ghTransientRetryReason(['pr', 'merge', '7'], 'HTTP 504: 504 Gateway Timeout')).toBe(null);
  });
  it('runGhSync retries a 504 on a read once and logs reason server-5xx', () => {
    const lockRoot = tmp(); let calls = 0;
    const out = runGhSync(LIST, syncOpts(lockRoot, () => { calls += 1; if (calls === 1) throw ghFail('HTTP 504: 504 Gateway Timeout (https://api.github.com/graphql)\n'); return '[]'; }));
    expect(out).toBe('[]');
    expect(logLines(lockRoot).filter((l) => l.outcome === 'retry').map((l) => l.reason)).toEqual(['server-5xx']);
  });
});

describe('runGhCliPassthrough — truncated JSON on a read', () => {
  const spawnSeq = (results) => { let i = 0; const fn = () => results[Math.min(i++, results.length - 1)]; fn.count = () => i; return fn; };
  const res = (status, stderr, stdout = '') => ({ status, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) });
  const throttle = (lockRoot, env = {}) => ({ lockRoot, cap: 4, sleep: () => {}, env, maxAttempts: 3, retryBaseMs: 1 });
  it('retries once when not nested', () => {
    const lockRoot = tmp(); const spawn = spawnSeq([res(1, TRUNC), res(0, '', '[]')]);
    const r = runGhCliPassthrough(LIST, { throttle: throttle(lockRoot), spawn });
    expect(r.status).toBe(0);
    expect(spawn.count()).toBe(2);
    expect(logLines(lockRoot).some((l) => l.outcome === 'retry' && l.reason === 'truncated-json')).toBe(true);
  });
  it('a nested call leaves the retry to its outer runGhSync (one retry per logical call)', () => {
    const lockRoot = tmp(); const spawn = spawnSeq([res(1, TRUNC), res(0, '', '[]')]);
    const r = runGhCliPassthrough(LIST, { throttle: throttle(lockRoot, { WE_GH_THROTTLE_OUTER_INV: 'outer123' }), spawn });
    expect(r.status).toBe(1);
    expect(spawn.count()).toBe(1);
  });
});
