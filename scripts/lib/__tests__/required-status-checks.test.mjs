/**
 * @file required-status-checks.test.mjs — unit tests for `we:scripts/lib/required-status-checks.mjs` (#2748
 * false-red follow-up, soak-replay-gate PR #2775). Covers the full degradation chain the module's own header
 * documents: live fetch → cache write → cache hit within TTL → live failure falls back to a stale cache →
 * live failure with no cache uses only the repo's declared set, or reports unavailable. The
 * `gh` reader is injected throughout, so every branch is reachable with no network and no credential.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal();
  const execFileSync = vi.fn(() => '["test","smoke","daemon-soak"]');
  const spawnSync = vi.fn();
  return { ...actual, spawnSync, execFileSync, default: { ...actual.default, spawnSync, execFileSync } };
});
import { execFileSync, spawnSync } from 'node:child_process';
import { getRequiredStatusChecks, defaultReadRequiredStatusChecks, FALLBACK_REQUIRED_STATUS_CHECKS } from '../required-status-checks.mjs';

describe('getRequiredStatusChecks', () => {
  let dir;
  let cachePath;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'we-required-status-checks-'));
    cachePath = join(dir, '.required-status-checks-cache.json');
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('fetches live and writes a cache on success', () => {
    const readChecks = () => ['test', 'smoke', 'daemon-soak'];
    const result = getRequiredStatusChecks({ repo: 'web-everything/web-everything', cachePath, now: 1000, readChecks });
    expect(result).toEqual({ checks: ['test', 'smoke', 'daemon-soak'], source: 'live' });
    const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
    expect(cached.entries['web-everything/web-everything@main']).toEqual({
      checks: ['test', 'smoke', 'daemon-soak'], source: 'live', fetchedAtMs: 1000,
    });
  });

  it('serves the cache within the TTL without calling the reader again', () => {
    let calls = 0;
    const readChecks = () => { calls += 1; return ['test', 'smoke', 'daemon-soak']; };
    getRequiredStatusChecks({ repo: 'web-everything/web-everything', cachePath, now: 1000, readChecks });
    const second = getRequiredStatusChecks({
      repo: 'web-everything/web-everything', cachePath, now: 1000 + 60_000, ttlMs: 15 * 60_000, readChecks,
    });
    expect(second).toEqual({ checks: ['test', 'smoke', 'daemon-soak'], source: 'cache' });
    expect(calls).toBe(1);
  });

  it('re-fetches once the cache is past its TTL', () => {
    let calls = 0;
    const readChecks = () => { calls += 1; return ['test', 'smoke', 'daemon-soak', 'a-new-required-check']; };
    getRequiredStatusChecks({ repo: 'web-everything/web-everything', cachePath, now: 1000, ttlMs: 1000, readChecks });
    const third = getRequiredStatusChecks({
      repo: 'web-everything/web-everything', cachePath, now: 1000 + 2000, ttlMs: 1000, readChecks,
    });
    expect(third).toEqual({ checks: ['test', 'smoke', 'daemon-soak', 'a-new-required-check'], source: 'live' });
    expect(calls).toBe(2);
  });

  it('falls back to a STALE cache when the live fetch fails', () => {
    const flakyRead = () => { throw new Error('gh: rate limited'); };
    writeFileSync(cachePath, JSON.stringify({
      key: 'web-everything/web-everything@main', checks: ['test', 'smoke', 'daemon-soak'], fetchedAtMs: 0,
    }));
    const result = getRequiredStatusChecks({
      repo: 'web-everything/web-everything', cachePath, now: 999_999_999, ttlMs: 1000, readChecks: flakyRead,
    });
    expect(result).toEqual({ checks: ['test', 'smoke', 'daemon-soak'], source: 'stale-cache', cacheAgeMs: 999_999_999 });
  });

  it('falls back to the hardcoded FALLBACK_REQUIRED_STATUS_CHECKS when there is no cache at all and the ' +
    'live fetch fails — gh missing, unauthenticated, offline, or rate-limited', () => {
    const flakyRead = () => { throw new Error('gh: command not found'); };
    const result = getRequiredStatusChecks({ repo: 'web-everything/web-everything', cachePath, now: 1000, readChecks: flakyRead });
    expect(result).toEqual({ checks: [...FALLBACK_REQUIRED_STATUS_CHECKS], source: 'fallback' });
  });

  it('does not use a live result that comes back empty — falls through to cache/fallback instead', () => {
    const readChecks = () => [];
    const result = getRequiredStatusChecks({ repo: 'web-everything/web-everything', cachePath, now: 1000, readChecks });
    expect(result).toEqual({ checks: [...FALLBACK_REQUIRED_STATUS_CHECKS], source: 'fallback' });
  });

  it('keys the cache by repo+branch — a different repo/branch never reads another\'s cached set', () => {
    const readChecks = () => ['test', 'smoke', 'daemon-soak'];
    getRequiredStatusChecks({ repo: 'web-everything/web-everything', branch: 'main', cachePath, now: 1000, readChecks });
    let otherCalls = 0;
    const otherRead = () => { otherCalls += 1; return ['test']; };
    const result = getRequiredStatusChecks({ repo: 'chalbert/other-repo', branch: 'main', cachePath, now: 1000, readChecks: otherRead });
    expect(result).toEqual({ checks: ['test'], source: 'live' });
    expect(otherCalls).toBe(1);
  });

  const plan403 = () => { throw Object.assign(new Error('gh api failed'), {
    stderr: Buffer.from('gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)'),
  }); };

  it.each([
    ['plateauapp/plateau-app', ['test', 'e2e']],
    ['frontier-ui/frontierui', ['test']],
    ['web-everything/web-everything', ['test', 'smoke', 'daemon-soak', 'integration']],
  ])('caches the declared set for %s on a plan-feature 403, then retries after TTL', (repo, checks) => {
    const readChecks = vi.fn(plan403);
    expect(getRequiredStatusChecks({ repo, cachePath, now: 1000, ttlMs: 1000, readChecks }))
      .toEqual({ checks, source: 'declared' });
    expect(getRequiredStatusChecks({ repo, cachePath, now: 1500, ttlMs: 1000, readChecks }))
      .toEqual({ checks, source: 'declared' });
    expect(readChecks).toHaveBeenCalledTimes(1);
    readChecks.mockReturnValue(['new-protection-check']);
    expect(getRequiredStatusChecks({ repo, cachePath, now: 2000, ttlMs: 1000, readChecks }))
      .toEqual({ checks: ['new-protection-check'], source: 'live' });
    expect(readChecks).toHaveBeenCalledTimes(2);
  });

  const failing = message => vi.fn(() => {
    throw Object.assign(new Error('gh api failed'), { stderr: Buffer.from(message) });
  });
  const LIVE = ['test', 'smoke', 'daemon-soak', 'live-only-check'];
  const WE = 'web-everything/web-everything';
  const seedLive = () => getRequiredStatusChecks({
    repo: WE, cachePath, now: 1000, ttlMs: 1000, readChecks: () => LIVE,
  });
  const entryOnDisk = () => JSON.parse(readFileSync(cachePath, 'utf8')).entries[`${WE}@main`];

  const DENIALS = [
    'Resource not accessible by integration (HTTP 403)',
    'Not Found (HTTP 404)',
    'gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)',
  ];
  const RATE_LIMITS = [
    'HTTP 403: API rate limit exceeded',
    'HTTP 403: You have exceeded a secondary rate limit',
    'HTTP 403: You have triggered an abuse detection mechanism',
  ];

  it.each(DENIALS)('uses declared policy on protection denial: %s', message => {
    const readChecks = failing(message);
    expect(getRequiredStatusChecks({ repo: 'plateauapp/plateau-app', cachePath, now: 1000, readChecks }))
      .toEqual({ checks: ['test', 'e2e'], source: 'declared' });
    expect(getRequiredStatusChecks({ repo: 'plateauapp/plateau-app', cachePath, now: 1001, readChecks }))
      .toEqual({ checks: ['test', 'e2e'], source: 'declared' });
    expect(readChecks).toHaveBeenCalledTimes(1);
  });

  it.each(RATE_LIMITS)('a rate-limit 403 is not a protection denial — no declared selection, no cache write: %s', message => {
    const readChecks = failing(message);
    expect(getRequiredStatusChecks({ repo: 'plateauapp/plateau-app', cachePath, now: 1000, readChecks }))
      .toEqual({ checks: ['test', 'e2e'], source: 'fallback' });
    expect(existsSync(cachePath)).toBe(false);
    // Nothing was cached, so the next call re-reads rather than serving a stuck `declared`.
    getRequiredStatusChecks({ repo: 'plateauapp/plateau-app', cachePath, now: 1001, readChecks });
    expect(readChecks).toHaveBeenCalledTimes(2);
  });

  it.each(RATE_LIMITS)('an undeclared repo hit by a rate-limit 403 is unavailable, not fallback: %s', message => {
    expect(getRequiredStatusChecks({ repo: 'chalbert/unknown', cachePath, now: 1000, readChecks: failing(message) }))
      .toEqual({ checks: [], source: 'unavailable' });
  });

  it.each(RATE_LIMITS)('a rate-limit 403 keeps a live cache past TTL (stale-cache, file still live): %s', message => {
    seedLive();
    expect(getRequiredStatusChecks({ repo: WE, cachePath, now: 3000, ttlMs: 1000, readChecks: failing(message) }))
      .toEqual({ checks: LIVE, source: 'stale-cache', cacheAgeMs: 2000 });
    expect(entryOnDisk()).toEqual({ checks: LIVE, source: 'live', fetchedAtMs: 1000 });
  });

  it.each(DENIALS)('a genuine denial never overwrites an existing live entry; each call re-reads once: %s', message => {
    seedLive();
    const readChecks = failing(message);
    const expected = { checks: LIVE, source: 'stale-cache' };
    expect(getRequiredStatusChecks({ repo: WE, cachePath, now: 3000, ttlMs: 1000, readChecks }))
      .toEqual({ ...expected, cacheAgeMs: 2000 });
    expect(entryOnDisk()).toEqual({ checks: LIVE, source: 'live', fetchedAtMs: 1000 });
    expect(getRequiredStatusChecks({ repo: WE, cachePath, now: 3001, ttlMs: 1000, readChecks }))
      .toEqual({ ...expected, cacheAgeMs: 2001 });
    expect(readChecks).toHaveBeenCalledTimes(2);
    expect(entryOnDisk().source).toBe('live');
  });

  it('a legacy (source-less) cache entry is live data and is protected from a denial too', () => {
    writeFileSync(cachePath, JSON.stringify({ key: `${WE}@main`, checks: ['legacy-required'], fetchedAtMs: 0 }));
    expect(getRequiredStatusChecks({ repo: WE, cachePath, now: 5000, ttlMs: 1000, readChecks: failing(DENIALS[1]) }))
      .toEqual({ checks: ['legacy-required'], source: 'stale-cache', cacheAgeMs: 5000 });
  });

  it('a stale `unavailable` entry is not live data: a denial still selects the declared policy', () => {
    writeFileSync(cachePath, JSON.stringify({
      entries: { [`${WE}@main`]: { checks: [], source: 'unavailable', fetchedAtMs: 0 } },
    }));
    expect(getRequiredStatusChecks({ repo: WE, cachePath, now: 5000, ttlMs: 1000, readChecks: failing(DENIALS[1]) }))
      .toEqual({ checks: [...FALLBACK_REQUIRED_STATUS_CHECKS], source: 'declared' });
    expect(entryOnDisk().source).toBe('declared');
  });

  it('a stale declared entry is still refreshed (re-saved as declared) on a repeat denial', () => {
    const readChecks = failing(DENIALS[0]);
    getRequiredStatusChecks({ repo: WE, cachePath, now: 1000, ttlMs: 1000, readChecks });
    expect(getRequiredStatusChecks({ repo: WE, cachePath, now: 3000, ttlMs: 1000, readChecks }))
      .toEqual({ checks: [...FALLBACK_REQUIRED_STATUS_CHECKS], source: 'declared' });
    expect(entryOnDisk()).toMatchObject({ source: 'declared', fetchedAtMs: 3000 });
  });

  it('a bare 403/404 without gh\'s `HTTP` prefix is a transient failure, not a denial', () => {
    for (const message of ['403', 'error 404 from proxy']) {
      expect(getRequiredStatusChecks({ repo: 'plateauapp/plateau-app', cachePath, now: 1000, readChecks: failing(message) }))
        .toEqual({ checks: ['test', 'e2e'], source: 'fallback' });
    }
    expect(existsSync(cachePath)).toBe(false);
  });

  it.each(['chalbert/unknown', undefined])('never gives undeclared repo %s WE defaults', repo => {
    expect(getRequiredStatusChecks({ repo, cachePath, readChecks: plan403 }))
      .toEqual({ checks: [], source: 'fallback' });
    expect(getRequiredStatusChecks({ repo, cachePath, readChecks: () => { throw new Error('offline'); } }))
      .toEqual({ checks: [], source: 'unavailable' });
  });

  it('alternates repositories and branches without evicting live or declared entries', () => {
    const liveRead = vi.fn(() => ['test', 'smoke', 'daemon-soak', 'new-check']);
    const declaredRead = vi.fn(plan403);
    const releaseRead = vi.fn(() => ['release-check']);
    for (const now of [1000, 1500]) {
      expect(getRequiredStatusChecks({ repo: 'web-everything/web-everything', cachePath, now, readChecks: liveRead }))
        .toEqual({ checks: ['test', 'smoke', 'daemon-soak', 'new-check'], source: now === 1000 ? 'live' : 'cache' });
      expect(getRequiredStatusChecks({ repo: 'plateauapp/plateau-app', cachePath, now, readChecks: declaredRead }))
        .toEqual({ checks: ['test', 'e2e'], source: 'declared' });
      expect(getRequiredStatusChecks({ repo: 'web-everything/web-everything', branch: 'release', cachePath, now, readChecks: releaseRead }))
        .toEqual({ checks: ['release-check'], source: now === 1000 ? 'live' : 'cache' });
    }
    for (const reader of [liveRead, declaredRead, releaseRead]) expect(reader).toHaveBeenCalledTimes(1);
    expect(Object.keys(JSON.parse(readFileSync(cachePath, 'utf8')).entries)).toHaveLength(3);
  });

  it('preserves a legacy entry when another repo writes its first cache entry', () => {
    writeFileSync(cachePath, JSON.stringify({
      key: 'web-everything/web-everything@main', checks: ['test', 'legacy-required'], fetchedAtMs: 1000,
    }));
    getRequiredStatusChecks({ repo: 'plateauapp/plateau-app', cachePath, now: 1500, readChecks: plan403 });
    const readChecks = vi.fn();
    expect(getRequiredStatusChecks({ repo: 'web-everything/web-everything', cachePath, now: 1500, readChecks }))
      .toEqual({ checks: ['test', 'legacy-required'], source: 'cache' });
    expect(readChecks).not.toHaveBeenCalled();
  });
});

describe('defaultReadRequiredStatusChecks', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'we-required-route-'));
    vi.stubEnv('WE_GH_THROTTLE_LOCK_ROOT', dir);
    vi.stubEnv('WE_GH_THROTTLE_PERSONAL_ROUTE', '0');
    vi.stubEnv('WE_GH_THROTTLE_COST_HEADERS', '0');
  });
  afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

  it('routes the protection read through the real throttle personal read path when enabled', () => {
    vi.stubEnv('WE_GH_THROTTLE_PERSONAL_ROUTE', '1');
    vi.stubEnv('WE_GITHUB_AUTH_PERSONAL_EXCEPTIONS', 'reads'); // github.auth=app keeps the route off unless 'reads' is listed
    vi.stubEnv('GH_TOKEN', 'ghs_test_fixture');
    execFileSync.mockReturnValueOnce('ghp_test_fixture');
    spawnSync.mockImplementationOnce((_bin, _args, opts) => {
      expect(opts.env.GH_TOKEN === 'ghp_test_fixture').toBe(true);
      expect(opts.timeout).toBe(15_000);
      return { status: 0, stdout: Buffer.from('["personal-check"]'), stderr: Buffer.alloc(0) };
    });
    expect(defaultReadRequiredStatusChecks({ repo: 'web-everything/web-everything' })).toEqual(['personal-check']);
    expect(execFileSync).toHaveBeenCalledWith('gh', ['auth', 'token'], expect.any(Object));
    expect(spawnSync.mock.calls[0][1]).toEqual(['api', 'repos/web-everything/web-everything/branches/main/protection', '--jq', '.required_status_checks.contexts']);
    expect(process.env.GH_TOKEN === 'ghs_test_fixture').toBe(true);
  });

  it('preserves routed HTTP failures for declared-policy classification', () => {
    vi.stubEnv('WE_GH_THROTTLE_PERSONAL_ROUTE', '1');
    vi.stubEnv('WE_GITHUB_AUTH_PERSONAL_EXCEPTIONS', 'reads'); // github.auth=app keeps the route off unless 'reads' is listed
    spawnSync.mockReturnValue({ status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('Resource not accessible by integration (HTTP 403)') });
    expect(getRequiredStatusChecks({ repo: 'plateauapp/plateau-app', cachePath: join(dir, 'cache.json') }))
      .toEqual({ source: 'declared', checks: ['test', 'e2e'] });
  });

  it('shells `gh api repos/<repo>/branches/<branch>/protection --jq .required_status_checks.contexts`', () => {
    const result = defaultReadRequiredStatusChecks({ repo: 'web-everything/web-everything', branch: 'main' });
    expect(result).toEqual(['test', 'smoke', 'daemon-soak']);
    expect(execFileSync).toHaveBeenCalledWith(
      'gh',
      ['api', 'repos/web-everything/web-everything/branches/main/protection', '--jq', '.required_status_checks.contexts'],
      expect.objectContaining({ encoding: 'utf8' }),
    );
  });

  // `repo` omitted lets `gh api` resolve `{owner}/{repo}` from the current directory's git remote — the same
  // "let gh infer it" convention `we:scripts/conveyor/reconcile-pass.mjs#defaultReadAheadBy` already uses,
  // rather than this reader failing a caller (e.g. a local CLI run with no `--repo` flag) that never had a
  // slug to pass.
  it('falls back to gh\'s own {owner}/{repo} template placeholders when no repo slug is given', () => {
    defaultReadRequiredStatusChecks({});
    expect(execFileSync).toHaveBeenCalledWith(
      'gh',
      ['api', 'repos/{owner}/{repo}/branches/main/protection', '--jq', '.required_status_checks.contexts'],
      expect.objectContaining({ encoding: 'utf8' }),
    );
  });
});

describe('adding a required check never stalls reviews (live 2026-10-07, `integration`, #4261)', () => {
  const ok = (name) => ({ name, status: 'completed', conclusion: 'success' });
  it('the declared fallback names `integration`', async () => {
    const m = await import('../required-status-checks.mjs');
    expect(m.FALLBACK_REQUIRED_STATUS_CHECKS).toContain('integration');
  });
  it('integration is implied by a green `test`, only when it has no row of its own', async () => {
    const { withoutImpliedRequiredChecks: w } = await import('../required-status-checks.mjs');
    const req = ['test', 'integration'];
    expect(w(req, [ok('test')])).toEqual(['test']);
    expect(w(req, [])).toEqual(req);
    expect(w(req, [{ name: 'test', status: 'in_progress' }])).toEqual(req);
    expect(w(req, [{ name: 'test', status: 'completed', conclusion: 'failure' }])).toEqual(req);
    expect(w(req, [ok('test'), { name: 'integration', status: 'completed', conclusion: 'failure' }])).toEqual(req);
  });
  it('the review gate and the check reducer accept a head that predates the job', async () => {
    const { reviewCiGate } = await import('../review-ci-gate.mjs');
    const { reduceCheckState } = await import('../../operations/pr-status.mjs');
    const req = ['test', 'integration'];
    expect(reviewCiGate({ headSha: 'a'.repeat(40), requiredChecks: req, checks: [ok('test')] }).allowed).toBe(true);
    expect(reviewCiGate({ headSha: 'a'.repeat(40), requiredChecks: req, checks: [] }).allowed).toBe(false);
    expect(reduceCheckState([ok('test')], req).state).toBe('green');
  });
});
