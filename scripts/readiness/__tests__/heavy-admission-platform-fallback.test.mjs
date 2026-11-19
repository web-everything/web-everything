// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadAdmissionPolicy, admissionLockRoot, decideRemote, resolveAdmissionPolicy } from '../heavy-admission.mjs';
import { PLATFORM_FILE_MAX_BYTES } from '../../lib/platform-preferences-io.mjs';

const roots = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(process.env.TMPDIR, 'platform-fallback-')); roots.push(root);
  const path = join(root, 'preferences.json');
  const options = { repoRoot: root, checkoutRoot: root, env: { WE_UNDER_TEST: '1', WE_PLATFORM_PREFERENCES: path, LANE_POOL_ROOT: join(root, 'pool') } };
  return { root, path, options, cache: join(admissionLockRoot(root, options.env), 'platform-last-good.json') };
}
function freshPolicy(options) {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { loadAdmissionPolicy } from ${JSON.stringify(new URL('../heavy-admission.mjs', import.meta.url).href)};
    process.stdout.write(JSON.stringify(loadAdmissionPolicy(${JSON.stringify(options)})));
  `], { env: { ...process.env, WE_TOOLS_ROOT_REEXEC: 'test' }, encoding: 'utf8', timeout: 15000, maxBuffer: 128 * 1024 });
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout);
}
const block = { remote: { enabled: true, mode: 'always' } };
it('a platform file above 256 KiB retains platform routing and atomically persists its block', () => {
  const f = fixture();
  writeFileSync(f.path, JSON.stringify({ padding: 'x'.repeat(300 * 1024), heavyAdmission: block }));
  const policy = loadAdmissionPolicy(f.options);
  expect(policy.settings.remote).toMatchObject(block.remote);
  expect(policy.sources['remote.enabled']).toBe('platform');
  expect(JSON.parse(readFileSync(f.cache, 'utf8'))).toEqual({ path: f.path, heavyAdmission: block });
  expect(readdirSync(join(f.cache, '..'))).toEqual(['platform-last-good.json']);
});
it.each(['corrupt', 'oversized'])('a fresh process uses persisted last-good after a %s platform read', failure => {
  const f = fixture();
  writeFileSync(f.path, JSON.stringify({ heavyAdmission: block }));
  freshPolicy(f.options);
  writeFileSync(f.path, failure === 'corrupt' ? '{' : ' '.repeat(PLATFORM_FILE_MAX_BYTES + 1));
  const policy = freshPolicy(f.options);
  expect(policy.settings.remote).toMatchObject(block.remote);
  expect(policy.sources['remote.enabled']).toBe('platform');
  expect(policy.invalid.join(';')).toMatch(/platform:.*last-good used/);
  if (failure === 'oversized') expect(policy.invalid.join(';')).toContain(`file larger than ${PLATFORM_FILE_MAX_BYTES}`);
});
it.each(['missing', 'corrupt', 'oversized', 'wrong-source'])('failed reads with %s last-good fall to standard', saved => {
  const f = fixture(); writeFileSync(f.path, '{');
  if (saved !== 'missing') {
    mkdirSync(join(f.cache, '..'), { recursive: true });
    writeFileSync(f.cache, saved === 'corrupt' ? '{' : saved === 'oversized' ? ' '.repeat(PLATFORM_FILE_MAX_BYTES + 1) : JSON.stringify({ path: 'other-source', heavyAdmission: block }));
  }
  const policy = freshPolicy(f.options);
  expect(policy.settings.remote.enabled).toBe(false);
  expect(policy.sources['remote.enabled']).toBe('standard');
  expect(policy.invalid.join(';')).toMatch(/platform:/);
  expect(policy.invalid.join(';')).not.toContain('last-good used');
});
it('an unwritable persistence destination never breaks successful platform parsing', () => {
  const f = fixture();
  mkdirSync(join(f.cache, '..'), { recursive: true });
  mkdirSync(f.cache);
  writeFileSync(f.path, JSON.stringify({ heavyAdmission: block }));
  expect(loadAdmissionPolicy(f.options).settings.remote.enabled).toBe(true);
  expect(readdirSync(join(f.cache, '..'))).toEqual(['platform-last-good.json']);
});
it.each([0.1, NaN])('mode=always routes remotely regardless of loadPerCore=%s', loadPerCore => {
  expect(decideRemote({ policy: resolveAdmissionPolicy({ platform: block }), loadPerCore, argv: ['npx', 'vitest', 'run', 'a.test.mjs'] })).toMatchObject({ remote: true, reason: expect.stringContaining('mode=always') });
});
