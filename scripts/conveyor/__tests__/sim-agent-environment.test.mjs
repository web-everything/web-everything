import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { acquireLane, fail401, postVerdict, releaseLane } from './sim/agent-actions.mjs';

// The helper under test is a `.mjs` file vite-node externalizes, so `vi.mock('node:child_process')` never
// reaches its import. Real fixture children instead: each one dumps the environment it was handed to a file.
const DUMP = "await import('node:fs').then(fs => fs.writeFileSync(process.env.ENV_DUMP, JSON.stringify(process.env)));";
let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sim-agent-env-'));
  mkdirSync(join(root, 'clone', 'scripts'), { recursive: true });
  mkdirSync(join(root, 'tools'));
  for (const name of ['review-set-label.mjs', 'lane-pool.mjs']) {
    writeFileSync(join(root, 'clone', 'scripts', name),
      `${DUMP}\nprocess.stdout.write('{"lane":1,"path":"/fixture/lane-1"}');\n`);
  }
  // extensionless → CommonJS, so no top-level await here
  writeFileSync(join(root, 'tools', 'gh'),
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.ENV_DUMP, JSON.stringify(process.env));\n`);
  chmodSync(join(root, 'tools', 'gh'), 0o755);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });

it.each([
  ['verdict CLI', () => postVerdict({ verdict: 'accepted' })],
  ['acquire', () => acquireLane()],
  ['release', () => releaseLane()],
  ['session auth failure', () => fail401()],
])('%s passes only the world environment to its child', (_name, action) => {
  vi.stubEnv('WE_DISPATCH_ROUTING_SNAPSHOT', 'ambient-daemon-snapshot');
  vi.stubEnv('WE_GITHUB_APP_ID', 'ambient-app');
  const dump = join(root, 'env.json');
  const env = { PATH: join(root, 'tools'), HOME: '/fixture/home', GH_TOKEN: 'world-token', ENV_DUMP: dump };
  const ctx = {
    simClone: join(root, 'clone'), env, repoFor: () => ({ slug: 'fixture/repo' }),
    claude: { killPid: vi.fn(), setState: vi.fn() },
  };
  action().run(ctx, { name: 'review-123', lane: 1, env: { GH_TOKEN: 'session-token' } });
  const childEnv = JSON.parse(readFileSync(dump, 'utf8'));
  expect(childEnv).not.toHaveProperty('WE_DISPATCH_ROUTING_SNAPSHOT');
  expect(childEnv).not.toHaveProperty('WE_GITHUB_APP_ID');
  expect(childEnv.PATH).toBe(env.PATH);
  expect(childEnv.GH_TOKEN).toBe(_name === 'session auth failure' ? 'session-token' : 'world-token');
});
