import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { renderGuardSyncPlist } from '../render-guard-sync-plist.mjs';

const values = {
  NODE_PATH: '/opt/node/bin/node', GUARD_CLONE_PATH: '/workspace/guard clone',
  ORIGIN_URL: 'https://example.test/repo.git', EXECUTABLE_PATH: '/opt/node/bin:/usr/bin:/bin',
  LOG_DIRECTORY: '/workspace/logs',
};
const temps = [];
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function installation(options) {
  const dir = mkdtempSync(join(process.env.TMPDIR, 'guard-sync-plist-'));
  temps.push(dir);
  const path = join(dir, 'com.we.guard-main-sync.plist');
  writeFileSync(path, renderGuardSyncPlist(values, options));
  return readFileSync(path, 'utf8');
}
it('template installation omits DEVELOPER_DIR when standalone CLT is absent', () => {
  const exists = vi.fn(() => false);
  const xml = installation({ env: {}, exists });
  expect(exists).toHaveBeenCalledWith('/Library/Developer/CommandLineTools');
  expect(xml).not.toContain('<key>DEVELOPER_DIR</key>');
  expect(xml).not.toMatch(/__[A-Z_]+__/);
  expect(xml).toContain('<string>/workspace/guard clone/scripts/hooks/sync-guard-clone.mjs</string>');
});
it.each([true, false])('template installation preserves an explicit developer-directory override (CLT exists: %s)', installed => {
  const exists = vi.fn(() => installed);
  const env = { DEVELOPER_DIR: '/nonexistent/fake & explicit' };
  const xml = installation({ env, exists });
  expect(xml).toContain('<key>DEVELOPER_DIR</key><string>/nonexistent/fake &amp; explicit</string>');
  expect(exists).not.toHaveBeenCalled();
  expect(env).toEqual({ DEVELOPER_DIR: '/nonexistent/fake & explicit' });
});
it.each([{}, { DEVELOPER_DIR: '' }])('template installation pins installed CLT when unset or empty: %j', env => {
  const before = { ...env };
  expect(installation({ env, exists: () => true })).toContain('<key>DEVELOPER_DIR</key><string>/Library/Developer/CommandLineTools</string>');
  expect(env).toEqual(before);
});
it('installation CLI renders the actual template and inherits an explicit override', () => {
  const stdout = execFileSync(process.execPath, [resolve('scripts/hooks/render-guard-sync-plist.mjs'),
    ...Object.entries(values).map(([key, value]) => `--${key.toLowerCase().replaceAll('_', '-')}=${value}`)], {
    env: { ...process.env, DEVELOPER_DIR: '/nonexistent/fake' },
    encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024,
  });
  expect(stdout).toContain('<key>DEVELOPER_DIR</key><string>/nonexistent/fake</string>');
  expect(stdout).not.toMatch(/__[A-Z_]+__/);
});
it('refuses incomplete installation inputs instead of producing an unresolved plist', () => {
  expect(() => renderGuardSyncPlist({ ...values, NODE_PATH: '' }, { env: {}, exists: () => false })).toThrow('missing NODE_PATH');
});
