import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { decideRemote, loadAdmissionPolicy, resolveAdmissionPolicy } from '../heavy-admission.mjs';

const roots = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function fixture() {
  const root = mkdtempSync(join(process.env.TMPDIR, 'platform-fallback-')); roots.push(root);
  const path = join(root, 'preferences.json');
  // Redirected settings still require independent canonical manifest evidence.
  mkdirSync(join(root, '.claude'));
  writeFileSync(join(root, '.claude', 'platform-preferences.json'), '{}');
  return { path, options: { home: root, repoRoot: root, checkoutRoot: root, env: { WE_UNDER_TEST: '1', WE_PLATFORM_PREFERENCES: path, LANE_POOL_ROOT: join(root, 'pool') } } };
}
const block = { remote: { enabled: true, mode: 'always' } };

it('a platform file above 256 KiB still supplies the platform layer', () => {
  const f = fixture();
  writeFileSync(f.path, JSON.stringify({ padding: 'x'.repeat(300 * 1024), heavyAdmission: block }));
  const policy = loadAdmissionPolicy(f.options);
  expect(policy.settings.remote).toMatchObject(block.remote);
  expect(policy.sources['remote.enabled']).toBe('platform');
  expect(policy.manifestFailClosed).toBeUndefined();
  expect(policy.invalid).toEqual([]);
});
it('a platform file above 4 MiB is diagnosed and falls to standard', () => {
  const f = fixture();
  writeFileSync(f.path, JSON.stringify({ padding: 'x'.repeat(4 * 1024 * 1024 + 10), heavyAdmission: block }));
  const policy = loadAdmissionPolicy(f.options);
  expect(policy.sources['remote.enabled']).toBe('standard');
  expect(policy.invalid.join(';')).toContain('file larger than');
  expect(policy.manifestFailClosed).toBeUndefined();
});
it.each([0.1, NaN])('mode=always routes remotely regardless of loadPerCore=%s', loadPerCore => {
  expect(decideRemote({ policy: resolveAdmissionPolicy({ platform: block }), loadPerCore, argv: ['npx', 'vitest', 'run', 'a.test.mjs'] }))
    .toMatchObject({ remote: true, reason: expect.stringContaining('mode=always') });
});
