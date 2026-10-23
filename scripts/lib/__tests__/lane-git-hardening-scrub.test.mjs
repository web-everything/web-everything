
import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scrubRiskyLaneConfig, riskyLaneConfig, LANE_CONFIG_LIST_ARGS, GIT_REPO_ENV_KEYS, GIT_REPO_LOCATION_ENV_KEYS, LANE_GIT_CONFIG_PINS, laneGitHardeningEnv, scrubGitLocationEnv, scrubGitRepoEnv } from '../lane-git-hardening.mjs';

const dirs = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'lane-scrub-'));
  dirs.push(dir);
  const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git(['init', '--quiet']);
  return { dir, git };
}
it('removes unsafe remotes and aliases while preserving safe origin', () => {
  const { dir, git } = repo();
  git(['remote', 'add', 'origin', 'https://github.com/x/y.git']);
  git(['remote', 'add', 'primary', join(tmpdir(), 'primary-checkout')]);
  git(['config', 'alias.x', '!false']);
  const log = vi.fn();
  expect(scrubRiskyLaneConfig(dir, { log })).toEqual({ removed: ['remote.primary.url', 'alias.x'], kept: [] });
  expect(git(['remote'])).toBe('origin\n');
  expect(riskyLaneConfig(git([...LANE_CONFIG_LIST_ARGS]))).toEqual([]);
  expect(log).toHaveBeenCalledTimes(1);
});
it('keeps unsafe origin so the guard continues refusing it', () => {
  const { dir, git } = repo();
  git(['remote', 'add', 'origin', join(tmpdir(), 'origin-checkout')]);
  expect(scrubRiskyLaneConfig(dir)).toEqual({ removed: [], kept: ['remote.origin.url'] });
  expect(riskyLaneConfig(git([...LANE_CONFIG_LIST_ARGS]))).toEqual(['remote.origin.url']);
});
it.each(['local', 'worktree'])('scrubs differently cased origin remotes in %s config', scope => {
  const { dir, git } = repo();
  git(['remote', 'add', 'origin', 'https://github.com/x/y.git']);
  if (scope === 'worktree') git(['config', 'extensions.worktreeConfig', 'true']);
  for (const name of ['Origin', 'ORIGIN']) {
    git(['config', `--${scope}`, `remote.${name}.url`, join(tmpdir(), `${name}-checkout`)]);
  }
  expect(scrubRiskyLaneConfig(dir)).toEqual({
    removed: ['remote.Origin.url', 'remote.ORIGIN.url'], kept: [],
  });
  expect(git(['remote'])).toBe('origin\n');
  expect(git(['remote', 'get-url', 'origin'])).toBe('https://github.com/x/y.git\n');
  expect(riskyLaneConfig(git([...LANE_CONFIG_LIST_ARGS]))).toEqual([]);
  expect(scrubRiskyLaneConfig(dir)).toEqual({ removed: [], kept: [] });
});
it('unsets worktree keys in worktree scope', () => {
  const { dir, git } = repo();
  git(['config', 'extensions.worktreeConfig', 'true']);
  git(['config', '--worktree', 'alias.x', '!false']);
  expect(scrubRiskyLaneConfig(dir).removed).toEqual(['alias.x']);
  expect(riskyLaneConfig(git([...LANE_CONFIG_LIST_ARGS]))).toEqual([]);
});
it('reports runner errors without throwing', () => {
  const onConfig = vi.fn();
  expect(scrubRiskyLaneConfig('unused', { run: () => { throw new Error('read failed'); }, onConfig }).kept.join()).toContain('read failed');
  expect(onConfig).not.toHaveBeenCalled();
});

it('shares the successful listing without adding git spawns', () => {
  const output = 'local\0remote.origin.fetch\n+refs/heads/*:refs/remotes/origin/*\0';
  const run = vi.fn(() => output), onConfig = vi.fn();
  expect(scrubRiskyLaneConfig('unused', { run, onConfig })).toEqual({ removed: [], kept: [] });
  expect(onConfig).toHaveBeenCalledWith(output);
  expect(run).toHaveBeenCalledTimes(1);
});

