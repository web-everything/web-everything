/**
 * @file scripts/lib/__tests__/github-app-auth-env.test.mjs
 * @description Unit proof of the #3866-ratified GitHub App auth-env wiring. Every effect (the cache
 *   read/write, the mint call, the repo listing, the clock, the `process.env` mutation) is injected — no real fs,
 *   no real network, no real GitHub App needed.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveGithubAppEnvConfig, isCacheFresh, ensureFreshGithubAppEnv, withGithubAppAuth,
  REFRESH_BUFFER_MS, defaultCachePath, findInstallationGaps, CACHE_VERSION, REQUIRED_APP_PERMISSIONS, REQUIRED_APP_REPOS,
  defaultStatusPath, readGithubAppStatus,
} from '../github-app-auth-env.mjs';

// NEVER THE REAL HOME DIR (#x8mpubm follow-up, live-caught: before this existed, this suite's own pre-existing
// tests — none of which had any reason to know status recording exists — silently wrote real, misleading
// entries into the developer's actual `~/.claude/github-app-token/status.json` on every run, stomping
// whatever a real daemon on the same machine had just recorded there; a `vi.mock('node:os', …)` attempt to
// fix this at the module level was tried and DISCARDED — this suite's `environment: 'happy-dom'` resolves
// the SUT's own `import { homedir } from 'node:os'` through a different path than this file's own import of
// the same specifier, so the mock silently never reached the SUT). The reliable fix is explicit, at every
// call site: this is a no-op `writeStatus` passed to every `ensureFreshGithubAppEnv` call below that is not
// itself testing status recording (that describe block, further down, injects its own per case) — matching
// this file's own established discipline of injecting every effect rather than trusting a real default.
const NOOP_STATUS = { writeStatus: () => {} };

const CONFIGURED_ENV = {
  WE_GITHUB_APP_ID: '5037855',
  WE_GITHUB_APP_INSTALLATION_ID: '555000111',
  WE_GITHUB_APP_PRIVATE_KEY_PATH: '/Users/x/.secrets/github-apps/web-everything.pem',
};

/** A fully-configured installation: every required permission at its required level, every repo visible. */
const FULL_PERMS = { ...REQUIRED_APP_PERMISSIONS };
const allRepos = vi.fn(async () => [...REQUIRED_APP_REPOS]);

/** The default fake for the new `getInstallationInfo` dependency: a 'selected' installation, so every
 *  pre-existing test below (written before `repository_selection` existed) keeps exercising `listRepos`
 *  exactly as it did before this file added the 'all' short-circuit. */
const selectedInfo = vi.fn(async () => ({ permissions: FULL_PERMS, repositorySelection: 'selected' }));

describe('resolveGithubAppEnvConfig — opt-in, all three or none', () => {
  it('returns the config when all three env vars are set', () => {
    expect(resolveGithubAppEnvConfig(CONFIGURED_ENV)).toEqual({
      appId: '5037855', installationId: '555000111', privateKeyPath: '/Users/x/.secrets/github-apps/web-everything.pem',
    });
  });

  it('returns null when none are set — the status-quo, personal-auth path, unchanged', () => {
    expect(resolveGithubAppEnvConfig({})).toBeNull();
  });

  it('returns null on a PARTIAL configuration — a two-thirds opt-in is almost certainly a typo, never a real intent', () => {
    expect(resolveGithubAppEnvConfig({ WE_GITHUB_APP_ID: '1', WE_GITHUB_APP_INSTALLATION_ID: '2' })).toBeNull();
    expect(resolveGithubAppEnvConfig({ WE_GITHUB_APP_PRIVATE_KEY_PATH: '/x.pem' })).toBeNull();
  });
});

