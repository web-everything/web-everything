/**
 * Multi-repo callers (the drain) must not pin ONE org's installation token as GH_TOKEN. Live 2026-10-03 23:17Z:
 * the drain's single web-everything token made `gh pr list --repo frontier-ui/frontierui` fail with "Could not
 * resolve to a Repository", and the whole pass died. With `perOwner`, every owner keeps its own cached token and
 * `gh` goes through the shim, which picks the token by the target repo's owner.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { OWNER_INSTALLATIONS } from '../github-app-installations.mjs';
import { renderGhShimScript } from '../gh-app-shim.mjs';
import { ensureFreshGithubAppEnv } from '../github-app-auth-env.mjs';

const PERMS = { metadata: 'read', pull_requests: 'write', issues: 'write', contents: 'write', workflows: 'write', checks: 'read', statuses: 'read', actions: 'read' };
const baseEnv = () => ({ WE_GITHUB_APP_ID: '1', WE_GITHUB_APP_INSTALLATION_ID: OWNER_INSTALLATIONS['web-everything'], WE_GITHUB_APP_PRIVATE_KEY_PATH: '/k', PATH: '/usr/bin' });

// A fake `gh` that behaves like GitHub: a token only resolves repos of the owner whose installation minted it.
const FAKE_GH = `#!/usr/bin/env node
const a = process.argv.slice(2);
const i = a.indexOf('--repo');
const slug = i >= 0 ? a[i + 1] : '';
const owner = slug.split('/')[0];
const tok = process.env.GH_TOKEN || '';
if (tok && tok !== 'tok-' + owner) { process.stderr.write("GraphQL: Could not resolve to a Repository with the name '" + slug + "'.\\n"); process.exit(1); }
process.stdout.write('ok token=' + tok + ' repo=' + slug + '\\n');
`;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'per-owner-'));
  const fakeGh = join(dir, 'gh');
  writeFileSync(fakeGh, FAKE_GH);
  chmodSync(fakeGh, 0o755);
  const cachePath = join(dir, 'web-everything.json');
  const exp = new Date(Date.now() + 3600e3).toISOString();
  const byId = Object.fromEntries(Object.entries(OWNER_INSTALLATIONS).map(([o, id]) => [id, o]));
  const env = baseEnv();
  const minted = [];
  const shimPath = join(dir, 'shim.js');
  const run = async (opts = {}) => ensureFreshGithubAppEnv({
    env, cachePath, statusPath: join(dir, 'status.json'), now: Date.now(),
    mint: async ({ installationId }) => { minted.push(String(installationId)); return { token: `tok-${byId[installationId]}`, expiresAt: exp, permissions: PERMS }; },
    getInstallationInfo: async () => ({ repositorySelection: 'all' }),
    log: { error() {} },
    installShim: async () => { writeFileSync(shimPath, renderGhShimScript({ realGhPath: fakeGh, cachePath, ghThrottleCliPath: join(dir, 'missing-throttle.mjs') })); return { ok: true }; },
    ...opts,
  });
  const gh = (args) => spawnSync(process.execPath, [shimPath, ...args], { encoding: 'utf8', cwd: dir, env: { PATH: process.env.PATH, HOME: dir } });
  return { env, run, gh, minted, dir };
}

describe('ensureFreshGithubAppEnv({ perOwner: true })', () => {
  it('does not pin GH_TOKEN, and keeps a fresh token cached for every owner', async () => {
    const { env, run, minted, dir } = setup();
    const r = await run({ perOwner: true });
    expect(r).toMatchObject({ applied: true, reason: 'ok' });
    expect(env.GH_TOKEN).toBeUndefined();
    expect(minted.sort()).toEqual(Object.values(OWNER_INSTALLATIONS).sort());
    for (const [owner, id] of Object.entries(OWNER_INSTALLATIONS)) {
      expect(JSON.parse(readFileSync(join(dir, `web-everything.${id}.json`), 'utf8')).token).toBe(`tok-${owner}`);
    }
  });

  it('a multi-repo caller gets the right installation token per owner (frontier-ui regression)', async () => {
    const { run, gh } = setup();
    await run({ perOwner: true });
    for (const slug of ['web-everything/web-everything', 'frontier-ui/frontierui', 'plateauapp/plateau-app']) {
      const r = gh(['pr', 'list', '--repo', slug]);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain(`token=tok-${slug.split('/')[0]} `);
    }
  });

  it('the old single pinned token fails on frontier-ui (what the drain hit)', async () => {
    const { env, run, dir } = setup();
    await run(); // single-repo behaviour: GH_TOKEN pinned to the web-everything install
    const r = spawnSync(process.execPath, [join(dir, 'gh'), 'pr', 'list', '--repo', 'frontier-ui/frontierui'], { encoding: 'utf8', env: { ...env, PATH: process.env.PATH } });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Could not resolve to a Repository with the name 'frontier-ui\/frontierui'/);
  });

  it('an unknown owner falls back to personal auth with a warning', async () => {
    const { run, gh } = setup();
    await run({ perOwner: true });
    const r = gh(['pr', 'list', '--repo', 'someone-else/repo']);
    expect(r.stdout).toContain('token= ');
    expect(r.stderr).toMatch(/no GitHub App installation is configured for owner "someone-else"/);
  });

  it('stays on personal auth (nothing pinned) when the shim cannot be installed', async () => {
    const { env, run } = setup();
    const r = await run({ perOwner: true, installShim: async () => ({ ok: false, reason: 'no-real-gh' }) });
    expect(r).toMatchObject({ applied: false, reason: 'shim-failed' });
    expect(env.GH_TOKEN).toBeUndefined();
  });

  it('single-repo callers (no perOwner) keep today\'s behaviour: GH_TOKEN set, shim untouched', async () => {
    const { env, run, dir } = setup();
    const r = await run();
    expect(r.applied).toBe(true);
    expect(env.GH_TOKEN).toBe('tok-web-everything');
    expect(existsSync(join(dir, 'shim.js'))).toBe(false);
  });
});
