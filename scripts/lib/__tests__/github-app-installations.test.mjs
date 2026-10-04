import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  OWNER_INSTALLATIONS, installationForOwner, installationMap, ownerFromGhArgv, ownerFromRemoteUrl,
  installationCachePath, remapLegacyInstallationId, LEGACY_PERSONAL_INSTALLATION_ID,
} from '../github-app-installations.mjs';
import { renderGhShimScript } from '../gh-app-shim.mjs';
import { ensureFreshGithubAppEnv, resolveGithubAppEnvConfig, CACHE_VERSION } from '../github-app-auth-env.mjs';

describe('owner -> installation selection', () => {
  it('maps each new org to its installation, case-insensitively', () => {
    expect(installationForOwner('web-everything')).toBe('167640002');
    expect(installationForOwner('Frontier-UI')).toBe('167639957');
    expect(installationForOwner('plateauapp')).toBe('167639975');
  });
  it('returns null for an unknown owner (personal-auth fallback), including the retired personal account', () => {
    expect(installationForOwner('chalbert')).toBeNull();
    expect(installationForOwner('')).toBeNull();
    expect(installationForOwner('constructor')).toBeNull();
  });
  it('lets WE_GITHUB_APP_INSTALLATIONS add an owner and ignores a malformed override', () => {
    expect(installationForOwner('new-org', { WE_GITHUB_APP_INSTALLATIONS: '{"new-org":"42"}' })).toBe('42');
    expect(installationMap({ WE_GITHUB_APP_INSTALLATIONS: '{not json' })).toEqual(OWNER_INSTALLATIONS);
  });
  it('remaps the legacy personal installation id to the web-everything org installation', () => {
    expect(remapLegacyInstallationId(LEGACY_PERSONAL_INSTALLATION_ID)).toBe('167640002');
    expect(remapLegacyInstallationId('999')).toBe('999');
    expect(resolveGithubAppEnvConfig({ WE_GITHUB_APP_ID: '1', WE_GITHUB_APP_INSTALLATION_ID: '163880042', WE_GITHUB_APP_PRIVATE_KEY_PATH: '/k' }).installationId).toBe('167640002');
  });
  it('reads the owner from gh argv forms', () => {
    expect(ownerFromGhArgv(['pr', 'list', '--repo', 'frontier-ui/frontierui'])).toBe('frontier-ui');
    expect(ownerFromGhArgv(['pr', 'view', '3', '--repo=plateauapp/plateau-app'])).toBe('plateauapp');
    expect(ownerFromGhArgv(['pr', 'view', '-R', 'web-everything/web-everything'])).toBe('web-everything');
    expect(ownerFromGhArgv(['api', 'repos/frontier-ui/frontierui/pulls'])).toBe('frontier-ui');
    expect(ownerFromGhArgv(['auth', 'status'])).toBeNull();
  });
  it('reads the owner from https and ssh remotes, masking credentials', () => {
    expect(ownerFromRemoteUrl('https://github.com/plateauapp/plateau-app.git')).toBe('plateauapp');
    expect(ownerFromRemoteUrl('git@github.com:frontier-ui/frontierui.git')).toBe('frontier-ui');
    expect(ownerFromRemoteUrl('https://x-access-token:abc@github.com/web-everything/web-everything')).toBe('web-everything');
    expect(ownerFromRemoteUrl('/local/path')).toBeNull();
  });
  it('derives a per-installation cache path', () => {
    expect(installationCachePath('/h/.claude/github-app-token/web-everything.json', '7')).toBe('/h/.claude/github-app-token/web-everything.7.json');
  });
});

describe('minter keeps one cache per installation', () => {
  it('mints and caches every mapped installation, and applies the primary to GH_TOKEN', async () => {
    const files = {};
    const minted = [];
    const env = { WE_GITHUB_APP_ID: '1', WE_GITHUB_APP_INSTALLATION_ID: '163880042', WE_GITHUB_APP_PRIVATE_KEY_PATH: '/k' };
    const exp = new Date(Date.now() + 3600e3).toISOString();
    const result = await ensureFreshGithubAppEnv({
      env, cachePath: '/c/web-everything.json', now: Date.now(),
      readCache: (p) => files[p] ?? null, writeCache: (p, d) => { files[p] = d; },
      mint: async ({ installationId }) => { minted.push(String(installationId)); return { token: `tok-${installationId}`, expiresAt: exp, permissions: { metadata: 'read', pull_requests: 'write', issues: 'write', contents: 'write', workflows: 'write', checks: 'read', statuses: 'read', actions: 'read' } }; },
      getInstallationInfo: async () => ({ repositorySelection: 'all' }),
      writeStatus: () => {}, log: { error() {} },
    });
    expect(result.applied).toBe(true);
    expect(env.GH_TOKEN).toBe('tok-167640002');
    expect(minted.sort()).toEqual(['167639957', '167639975', '167640002']);
    for (const id of ['167640002', '167639957', '167639975']) {
      expect(files[`/c/web-everything.${id}.json`].token).toBe(`tok-${id}`);
    }
  });
});