describe('isCacheFresh — pure freshness classifier', () => {
  const NOW = Date.parse('2026-09-23T12:00:00Z');

  it('a token expiring well in the future is fresh', () => {
    expect(isCacheFresh({ v: CACHE_VERSION, expiresAt: '2026-09-23T13:00:00Z' }, NOW)).toBe(true);
  });

  it('a token expiring within the refresh buffer is NOT fresh — refresh early, never right at the wire', () => {
    const expiresAt = new Date(NOW + REFRESH_BUFFER_MS - 1000).toISOString();
    expect(isCacheFresh({ v: CACHE_VERSION, expiresAt }, NOW)).toBe(false);
  });

  it('a token already past its own expiry is not fresh', () => {
    expect(isCacheFresh({ v: CACHE_VERSION, expiresAt: '2026-09-23T11:00:00Z' }, NOW)).toBe(false);
  });

  it('no cache at all (null) is never fresh — that is a mint, not a refresh', () => {
    expect(isCacheFresh(null, NOW)).toBe(false);
  });

  it('a corrupt/malformed cache entry (no usable expiresAt) is not fresh', () => {
    expect(isCacheFresh({}, NOW)).toBe(false);
    expect(isCacheFresh({ v: CACHE_VERSION, expiresAt: 'not-a-date' }, NOW)).toBe(false);
  });

  it('an entry from another cache version (or none) is never fresh, however far off its expiry', () => {
    expect(isCacheFresh({ expiresAt: '2026-09-23T13:00:00Z' }, NOW)).toBe(false);
    expect(isCacheFresh({ v: CACHE_VERSION - 1, expiresAt: '2026-09-23T13:00:00Z' }, NOW)).toBe(false);
  });
});

describe('THE DEPLOY INCIDENT (2026-09-23) — an unvalidated token cached by an older version', () => {
  it('is never applied: it is re-minted and re-checked, and a still-under-configured App is refused', async () => {
    const oldEntry = { token: 'ghs_unvalidated', expiresAt: '2026-09-23T13:58:13Z' }; // no `v` — the pre-check shape
    const mint = vi.fn().mockResolvedValue({ token: 'ghs_new', expiresAt: '2026-09-23T14:00:00Z', permissions: {} });
    const setEnv = vi.fn();
    const result = await ensureFreshGithubAppEnv({
      env: CONFIGURED_ENV, now: Date.parse('2026-09-23T13:20:00Z'), readCache: () => oldEntry, writeCache: vi.fn(),
      mint, listRepos: vi.fn(async () => []), getInstallationInfo: selectedInfo, setEnv, log: { error: vi.fn() }, ...NOOP_STATUS,
    });
    expect(mint).toHaveBeenCalled();
    expect(result.reason).toBe('insufficient-access');
    expect(setEnv).not.toHaveBeenCalled(); // neither the old token nor the fresh one
  });
});

