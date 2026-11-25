/**
 * @file scripts/conveyor/__tests__/repo-health.test.mjs
 * @description Pins the pure per-repo health reader (REPO-REGISTRY-HEALTH).
 */
import { describe, it, expect, vi } from 'vitest';
import { computeRepoHealth, formatHealthLine, healthAlerts, countVerdicts, readAllHealth, fetchFacts, runCli } from '../repo-health.mjs';
import { REVIEW_LABELS } from '../../lib/review-labels.mjs';
import { loadRepoRegistry } from '../../lib/repo-registry.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Keep the pre-fix/revert-red path hermetic even when fetchFacts ignores injected IO.
vi.mock('../../lib/proc-read.mjs', () => ({ readGhJson: () => { throw new Error('unexpected uninjected gh read'); } }));

const NOW = Date.parse('2026-11-24T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600e3).toISOString();
const thresholds = { noMergeHours: 24, oldPrHours: 48 };
const run = (facts, extra = {}) => computeRepoHealth({ repo: { name: 'r' }, facts, now: NOW, thresholds, ...extra });

describe('repo health', () => {
  it('a repo with no merge in N hours and an open PR older than X raises one alert', () => {
    const h = computeRepoHealth({
      repo: { name: 'plateau-app' },
      facts: { openPrs: [{ number: 229, createdAt: '2026-11-15T12:00:00Z', labels: [] }], merges: [{ mergedAt: hoursAgo(100) }] },
      now: NOW, thresholds,
    });
    expect(h.oldestOpenPr).toEqual({ number: 229, createdAt: '2026-11-15T12:00:00Z' });
    expect(h.mergesLast24h).toBe(0);
    expect(h.verdictsLanded).toBe(0);
    const alerts = healthAlerts(h, thresholds);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].key).toBe('plateau-app:stale');
    expect(formatHealthLine(h)).toMatch(/plateau-app.*#229/);
  });

  it('a quiet repo with no open PRs raises no alert', () => {
    expect(healthAlerts(run({ openPrs: [], merges: [] }), thresholds)).toEqual([]);
  });

  it('a recent merge keeps the repo healthy even with an old open PR', () => {
    const h = run({ openPrs: [{ number: 1, createdAt: hoursAgo(200), labels: [] }], merges: [{ mergedAt: hoursAgo(2) }] });
    expect(h.mergesLast24h).toBe(1);
    expect(healthAlerts(h, thresholds)).toEqual([]);
  });

  it('young open PRs without recent merges do not raise an alert', () => {
    expect(healthAlerts(run({ openPrs: [{ number: 1, createdAt: hoursAgo(1), labels: [] }], merges: [] }), thresholds)).toEqual([]);
  });

  it.each([NaN, Infinity, '2026-11-24', null])('fails closed for invalid now %s', (now) => {
    expect(run({ openPrs: [], merges: [] }, { now }).status).toBe('unknown');
  });

  it('fails closed for future-created PRs and incomplete labels', () => {
    for (const pr of [
      { number: 1, createdAt: hoursAgo(-1), labels: [] },
      { number: 1, createdAt: hoursAgo(1) },
      { number: 1, createdAt: hoursAgo(1), labels: null },
      { number: 1, createdAt: hoursAgo(1), labels: [null] },
      { number: 1, createdAt: hoursAgo(1), labels: [{}] },
    ]) expect(run({ openPrs: [pr], merges: [] }).status).toBe('unknown');
  });

  it('readAllHealth returns unknown for every repo when fetch throws', () => {
    const fetch = vi.fn(() => { throw new Error('HTTP 502'); });
    const all = readAllHealth({ now: NOW, fetch });
    expect(all.map((h) => h.repo)).toEqual(loadRepoRegistry().repos.map((r) => r.name));
    expect(all.every((h) => h.status === 'unknown' && h.error === 'HTTP 502')).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(all.length);
  });

  it('prints one line per registry repo despite one fetch failure and exits nonzero', () => {
    const reg = loadRepoRegistry();
    const fetch = vi.fn((slug) => {
      if (slug === reg.repos[0].slug) throw new Error('HTTP 502');
      return { openPrs: [], merges: [] };
    });
    const lines = [];
    expect(runCli({ argv: [], now: NOW, fetch, write: (line) => lines.push(line) })).toBe(1);
    expect(lines).toHaveLength(reg.repos.length);
    expect(lines[0]).toContain('unknown (HTTP 502)');
    expect(lines.slice(1)).toEqual(reg.repos.slice(1).map((r) => `${r.name}: no open PRs, 0 merged/24h, 0 verdicts landed`));
    expect(fetch.mock.calls.map(([slug]) => slug)).toEqual(reg.repos.map((r) => r.slug));
  });

  it('emits JSON health and alerts and exits zero when all reads succeed', () => {
    const lines = [];
    const reg = loadRepoRegistry();
    const fetch = (slug) => ({ openPrs: slug === reg.repos[0].slug ? [{ number: 1, createdAt: hoursAgo(200), labels: [] }] : [], merges: [] });
    expect(runCli({ argv: ['--json'], now: NOW, fetch, write: (line) => lines.push(line) })).toBe(0);
    const result = JSON.parse(lines[0]);
    expect(result.health).toHaveLength(reg.repos.length);
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0].key).toBe(`${reg.repos[0].name}:stale`);
  });

  it.each([false, true])('the executable prints every repo and sets its exit status (fetch failure: %s)', (fail) => {
    // A Node loader replaces only process IO, so this exercises the real entrypoint
    // and process.exitCode without launching gh or altering production source.
    const stub = `export function readGhJson(args) {
      if (process.env.HEALTH_TEST_FAIL === 'true' && args.includes('repo=web-everything')) throw new Error('HTTP 502');
      const empty = { nodes: [], pageInfo: { hasNextPage: false } };
      return args.some((arg) => arg.includes('pullRequests'))
        ? { data: { repository: { pullRequests: empty } } }
        : { data: { search: { ...empty, issueCount: 0 } } };
    }`;
    const stubUrl = `data:text/javascript,${encodeURIComponent(stub)}`;
    const loader = `export function resolve(specifier, context, next) {
      if (specifier.endsWith('/proc-read.mjs')) return { url: ${JSON.stringify(stubUrl)}, shortCircuit: true };
      return next(specifier, context);
    }`;
    const preload = `import { register } from 'node:module'; register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(loader)}`)}, import.meta.url);`;
    const child = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`,
      fileURLToPath(new URL('../repo-health.mjs', import.meta.url))], {
      encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
      env: { ...process.env, HEALTH_TEST_FAIL: String(fail) },
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(fail ? 1 : 0);
    const lines = child.stdout.trim().split('\n');
    expect(lines).toHaveLength(loadRepoRegistry().repos.length);
    expect(lines[0]).toContain(fail ? 'unknown (HTTP 502)' : 'no open PRs');
  });

  const page = (nodes, hasNextPage = false, endCursor = null) => ({ nodes, pageInfo: { hasNextPage, endCursor } });
  const openNode = (number, age = 1) => ({ number, createdAt: hoursAgo(age), labels: page([]) });
  const response = (connection, merged = false) => merged
    ? { data: { search: { issueCount: 101, ...connection } } }
    : { data: { repository: { pullRequests: connection } } };

  it('fetches exactly two lists per repo when neither list needs pagination', () => {
    const gh = vi.fn().mockReturnValueOnce(response(page([]))).mockReturnValueOnce(response({ ...page([]), issueCount: 0 }, true));
    expect(fetchFacts('owner/repo', { gh, now: NOW, thresholds })).toMatchObject({ openPrs: [], merges: [] });
    expect(gh).toHaveBeenCalledTimes(2);
    expect(gh.mock.calls[1][0].join(' ')).toContain('merged:>=2026-11-23T12:00:00.000Z');
  });

  it('paginates facts to preserve oldest PR and recent merge totals', () => {
    const gh = vi.fn()
      .mockReturnValueOnce(response(page(Array.from({ length: 100 }, (_, i) => openNode(i + 1)), true, 'open-next')))
      .mockReturnValueOnce(response(page([openNode(101, 200)])))
      .mockReturnValueOnce(response(page(Array.from({ length: 100 }, (_, i) => ({ number: i + 201, mergedAt: hoursAgo(1) })), true, 'merge-next'), true))
      .mockReturnValueOnce(response(page([{ number: 301, mergedAt: hoursAgo(2) }]), true));
    const h = run(fetchFacts('owner/repo', { gh, now: NOW, thresholds }));
    expect(h.openPrCount).toBe(101);
    expect(h.oldestOpenPr.number).toBe(101);
    expect(h.mergesLast24h).toBe(101);
    expect(h.lastMergeAt).toBe(hoursAgo(1));
    expect(healthAlerts(h, thresholds)).toEqual([]);
    expect(gh).toHaveBeenCalledTimes(4);
    expect(gh.mock.calls[1][0]).toContain('cursor=open-next');
    expect(gh.mock.calls[3][0]).toContain('cursor=merge-next');
    const stale = run({ ...fetchFacts('owner/repo', {
      gh: vi.fn().mockReturnValueOnce(response(page([openNode(101, 200)]))).mockReturnValueOnce(response({ ...page([]), issueCount: 0 }, true)),
      now: NOW, thresholds,
    }), merges: [] });
    expect(healthAlerts(stale, thresholds)).toHaveLength(1);
  });

  it('fails closed on partial GraphQL data, truncated labels, cursor failure and page-budget exhaustion', () => {
    for (const data of [
      { errors: [{ message: 'unreadable' }], ...response(page([])) },
      response(page([{ ...openNode(1), labels: page([], true, 'more-labels') }])),
      response(page([], true, null)),
      {},
    ]) expect(() => fetchFacts('owner/repo', { gh: () => data, now: NOW, thresholds })).toThrow();
    let calls = 0;
    const gh = vi.fn(() => { calls++; return response(page([openNode(calls)], true, `more-${calls}`)); });
    const all = readAllHealth({ now: NOW, fetch: (slug) => fetchFacts(slug, { gh, now: NOW, thresholds }) });
    expect(all.every((h) => h.status === 'unknown' && /page budget exhausted/.test(h.error))).toBe(true);
    expect(gh).toHaveBeenCalledTimes(loadRepoRegistry().repos.length * 10);
  });

  it('fails closed for merge search truncation, mismatched totals and errors on a later page', () => {
    for (const connection of [
      { ...page([]), issueCount: 1001 },
      { ...page([]), issueCount: 1 },
      { ...page([]), issueCount: null },
    ]) {
      const gh = vi.fn().mockReturnValueOnce(response(page([]))).mockReturnValueOnce(response(connection, true));
      expect(() => fetchFacts('owner/repo', { gh, now: NOW, thresholds })).toThrow();
    }
    const gh = vi.fn().mockReturnValueOnce(response(page([openNode(1)], true, 'next')))
      .mockImplementationOnce(() => { throw new Error('HTTP 502'); });
    expect(() => fetchFacts('owner/repo', { gh, now: NOW, thresholds })).toThrow('HTTP 502');
  });

  it('uses a merge-date window covering thresholds longer than 24 hours', () => {
    const gh = vi.fn().mockReturnValueOnce(response(page([]))).mockReturnValueOnce(response({ ...page([]), issueCount: 0 }, true));
    fetchFacts('owner/repo', { gh, now: NOW, thresholds: { ...thresholds, noMergeHours: 72 } });
    expect(gh.mock.calls[1][0].join(' ')).toContain('merged:>=2026-11-21T12:00:00.000Z');
    expect(run({ openPrs: [], merges: [], mergeWindowStart: NOW - 3600e3 }).status).toBe('unknown');
  });

  it('propagates API failures from fetchFacts through the real reader catch', () => {
    const all = readAllHealth({ now: NOW, fetch: (slug) => fetchFacts(slug, {
      gh: () => { throw new Error('HTTP 502'); }, now: NOW, thresholds,
    }) });
    expect(all.every((h) => h.status === 'unknown' && h.error === 'HTTP 502')).toBe(true);
  });

  it('counts verdicts by the labels the review flow really sets, not approved', () => {
    const lbl = (...n) => n.map((name) => ({ name }));
    const prs = [
      { labels: lbl(REVIEW_LABELS.accepted) },
      { labels: lbl(REVIEW_LABELS.changes, 'bug') },
      { labels: lbl(REVIEW_LABELS.pending) },
      { labels: lbl('review:approved') },
      { labels: [] },
    ];
    expect(countVerdicts(prs)).toBe(2);
  });

  it('an unreadable repo (API error) shows unknown, never healthy', () => {
    const h = computeRepoHealth({ repo: { name: 'plateau-app' }, facts: null, error: 'HTTP 502', now: NOW, thresholds });
    expect(h.status).toBe('unknown');
    expect(formatHealthLine(h)).toMatch(/unknown/);
    expect(formatHealthLine(h)).not.toMatch(/healthy/);
  });

  it('fails closed to unknown on missing facts, bad timestamps, future merges and bad thresholds', () => {
    expect(run({}).status).toBe('unknown');
    expect(run({ openPrs: [{ number: 1, createdAt: 'nope', labels: [] }], merges: [] }).status).toBe('unknown');
    expect(run({ openPrs: [], merges: [{ mergedAt: 'nope' }] }).status).toBe('unknown');
    expect(run({ openPrs: [], merges: [{ mergedAt: hoursAgo(-10) }] }).status).toBe('unknown');
    expect(run({ openPrs: [], merges: [] }, { thresholds: {} }).status).toBe('unknown');
    expect(run({ openPrs: [], merges: [] }, { thresholds: { noMergeHours: 'x', oldPrHours: 48 } }).status).toBe('unknown');
  });
});
