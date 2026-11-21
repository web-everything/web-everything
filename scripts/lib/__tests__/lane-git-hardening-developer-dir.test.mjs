import { afterEach, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { pinDeveloperDir, scrubGitLocationEnv } from '../lane-git-hardening.mjs';

vi.mock('node:fs', async importOriginal => ({ ...await importOriginal(), existsSync: vi.fn() }));
afterEach(() => vi.resetAllMocks());
const clt = '/Library/Developer/CommandLineTools';

it.each([{}, { DEVELOPER_DIR: '' }])('pins installed CLT in place when unset or empty: %j', env => {
  const exists = vi.fn(() => true);
  expect(pinDeveloperDir(env, { exists })).toBe(env);
  expect(env.DEVELOPER_DIR).toBe(clt);
  expect(exists).toHaveBeenCalledWith(clt);
});
it('preserves an existing developer directory', () => {
  const env = { DEVELOPER_DIR: '/chosen/developer' };
  const exists = vi.fn(() => true);
  expect(pinDeveloperDir(env, { exists })).toBe(env);
  expect(env.DEVELOPER_DIR).toBe('/chosen/developer');
  expect(exists).not.toHaveBeenCalled();
});
it('does nothing when CLT is absent', () => {
  const env = {};
  expect(pinDeveloperDir(env, { exists: () => false })).toBe(env);
  expect(env).toEqual({});
});
it('leaves a nonexistent fake directory untouched without probing or throwing', () => {
  const env = { DEVELOPER_DIR: '/nonexistent/fake' };
  expect(() => pinDeveloperDir(env, { exists: () => { throw Error('must not probe'); } })).not.toThrow();
  expect(env.DEVELOPER_DIR).toBe('/nonexistent/fake');
});
it('scrubGitLocationEnv pins its copy without mutating the input', async () => {
  const env = { GIT_DIR: '/redirect' };
  const real = await vi.importActual('node:fs');
  expect(scrubGitLocationEnv(env)).toEqual({
    ...(real.existsSync(clt) ? { DEVELOPER_DIR: clt } : {}), GIT_REF_PARANOIA: '1',
  });
  expect(env).toEqual({ GIT_DIR: '/redirect' });
});