describe('ensureFreshGithubAppEnv — the IO shell, every effect injected', () => {
  const NOW = Date.parse('2026-09-23T12:00:00Z');

  it('not configured — does nothing, mints nothing, sets no env, and says so', async () => {
    const mint = vi.fn();
    const setEnv = vi.fn();
    const result = await ensureFreshGithubAppEnv({ env: {}, now: NOW, mint, setEnv });
    expect(result).toEqual({ applied: false, reason: 'not-configured' });
    expect(mint).not.toHaveBeenCalled();
    expect(setEnv).not.toHaveBeenCalled();
  });

  it('cache already fresh — reads it, mints NOTHING, and sets env from the cached token', async () => {
    const cached = { v: CACHE_VERSION, appId: CONFIGURED_ENV.WE_GITHUB_APP_ID, installationId: CONFIGURED_ENV.WE_GITHUB_APP_INSTALLATION_ID, token: 'ghs_cached', expiresAt: '2026-09-23T13:00:00Z' };
    const readCache = vi.fn(() => cached);
    const writeCache = vi.fn();
    const mint = vi.fn();
    const setEnv = vi.fn();
    const result = await ensureFreshGithubAppEnv({
      env: CONFIGURED_ENV, now: NOW, readCache, writeCache, mint, setEnv, ...NOOP_STATUS,
    });
    expect(result).toEqual({ applied: true, reason: 'ok' });
    expect(mint).not.toHaveBeenCalled();
    expect(writeCache).not.toHaveBeenCalled();
    expect(setEnv).toHaveBeenCalledWith('ghs_cached');
  });

  it('cache missing — mints a fresh token, writes it back to the cache, and sets env from it', async () => {
    const readCache = vi.fn(() => null);
    const writeCache = vi.fn();
    const mint = vi.fn().mockResolvedValue({ token: 'ghs_fresh', expiresAt: '2026-09-23T13:00:00Z', permissions: FULL_PERMS });
    const setEnv = vi.fn();
    const result = await ensureFreshGithubAppEnv({
      env: CONFIGURED_ENV, now: NOW, readCache, writeCache, mint, listRepos: allRepos, getInstallationInfo: selectedInfo, setEnv, ...NOOP_STATUS,
    });
    expect(result).toEqual({ applied: true, reason: 'ok' });
    expect(mint).toHaveBeenCalledWith({
      appId: '5037855', installationId: '555000111',
      privateKeyPath: '/Users/x/.secrets/github-apps/web-everything.pem', now: NOW,
    });
    expect(writeCache).toHaveBeenCalledWith(expect.any(String), { v: CACHE_VERSION, appId: CONFIGURED_ENV.WE_GITHUB_APP_ID, installationId: CONFIGURED_ENV.WE_GITHUB_APP_INSTALLATION_ID, token: 'ghs_fresh', expiresAt: '2026-09-23T13:00:00Z' });
    expect(setEnv).toHaveBeenCalledWith('ghs_fresh');
  });

  it('cache expiring within the buffer — mints a fresh one rather than trusting the stale entry', async () => {
    const expiresAt = new Date(NOW + REFRESH_BUFFER_MS - 1000).toISOString();
    const readCache = vi.fn(() => ({ v: CACHE_VERSION, appId: CONFIGURED_ENV.WE_GITHUB_APP_ID, installationId: CONFIGURED_ENV.WE_GITHUB_APP_INSTALLATION_ID, token: 'ghs_stale', expiresAt }));
    const writeCache = vi.fn();
    const mint = vi.fn().mockResolvedValue({ token: 'ghs_new', expiresAt: '2026-09-23T14:00:00Z', permissions: FULL_PERMS });
    const setEnv = vi.fn();
    await ensureFreshGithubAppEnv({ env: CONFIGURED_ENV, now: NOW, readCache, writeCache, mint, listRepos: allRepos, getInstallationInfo: selectedInfo, setEnv, ...NOOP_STATUS });
    expect(mint).toHaveBeenCalled();
    expect(setEnv).toHaveBeenCalledWith('ghs_new');
  });

  it('a mint failure NEVER throws — falls back, leaves env untouched, and reports why', async () => {
    const readCache = vi.fn(() => null);
    const mint = vi.fn().mockRejectedValue(new Error('github-app-token: mint failed (HTTP 401): bad credentials'));
    const setEnv = vi.fn();
    const log = { error: vi.fn() };
    const result = await ensureFreshGithubAppEnv({ env: CONFIGURED_ENV, now: NOW, readCache, mint, setEnv, log, ...NOOP_STATUS });
    expect(result).toEqual({ applied: false, reason: 'mint-failed' });
    expect(setEnv).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('mint failed'));
  });

  it('a corrupt cache (unreadable JSON, surfaced as null by the reader) is treated as absent, not thrown on', async () => {
    const readCache = vi.fn(() => null); // the real readCacheFile swallows a parse error into null — this
    // pins the CONTRACT ensureFreshGithubAppEnv relies on, not the real fs-backed reader (that would need a
    // real corrupt file on disk, out of scope for a pure-injection unit test).
    const writeCache = vi.fn();
    const mint = vi.fn().mockResolvedValue({ token: 'ghs_recovered', expiresAt: '2026-09-23T13:00:00Z', permissions: FULL_PERMS });
    const setEnv = vi.fn();
    const result = await ensureFreshGithubAppEnv({ env: CONFIGURED_ENV, now: NOW, readCache, writeCache, mint, listRepos: allRepos, getInstallationInfo: selectedInfo, setEnv, ...NOOP_STATUS });
    expect(result.applied).toBe(true);
    expect(setEnv).toHaveBeenCalledWith('ghs_recovered');
  });

  // Live-caught 2026-09-23: the real first installation minted fine with `permissions: {}` and only public-repo
  // read access. Applying it would have left the fleet unable to label, comment, merge, or see plateau-app.
  it('THE LIVE CASE: an installation with NO permissions is refused — personal auth stays, nothing cached', async () => {
    const writeCache = vi.fn();
    const mint = vi.fn().mockResolvedValue({ token: 'ghs_bare', expiresAt: '2026-09-23T13:00:00Z', permissions: {} });
    const listRepos = vi.fn(async () => ['web-everything/web-everything']);
    const setEnv = vi.fn();
    const log = { error: vi.fn() };
    const result = await ensureFreshGithubAppEnv({
      env: CONFIGURED_ENV, now: NOW, readCache: () => null, writeCache, mint, listRepos, getInstallationInfo: selectedInfo, setEnv, log, ...NOOP_STATUS,
    });
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('insufficient-access');
    expect(result.missingPermissions).toContain('pull_requests:write');
    expect(result.missingRepos).toEqual(REQUIRED_APP_REPOS.filter((r) => r !== 'web-everything/web-everything'));
    expect(setEnv).not.toHaveBeenCalled();
    expect(writeCache).not.toHaveBeenCalled(); // an unusable token is never cached, so the next refresh re-checks
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('NOT applying'));
  });

  it('full permissions but a repo missing from the installation is still refused', async () => {
    const mint = vi.fn().mockResolvedValue({ token: 'ghs_x', expiresAt: '2026-09-23T13:00:00Z', permissions: FULL_PERMS });
    const listRepos = vi.fn(async () => REQUIRED_APP_REPOS.slice(0, 1));
    const setEnv = vi.fn();
    const result = await ensureFreshGithubAppEnv({
      env: CONFIGURED_ENV, now: NOW, readCache: () => null, writeCache: vi.fn(), mint, listRepos, getInstallationInfo: selectedInfo, setEnv, log: { error: vi.fn() }, ...NOOP_STATUS,
    });
    expect(result.reason).toBe('insufficient-access');
    expect(result.missingPermissions).toEqual([]);
    expect(setEnv).not.toHaveBeenCalled();
  });

  // Live-caught 2026-09-26: a `listRepos` failure used to be bucketed as `mint-failed` — misleading, since the
  // mint itself succeeded (the token IS good) and an operator reading that reason would think the App token
  // was broken, not that one read of the (separate) repo listing failed. It is its own reason now, and it
  // must never report every required repo as a confirmed gap on a read failure it never actually confirmed.
  it("a failure LISTING repos — with repository_selection not 'all' — is its own reason, distinct from mint-failed and from a confirmed gap", async () => {
    const mint = vi.fn().mockResolvedValue({ token: 'ghs_x', expiresAt: '2026-09-23T13:00:00Z', permissions: FULL_PERMS });
    const listRepos = vi.fn(async () => { throw new Error('HTTP 502'); });
    const setEnv = vi.fn();
    const writeCache = vi.fn();
    const log = { error: vi.fn() };
    const result = await ensureFreshGithubAppEnv({
      env: CONFIGURED_ENV, now: NOW, readCache: () => null, writeCache, mint, listRepos, getInstallationInfo: selectedInfo, setEnv, log, ...NOOP_STATUS,
    });
    expect(result).toEqual({ applied: false, reason: 'access-check-failed' });
    expect(setEnv).not.toHaveBeenCalled();
    expect(writeCache).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('could not verify'));
  });

  // THE LIVE FIX (2026-09-26): the exact real response shape the fleet hit — a mint with every permission
  // correctly granted, `repository_selection: 'all'` (an installation with access to every repository), and
  // `listRepos` returning an INCOMPLETE list (simulating GitHub's own listing lag right after the operator
  // changed the installation's access) — must still apply, because 'all' is checked BEFORE any enumeration.
  it("THE LIVE FIX: repository_selection 'all' applies even when the repo LISTING is empty/incomplete — never calls listRepos at all", async () => {
    const mint = vi.fn().mockResolvedValue({ token: 'ghs_all', expiresAt: '2026-09-26T15:08:07Z', permissions: FULL_PERMS });
    const getInstallationInfoAll = vi.fn(async () => ({ permissions: FULL_PERMS, repositorySelection: 'all' }));
    const listRepos = vi.fn(async () => []); // what the fleet actually saw mid-lag — must never be reached
    const writeCache = vi.fn();
    const setEnv = vi.fn();
    const result = await ensureFreshGithubAppEnv({
      env: CONFIGURED_ENV, now: NOW, readCache: () => null, writeCache, mint, listRepos,
      getInstallationInfo: getInstallationInfoAll, setEnv, log: { error: vi.fn() }, ...NOOP_STATUS,
    });
    expect(result).toEqual({ applied: true, reason: 'ok' });
    expect(listRepos).not.toHaveBeenCalled();
    expect(setEnv).toHaveBeenCalledWith('ghs_all');
    expect(writeCache).toHaveBeenCalled();
  });

  it("a getInstallationInfo failure alone (repository_selection unknown) falls back to the enumeration check, exactly as before this file added 'all'", async () => {
    const mint = vi.fn().mockResolvedValue({ token: 'ghs_y', expiresAt: '2026-09-23T13:00:00Z', permissions: FULL_PERMS });
    const getInstallationInfoFailing = vi.fn().mockRejectedValue(new Error('HTTP 500'));
    const setEnv = vi.fn();
    const result = await ensureFreshGithubAppEnv({
      env: CONFIGURED_ENV, now: NOW, readCache: () => null, writeCache: vi.fn(), mint, listRepos: allRepos,
      getInstallationInfo: getInstallationInfoFailing, setEnv, log: { error: vi.fn() }, ...NOOP_STATUS,
    });
    expect(allRepos).toHaveBeenCalled();
    expect(result).toEqual({ applied: true, reason: 'ok' });
    expect(setEnv).toHaveBeenCalledWith('ghs_y');
  });

  it('BOTH the repository_selection read and the repo listing failing is access-check-failed, never a confirmed gap', async () => {
    const mint = vi.fn().mockResolvedValue({ token: 'ghs_z', expiresAt: '2026-09-23T13:00:00Z', permissions: FULL_PERMS });
    const getInstallationInfoFailing = vi.fn().mockRejectedValue(new Error('fetch failed'));
    const listRepos = vi.fn(async () => { throw new Error('fetch failed'); });
    const setEnv = vi.fn();
    const result = await ensureFreshGithubAppEnv({
      env: CONFIGURED_ENV, now: NOW, readCache: () => null, writeCache: vi.fn(), mint, listRepos,
      getInstallationInfo: getInstallationInfoFailing, setEnv, log: { error: vi.fn() }, ...NOOP_STATUS,
    });
    expect(result).toEqual({ applied: false, reason: 'access-check-failed' });
    expect(setEnv).not.toHaveBeenCalled();
  });
});

