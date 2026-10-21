
import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scrubRiskyLaneConfig, riskyLaneConfig, LANE_CONFIG_LIST_ARGS } from '../lane-git-hardening.mjs';
import { applyLaneDietConfig } from '../lane-git-diet.mjs';

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
  expect(scrubRiskyLaneConfig('unused', { run: () => { throw new Error('read failed'); } }).kept.join()).toContain('read failed');
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

it('shares the unchanged local config with the diet without extra reads', () => {
  const { dir, git } = repo();
  git(['remote', 'add', 'origin', join(tmpdir(), 'origin-checkout')]);
  applyLaneDietConfig(git);
  // Command and global scope values must not masquerade as local settings.
  const run = vi.fn(args => git(args));
  let snapshot;
  scrubRiskyLaneConfig(dir, { run, onLocalConfig: text => { snapshot = text; } });
  expect(snapshot).toBe(git(['config', '--local', '--null', '--list']));
  expect(applyLaneDietConfig(run, snapshot)).toEqual([]);
  expect(run).toHaveBeenCalledTimes(1);
});

it.each([
  ['local\0alias.x\n!false\0', false],
  ['local\0include.path\nmissing\0', false],
  ['worktree\0includeif.gitdir:x.path\nmissing\0', false],
  ['', true],
])('only shares an unchanged listing without lane includes: %s', (listing, reusable) => {
  const onLocalConfig = vi.fn();
  scrubRiskyLaneConfig('unused', { run: () => listing, onLocalConfig });
  expect(onLocalConfig).toHaveBeenCalledTimes(reusable ? 1 : 0);
});

it('does not share failed config reads or failed scrubs', () => {
  for (const listing of [null, 'local\0alias.x\n!false\0']) {
    const onLocalConfig = vi.fn();
    scrubRiskyLaneConfig('unused', {
      run: args => {
        if (listing === null || args.includes('--unset-all')) throw new Error('failed');
        return listing;
      },
      onLocalConfig,
    });
    expect(onLocalConfig).not.toHaveBeenCalled();
  }
});
