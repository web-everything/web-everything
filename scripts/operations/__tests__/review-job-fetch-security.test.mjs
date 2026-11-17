import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createReviewJobIo } from '../review-job.mjs';
import { laneGitHardeningEnv } from '../../lib/lane-git-hardening.mjs';

const roots = [], repo = 'plateauapp/plateau-app', pr = 229;
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe.each(['prepareLane', 'fetchRedTeamHead'])('%s fetch command isolation', method => {
  it.each(['global', 'local', 'both'])('isolates inherited config and removes %s URL rewrites before fetching', scope => {
    const root = mkdtempSync(join(process.env.TMPDIR, 'review-fetch-rewrite-')); roots.push(root);
    const lane = join(root, 'lane'), source = join(root, 'source'), globalConfig = join(root, 'global');
    const marker = join(root, 'executed'), helper = join(root, 'git-remote-review-marker'), ssh = join(root, 'ssh-fixture');
    mkdirSync(lane); mkdirSync(source); writeFileSync(globalConfig, '');
    writeFileSync(helper, '#!/bin/sh\nprintf executed > "$REVIEW_HELPER_MARKER"\nexit 1\n', { mode: 0o755 });
    writeFileSync(ssh, '#!/bin/sh\nexec git-upload-pack "$REVIEW_TEST_SOURCE"\n', { mode: 0o755 });
    const env = { ...process.env, PATH: `${root}:${process.env.PATH}`, REVIEW_HELPER_MARKER: marker,
      REVIEW_TEST_SOURCE: source, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_SYSTEM: globalConfig, GIT_CONFIG_NOSYSTEM: '0' };
    const git = (cwd, args) => execFileSync('git', args, { cwd, env: laneGitHardeningEnv(env),
      encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    git(source, ['init', '--quiet']);
    git(source, ['-c', 'user.name=Review Fixture', '-c', 'user.email=review@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'fixture']);
    const head = git(source, ['rev-parse', 'HEAD']).trim();
    git(source, ['update-ref', `refs/pull/${pr}/head`, head]);
    git(lane, ['init', '--quiet']);
    git(lane, ['remote', 'add', 'origin', `git@github.com:${repo}.git`]);
    const key = 'url.review-marker::poison.insteadof';
    if (scope !== 'local') git(lane, ['config', '--file', globalConfig, key, 'git@github.com:']);
    if (scope !== 'global') git(lane, ['config', '--local', key, 'git@github.com:']);
    expect(() => git(lane, ['-c', 'protocol.review-marker.allow=always', 'fetch', `git@github.com:${repo}.git`])).toThrow();
    expect(existsSync(marker)).toBe(true); rmSync(marker);

    let isolated;
    const fetchedUrls = [];
    const exec = (file, args, options) => {
      if (file === 'gh') return JSON.stringify({ headRefOid: head });
      isolated ??= options.env;
      expect(options.env).toBe(isolated);
      expect(isolated.GIT_CONFIG_GLOBAL).not.toBe(globalConfig);
      expect(isolated.GIT_CONFIG_SYSTEM).toBe(isolated.GIT_CONFIG_GLOBAL);
      expect(isolated.GIT_CONFIG_NOSYSTEM).toBe('1');
      expect(readFileSync(isolated.GIT_CONFIG_GLOBAL, 'utf8')).toBe('');
      if (args.includes('fetch')) {
        expect(args).toEqual(['-c', 'protocol.ext.allow=never', '-c', 'submodule.recurse=false', 'fetch', '--no-recurse-submodules', '--upload-pack=git-upload-pack',
          '--no-tags', `git@github.com:${repo}.git`, `refs/pull/${pr}/head`]);
        fetchedUrls.push(args[args.length - 2]);
      }
      // Serve the genuine SSH URL locally. A surviving rewrite would select the marker helper instead.
      const actual = args.includes('fetch') ? ['-c', 'ssh.variant=ssh', '-c', `core.sshCommand=${ssh}`, ...args] : args;
      return execFileSync(file, actual, { ...options, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    };
    const inherited = { ...env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: key, GIT_CONFIG_VALUE_0: 'git@github.com:' };
    expect(createReviewJobIo({ env: inherited, exec, log: () => {} })[method]({ repo, pr, lanePath: lane, head })).toEqual({ head });
    expect(fetchedUrls).toEqual([`git@github.com:${repo}.git`]);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(isolated.GIT_CONFIG_GLOBAL)).toBe(false);
  });

  it.each(['uploadpack', 'vcs', 'both'])('never executes populated submodule helpers (%s)', setting => {
    const root = mkdtempSync(join(process.env.TMPDIR, 'review-fetch-submodule-')); roots.push(root);
    const source = join(root, 'source'), subSource = join(root, 'sub-source');
    const lane = join(root, 'lane'), control = join(root, 'control'), marker = join(root, 'executed');
    const helper = join(root, 'git-remote-review-marker');
    writeFileSync(helper, '#!/bin/sh\nprintf executed > "$REVIEW_HELPER_MARKER"\nexit 1\n', { mode: 0o755 });
    const env = { ...process.env, PATH: `${root}:${process.env.PATH}`, REVIEW_HELPER_MARKER: marker };
    const git = (cwd, args) => execFileSync('git', args, { cwd, env: laneGitHardeningEnv(env),
      encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    const commit = cwd => git(cwd, ['-c', 'user.name=Review Fixture', '-c', 'user.email=review@example.invalid',
      'commit', '--quiet', '--allow-empty', '-m', 'fixture']);
    mkdirSync(source); mkdirSync(subSource);
    git(subSource, ['init', '--quiet']); commit(subSource);
    const oldSubHead = git(subSource, ['rev-parse', 'HEAD']).trim();
    git(source, ['init', '--quiet']);
    writeFileSync(join(source, '.gitmodules'), `[submodule "module"]\n\tpath = module\n\turl = ${subSource}\n`);
    git(source, ['add', '.gitmodules']);
    git(source, ['update-index', '--add', '--cacheinfo', `160000,${oldSubHead},module`]); commit(source);
    for (const target of [lane, control]) {
      git(root, ['clone', '--quiet', '--no-recurse-submodules', source, target]);
      git(target, ['remote', 'set-url', 'origin', `git@github.com:${repo}.git`]);
      // A nested repository at a tracked gitlink is a populated submodule.
      git(target, ['clone', '--quiet', subSource, 'module']);
      git(target, ['config', 'submodule.recurse', 'true']);
      git(target, ['config', 'fetch.recurseSubmodules', 'on-demand']);
      const submodule = join(target, 'module');
      if (setting !== 'vcs') git(submodule, ['config', 'remote.origin.uploadpack', helper]);
      if (setting !== 'uploadpack') git(submodule, ['config', 'remote.origin.vcs', 'review-marker']);
    }
    // Both populated submodules lack the new gitlink target, forcing an on-demand fetch.
    commit(subSource);
    const newSubHead = git(subSource, ['rev-parse', 'HEAD']).trim();
    git(source, ['update-index', '--cacheinfo', `160000,${newSubHead},module`]); commit(source);
    const head = git(source, ['rev-parse', 'HEAD']).trim();
    git(source, ['update-ref', `refs/pull/${pr}/head`, head]);
    const transport = ['-c', 'protocol.file.allow=always', '-c',
      `url.${pathToFileURL(source).href}.insteadOf=git@github.com:${repo}.git`];
    // Keep the production transport pins: only the recursion guards are absent in this control.
    expect(() => git(control, [...transport, '-c', 'protocol.ext.allow=never', 'fetch',
      '--upload-pack=git-upload-pack', '--no-tags', `git@github.com:${repo}.git`, `refs/pull/${pr}/head`])).toThrow();
    expect(existsSync(marker)).toBe(true); rmSync(marker);
    const exec = (file, args, options) => {
      if (file === 'gh') return JSON.stringify({ headRefOid: head });
      return execFileSync(file, args.includes('fetch') ? [...transport, ...args] : args,
        { ...options, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    };
    expect(createReviewJobIo({ env, exec, log: () => {} }).prepareLane({ repo, pr, lanePath: lane })).toEqual({ head });
    expect(existsSync(marker)).toBe(false);
    expect(git(lane, ['rev-parse', 'FETCH_HEAD^{commit}']).trim()).toBe(head);
  });

  it.each(['uploadpack', 'vcs', 'both'])(
    'never executes retained origin helpers (%s)', setting => {
      const root = mkdtempSync(join(process.env.TMPDIR, 'review-fetch-security-')); roots.push(root);
      const lane = join(root, 'lane'), source = join(root, 'source'), marker = join(root, 'executed');
      mkdirSync(lane); mkdirSync(source);
      const helper = join(root, 'git-remote-review-marker');
      writeFileSync(helper, '#!/bin/sh\nprintf executed > "$REVIEW_HELPER_MARKER"\nexit 1\n');
      chmodSync(helper, 0o755);
      const env = { ...process.env, PATH: `${root}:${process.env.PATH}`, REVIEW_HELPER_MARKER: marker };
      const git = (cwd, args) => execFileSync('git', args, {
        cwd, env: laneGitHardeningEnv(env), encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
      });
      git(source, ['init', '--quiet']);
      git(source, ['-c', 'user.name=Review Fixture', '-c', 'user.email=review@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'fixture']);
      const head = git(source, ['rev-parse', 'HEAD']).trim();
      git(source, ['update-ref', `refs/pull/${pr}/head`, head]);
      git(lane, ['init', '--quiet']);
      git(lane, ['remote', 'add', 'origin', `git@github.com:${repo}.git`]);
      if (setting !== 'vcs') git(lane, ['config', 'remote.origin.uploadpack', helper]);
      if (setting !== 'uploadpack') git(lane, ['config', 'remote.origin.vcs', 'review-marker']);
      git(lane, ['config', 'alias.review-unsafe', `!${helper}`]);

      // Prove this fixture executes the hostile helper if a fetch resolves the remote name.
      expect(() => git(lane, ['-c', 'protocol.file.allow=always', '-c',
        `url.${pathToFileURL(source).href}.insteadOf=git@github.com:${repo}.git`,
        'fetch', '--no-tags', 'origin', `refs/pull/${pr}/head`])).toThrow();
      expect(existsSync(marker)).toBe(true);
      rmSync(marker);

      const fetchedUrls = [];
      let isolated;
      const exec = (file, args, options) => {
        if (file === 'gh') return JSON.stringify({ headRefOid: head });
        isolated ??= options.env;
        expect(options.env).toBe(isolated);
        expect(isolated.GIT_CONFIG_GLOBAL).not.toBe(env.GIT_CONFIG_GLOBAL);
        expect(isolated.GIT_CONFIG_SYSTEM).toBe(isolated.GIT_CONFIG_GLOBAL);
        expect(isolated.GIT_CONFIG_NOSYSTEM).toBe('1');
        expect(readFileSync(isolated.GIT_CONFIG_GLOBAL, 'utf8')).toBe('');
        let actual = args;
        if (args.includes('fetch')) {
          const url = args[8]; fetchedUrls.push(url);
          expect(args).toEqual(['-c', 'protocol.ext.allow=never', '-c', 'submodule.recurse=false', 'fetch', '--no-recurse-submodules', '--upload-pack=git-upload-pack',
            '--no-tags', url, `refs/pull/${pr}/head`]);
          expect(url).toBe(`git@github.com:${repo}.git`);
          // Rewrite only the explicit transport URL to a local source, without networking.
          actual = ['-c', 'protocol.file.allow=always', '-c', `url.${pathToFileURL(source).href}.insteadOf=${url}`, ...args];
        }
        return execFileSync(file, actual, { ...options, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      };
      expect(createReviewJobIo({ env, exec, log: () => {} })[method]({ repo, pr, lanePath: lane, head })).toEqual({ head });
      expect(fetchedUrls).toHaveLength(1);
      expect(existsSync(isolated.GIT_CONFIG_GLOBAL)).toBe(false);
      expect(existsSync(marker)).toBe(false);
      const config = git(lane, ['config', '--local', '--list']);
      expect(config).not.toContain('alias.review-unsafe');
      if (setting !== 'vcs') expect(config).toContain(`remote.origin.uploadpack=${helper}`);
      if (setting !== 'uploadpack') expect(config).toContain('remote.origin.vcs=review-marker');
    });
});

describe('red-team fetch refusals', () => {
  it.each(['invalid-repo', 'invalid-head', 'scrub-failure', 'origin-mismatch', 'fetch-failure', 'moved-head', 'missing-commit', 'wrong-commit'])(
    'throws and removes isolated config on %s', failure => {
      const head = 'a'.repeat(40), calls = [];
      let isolated;
      const exec = (file, args, options) => {
        calls.push(args);
        isolated ??= options.env;
        expect(options.env).toBe(isolated);
        expect(readFileSync(isolated.GIT_CONFIG_GLOBAL, 'utf8')).toBe('');
        if (args[0] === 'config') {
          if (failure === 'scrub-failure') throw Error('unreadable config');
          return '';
        }
        if (args[0] === 'remote') return `git@github.com:${failure === 'origin-mismatch' ? 'other/repo' : repo}.git`;
        if (args.includes('fetch')) {
          if (failure === 'fetch-failure') throw Error('fetch refused');
          return '';
        }
        if (args[1] === 'FETCH_HEAD^{commit}') {
          if (failure === 'missing-commit') throw Error('unknown commit');
          return failure === 'moved-head' ? 'b'.repeat(40) : head;
        }
        return failure === 'wrong-commit' ? 'b'.repeat(40) : args.at(-1).replace('^{commit}', '');
      };
      const errors = {
        'invalid-repo': /invalid review repository/, 'invalid-head': /missing pinned red-team head/,
        'scrub-failure': /config scrub failed/, 'origin-mismatch': /origin repository mismatch/,
        'fetch-failure': /fetch refused/, 'moved-head': /red-team head changed during fetch/,
        'missing-commit': /unknown commit/, 'wrong-commit': /pinned review commit unavailable/,
      };
      expect(() => createReviewJobIo({ env: {}, exec, log: () => {} }).fetchRedTeamHead({
        lanePath: 'fixture-lane', repo: failure === 'invalid-repo' ? 'invalid' : repo, pr,
        head: failure === 'invalid-head' ? 'invalid' : head,
      })).toThrow(errors[failure]);
      if (isolated) expect(existsSync(isolated.GIT_CONFIG_GLOBAL)).toBe(false);
      if (['invalid-repo', 'invalid-head', 'scrub-failure', 'origin-mismatch'].includes(failure)) {
        expect(calls.some(args => args.includes('fetch'))).toBe(false);
      }
    });
});
