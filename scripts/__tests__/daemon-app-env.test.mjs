/** Exercise the shared CLI fixture through the real auth installer and generated gh guard. */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DAEMON_APP_FIXTURE_TOKEN, daemonAppEnv } from './fixtures/daemon-app-env.mjs';

const authModule = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'github-app-auth-env.mjs')).href;
const probe = `
  import { ensureFreshGithubAppEnv } from ${JSON.stringify(authModule)};
  import { spawnSync } from 'node:child_process';
  await ensureFreshGithubAppEnv({ daemon: true, perOwner: true });
  const r = spawnSync('gh', ['api', process.argv[1]], { env: process.env, encoding: 'utf8' });
  process.stdout.write(r.stdout || '');
  process.stderr.write(r.stderr || '');
  process.exitCode = r.status ?? 1;
`;

function fixture(run) {
  const home = mkdtempSync(join(tmpdir(), 'daemon-app-env-'));
  try {
    const bin = join(home, 'bin');
    mkdirSync(bin);
    const called = join(home, 'called');
    writeFileSync(join(bin, 'gh'), `#!${process.execPath}
      require('node:fs').writeFileSync(${JSON.stringify(called)}, 'called');
      process.stdout.write(JSON.stringify({ token: process.env.GH_TOKEN, daemon: process.env.WE_GH_DAEMON_CALLER }));
    `, { mode: 0o755 });
    const env = { ...process.env, ...daemonAppEnv(home), PATH: `${bin}:${process.env.PATH}`,
      WE_GH_THROTTLE_LOCK_ROOT: join(home, 'throttle') };
    const invoke = (endpoint = 'repos/web-everything/web-everything') => spawnSync(process.execPath,
      ['--input-type=module', '-e', probe, endpoint], { cwd: home, env, encoding: 'utf8', timeout: 15_000 });
    run({ env, home, called, invoke });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

describe('daemon CLI App fixture', () => {
  it('reaches fake gh with App auth for every fixture owner while personal fallback is refused', () => fixture(({ env, invoke }) => {
    expect(env.WE_GH_AUTH_PERSONAL_FALLBACK).toBe('refuse');
    for (const owner of ['web-everything', 'frontier-ui', 'plateauapp', 'fixture']) {
      const r = invoke(`repos/${owner}/repo`);
      expect(r.error, r.stderr).toBeUndefined();
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout)).toMatchObject({ token: DAEMON_APP_FIXTURE_TOKEN, daemon: expect.any(String) });
    }
  }));

  it('still refuses inherited personal auth when no App cache or configuration is supplied', () => fixture(({ env, home, called, invoke }) => {
    rmSync(join(home, '.claude'), { recursive: true, force: true });
    for (const key of ['WE_GITHUB_APP_ID', 'WE_GITHUB_APP_INSTALLATION_ID', 'WE_GITHUB_APP_PRIVATE_KEY_PATH', 'WE_GH_AUTH_TOKEN_HASH']) delete env[key];
    env.GH_TOKEN = 'fixture-personal';
    const r = invoke();
    expect(r.error, r.stderr).toBeUndefined();
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain('REFUSING personal-auth fallback');
    expect(existsSync(called)).toBe(false);
  }));
});