describe('generated shim picks the token by repo owner', () => {
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), 'shim-owner-'));
    const fakeGh = join(dir, 'gh');
    writeFileSync(fakeGh, '#!/bin/sh\necho "token=$GH_TOKEN"\n');
    chmodSync(fakeGh, 0o755);
    const cachePath = join(dir, 'web-everything.json');
    const exp = new Date(Date.now() + 3600e3).toISOString();
    for (const [owner, id] of Object.entries(OWNER_INSTALLATIONS)) {
      writeFileSync(installationCachePath(cachePath, id), JSON.stringify({ v: CACHE_VERSION, appId: '1', installationId: id, token: `T-${owner}`, expiresAt: exp }));
    }
    const shim = join(dir, 'shim.js');
    writeFileSync(shim, renderGhShimScript({ realGhPath: fakeGh, cachePath, ghThrottleCliPath: join(dir, 'missing-throttle.mjs') }));
    const run = (args) => spawnSync(process.execPath, [shim, ...args], { encoding: 'utf8', cwd: dir, env: { ...process.env, GH_TOKEN: '', GH_REPO: '', HOME: dir } });
    return { run, cachePath };
  };
  it.each([
    ['frontier-ui/frontierui', 'T-frontier-ui'],
    ['plateauapp/plateau-app', 'T-plateauapp'],
    ['web-everything/web-everything', 'T-web-everything'],
  ])('uses the %s installation token', (slug, expected) => {
    const { run } = setup();
    expect(run(['pr', 'list', '--repo', slug]).stdout).toContain(`token=${expected}`);
  });
  it('falls back to personal auth with a warning for an unknown owner', () => {
    const { run } = setup();
    const r = run(['pr', 'list', '--repo', 'someone-else/repo']);
    expect(r.stdout).toContain('token=\n');
    expect(r.stderr).toMatch(/no GitHub App installation is configured for owner "someone-else"/);
  });
});

describe('legacy chalbert slugs resolve to the new owner', () => {
  it('maps chalbert/<moved repo> to the repo\'s new org, from argv, remotes and api paths', async () => {
    const { canonicalOwner } = await import('../github-app-installations.mjs');
    expect(canonicalOwner('chalbert', 'frontierui')).toBe('frontier-ui');
    expect(canonicalOwner('chalbert', 'unrelated')).toBe('chalbert');
    expect(ownerFromGhArgv(['pr', 'list', '--repo', 'chalbert/plateau-app'])).toBe('plateauapp');
    expect(ownerFromGhArgv(['api', 'repos/chalbert/web-everything/pulls'])).toBe('web-everything');
    expect(ownerFromRemoteUrl('https://github.com/chalbert/webeverything.git')).toBe('web-everything');
  });
});

describe('legacy slugs from old origin remotes are canonicalized before reaching gh --repo', () => {
  it('canonicalizeSlug maps chalbert/<known repo> and leaves everything else alone', async () => {
    const { canonicalizeSlug, repoKeyForSlug } = await import('../constellation-repos.mjs');
    expect(canonicalizeSlug('chalbert/web-everything')).toBe('web-everything/web-everything');
    expect(canonicalizeSlug('chalbert/webeverything')).toBe('web-everything/web-everything');
    expect(canonicalizeSlug('chalbert/frontierui')).toBe('frontier-ui/frontierui');
    expect(canonicalizeSlug('chalbert/plateau-app')).toBe('plateauapp/plateau-app');
    expect(canonicalizeSlug('chalbert/other-repo')).toBe('chalbert/other-repo');
    expect(canonicalizeSlug('acme/frontierui')).toBe('acme/frontierui');
    expect(repoKeyForSlug('chalbert/frontierui')).toBe('frontierui');
  });
  it('the drain sweeps the declared per-org slugs even when self comes from a legacy origin', async () => {
    const { resolveRepos } = await import('../../merge-ai-prs.mjs');
    expect(resolveRepos({ self: 'chalbert/web-everything' }))
      .toEqual(['web-everything/web-everything', 'frontier-ui/frontierui', 'plateauapp/plateau-app']);
    expect(resolveRepos({ self: 'frontier-ui/frontierui' })[0]).toBe('frontier-ui/frontierui');
    expect(resolveRepos({ repos: 'frontierui,chalbert/plateau-app', self: 'web-everything/web-everything' }))
      .toEqual(['frontier-ui/frontierui', 'plateauapp/plateau-app']);
  });
});
