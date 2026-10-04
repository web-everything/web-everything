/**
 * The review daemon sweeps all three constellation orgs in one process, so its App auth must be per-owner.
 * Live 2026-10-04: it pinned the web-everything installation's token as GH_TOKEN, every `gh` call against
 * plateauapp/plateau-app failed with "Could not resolve to a Repository", and PR #202 (CI green) was skipped
 * every pass as `review-ci: unreadable-ci`.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { OWNER_INSTALLATIONS } from '../../../scripts/lib/github-app-installations.mjs';
import { renderGhShimScript } from '../../../scripts/lib/gh-app-shim.mjs';
import { withGithubAppAuth } from '../../../scripts/lib/github-app-auth-env.mjs';
import { REVIEW_DAEMON_APP_AUTH_OPTS } from '../review-daemon.mjs';

const PERMS = { metadata: 'read', pull_requests: 'write', issues: 'write', contents: 'write', workflows: 'write', checks: 'read', statuses: 'read', actions: 'read' };
// A fake `gh` that behaves like GitHub: a token only resolves repos of the owner whose installation minted it.
const FAKE_GH = `#!/usr/bin/env node
const a = process.argv.slice(2);
const i = a.indexOf('--repo');
const slug = i >= 0 ? a[i + 1] : '';
const tok = process.env.GH_TOKEN || '';
if (tok && tok !== 'tok-' + slug.split('/')[0]) { process.stderr.write("GraphQL: Could not resolve to a Repository with the name '" + slug + "'.\\n"); process.exit(1); }
process.stdout.write('{"headRefOid":"${'a'.repeat(40)}"}');
`;

describe('review daemon App auth', () => {
  it('is per-owner', () => {
    expect(REVIEW_DAEMON_APP_AUTH_OPTS?.perOwner).toBe(true);
  });

  it('a tick can read plateauapp/plateau-app#202 (the live repro)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-daemon-auth-'));
    const fakeGh = join(dir, 'gh');
    writeFileSync(fakeGh, FAKE_GH);
    chmodSync(fakeGh, 0o755);
    const cachePath = join(dir, 'web-everything.json');
    const shimPath = join(dir, 'shim.js');
    const byId = Object.fromEntries(Object.entries(OWNER_INSTALLATIONS).map(([o, id]) => [id, o]));
    const env = { WE_GITHUB_APP_ID: '1', WE_GITHUB_APP_INSTALLATION_ID: OWNER_INSTALLATIONS['web-everything'], WE_GITHUB_APP_PRIVATE_KEY_PATH: '/k', PATH: '/usr/bin' };
    const exp = new Date(Date.now() + 3600e3).toISOString();
    let seen;
    const effects = withGithubAppAuth({
      tickOnce: () => {
        // The tick's gh call: through the shim when per-owner installed it, else the raw gh with whatever GH_TOKEN was pinned.
        const viaShim = env.PATH !== '/usr/bin';
        const argv = ['pr', 'view', '202', '--repo', 'plateauapp/plateau-app', '--json', 'headRefOid'];
        seen = viaShim
          ? spawnSync(process.execPath, [shimPath, ...argv], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir } })
          : spawnSync(process.execPath, [fakeGh, ...argv], { encoding: 'utf8', env: { ...env, PATH: process.env.PATH } });
      },
    }, {
      ...REVIEW_DAEMON_APP_AUTH_OPTS,
      env, cachePath, statusPath: join(dir, 'status.json'), log: { error() {} },
      mint: async ({ installationId }) => ({ token: `tok-${byId[installationId]}`, expiresAt: exp, permissions: PERMS }),
      getInstallationInfo: async () => ({ repositorySelection: 'all' }),
      installShim: async (e) => {
        writeFileSync(shimPath, renderGhShimScript({ realGhPath: fakeGh, cachePath, ghThrottleCliPath: join(dir, 'missing-throttle.mjs') }));
        e.PATH = `${dir}:${e.PATH}`;
        return { ok: true };
      },
    });
    await effects.tickOnce();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(seen.status, seen.stderr).toBe(0);
    expect(JSON.parse(seen.stdout).headRefOid).toHaveLength(40);
  });
});
