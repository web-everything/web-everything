
import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scrubRiskyLaneConfig, riskyLaneConfig, LANE_CONFIG_LIST_ARGS, GIT_REPO_ENV_KEYS, LANE_GIT_CONFIG_PINS, laneGitHardeningEnv, scrubGitRepoEnv } from '../lane-git-hardening.mjs';

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
  expect(scrubGitRepoEnv(inherited)).toEqual({ PATH: '/bin', GIT_TERMINAL_PROMPT: '0' });
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM']) {
    expect(GIT_REPO_ENV_KEYS).toContain(key);
  }
  expect(inherited.GIT_DIR).toBe('/elsewhere'); // a copy, never the caller's object
  // Hardening after the scrub starts its pins at index 0, with no inherited entry left in front of them.
  const env = laneGitHardeningEnv(scrubGitRepoEnv(inherited));
  expect(env.GIT_CONFIG_KEY_0).toBe(LANE_GIT_CONFIG_PINS[0][0]);
  expect(env.GIT_CONFIG_COUNT).toBe(String(LANE_GIT_CONFIG_PINS.length));
  expect(env.GIT_CONFIG_KEY_99).toBeUndefined();
});
