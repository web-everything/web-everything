/** Synthetic App auth for CLI fixtures whose PATH contains only a fake gh. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CACHE_VERSION, defaultCachePath } from '../../lib/github-app-auth-env.mjs';
import { installationCachePath, OWNER_INSTALLATIONS } from '../../lib/github-app-installations.mjs';

export const DAEMON_APP_FIXTURE_TOKEN = 'fixture-daemon-app-token';

/** Keep the real daemon guard and per-owner routing active, without minting or real credentials. */
export function daemonAppEnv(home) {
  const cachePath = defaultCachePath(home);
  mkdirSync(dirname(cachePath), { recursive: true });
  const appId = '123456';
  const installationId = '654321';
  const key = join(dirname(cachePath), 'fixture-key');
  writeFileSync(key, 'unused: the fixture always supplies a fresh cache');
  const cached = JSON.stringify({ v: CACHE_VERSION, appId, installationId,
    token: DAEMON_APP_FIXTURE_TOKEN, expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString() });
  writeFileSync(cachePath, cached);
  writeFileSync(installationCachePath(cachePath, installationId), cached);
  return {
    HOME: home, GH_CONFIG_DIR: join(home, '.config', 'gh'),
    GH_TOKEN: '', GITHUB_TOKEN: '', GH_HOST: 'github.com', GH_REPO: '',
    WE_GITHUB_AUTH: 'app', WE_GH_AUTH_PERSONAL_FALLBACK: 'refuse', WE_DELIVERY_IDENTITY: 'none',
    WE_GITHUB_APP_ID: appId, WE_GITHUB_APP_INSTALLATION_ID: installationId,
    WE_GITHUB_APP_PRIVATE_KEY_PATH: key,
    WE_GITHUB_APP_INSTALLATIONS: JSON.stringify(Object.fromEntries(
      [...Object.keys(OWNER_INSTALLATIONS), 'fixture'].map(owner => [owner, installationId]))),
  };
}
