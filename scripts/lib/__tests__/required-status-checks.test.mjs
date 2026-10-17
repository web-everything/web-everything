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
import { getRequiredStatusChecks, defaultReadRequiredStatusChecks, readRequiredStatusChecksDetailed, requiredChecksFromRules, FALLBACK_REQUIRED_STATUS_CHECKS, defaultCachePath, resolveCacheTtlMs, cacheTtlMsFromSettings } from '../required-status-checks.mjs';
import { ghRestGetJson } from '../gh-rest-read.mjs';
import { readSettings } from '../settings-files.mjs';

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
    ['web-everything/web-everything', ['test', 'smoke', 'daemon-soak', 'soak-replay-gate']],
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

const requiredRule = (...contexts) => ({ type: 'required_status_checks', parameters: {
  required_status_checks: contexts.map(context => ({ context, integration_id: 15368 })),
} });
/** A `GET repos/{repo}/branches/{branch}` body whose classic protection requires `contexts`. */
const classicBranch = (...contexts) => JSON.stringify({ name: 'main', protected: true, protection: {
  enabled: true, required_status_checks: { enforcement_level: 'non_admins', contexts, checks: [] },
} });

describe('requiredChecksFromRules', () => {
  it('unions required rules, deduplicating contexts and ignoring other rule types', () => {
    expect(requiredChecksFromRules([
      requiredRule('test', 'smoke', 'test'),
      { ...requiredRule('ignored'), type: 'pull_request' },
      requiredRule('smoke', 'daemon-soak'),
      { type: 'deletion' },
    ])).toEqual(['test', 'smoke', 'daemon-soak']);
  });
  it('returns no contexts when there are no required checks', () => {
    expect(requiredChecksFromRules([])).toEqual([]);
    expect(requiredChecksFromRules([{ type: 'deletion' }, requiredRule()])).toEqual([]);
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

  // GitHub enforces rulesets AND classic protection together, so the required set is their union (PR #4924).
  const bothSources = (rules, protection) => vi.fn(args => {
    const reply = args.some(a => a.includes('/rules/')) ? rules : protection;
    if (reply instanceof Error) throw reply;
    return reply;
  });
  const UNPROTECTED = JSON.stringify({ name: 'main', protected: false });

  it('unions ruleset and classic-protection checks: a classic-only check is never dropped', () => {
    const gh = bothSources(JSON.stringify([[requiredRule('smoke', 'test')]]), classicBranch('test', 'classic-only'));
    expect(defaultReadRequiredStatusChecks({ repo: 'owner/repo', branch: 'release', gh })).toEqual(['smoke', 'test', 'classic-only']);
    expect(gh.mock.calls).toEqual([
      [['api', '--paginate', '--slurp', 'repos/owner/repo/rules/branches/release?per_page=100']],
      [['api', 'repos/owner/repo/branches/release']],
    ]);
  });

  // Live 2026-10-11: the App token gets `Resource not accessible by integration (HTTP 403)` on `…/protection`, but
  // `GET …/branches/main` returns this shape — so the classic set is read from the branch, never skipped on a 403.
  it('reads classic checks off the branch body (contexts ∪ checks[].context) — the App-token-readable endpoint', () => {
    const live = JSON.stringify({ name: 'main', protected: true, protection: { enabled: true, required_status_checks: {
      enforcement_level: 'non_admins', contexts: ['test', 'smoke'],
      checks: [{ app_id: 15368, context: 'test' }, { app_id: 15368, context: 'checks-only' }],
    } } });
    const gh = bothSources(JSON.stringify([[requiredRule('test', 'soak-replay-gate')]]), live);
    expect(defaultReadRequiredStatusChecks({ gh })).toEqual(['test', 'soak-replay-gate', 'smoke', 'checks-only']);
  });

  it.each([
    ['an unprotected branch', UNPROTECTED],
    ['ruleset-only protection (classic disabled)', JSON.stringify({ protected: true, protection: { enabled: false,
      required_status_checks: { enforcement_level: 'off', contexts: [], checks: [] } } })],
    ['classic protection that requires no status checks', JSON.stringify({ protected: true, protection: { enabled: true } })],
    ['null contexts', JSON.stringify({ protected: true, protection: { enabled: true, required_status_checks: { contexts: null } } })],
  ])('keeps the ruleset set alone for %s', (_label, branchBody) => {
    const gh = bothSources(JSON.stringify([[requiredRule('test', 'smoke', 'test')]]), branchBody);
    expect(defaultReadRequiredStatusChecks({ gh })).toEqual(['test', 'smoke']);
  });

  // Live 2026-10-11 bodies: frontierui is ruleset-protected with no check rule; plateau-app is unprotected. Two
  // successful reads that require nothing are an authoritative "nothing required" — the declared policy, cached
  // as `declared` like a protection denial, never the untrusted `fallback` the review gate refuses.
  it.each([
    ['frontier-ui/frontierui', JSON.stringify([[{ type: 'deletion' }, { type: 'non_fast_forward' }]]),
      JSON.stringify({ protected: true, protection: { enabled: false, required_status_checks: { checks: [], contexts: [], enforcement_level: 'off' } } }),
      ['test']],
    ['plateauapp/plateau-app', '[[]]',
      JSON.stringify({ protected: false, protection: { enabled: false, required_status_checks: { checks: [], contexts: [], enforcement_level: 'off' } } }),
      ['test', 'e2e']],
  ])('%s: nothing required by either source selects the declared policy', (repo, rules, branchBody, declared) => {
    const cachePath = join(dir, 'cache.json');
    const gh = bothSources(rules, branchBody);
    const readChecks = options => defaultReadRequiredStatusChecks({ ...options, gh });
    expect(() => readChecks({ repo })).toThrow(expect.objectContaining({ noRequiredChecks: true }));
    expect(getRequiredStatusChecks({ repo, cachePath, now: 1000, readChecks })).toEqual({ checks: declared, source: 'declared' });
    expect(getRequiredStatusChecks({ repo, cachePath, now: 1001, readChecks })).toEqual({ checks: declared, source: 'declared' });
  });

  it('nothing required never clobbers a live cache entry (stale-cache, file untouched)', () => {
    const cachePath = join(dir, 'cache.json');
    const repo = 'frontier-ui/frontierui';
    getRequiredStatusChecks({ repo, cachePath, now: 1000, readChecks: () => ['test'] });
    const gh = bothSources('[[]]', UNPROTECTED);
    expect(getRequiredStatusChecks({ repo, cachePath, now: 90_000_000,
      readChecks: options => defaultReadRequiredStatusChecks({ ...options, gh }),
    })).toMatchObject({ checks: ['test'], source: 'stale-cache' });
  });

  it('drops blank or non-string classic contexts instead of turning them into check names', () => {
    const body = JSON.stringify({ protected: true, protection: { enabled: true, required_status_checks: {
      contexts: ['', null, 7, 'real'], checks: [{ context: '' }, null, {}] } } });
    expect(defaultReadRequiredStatusChecks({ gh: bothSources('[[]]', body) })).toEqual(['real']);
  });

  it.each([
    ['a transient failure', new Error('HTTP 502')],
    ['a rate-limit 403', new Error('HTTP 403: API rate limit exceeded')],
    ['an access 403', new Error('HTTP 403: Resource not accessible by integration')],
    ['a 404', new Error('gh: Not Found (HTTP 404)')],
    ['a blank body', ''],
    ['an array body', '["classic"]'],
    ['a protected branch whose protection is hidden', JSON.stringify({ protected: true })],
    ['a non-object required_status_checks', JSON.stringify({ protected: true, protection: { required_status_checks: 'x' } })],
  ])('a nonempty ruleset never stands alone as live when the classic read hits %s', (_label, protection) => {
    const gh = bothSources(JSON.stringify([[requiredRule('smoke')]]), protection);
    expect(() => defaultReadRequiredStatusChecks({ gh })).toThrow();
  });

  it('keeps an expired live cache when rules succeed but classic protection fails transiently', () => {
    const cachePath = join(dir, 'cache.json');
    const repo = 'web-everything/web-everything';
    getRequiredStatusChecks({ repo, cachePath, now: 1000, readChecks: () => ['smoke', 'classic-only'] });
    const gh = bothSources(JSON.stringify([[requiredRule('smoke')]]), new Error('HTTP 502'));
    expect(getRequiredStatusChecks({ repo, cachePath, now: 90_000_000,
      readChecks: options => defaultReadRequiredStatusChecks({ ...options, gh }),
    })).toMatchObject({ checks: ['smoke', 'classic-only'], source: 'stale-cache' });
  });

  it('reads EVERY rules page: a required check on page two is not dropped', () => {
    const page1 = [requiredRule('test'), ...Array.from({ length: 29 }, () => ({ type: 'deletion' }))];
    const page2 = [requiredRule('security-scan')];
    // `gh api --paginate --slurp` prints one array of pages
    const gh = bothSources(JSON.stringify([page1, page2]), UNPROTECTED);
    expect(defaultReadRequiredStatusChecks({ repo: 'owner/repo', gh })).toEqual(['test', 'security-scan']);
    expect(gh.mock.calls[0]).toEqual([['api', '--paginate', '--slurp', 'repos/owner/repo/rules/branches/main?per_page=100']]);
  });

  it('treats a blank rules response as a failed read, never as "no rules"', () => {
    const gh = vi.fn().mockReturnValueOnce('').mockReturnValueOnce(classicBranch('classic'));
    expect(() => defaultReadRequiredStatusChecks({ gh })).toThrow();
  });

  it('treats a blank classic-protection body as a failed read, never as "no checks"', () => {
    const gh = vi.fn().mockReturnValueOnce('[[]]').mockReturnValueOnce('');
    expect(() => defaultReadRequiredStatusChecks({ gh })).toThrow();
  });

  it('falls through to classic protection when the single rules page is empty', () => {
    const gh = vi.fn().mockReturnValueOnce('[[]]').mockReturnValueOnce(classicBranch('classic'));
    expect(defaultReadRequiredStatusChecks({ gh })).toEqual(['classic']);
  });

  it('rejects a non-array rules body', () => {
    const gh = vi.fn().mockReturnValueOnce('{"message":"x"}').mockReturnValueOnce(classicBranch('classic'));
    expect(() => defaultReadRequiredStatusChecks({ gh })).toThrow();
  });

  it('rejects a rules response that mixes pages and bare rules', () => {
    const gh = vi.fn().mockReturnValueOnce(JSON.stringify([[requiredRule('test')], requiredRule('x')])).mockReturnValueOnce(classicBranch('classic'));
    expect(() => defaultReadRequiredStatusChecks({ gh })).toThrow();
  });

  it('falls back to classic protection when rules are empty', () => {
    const gh = vi.fn().mockReturnValueOnce('[]').mockReturnValueOnce(classicBranch('classic'));
    expect(defaultReadRequiredStatusChecks({ gh })).toEqual(['classic']);
    expect(gh.mock.calls).toEqual([
      [['api', '--paginate', '--slurp', 'repos/{owner}/{repo}/rules/branches/main?per_page=100']],
      [['api', 'repos/{owner}/{repo}/branches/main']],
    ]);
  });

  it.each([
    ['HTTP 403: Resource not accessible by integration', 'HTTP 403: Resource not accessible by integration', 'declared'],
    ['HTTP 502', 'HTTP 403: Resource not accessible by integration', 'fallback'],
    ['HTTP 403: API rate limit exceeded', 'HTTP 403: Resource not accessible by integration', 'fallback'],
    ['HTTP 403: Resource not accessible by integration', 'HTTP 502', 'fallback'],
  ])('preserves error classification: rules %s, protection %s', (rulesMessage, protectionMessage, source) => {
    const rulesError = new Error(rulesMessage);
    const protectionError = new Error(protectionMessage);
    const gh = vi.fn(args => { throw args.some(a => a.includes('/rules/')) ? rulesError : protectionError; });
    const readChecks = options => defaultReadRequiredStatusChecks({ ...options, gh });
    expect(() => readChecks({})).toThrow(source === 'fallback' && !rulesMessage.includes('Resource not accessible') ? rulesError : protectionError);
    expect(getRequiredStatusChecks({ repo: 'web-everything/web-everything', cachePath: join(dir, 'cache.json'), readChecks }))
      .toEqual({ checks: [...FALLBACK_REQUIRED_STATUS_CHECKS], source });
    if (source === 'fallback') expect(existsSync(join(dir, 'cache.json'))).toBe(false);
  });

  it.each(['HTTP 403: Resource not accessible by integration', 'HTTP 502'])('preserves rules failure when protection is empty: %s', message => {
    const error = new Error(message);
    const gh = vi.fn().mockImplementationOnce(() => { throw error; }).mockReturnValueOnce(UNPROTECTED);
    expect(() => defaultReadRequiredStatusChecks({ gh })).toThrow(error);
  });

  it('replaces an expired live cache with a successful rules read', () => {
    const cachePath = join(dir, 'cache.json');
    const repo = 'web-everything/web-everything';
    getRequiredStatusChecks({ repo, cachePath, now: 1000, readChecks: () => ['old-check'] });
    const gh = bothSources(JSON.stringify([[requiredRule(...FALLBACK_REQUIRED_STATUS_CHECKS)]]), UNPROTECTED);
    expect(getRequiredStatusChecks({ repo, cachePath, now: 90_000_000,
      readChecks: options => defaultReadRequiredStatusChecks({ ...options, gh }),
    })).toEqual({ checks: [...FALLBACK_REQUIRED_STATUS_CHECKS], source: 'live' });
    expect(JSON.parse(readFileSync(cachePath, 'utf8')).entries[`${repo}@main`]).toEqual({
      checks: [...FALLBACK_REQUIRED_STATUS_CHECKS], source: 'live', fetchedAtMs: 90_000_000,
    });
    expect(gh).toHaveBeenCalledTimes(2);
  });

  it('propagates a transient rules failure even when classic protection succeeds', () => {
    const error = new Error('HTTP 502');
    const gh = vi.fn().mockImplementationOnce(() => { throw error; }).mockReturnValueOnce(classicBranch('classic'));
    expect(() => defaultReadRequiredStatusChecks({ gh })).toThrow(error);
  });

  // An unreadable ruleset does not mean its requirements disappeared (red-team break on PR #4924): a rules ACCESS
  // denial never returns the classic set as live — it stays a denial, carrying the classic set as a partial floor.
  const rulesDenied = classic => vi.fn()
    .mockImplementationOnce(() => { throw new Error('HTTP 403: Resource not accessible by integration'); })
    .mockReturnValueOnce(classic);

  it('a rules access denial is never a live result, even when classic protection is readable', () => {
    expect(() => defaultReadRequiredStatusChecks({ gh: rulesDenied(classicBranch('classic')) }))
      .toThrow(expect.objectContaining({ message: 'HTTP 403: Resource not accessible by integration', partialChecks: ['classic'] }));
  });

  it('a rules access denial keeps an expired live cache (ruleset-only check kept, file untouched) and the review gate still refuses its red', async () => {
    const { readReviewCiGate } = await import('../review-ci-gate-io.mjs');
    const cachePath = join(dir, 'cache.json');
    const repo = 'web-everything/web-everything';
    getRequiredStatusChecks({ repo, cachePath, now: 1000, readChecks: () => ['test', 'security-scan'] });
    const readChecks = options => defaultReadRequiredStatusChecks({ ...options, gh: rulesDenied(classicBranch('test')) });
    expect(getRequiredStatusChecks({ repo, cachePath, now: 90_000_000, readChecks }))
      .toMatchObject({ checks: ['test', 'security-scan'], source: 'stale-cache' });
    expect(JSON.parse(readFileSync(cachePath, 'utf8')).entries[`${repo}@main`]).toEqual({
      checks: ['test', 'security-scan'], source: 'live', fetchedAtMs: 1000,
    });
    const now = Date.now();
    getRequiredStatusChecks({ repo, cachePath, now, readChecks: () => ['test', 'security-scan'] });
    const gate = readReviewCiGate({ repo, pr: 1, policy: { startAfter: 'ci-green' }, readHead: () => 'a'.repeat(40),
      readRequired: o => getRequiredStatusChecks({ ...o, cachePath, now: now + 1, readChecks }),
      readChecks: () => [
        { name: 'test', status: 'completed', conclusion: 'success' },
        { name: 'security-scan', status: 'completed', conclusion: 'failure' },
      ],
    });
    expect(gate).toMatchObject({ allowed: false, source: 'stale-cache' });
  });

  it('a rules access denial with no cache selects the declared policy, still requiring every classic check', () => {
    const cachePath = join(dir, 'cache.json');
    const repo = 'web-everything/web-everything';
    const readChecks = options => defaultReadRequiredStatusChecks({ ...options, gh: rulesDenied(classicBranch('test', 'classic-only')) });
    const expected = { checks: [...FALLBACK_REQUIRED_STATUS_CHECKS, 'classic-only'], source: 'declared' };
    expect(getRequiredStatusChecks({ repo, cachePath, now: 1000, readChecks })).toEqual(expected);
    expect(JSON.parse(readFileSync(cachePath, 'utf8')).entries[`${repo}@main`]).toEqual({ ...expected, fetchedAtMs: 1000 });
  });

  // The same break with the sources swapped: a readable ruleset behind a classic denial is a floor too.
  it('a classic access denial behind a readable ruleset keeps every ruleset check on top of the declared policy', () => {
    const cachePath = join(dir, 'cache.json');
    const repo = 'web-everything/web-everything';
    const gh = () => bothSources(JSON.stringify([[requiredRule('test', 'security-scan')]]),
      new Error('HTTP 403: Resource not accessible by integration'));
    expect(() => defaultReadRequiredStatusChecks({ gh: gh() }))
      .toThrow(expect.objectContaining({ partialChecks: ['test', 'security-scan'] }));
    const readChecks = options => defaultReadRequiredStatusChecks({ ...options, gh: gh() });
    expect(getRequiredStatusChecks({ repo, cachePath, now: 1000, readChecks }))
      .toEqual({ checks: [...FALLBACK_REQUIRED_STATUS_CHECKS, 'security-scan'], source: 'declared' });
  });

  it('a denial behind a live cache adds the readable source\'s checks to the stale-cache result, file untouched', () => {
    const cachePath = join(dir, 'cache.json');
    const repo = 'web-everything/web-everything';
    getRequiredStatusChecks({ repo, cachePath, now: 1000, readChecks: () => ['test', 'security-scan'] });
    const readChecks = options => defaultReadRequiredStatusChecks({ ...options, gh: rulesDenied(classicBranch('test', 'new-classic')) });
    expect(getRequiredStatusChecks({ repo, cachePath, now: 90_000_000, readChecks }))
      .toMatchObject({ checks: ['test', 'security-scan', 'new-classic'], source: 'stale-cache' });
    expect(JSON.parse(readFileSync(cachePath, 'utf8')).entries[`${repo}@main`].checks).toEqual(['test', 'security-scan']);
  });

  it('a transient rules failure with no cache keeps the readable classic set on top of the fallback', () => {
    const gh = vi.fn().mockImplementationOnce(() => { throw new Error('HTTP 502'); }).mockReturnValueOnce(classicBranch('classic-only'));
    const readChecks = options => defaultReadRequiredStatusChecks({ ...options, gh });
    expect(getRequiredStatusChecks({ repo: 'web-everything/web-everything', cachePath: join(dir, 'cache.json'), readChecks }))
      .toEqual({ checks: [...FALLBACK_REQUIRED_STATUS_CHECKS, 'classic-only'], source: 'fallback' });
  });

  it('a rules read that throws a falsy value is still a failed read, never a classic-only live set', () => {
    const gh = vi.fn().mockImplementationOnce(() => { throw undefined; }).mockReturnValueOnce(classicBranch('classic'));
    let threw = false;
    try { defaultReadRequiredStatusChecks({ gh }); } catch { threw = true; }
    expect(threw).toBe(true);
  });

  // With no base set, an empty set means "count every observed check": a partial set would narrow that and drop a
  // ruleset-only red for source-blind readers (`reduceCheckState`, `ciFailed`), so it is never returned alone.
  it.each([
    ['a rules access denial', () => rulesDenied(classicBranch('classic')), 'fallback'],
    ['a transient rules failure', () => vi.fn().mockImplementationOnce(() => { throw new Error('HTTP 502'); })
      .mockReturnValueOnce(classicBranch('classic')), 'unavailable'],
  ])('%s on an undeclared repo with no cache returns the empty "count everything" set, never the partial one', (_label, gh, source) => {
    const cachePath = join(dir, 'cache.json');
    const readChecks = options => defaultReadRequiredStatusChecks({ ...options, gh: gh() });
    expect(getRequiredStatusChecks({ repo: 'owner/undeclared', cachePath, now: 1000, readChecks }))
      .toEqual({ checks: [], source });
    expect(existsSync(cachePath)).toBe(false);
  });

  it('keeps an expired live cache when rules fail transiently but protection returns a partial set', () => {
    const cachePath = join(dir, 'cache.json');
    const repo = 'web-everything/web-everything';
    getRequiredStatusChecks({ repo, cachePath, now: 1000, readChecks: () => ['test', 'soak-replay-gate'] });
    const gh = vi.fn().mockImplementationOnce(() => { throw new Error('HTTP 502'); }).mockReturnValueOnce(classicBranch('test'));
    const result = getRequiredStatusChecks({ repo, cachePath, now: 90_000_000,
      readChecks: options => defaultReadRequiredStatusChecks({ ...options, gh }),
    });
    expect(result).toMatchObject({ checks: ['test', 'soak-replay-gate'], source: 'stale-cache' });
    expect(JSON.parse(readFileSync(cachePath, 'utf8')).entries[`${repo}@main`]).toEqual({
      checks: ['test', 'soak-replay-gate'], source: 'live', fetchedAtMs: 1000,
    });
  });

  it('routes the rules read through the real throttle personal read path when enabled', () => {
    vi.stubEnv('WE_GH_THROTTLE_PERSONAL_ROUTE', '1');
    vi.stubEnv('WE_GITHUB_AUTH_PERSONAL_EXCEPTIONS', 'reads'); // github.auth=app keeps the route off unless 'reads' is listed
    vi.stubEnv('GH_TOKEN', 'ghs_test_fixture');
    execFileSync.mockReturnValueOnce('ghp_test_fixture');
    const routed = (_bin, args, opts) => {
      expect(opts.env.GH_TOKEN === 'ghp_test_fixture').toBe(true);
      expect(opts.timeout).toBe(15_000);
      const body = args.some(a => a.includes('/rules/')) ? JSON.stringify([[requiredRule('personal-check')]]) : classicBranch('classic-check');
      return { status: 0, stdout: Buffer.from(body), stderr: Buffer.alloc(0) };
    };
    spawnSync.mockImplementationOnce(routed).mockImplementationOnce(routed);
    expect(defaultReadRequiredStatusChecks({ repo: 'web-everything/web-everything' })).toEqual(['personal-check', 'classic-check']);
    expect(execFileSync).toHaveBeenCalledWith('gh', ['auth', 'token'], expect.any(Object));
    expect(spawnSync.mock.calls[0][1]).toEqual(['api', '--paginate', '--slurp', 'repos/web-everything/web-everything/rules/branches/main?per_page=100']);
    expect(spawnSync.mock.calls[1][1]).toEqual(['api', 'repos/web-everything/web-everything/branches/main']);
    expect(process.env.GH_TOKEN === 'ghs_test_fixture').toBe(true);
  });

  it('preserves routed HTTP failures for declared-policy classification', () => {
    vi.stubEnv('WE_GH_THROTTLE_PERSONAL_ROUTE', '1');
    vi.stubEnv('WE_GITHUB_AUTH_PERSONAL_EXCEPTIONS', 'reads'); // github.auth=app keeps the route off unless 'reads' is listed
    spawnSync.mockReturnValue({ status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('Resource not accessible by integration (HTTP 403)') });
    expect(getRequiredStatusChecks({ repo: 'plateauapp/plateau-app', cachePath: join(dir, 'cache.json') }))
      .toEqual({ source: 'declared', checks: ['test', 'e2e'] });
  });

  it('reads `repos/<repo>/branches/<branch>` for the classic set through the conditional REST reader', () => {
    execFileSync.mockReturnValueOnce('[]').mockReturnValueOnce(classicBranch('test', 'smoke', 'daemon-soak'));
    const result = defaultReadRequiredStatusChecks({ repo: 'web-everything/web-everything', branch: 'main' });
    expect(result).toEqual(['test', 'smoke', 'daemon-soak']);
    expect(execFileSync).toHaveBeenCalledWith(
      'gh',
      ['api', '-i', 'repos/web-everything/web-everything/branches/main'],
      expect.objectContaining({ encoding: 'utf8' }),
    );
    expect(execFileSync).toHaveBeenCalledWith(
      'gh',
      ['api', '-i', 'repos/web-everything/web-everything/rules/branches/main?per_page=100&page=1'],
      expect.objectContaining({ encoding: 'utf8' }),
    );
  });

  // `repo` omitted lets `gh api` resolve `{owner}/{repo}` from the current directory's git remote — the same
  // "let gh infer it" convention `we:scripts/conveyor/reconcile-pass.mjs#defaultReadAheadBy` already uses,
  // rather than this reader failing a caller (e.g. a local CLI run with no `--repo` flag) that never had a
  // slug to pass.
  it('falls back to gh\'s own {owner}/{repo} template placeholders when no repo slug is given', () => {
    execFileSync.mockReturnValueOnce('[]').mockReturnValueOnce(classicBranch('test'));
    defaultReadRequiredStatusChecks({});
    expect(execFileSync).toHaveBeenCalledWith(
      'gh',
      ['api', '-i', 'repos/{owner}/{repo}/branches/main'],
      expect.objectContaining({ encoding: 'utf8' }),
    );
  });
});

describe('adding a required check never stalls reviews (live 2026-10-07, `integration`, #4261)', () => {
  const ok = (name) => ({ name, status: 'completed', conclusion: 'success' });
  it('the declared fallback matches ruleset 24883772', async () => {
    const m = await import('../required-status-checks.mjs');
    expect(m.FALLBACK_REQUIRED_STATUS_CHECKS).toEqual(['test', 'smoke', 'daemon-soak', 'soak-replay-gate']);
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

// ── xqd4v1o — ONE shared per-repo cache instead of re-reading branch protection on every check ───────────────────
describe('shared per-repo required-checks cache (xqd4v1o)', () => {
  const WE = 'web-everything/web-everything';
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'we-required-shared-')); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

  it('defaultCachePath is identical from two different working directories and lives under the coordination root', () => {
    vi.stubEnv('WE_COORDINATION_ROOT', join(dir, 'coord'));
    const cwd = vi.spyOn(process, 'cwd');
    cwd.mockReturnValue('/lane/clone/one');
    const first = defaultCachePath();
    cwd.mockReturnValue('/lane/clone/two');
    const second = defaultCachePath();
    expect(first).toBe(second);
    expect(first).toBe(join(dir, 'coord', 'required-status-checks-cache.json'));
  });

  it('a second reader in another cwd makes zero reads against the shared default file', () => {
    vi.stubEnv('WE_COORDINATION_ROOT', join(dir, 'coord'));
    const cwd = vi.spyOn(process, 'cwd');
    const readChecks = vi.fn(() => ['test', 'smoke']);
    cwd.mockReturnValue('/lane/clone/one');
    expect(getRequiredStatusChecks({ repo: WE, now: 1000, readChecks })).toMatchObject({ source: 'live' });
    cwd.mockReturnValue('/lane/clone/two');
    expect(getRequiredStatusChecks({ repo: WE, now: 2000, readChecks })).toEqual({ checks: ['test', 'smoke'], source: 'cache' });
    expect(readChecks).toHaveBeenCalledTimes(1);
  });

  it('records the classic subset on a live entry and serves it from cache and from a stale entry', () => {
    const cachePath = join(dir, 'cache.json');
    const readChecks = () => ({ checks: ['test', 'merge-gate'], classic: ['test'] });
    expect(getRequiredStatusChecks({ repo: WE, cachePath, now: 1000, ttlMs: 1000, readChecks }))
      .toEqual({ checks: ['test', 'merge-gate'], classic: ['test'], source: 'live' });
    expect(JSON.parse(readFileSync(cachePath, 'utf8')).entries[`${WE}@main`].classic).toEqual(['test']);
    expect(getRequiredStatusChecks({ repo: WE, cachePath, now: 1500, ttlMs: 1000, readChecks }))
      .toEqual({ checks: ['test', 'merge-gate'], classic: ['test'], source: 'cache' });
    expect(getRequiredStatusChecks({ repo: WE, cachePath, now: 9000, ttlMs: 1000, readChecks: () => { throw new Error('offline'); } }))
      .toMatchObject({ checks: ['test', 'merge-gate'], classic: ['test'], source: 'stale-cache' });
  });

  it('a declared entry carries no classic set', () => {
    const cachePath = join(dir, 'cache.json');
    const denied = () => { throw new Error('Resource not accessible by integration (HTTP 403)'); };
    const result = getRequiredStatusChecks({ repo: 'plateauapp/plateau-app', cachePath, now: 1000, readChecks: denied });
    expect(result).toEqual({ checks: ['test', 'e2e'], source: 'declared' });
    expect(JSON.parse(readFileSync(cachePath, 'utf8')).entries['plateauapp/plateau-app@main']).not.toHaveProperty('classic');
  });

  it('two interleaved writers for different repos keep both entries (read-merge-write under a lock)', () => {
    const cachePath = join(dir, 'cache.json');
    const other = 'frontier-ui/frontierui';
    // Repo A's read is IN FLIGHT when repo B finishes and writes: A's save must merge, not clobber B.
    const readA = () => {
      getRequiredStatusChecks({ repo: other, cachePath, now: 1000, readChecks: () => ['test'] });
      return ['test', 'smoke'];
    };
    getRequiredStatusChecks({ repo: WE, cachePath, now: 1001, readChecks: readA });
    expect(Object.keys(JSON.parse(readFileSync(cachePath, 'utf8')).entries).sort()).toEqual([`${WE}@main`, `${other}@main`].sort());
    expect(existsSync(`${cachePath}.lock`)).toBe(false);
  });

  describe('overlapping writers for the SAME repo (PR #5404 red team)', () => {
    const denied = () => { throw new Error('Resource not accessible by integration (HTTP 403)'); };
    const entryOf = cachePath => JSON.parse(readFileSync(cachePath, 'utf8')).entries[`${WE}@main`];

    it('a denied reader that started first never overwrites a newer live entry with the declared policy', () => {
      const cachePath = join(dir, 'cache.json');
      // Reader A (cold cache, t=1000) is in flight when reader B (t=2000) saves a live policy; then A is denied.
      const readA = () => {
        getRequiredStatusChecks({ repo: WE, cachePath, now: 2000, readChecks: () => ['test', 'security-scan'] });
        return denied();
      };
      // A's own answer is the entry that won, never the declared defaults the file no longer holds.
      expect(getRequiredStatusChecks({ repo: WE, cachePath, now: 1000, readChecks: readA }))
        .toEqual({ checks: ['test', 'security-scan'], source: 'cache' });
      expect(entryOf(cachePath)).toMatchObject({ checks: ['test', 'security-scan'], source: 'live', fetchedAtMs: 2000 });
      const next = vi.fn(() => ['never']);
      expect(getRequiredStatusChecks({ repo: WE, cachePath, now: 3000, readChecks: next }))
        .toEqual({ checks: ['test', 'security-scan'], source: 'cache' });
      expect(next).not.toHaveBeenCalled();
    });

    it('a denied reader never replaces an OLDER live entry that landed while it read either', () => {
      const cachePath = join(dir, 'cache.json');
      const readA = () => {
        getRequiredStatusChecks({ repo: WE, cachePath, now: 1000, readChecks: () => ['test', 'security-scan'] });
        return denied();
      };
      expect(getRequiredStatusChecks({ repo: WE, cachePath, now: 2000, readChecks: readA }))
        .toEqual({ checks: ['test', 'security-scan'], source: 'cache' });
      expect(entryOf(cachePath)).toMatchObject({ checks: ['test', 'security-scan'], source: 'live', fetchedAtMs: 1000 });
    });

    it('a denied reader answers with a winning live entry past its TTL as stale-cache, keeping the partial floor', () => {
      const cachePath = join(dir, 'cache.json');
      const readA = () => {
        getRequiredStatusChecks({ repo: WE, cachePath, now: 1000, ttlMs: 10, readChecks: () => ['test', 'security-scan'] });
        throw Object.assign(new Error('Resource not accessible by integration (HTTP 403)'), { partialChecks: ['merge-gate'] });
      };
      expect(getRequiredStatusChecks({ repo: WE, cachePath, now: 5000, ttlMs: 10, readChecks: readA }))
        .toEqual({ checks: ['test', 'security-scan', 'merge-gate'], source: 'stale-cache', cacheAgeMs: 4000 });
    });

    it('a denied reader answers with a FRESH winning live entry plus its partial floor, never the entry alone', () => {
      const cachePath = join(dir, 'cache.json');
      // B (t=1000) caches ['test'] while A (t=2000) is in flight; A then sees a newly required check through rules.
      const readA = () => {
        getRequiredStatusChecks({ repo: WE, cachePath, now: 1000, readChecks: () => ['test'] });
        throw Object.assign(new Error('Resource not accessible by integration (HTTP 403)'), { partialChecks: ['security-scan'] });
      };
      expect(getRequiredStatusChecks({ repo: WE, cachePath, now: 2000, readChecks: readA }))
        .toEqual({ checks: ['test', 'security-scan'], source: 'cache' });
      expect(entryOf(cachePath)).toMatchObject({ checks: ['test'], source: 'live', fetchedAtMs: 1000 });
    });

    it.each([
      ['a transient failure', () => new Error('HTTP 502: Bad Gateway')],
      ['a transient failure with a stale snapshot', () => new Error('HTTP 502: Bad Gateway'), true],
    ])('%s answers from the entry another reader saved meanwhile, never the pre-read snapshot', (_l, makeError, seed) => {
      const cachePath = join(dir, 'cache.json');
      if (seed) getRequiredStatusChecks({ repo: WE, cachePath, now: 100, readChecks: () => ['old'] });
      const readA = () => {
        getRequiredStatusChecks({ repo: WE, cachePath, now: 1990, ttlMs: 1000, readChecks: () => ['test', 'merge-gate'] });
        throw Object.assign(makeError(), { partialChecks: ['security-scan'] });
      };
      expect(getRequiredStatusChecks({ repo: WE, cachePath, now: 2000, ttlMs: 1000, readChecks: readA }))
        .toEqual({ checks: ['test', 'merge-gate', 'security-scan'], source: 'cache' });
    });

    it('a denied reader whose cache write times out on the lock still answers with the newer live entry', () => {
      const cachePath = join(dir, 'cache.json');
      const readA = () => {
        getRequiredStatusChecks({ repo: WE, cachePath, now: 1990, readChecks: () => ['test', 'merge-gate'] });
        writeFileSync(`${cachePath}.lock`, `${process.pid}\n`); // a live holder: A's own save cannot take the lock
        throw Object.assign(new Error('Resource not accessible by integration (HTTP 403)'), { partialChecks: ['security-scan'] });
      };
      expect(getRequiredStatusChecks({ repo: WE, cachePath, now: 2000, readChecks: readA }))
        .toEqual({ checks: ['test', 'merge-gate', 'security-scan'], source: 'cache' });
      expect(entryOf(cachePath)).toMatchObject({ checks: ['test', 'merge-gate'], source: 'live', fetchedAtMs: 1990 });
    }, 15_000);

    it('an older live read never moves a newer live entry backwards', () => {
      const cachePath = join(dir, 'cache.json');
      const readA = () => {
        getRequiredStatusChecks({ repo: WE, cachePath, now: 2000, readChecks: () => ['test', 'security-scan'] });
        return ['test'];
      };
      expect(getRequiredStatusChecks({ repo: WE, cachePath, now: 1000, readChecks: readA }))
        .toEqual({ checks: ['test', 'security-scan'], source: 'cache' });
      expect(entryOf(cachePath)).toMatchObject({ checks: ['test', 'security-scan'], source: 'live', fetchedAtMs: 2000 });
    });

    it('a live read replaces a declared entry that landed while it read, even a newer one', () => {
      const cachePath = join(dir, 'cache.json');
      const readA = () => {
        getRequiredStatusChecks({ repo: WE, cachePath, now: 2000, readChecks: denied });
        return ['test', 'security-scan'];
      };
      getRequiredStatusChecks({ repo: WE, cachePath, now: 1000, readChecks: readA });
      expect(entryOf(cachePath)).toMatchObject({ checks: ['test', 'security-scan'], source: 'live', fetchedAtMs: 1000 });
    });

    it('a legacy source-less entry counts as live: a concurrent denial never replaces it', () => {
      const cachePath = join(dir, 'cache.json');
      const readA = () => {
        writeFileSync(cachePath, JSON.stringify({ entries: { [`${WE}@main`]: { checks: ['test', 'security-scan'], fetchedAtMs: 1500 } } }));
        return denied();
      };
      getRequiredStatusChecks({ repo: WE, cachePath, now: 1000, readChecks: readA });
      expect(entryOf(cachePath)).toEqual({ checks: ['test', 'security-scan'], fetchedAtMs: 1500 });
    });

    it('a newer write still replaces an older entry of the same kind (no regression)', () => {
      const cachePath = join(dir, 'cache.json');
      getRequiredStatusChecks({ repo: WE, cachePath, now: 1000, ttlMs: 10, readChecks: () => ['test'] });
      getRequiredStatusChecks({ repo: WE, cachePath, now: 2000, ttlMs: 10, readChecks: () => ['test', 'smoke'] });
      expect(entryOf(cachePath)).toMatchObject({ checks: ['test', 'smoke'], source: 'live', fetchedAtMs: 2000 });
    });
  });

  it('a lock that cannot be taken skips the write but never fails the read', () => {
    const cachePath = join(dir, 'cache.json');
    writeFileSync(`${cachePath}.lock`, `${process.pid}\n`); // a live holder (this process) — never stale-stolen
    const result = getRequiredStatusChecks({ repo: WE, cachePath, now: 1000, readChecks: () => ['test'] });
    expect(result).toEqual({ checks: ['test'], source: 'live' });
    expect(existsSync(cachePath)).toBe(false);
  }, 15_000);

  it.each([
    ['not JSON', '{not json'],
    ['an empty file', ''],
    ['a JSON array', '[]'],
    ['entries as an array', '{"entries":[]}'],
  ])('a corrupt cache (%s) is no cache: a live read happens and the file is repaired — never an empty required set', (_l, body) => {
    const cachePath = join(dir, 'cache.json');
    writeFileSync(cachePath, body);
    const readChecks = vi.fn(() => ['test']);
    expect(getRequiredStatusChecks({ repo: WE, cachePath, now: 1000, readChecks })).toEqual({ checks: ['test'], source: 'live' });
    expect(readChecks).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(cachePath, 'utf8')).entries[`${WE}@main`].checks).toEqual(['test']);
  });

  it('an anonymous (cwd-inferred) repo is never cached', () => {
    const cachePath = join(dir, 'cache.json');
    getRequiredStatusChecks({ cachePath, now: 1000, readChecks: () => ['test'] });
    expect(existsSync(cachePath)).toBe(false);
  });

  describe('ttl setting', () => {
    it('a settings value overrides the 15 minute default; junk values are ignored', () => {
      expect(cacheTtlMsFromSettings({ requiredChecksCache: { ttlMinutes: 5 } })).toBe(5 * 60_000);
      for (const junk of [undefined, {}, { requiredChecksCache: {} }, { requiredChecksCache: { ttlMinutes: 0 } },
        { requiredChecksCache: { ttlMinutes: -3 } }, { requiredChecksCache: { ttlMinutes: '9' } }, { requiredChecksCache: { ttlMinutes: NaN } }]) {
        expect(cacheTtlMsFromSettings(junk)).toBe(15 * 60_000);
      }
      expect(resolveCacheTtlMs({ settings: { requiredChecksCache: { ttlMinutes: 1 } } })).toBe(60_000);
    });
    it('with no explicit ttlMs, the default TTL decides whether an entry is served or revalidated', () => {
      const cachePath = join(dir, 'cache.json');
      const readChecks = vi.fn(() => ['test']);
      getRequiredStatusChecks({ repo: WE, cachePath, now: 1_000_000, readChecks });
      expect(getRequiredStatusChecks({ repo: WE, cachePath, now: 1_000_000 + 14 * 60_000, readChecks }).source).toBe('cache');
      expect(getRequiredStatusChecks({ repo: WE, cachePath, now: 1_000_000 + 16 * 60_000, readChecks }).source).toBe('live');
      expect(readChecks).toHaveBeenCalledTimes(2);
    });
    it('the shipped settings file is read by the real settings loader and drives the TTL', () => {
      // Not asserted against the 15 min default alone (a missing file would also pass): the key itself must be present.
      expect(readSettings().requiredChecksCache).toEqual({ ttlMinutes: 15 });
      expect(cacheTtlMsFromSettings(readSettings())).toBe(15 * 60_000);
      const dir2 = mkdtempSync(join(tmpdir(), 'we-ttl-settings-'));
      try {
        writeFileSync(join(dir2, 'required-checks-cache.json'), JSON.stringify({ requiredChecksCache: { ttlMinutes: 7 } }));
        expect(cacheTtlMsFromSettings(readSettings({ dir: dir2, legacyPath: null }))).toBe(7 * 60_000);
      } finally { rmSync(dir2, { recursive: true, force: true }); }
    });
  });

  describe('ETag revalidation', () => {
    const rulesBody = JSON.stringify([requiredRule('test', 'merge-gate')]);
    const okReply = (body, etag) => `HTTP/2.0 200 OK\r\netag: ${etag}\r\ncontent-type: application/json\r\n\r\n${body}`;
    const NOT_MODIFIED = () => Object.assign(new Error('Command failed: gh api'), { stdout: 'HTTP/2.0 304 Not Modified\r\netag: "e"\r\n\r\n', stderr: 'gh: HTTP 304' });

    it('isolates anonymous ETag reads across working directories', () => {
      const etagDir = join(dir, 'etag'); // Shared across both checkouts, just like the production REST cache.
      const cwdA = mkdtempSync(join(dir, 'repo-a-'));
      const cwdB = mkdtempSync(join(dir, 'repo-b-'));
      const calls = [];
      const replies = [];
      const exec = (_bin, argv) => {
        const path = argv[argv.length - 1];
        const kind = path.includes('/rules/') ? 'rules' : 'classic';
        const repo = process.cwd() === cwdA ? 'a' : 'b';
        calls.push({ cwd: process.cwd(), argv });
        // ETags are scoped to resources: two repositories may return the same tag for different bodies.
        if (argv.includes(`If-None-Match: "${kind}"`)) throw NOT_MODIFIED();
        const body = kind === 'rules' ? JSON.stringify([requiredRule(`${repo}-rules`)]) : classicBranch(`${repo}-classic`);
        return okReply(body, `"${kind}"`);
      };
      const restGet = (path, options) => {
        const reply = ghRestGetJson(path, { ...options, exec, dir: etagDir, env: { HOME: dir } });
        replies.push(reply.status);
        return reply;
      };
      // Vitest workers cannot chdir; only the cwd lookup is substituted. Cache keying, disk I/O and 304
      // body reuse all run through the real REST reader; the transport alone supplies deterministic replies.
      const cwd = vi.spyOn(process, 'cwd');
      try {
        for (const [checkout, repo] of [[cwdA, 'a'], [cwdB, 'b'], [cwdA, 'a'], [cwdB, 'b']]) {
          cwd.mockReturnValue(checkout);
          expect(readRequiredStatusChecksDetailed({ restGet })).toEqual({
            checks: [`${repo}-rules`, `${repo}-classic`], classic: [`${repo}-classic`],
          });
        }
        expect(replies).toEqual([200, 200, 200, 200, 304, 304, 304, 304]);
        expect(calls).toHaveLength(8);
        for (const [index, call] of calls.entries()) {
          const path = index % 2 === 0
            ? 'repos/{owner}/{repo}/rules/branches/main?per_page=100&page=1'
            : 'repos/{owner}/{repo}/branches/main';
          const headers = index < 4 ? [] : ['-H', `If-None-Match: "${index % 2 === 0 ? 'rules' : 'classic'}"`];
          expect(call).toEqual({ cwd: index % 4 < 2 ? cwdA : cwdB, argv: ['api', '-i', ...headers, path] });
        }
      } finally { cwd.mockRestore(); }
    });

    it('after the TTL the revalidating read sends If-None-Match and a 304 keeps the set, refreshing fetchedAtMs', () => {
      const etagDir = join(dir, 'etag');
      const cachePath = join(dir, 'cache.json');
      const branch = classicBranch('test');
      let phase = 'first';
      const calls = [];
      const exec = vi.fn((_bin, argv) => {
        calls.push(argv);
        const path = argv[argv.length - 1];
        if (phase === 'first') return okReply(path.includes('/rules/') ? rulesBody : branch, `"etag-${path.includes('/rules/') ? 'r' : 'b'}"`);
        throw NOT_MODIFIED();
      });
      const restGet = (path, o) => ghRestGetJson(path, { ...o, exec, dir: etagDir, env: { HOME: dir } });
      const readChecks = o => readRequiredStatusChecksDetailed({ ...o, restGet });
      const first = getRequiredStatusChecks({ repo: WE, cachePath, now: 1000, ttlMs: 1000, readChecks });
      expect(first).toEqual({ checks: ['test', 'merge-gate'], classic: ['test'], source: 'live' });
      expect(calls.every(a => !a.includes('-H'))).toBe(true);

      phase = 'revalidate';
      calls.length = 0;
      const second = getRequiredStatusChecks({ repo: WE, cachePath, now: 9000, ttlMs: 1000, readChecks });
      expect(second).toEqual({ checks: ['test', 'merge-gate'], classic: ['test'], source: 'live' });
      expect(calls).toHaveLength(2);
      for (const argv of calls) expect(argv).toEqual(expect.arrayContaining(['-H', expect.stringMatching(/^If-None-Match: "etag-[rb]"$/)]));
      expect(JSON.parse(readFileSync(cachePath, 'utf8')).entries[`${WE}@main`].fetchedAtMs).toBe(9000);
    });

    it('a 304 for an injected restGet keeps the checks and bumps the age', () => {
      const cachePath = join(dir, 'cache.json');
      const restGet = vi.fn(path => ({ status: 304, notModified: true,
        json: path.includes('/rules/') ? [requiredRule('test')] : JSON.parse(classicBranch('test')) }));
      const readChecks = o => readRequiredStatusChecksDetailed({ ...o, restGet });
      getRequiredStatusChecks({ repo: WE, cachePath, now: 1000, ttlMs: 1000, readChecks });
      getRequiredStatusChecks({ repo: WE, cachePath, now: 5000, ttlMs: 1000, readChecks });
      expect(JSON.parse(readFileSync(cachePath, 'utf8')).entries[`${WE}@main`]).toMatchObject({ checks: ['test'], fetchedAtMs: 5000 });
    });

    it('a blank 200 body is a failed read, never "no checks": the stale entry is kept', () => {
      const cachePath = join(dir, 'cache.json');
      getRequiredStatusChecks({ repo: WE, cachePath, now: 1000, readChecks: () => ['test', 'smoke'] });
      // A blank 200 body parses to `null` in ghRestGetJson (`JSON.parse(body || 'null')`): both sources must refuse it.
      const blank = () => ({ status: 200, json: null });
      const result = getRequiredStatusChecks({ repo: WE, cachePath, now: 90_000_000, ttlMs: 1000,
        readChecks: o => readRequiredStatusChecksDetailed({ ...o, restGet: blank }) });
      expect(result).toMatchObject({ checks: ['test', 'smoke'], source: 'stale-cache' });
    });

    it('a rules page that is not an array is a failed read (never an empty rule list), and the page cap is an error', () => {
      const notArray = vi.fn(path => ({ status: 200, json: path.includes('/rules/') ? null : JSON.parse(classicBranch('test')) }));
      expect(() => readRequiredStatusChecksDetailed({ repo: WE, restGet: notArray })).toThrow(/rules/);
      const endless = vi.fn(path => ({ status: 200, json: path.includes('/rules/') ? Array.from({ length: 100 }, () => ({ type: 'deletion' })) : JSON.parse(classicBranch('test')) }));
      expect(() => readRequiredStatusChecksDetailed({ repo: WE, restGet: endless })).toThrow(/page cap/);
    });

    it('reads every rules page until a short page', () => {
      const page1 = Array.from({ length: 99 }, () => ({ type: 'deletion' })).concat([requiredRule('p1')]);
      const restGet = vi.fn(path => ({ status: 200, json: path.endsWith('&page=1') ? page1 : path.endsWith('&page=2') ? [requiredRule('p2')]
        : JSON.parse(classicBranch('test')) }));
      expect(readRequiredStatusChecksDetailed({ repo: WE, restGet })).toEqual({ checks: ['p1', 'p2', 'test'], classic: ['test'] });
    });

    it('a REST 403 on the rules read keeps the declared-policy classification (denial → declared)', () => {
      const cachePath = join(dir, 'cache.json');
      const denied = () => { throw Object.assign(new Error('Command failed: gh api'), { stderr: 'gh: Resource not accessible by integration (HTTP 403)' }); };
      const result = getRequiredStatusChecks({ repo: 'plateauapp/plateau-app', cachePath, now: 1000,
        readChecks: o => readRequiredStatusChecksDetailed({ ...o, restGet: denied }) });
      expect(result).toEqual({ checks: ['test', 'e2e'], source: 'declared' });
    });
  });
});