describe('findInstallationGaps — pure', () => {
  it('a fully-configured installation has no gaps', () => {
    expect(findInstallationGaps({ permissions: FULL_PERMS, repos: [...REQUIRED_APP_REPOS] })).toEqual({ missingPermissions: [], missingRepos: [] });
  });

  it('a higher level satisfies a lower requirement (write covers read, admin covers write)', () => {
    const perms = { ...FULL_PERMS, checks: 'write', contents: 'admin' };
    expect(findInstallationGaps({ permissions: perms, repos: [...REQUIRED_APP_REPOS] }).missingPermissions).toEqual([]);
  });

  it('a lower level than required is a gap (read where write is needed)', () => {
    const perms = { ...FULL_PERMS, pull_requests: 'read' };
    expect(findInstallationGaps({ permissions: perms, repos: [...REQUIRED_APP_REPOS] }).missingPermissions).toEqual(['pull_requests:write']);
  });

  it('repo matching is case-insensitive (GitHub full names are)', () => {
    const repos = REQUIRED_APP_REPOS.map((r) => r.toUpperCase());
    expect(findInstallationGaps({ permissions: FULL_PERMS, repos }).missingRepos).toEqual([]);
  });

  // THE LIVE BUG (2026-09-26): `repos` came back empty/incomplete during GitHub's own listing lag right after
  // a permission/repo-access change, and every required repo was reported missing even though the installation
  // had `repository_selection: 'all'`. This is the fix, at the pure-core level: 'all' is never gated on `repos`.
  it("repository_selection 'all' reports zero missing repos regardless of what `repos` contains — empty, undefined, or incomplete", () => {
    expect(findInstallationGaps({ permissions: FULL_PERMS, repos: [], repositorySelection: 'all' }).missingRepos).toEqual([]);
    expect(findInstallationGaps({ permissions: FULL_PERMS, repositorySelection: 'all' }).missingRepos).toEqual([]);
    expect(findInstallationGaps({ permissions: FULL_PERMS, repos: ['web-everything/web-everything'], repositorySelection: 'all' }).missingRepos).toEqual([]);
  });

  it("repository_selection 'selected' (or absent) still enforces the enumeration check exactly as before", () => {
    expect(findInstallationGaps({ permissions: FULL_PERMS, repos: [], repositorySelection: 'selected' }).missingRepos).toEqual([...REQUIRED_APP_REPOS]);
    expect(findInstallationGaps({ permissions: FULL_PERMS, repos: [] }).missingRepos).toEqual([...REQUIRED_APP_REPOS]);
  });
});

