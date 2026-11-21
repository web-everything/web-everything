import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathBEvidenceGit, tipInMain } from '../audited-tip.mjs';
import { overlayGraduated } from '../adopt.mjs';
import { contentContainedInBuild } from '../prepare.mjs';
import { makeGit } from '../shared.mjs';

let root;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

it('refuses a non-merged tip when a custom merge driver silently keeps ours', () => {
  root = mkdtempSync(join(tmpdir(), 'audited-tip-drivers-'));
  const git = makeGit({ cwd: root, env: process.env,
    run: (args, opts) => spawnSync('git', args, { ...opts, encoding: 'utf8' }) });
  const ok = (...args) => {
    const result = git(args);
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  ok('init', '-q', '-b', 'main');
  ok('config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, '.gitattributes'), '* merge=evil\n');
  writeFileSync(join(root, 'file.txt'), 'base\n');
  ok('add', '.');
  ok('commit', '-qm', 'base');
  const base = ok('rev-parse', 'HEAD');
  writeFileSync(join(root, 'file.txt'), 'tip\n');
  ok('commit', '-qam', 'tip');
  const tip = ok('rev-parse', 'HEAD');
  ok('checkout', '-q', '--detach', base);
  writeFileSync(join(root, 'file.txt'), 'main\n');
  ok('commit', '-qam', 'main');
  const main = ok('rev-parse', 'HEAD');
  ok('config', 'merge.evil.driver', 'true');
  // Establish the exploit with real Git before asserting the hardened negative.
  expect(ok('merge-tree', '--write-tree', '--no-messages', main, tip))
    .toBe(ok('rev-parse', `${main}^{tree}`));
  expect(tipInMain(git, main, tip)).toBe(false);
  expect(overlayGraduated({ ref: 'lane/evil', sha: tip, build: main, registered: () => false, git,
    readyAt: '2026-11-21T02:00:00Z', events: [{ kind: 'auto-dropped', reason: 'in-main',
      ref: 'lane/evil', at: '2026-11-21T01:00:00Z' }] })).toBe(false);
  // Driver-free squash evidence still works, even without ancestry.
  ok('config', '--unset', 'merge.evil.driver');
  writeFileSync(join(root, 'file.txt'), 'tip\n');
  ok('commit', '-qam', 'squashed tip');
  expect(tipInMain(git, ok('rev-parse', 'HEAD'), tip)).toBe(true);
});

it('isolates every Path B evidence read and disables filter renormalization', () => {
  const calls = [];
  const git = pathBEvidenceGit((args, opts) => {
    calls.push({ args, opts });
    return { status: args[0] === 'config' ? 1 : 0, stdout: '' };
  });
  git(['merge-tree', '--write-tree', 'main', 'tip']);
  git(['rev-parse', 'main^{tree}']);
  git(['merge-base', '--is-ancestor', 'tip', 'main']);
  expect(calls).toHaveLength(4);
  for (const { opts } of calls) expect(opts.env).toEqual({
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1',
    GIT_CONFIG_PARAMETERS: '', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'merge.renormalize', GIT_CONFIG_VALUE_0: 'false',
  });
});

it.each([128, null, undefined])('refuses unknown driver configuration (status %s) before merging', (status) => {
  const commands = [];
  const git = pathBEvidenceGit((args) => { commands.push(args[0]); return { status }; });
  expect(git(['merge-tree', '--write-tree', 'main', 'tip']).status).not.toBe(0);
  expect(commands).toEqual(['config']);
});

it('content proof ignores configured clean filters and renormalization instead of hiding omitted content', () => {
  root = mkdtempSync(join(tmpdir(), 'content-proof-filters-'));
  const calls = [];
  const git = makeGit({ cwd: root, env: process.env,
    run: (args, opts) => {
      calls.push({ args, opts });
      return spawnSync('git', args, { ...opts, encoding: 'utf8' });
    } });
  const ok = (...args) => {
    const result = git(args);
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  ok('init', '-q', '-b', 'main');
  ok('config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, '.gitattributes'), 'file.txt filter=evil\n');
  writeFileSync(join(root, 'file.txt'), 'base\n');
  ok('add', '.');
  ok('commit', '-qm', 'base');
  const base = ok('rev-parse', 'HEAD');
  writeFileSync(join(root, 'file.txt'), 'omitted content\n');
  ok('commit', '-qam', 'overlay');
  const tip = ok('rev-parse', 'HEAD');
  ok('checkout', '-q', '--detach', base);
  writeFileSync(join(root, 'main.txt'), 'main\n');
  writeFileSync(join(root, 'file.txt'), 'main\n');
  ok('add', '.');
  ok('commit', '-qm', 'main');
  const build = ok('rev-parse', 'HEAD');
  ok('config', 'filter.evil.clean', "touch filter-ran; printf 'main\\n'");
  ok('config', 'merge.renormalize', 'true');
  // Real Git demonstrates that renormalization hides the tip's omitted content.
  expect(ok('merge-tree', '--write-tree', '--no-messages', build, tip)).toBe(ok('rev-parse', `${build}^{tree}`));
  expect(existsSync(join(root, 'filter-ran'))).toBe(true);
  unlinkSync(join(root, 'filter-ran'));
  calls.length = 0;
  expect(contentContainedInBuild(git, tip, build)).toBe(false);
  expect(existsSync(join(root, 'filter-ran'))).toBe(false);
  for (const { opts } of calls) expect(opts.env).toMatchObject({
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1',
    GIT_CONFIG_PARAMETERS: '', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'merge.renormalize', GIT_CONFIG_VALUE_0: 'false',
  });
});
