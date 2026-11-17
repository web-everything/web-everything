import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createReviewJobIo } from '../review-job.mjs';
import { laneGitHardeningEnv } from '../../lib/lane-git-hardening.mjs';

const roots = [], repo = 'plateauapp/plateau-app', pr = 229;
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('review lane fetch command isolation', () => {
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
      const exec = (file, args, options) => {
        if (file === 'gh') return JSON.stringify({ headRefOid: head });
        let actual = args;
        if (args.includes('fetch')) {
          const url = args[5]; fetchedUrls.push(url);
          expect(args).toEqual(['-c', 'protocol.ext.allow=never', 'fetch', '--upload-pack=git-upload-pack',
            '--no-tags', url, `refs/pull/${pr}/head`]);
          expect(url).toBe(`git@github.com:${repo}.git`);
          // Rewrite only the explicit transport URL to a local source, without networking.
          actual = ['-c', 'protocol.file.allow=always', '-c', `url.${pathToFileURL(source).href}.insteadOf=${url}`, ...args];
        }
        return execFileSync(file, actual, { ...options, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      };
      expect(createReviewJobIo({ env, exec, log: () => {} }).prepareLane({ repo, pr, lanePath: lane })).toEqual({ head });
      expect(fetchedUrls).toHaveLength(1);
      expect(existsSync(marker)).toBe(false);
      const config = git(lane, ['config', '--local', '--list']);
      expect(config).not.toContain('alias.review-unsafe');
      if (setting !== 'vcs') expect(config).toContain(`remote.origin.uploadpack=${helper}`);
      if (setting !== 'uploadpack') expect(config).toContain('remote.origin.vcs=review-marker');
    });
});