it.each(['primary', 'Origin', 'ORIGIN'])('falls back to removing the local %s remote section if remote remove fails', name => {
  const { dir, git } = repo();
  git(['remote', 'add', name, join(tmpdir(), 'primary-checkout')]);
  const run = vi.fn(args => {
    if (args[0] === 'remote') throw new Error('remote removal failed');
    return git(args);
  });
  expect(scrubRiskyLaneConfig(dir, { run })).toEqual({ removed: [`remote.${name}.url`], kept: [] });
  expect(run).toHaveBeenCalledWith(['config', '--local', '--remove-section', `remote.${name}`], expect.anything());
  expect(git(['remote'])).toBe('');
});
it('reports failed unsets as kept', () => {
  const { dir, git } = repo();
  git(['config', 'alias.x', '!false']);
  const run = args => {
    if (args.includes('--unset-all')) throw new Error('write failed');
    return git(args);
  };
  expect(scrubRiskyLaneConfig(dir, { run })).toEqual({ removed: [], kept: ['alias.x (write failed)'] });
});
it('scrubGitRepoEnv drops every inherited repo redirect and env config source, and keeps the rest', () => {
  const inherited = Object.fromEntries([...GIT_REPO_ENV_KEYS.map(key => [key, '/elsewhere']),
    ['GIT_CONFIG_KEY_0', 'gc.reflogExpire'], ['GIT_CONFIG_VALUE_0', 'now'], ['GIT_CONFIG_KEY_99', 'x.y'], ['GIT_CONFIG_VALUE_99', 'z'],
    ['PATH', '/bin'], ['GIT_TERMINAL_PROMPT', '0']]);
  // GIT_REF_PARANOIA=0 would let gc/prune skip a broken ref's objects: it is forced back on.
  expect(scrubGitRepoEnv(inherited)).toEqual({ PATH: '/bin', GIT_TERMINAL_PROMPT: '0', GIT_REF_PARANOIA: '1' });
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE']) {
    expect(GIT_REPO_ENV_KEYS).toContain(key);
  }
  expect(inherited.GIT_DIR).toBe('/elsewhere'); // a copy, never the caller's object
  // Hardening after the scrub starts its pins at index 0, with no inherited entry left in front of them.
  const env = laneGitHardeningEnv(scrubGitRepoEnv(inherited));
  expect(env.GIT_CONFIG_KEY_0).toBe(LANE_GIT_CONFIG_PINS[0][0]);
  expect(env.GIT_CONFIG_COUNT).toBe(String(LANE_GIT_CONFIG_PINS.length));
  expect(env.GIT_CONFIG_KEY_99).toBeUndefined();
});
it('scrubGitLocationEnv drops every repo/ref/reachability redirect but keeps env config (lane-pool git calls)', () => {
  const config = { GIT_CONFIG_GLOBAL: '/hermetic', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: 'c' };
  const inherited = { ...Object.fromEntries(GIT_REPO_LOCATION_ENV_KEYS.map(key => [key, '/elsewhere'])), ...config, PATH: '/bin' };
  expect(scrubGitLocationEnv(inherited)).toEqual({ ...config, PATH: '/bin', GIT_REF_PARANOIA: '1' });
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CONFIG', 'GIT_REFERENCE_BACKEND', 'GIT_SHALLOW_FILE']) {
    expect(GIT_REPO_LOCATION_ENV_KEYS).toContain(key);
  }
});
it('the default scrub runner ignores an inherited GIT_REFERENCE_BACKEND, so it never deletes another repo\'s refs', () => {
  const { dir, git } = repo();
  const other = repo();
  other.git(['commit', '--allow-empty', '-qm', 'x']);
  other.git(['update-ref', 'refs/remotes/evil/x', 'HEAD']);
  git(['remote', 'add', 'evil', join(tmpdir(), 'evil-checkout')]);
  vi.stubEnv('GIT_REFERENCE_BACKEND', `files://${join(other.dir, '.git')}`);
  try {
    expect(scrubRiskyLaneConfig(dir).removed).toEqual(['remote.evil.url']);
  } finally {
    vi.unstubAllEnvs();
  }
  expect(git(['remote'])).toBe('');
  expect(other.git(['for-each-ref', '--format=%(refname)', 'refs/remotes/evil/'])).toBe('refs/remotes/evil/x\n');
});
it('flags a ref store kept in another repository, never a bare format', () => {
  const list = (...entries) => entries.map(([scope, key, value]) => `${scope}\0${key}\n${value}`).join('\0') + '\0';
  expect(riskyLaneConfig(list(['local', 'extensions.refstorage', 'files:///other/.git']))).toEqual(['extensions.refstorage']);
  expect(riskyLaneConfig(list(['worktree', 'extensions.refStorage', 'reftable://../x']))).toEqual(['extensions.refStorage']);
  expect(riskyLaneConfig(list(['local', 'extensions.refstorage', 'reftable']))).toEqual(['extensions.refstorage']); // hides a files lane's refs
  expect(riskyLaneConfig(list(['local', 'extensions.refstorage', 'files']))).toEqual([]);
});
it('scrubs config-defined hooks, which run whatever core.hooksPath says', () => {
  const { dir, git } = repo();
  git(['config', 'hook.attack.event', 'reference-transaction']);
  git(['config', 'hook.attack.command', 'touch ran']);
  expect(riskyLaneConfig(git([...LANE_CONFIG_LIST_ARGS]))).toEqual(['hook.attack.event', 'hook.attack.command']);
  expect(scrubRiskyLaneConfig(dir, { log: () => {} }).removed).toEqual(['hook.attack.event', 'hook.attack.command']);
  expect(riskyLaneConfig(git([...LANE_CONFIG_LIST_ARGS]))).toEqual([]);
});
