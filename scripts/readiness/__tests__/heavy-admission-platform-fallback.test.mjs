// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, unlinkSync, symlinkSync, chmodSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadAdmissionPolicy, admissionLockRoot, decideRemote, resolveAdmissionPolicy } from '../heavy-admission.mjs';
import { PLATFORM_FILE_MAX_BYTES } from '../../lib/platform-preferences-io.mjs';

const roots = [];
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
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
it.each(['corrupt', 'oversized', 'non-object'])('a fresh process uses persisted last-good after a %s platform read', failure => {
  const f = fixture();
  writeFileSync(f.path, JSON.stringify({ heavyAdmission: block }));
  freshPolicy(f.options);
  writeFileSync(f.path, failure === 'corrupt' ? '{' : failure === 'non-object' ? '[]' : ' '.repeat(PLATFORM_FILE_MAX_BYTES + 1));
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

it('ENOENT clears in-process last-good and ignores persisted last-good', () => {
  const f = fixture();
  let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
  writeFileSync(f.path, JSON.stringify({ heavyAdmission: block }));
  expect(loadAdmissionPolicy(f.options).settings.remote.enabled).toBe(true);
  unlinkSync(f.path); now += 11000;
  const missing = loadAdmissionPolicy(f.options);
  expect(missing.settings.remote.enabled).toBe(false);
  expect(missing.sources['remote.enabled']).toBe('standard');
  expect(missing.invalid).toEqual([]);
  expect(freshPolicy(f.options).settings.remote.enabled).toBe(false);
  // With persisted evidence removed, a subsequent torn file proves memory was cleared too.
  unlinkSync(f.cache); writeFileSync(f.path, '{'); now += 11000;
  expect(loadAdmissionPolicy(f.options).settings.remote.enabled).toBe(false);
});
it('clientPath is selected only from a successful host read, never memory or disk last-good', () => {
  const f = fixture();
  f.options.home = f.root; delete f.options.env.WE_PLATFORM_PREFERENCES;
  f.path = join(f.root, '.claude', 'platform-preferences.json');
  mkdirSync(join(f.root, '.claude'));
  let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
  const clientPath = join(f.root, 'remote-exec.mjs');
  writeFileSync(f.path, JSON.stringify({ heavyAdmission: { remote: { ...block.remote, clientPath } } }));
  expect(loadAdmissionPolicy(f.options).settings.remote.clientPath).toBe(clientPath);
  expect(JSON.parse(readFileSync(f.cache, 'utf8')).heavyAdmission.remote).not.toHaveProperty('clientPath');
  expect(statSync(f.cache).mode & 0o777).toBe(0o600);
  writeFileSync(f.path, '{'); now += 11000;
  expect(loadAdmissionPolicy(f.options).settings.remote).toMatchObject({ ...block.remote, clientPath: null });
  // Historical cache files may still contain the executable selection: discard it on read too.
  writeFileSync(f.cache, JSON.stringify({ path: f.path, heavyAdmission: { remote: { ...block.remote, clientPath } } }));
  expect(freshPolicy(f.options).settings.remote).toMatchObject({ ...block.remote, clientPath: null });
});
it.each(['symlink', 'directory', 'group-writable', 'other-writable', 'foreign-owner'])(
  'ignores a %s persisted cache', kind => {
    const f = fixture(); writeFileSync(f.path, '{');
    mkdirSync(join(f.cache, '..'), { recursive: true });
    const saved = JSON.stringify({ path: f.path, heavyAdmission: block });
    if (kind === 'symlink') {
      const target = join(f.root, 'saved.json'); writeFileSync(target, saved, { mode: 0o600 });
      symlinkSync(target, f.cache);
    } else if (kind === 'directory') mkdirSync(f.cache);
    else {
      writeFileSync(f.cache, saved, { mode: 0o600 });
      if (kind === 'group-writable') chmodSync(f.cache, 0o620);
      if (kind === 'other-writable') chmodSync(f.cache, 0o602);
      if (kind === 'foreign-owner') vi.spyOn(process, 'getuid').mockReturnValue(process.getuid() + 1);
    }
    const policy = loadAdmissionPolicy(f.options);
    expect(policy.settings.remote.enabled).toBe(false);
    expect(policy.sources['remote.enabled']).toBe('standard');
    expect(policy.invalid.join(';')).not.toContain('last-good used');
  },
);