describe('withGithubAppAuth — refresh at the top of every tick, never on a timer', () => {
  // Live-caught 2026-09-23: a timer refresh could not run while a daemon tick's blocking execFileSync calls
  // held the event loop, and a mint caught mid-connection timed out. Per-tick ordering is the fix.
  it('the token is set BEFORE the real tick runs — including the very first tick', async () => {
    const order = [];
    const setEnv = vi.fn(() => order.push('setEnv'));
    const mint = vi.fn().mockResolvedValue({ token: 'ghs_t', expiresAt: '2099-01-01T00:00:00Z', permissions: FULL_PERMS });
    const effects = { tickOnce: vi.fn(() => { order.push('tick'); return { ok: 1 }; }), sleep: vi.fn(), intervalMs: 5 };
    const wrapped = withGithubAppAuth(effects, {
      env: CONFIGURED_ENV, readCache: () => null, writeCache: vi.fn(), mint, listRepos: allRepos, getInstallationInfo: selectedInfo, setEnv, ...NOOP_STATUS,
    });
    const result = await wrapped.tickOnce();
    expect(order).toEqual(['setEnv', 'tick']);
    expect(result).toEqual({ ok: 1 }); // the real tick's own result passes through untouched
  });

  it('keeps every other effect as-is (sleep, heartbeat, interval) — only tickOnce is wrapped', () => {
    const effects = { tickOnce: () => {}, sleep: vi.fn(), heartbeat: vi.fn(), intervalMs: 123 };
    const wrapped = withGithubAppAuth(effects, { env: {} });
    expect(wrapped.sleep).toBe(effects.sleep);
    expect(wrapped.heartbeat).toBe(effects.heartbeat);
    expect(wrapped.intervalMs).toBe(123);
    expect(wrapped.tickOnce).not.toBe(effects.tickOnce);
  });

  it('a failed refresh never blocks the tick — it still runs, on whatever auth was already in effect', async () => {
    const tick = vi.fn(() => 'ran');
    const mint = vi.fn().mockRejectedValue(new Error('fetch failed'));
    const wrapped = withGithubAppAuth({ tickOnce: tick }, {
      env: CONFIGURED_ENV, readCache: () => null, mint, listRepos: allRepos, getInstallationInfo: selectedInfo, setEnv: vi.fn(), log: { error: vi.fn() }, ...NOOP_STATUS,
    });
    await expect(wrapped.tickOnce()).resolves.toBe('ran');
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('not configured — the tick runs with no refresh attempt at all', async () => {
    const mint = vi.fn();
    const tick = vi.fn(() => 'ran');
    const wrapped = withGithubAppAuth({ tickOnce: tick }, { env: {}, mint });
    await expect(wrapped.tickOnce()).resolves.toBe('ran');
    expect(mint).not.toHaveBeenCalled();
  });
});

describe('defaultCachePath — one shared cache, keyed by home dir only, never per-process', () => {
  it('is deterministic for a given home dir, so two independent daemons resolve the SAME file', () => {
    expect(defaultCachePath('/Users/op')).toBe(defaultCachePath('/Users/op'));
    expect(defaultCachePath('/Users/op')).toContain('/Users/op/.claude/github-app-token/');
  });
});

describe('defaultStatusPath — one shared status file, sibling of the cache, keyed by home dir only', () => {
  it('is deterministic for a given home dir, so two independent daemons resolve the SAME file', () => {
    expect(defaultStatusPath('/Users/op')).toBe(defaultStatusPath('/Users/op'));
    expect(defaultStatusPath('/Users/op')).toContain('/Users/op/.claude/github-app-token/');
  });

  it('is a DIFFERENT file from the token cache — a status read must never accidentally return a cache entry', () => {
    expect(defaultStatusPath('/Users/op')).not.toBe(defaultCachePath('/Users/op'));
  });
});

describe('ensureFreshGithubAppEnv — records its outcome to the status file on every REAL path (#x8mpubm)', () => {
  const NOW = Date.parse('2026-09-23T12:00:00Z');

  // Live-caught the same day #x8mpubm's own status write shipped: a caller with nothing configured (a stray
  // local script, or a test that forgot to inject `statusPath`/`writeStatus`) would otherwise stomp a REAL
  // daemon's `insufficient-access`/`ok` with a misleading `not-configured` — which is exactly what happened
  // to `~/.claude/github-app-token/status.json` on this machine while this file's OWN pre-existing tests
  // (below, none of which pass `statusPath`) ran against the real default. `not-configured` describes the
  // CALLER, not the fleet's installation, so it is never written; a reader with no file at all already gets
  // its own honest, distinct message (see `readGithubAppStatus`'s null case in `github-app-status.mjs`).
  it('not-configured is NEVER recorded — it describes the caller, not the installation, and must not stomp a real status', async () => {
    const writeStatus = vi.fn();
    const result = await ensureFreshGithubAppEnv({ env: {}, now: NOW, statusPath: '/x/status.json', writeStatus });
    expect(result).toEqual({ applied: false, reason: 'not-configured' });
    expect(writeStatus).not.toHaveBeenCalled();
  });

  it('a live apply (cache hit) is recorded as applied:true', async () => {
    const cached = { v: CACHE_VERSION, appId: CONFIGURED_ENV.WE_GITHUB_APP_ID, installationId: CONFIGURED_ENV.WE_GITHUB_APP_INSTALLATION_ID, token: 'ghs_cached', expiresAt: '2026-09-23T13:00:00Z' };
    const writeStatus = vi.fn();
    await ensureFreshGithubAppEnv({
      env: CONFIGURED_ENV, now: NOW, readCache: () => cached, writeCache: vi.fn(), setEnv: vi.fn(),
      statusPath: '/x/status.json', writeStatus,
    });
    expect(writeStatus).toHaveBeenCalledWith('/x/status.json', { applied: true, reason: 'ok', checkedAt: new Date(NOW).toISOString() });
  });

  it('a mint failure is recorded as mint-failed, with no permissions/repos fields', async () => {
    const writeStatus = vi.fn();
    const mint = vi.fn().mockRejectedValue(new Error('fetch failed'));
    await ensureFreshGithubAppEnv({
      env: CONFIGURED_ENV, now: NOW, readCache: () => null, mint, setEnv: vi.fn(), log: { error: vi.fn() },
      statusPath: '/x/status.json', writeStatus,
    });
    expect(writeStatus).toHaveBeenCalledWith('/x/status.json', { applied: false, reason: 'mint-failed', checkedAt: new Date(NOW).toISOString() });
  });

  it('THE LIVE CASE, recorded: an under-permissioned install is captured with the exact missing permissions and repos', async () => {
    const writeStatus = vi.fn();
    const mint = vi.fn().mockResolvedValue({ token: 'ghs_bare', expiresAt: '2026-09-23T13:00:00Z', permissions: {} });
    const listRepos = vi.fn(async () => []);
    await ensureFreshGithubAppEnv({
      env: CONFIGURED_ENV, now: NOW, readCache: () => null, writeCache: vi.fn(), mint, listRepos, getInstallationInfo: selectedInfo, setEnv: vi.fn(),
      log: { error: vi.fn() }, statusPath: '/x/status.json', writeStatus,
    });
    expect(writeStatus).toHaveBeenCalledWith('/x/status.json', {
      applied: false,
      reason: 'insufficient-access',
      missingPermissions: Object.entries(REQUIRED_APP_PERMISSIONS).map(([name, level]) => `${name}:${level}`),
      missingRepos: [...REQUIRED_APP_REPOS],
      checkedAt: new Date(NOW).toISOString(),
    });
  });

  it('a failing REAL status write never throws and never changes the returned result — diagnostic only', async () => {
    // Exercises the REAL default writeStatusFile (no writeStatus override) against a path that CANNOT be
    // created (`blocker` is a plain file, so `mkdirSync(dirname(badStatusPath))` fails) — proving the real
    // writer swallows its own error rather than the caller having to guard against one.
    const dir = mkdtempSync(join(tmpdir(), 'we-app-status-'));
    const blocker = join(dir, 'blocker-file');
    writeFileSync(blocker, 'x', 'utf8');
    const badStatusPath = join(blocker, 'status.json');
    const cached = { v: CACHE_VERSION, appId: CONFIGURED_ENV.WE_GITHUB_APP_ID, installationId: CONFIGURED_ENV.WE_GITHUB_APP_INSTALLATION_ID, token: 'ghs_cached', expiresAt: '2026-09-23T13:00:00Z' };
    try {
      const result = await ensureFreshGithubAppEnv({
        env: CONFIGURED_ENV, now: NOW, readCache: () => cached, writeCache: vi.fn(), setEnv: vi.fn(),
        statusPath: badStatusPath,
      });
      expect(result).toEqual({ applied: true, reason: 'ok' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('readGithubAppStatus / the real writeStatusFile default — round trip through real fs', () => {
  it('reads back exactly what a real ensureFreshGithubAppEnv call wrote, in a scratch dir', async () => {
    // `not-configured` is deliberately never written (see the describe block above), so this round trip
    // uses a CONFIGURED env reaching a real recorded reason instead.
    const dir = mkdtempSync(join(tmpdir(), 'we-app-status-'));
    const statusPath = join(dir, 'status.json');
    const cached = { v: CACHE_VERSION, appId: CONFIGURED_ENV.WE_GITHUB_APP_ID, installationId: CONFIGURED_ENV.WE_GITHUB_APP_INSTALLATION_ID, token: 'ghs_cached', expiresAt: '2026-09-23T13:00:00Z' };
    try {
      const result = await ensureFreshGithubAppEnv({
        env: CONFIGURED_ENV, now: Date.parse('2026-09-23T12:00:00Z'), readCache: () => cached, writeCache: vi.fn(),
        setEnv: vi.fn(), statusPath,
      });
      expect(result).toEqual({ applied: true, reason: 'ok' });
      expect(readGithubAppStatus(statusPath)).toEqual({ ...result, checkedAt: '2026-09-23T12:00:00.000Z' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a missing status file reads as null, not a thrown error', () => {
    expect(readGithubAppStatus('/definitely/does/not/exist/status.json')).toBeNull();
  });
});

describe('installation-bound cache provenance (#4652)', () => {
  const NOW = Date.parse('2026-09-23T12:00:00Z');
  it.each([undefined, '999'])('remints a cache with missing or different installation %s', async (installationId) => {
    const env = { ...CONFIGURED_ENV };
    const mint = vi.fn(async () => ({ token: 'ghs_synthetic_rotated', expiresAt: '2026-09-23T13:00:00Z', permissions: REQUIRED_APP_PERMISSIONS }));
    const writeCache = vi.fn();
    await ensureFreshGithubAppEnv({ env, now: NOW,
      readCache: () => ({ v: CACHE_VERSION, appId: env.WE_GITHUB_APP_ID, installationId, token: 'ghs_synthetic_old', expiresAt: '2026-09-23T13:00:00Z' }),
      mint, writeCache, getInstallationInfo: async () => ({ repositorySelection: 'all' }), ...NOOP_STATUS,
    });
    expect(mint).toHaveBeenCalledOnce();
    expect(env.GH_TOKEN).toBe('ghs_synthetic_rotated');
    expect(env.WE_GH_AUTH_INSTALLATION).toBe(CONFIGURED_ENV.WE_GITHUB_APP_INSTALLATION_ID);
    expect(env.WE_GH_AUTH_SOURCE).toBe('mint');
    expect(writeCache.mock.calls[0][1].installationId).toBe(env.WE_GH_AUTH_INSTALLATION);
    expect(env.WE_GH_AUTH_TOKEN_HASH).toMatch(/^[a-f0-9]{64}$/);
  });
});
