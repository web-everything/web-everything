import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createReviewJobIo } from '../review-job.mjs';
import { laneGitHardeningEnv } from '../../lib/lane-git-hardening.mjs';

const roots = [], repo = 'plateauapp/plateau-app', pr = 229;
function expectGitEnv(options, args, env) {
  const { GIT_TEMPLATE_DIR: _template, ...templateFree } = env;
  expect(options.env).toEqual(args[0] === 'init' || args.includes('index-pack') || /iso\.git$/.test(options.cwd) ? templateFree : env);
}
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
      expectGitEnv(options, args, isolated);
      expect(isolated.GIT_CONFIG_GLOBAL).not.toBe(globalConfig);
      expect(isolated.GIT_CONFIG_SYSTEM).toBe(isolated.GIT_CONFIG_GLOBAL);
      expect(isolated.GIT_CONFIG_NOSYSTEM).toBe('1');
      expect(readFileSync(isolated.GIT_CONFIG_GLOBAL, 'utf8')).toBe('');
      if (args.includes('fetch')) {
        expect(options.cwd).not.toBe(lane);
        expect(options.cwd).toMatch(/iso\.git$/);
        expect(args).not.toContain(lane);
        expect(options.env.GIT_DIR).toBeUndefined();
        expect(args).toEqual(['-c', 'protocol.allow=never', '-c', 'protocol.ssh.allow=always', '-c', 'protocol.ext.allow=never', '-c', 'submodule.recurse=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'fetch.fsckObjects=true', '-c', 'transfer.fsckObjects=true', '-c', 'core.sshCommand=ssh', '-c', 'ssh.variant=ssh', 'fetch', '--no-recurse-submodules', '--no-auto-gc', '--no-auto-maintenance', '--upload-pack=git-upload-pack',
          '--no-tags', `git@github.com:${repo}.git`, `refs/pull/${pr}/head`]);
        fetchedUrls.push(args[args.length - 2]);
      }
      // Serve the genuine SSH URL locally. A surviving rewrite would select the marker helper instead.
      const actual = args.includes('fetch') ? [...args.slice(0, args.indexOf('fetch')), '-c', `core.sshCommand=${ssh}`, ...args.slice(args.indexOf('fetch'))] : args;
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
    expect(git(lane, ['rev-parse', '--verify', `${head}^{commit}`]).trim()).toBe(head);
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
        expectGitEnv(options, args, isolated);
        expect(isolated.GIT_CONFIG_GLOBAL).not.toBe(env.GIT_CONFIG_GLOBAL);
        expect(isolated.GIT_CONFIG_SYSTEM).toBe(isolated.GIT_CONFIG_GLOBAL);
        expect(isolated.GIT_CONFIG_NOSYSTEM).toBe('1');
        expect(readFileSync(isolated.GIT_CONFIG_GLOBAL, 'utf8')).toBe('');
        let actual = args;
        if (args.includes('fetch')) {
        expect(options.cwd).not.toBe(lane);
        expect(options.cwd).toMatch(/iso\.git$/);
        expect(args).not.toContain(lane);
        expect(options.env.GIT_DIR).toBeUndefined();
          const url = args[args.length - 2];fetchedUrls.push(url);
          expect(args).toEqual(['-c', 'protocol.allow=never', '-c', 'protocol.ssh.allow=always', '-c', 'protocol.ext.allow=never', '-c', 'submodule.recurse=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'fetch.fsckObjects=true', '-c', 'transfer.fsckObjects=true', '-c', 'core.sshCommand=ssh', '-c', 'ssh.variant=ssh', 'fetch', '--no-recurse-submodules', '--no-auto-gc', '--no-auto-maintenance', '--upload-pack=git-upload-pack',
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

// Replant hostile configuration AFTER the retained scrub/identity check. Isolation must
// remain the security boundary even for keys the scrubber has never heard of.
describe.each(['prepareLane', 'fetchRedTeamHead'])('%s isolated object handoff', method => {
  function fixture({ poison = 'local', failure } = {}) {
    const root = mkdtempSync(join(process.env.TMPDIR, 'review-object-handoff-')); roots.push(root);
    const lane = join(root, 'lane'), source = join(root, 'source'), marker = join(root, 'contacted');
    mkdirSync(lane); mkdirSync(source);
    writeFileSync(join(root, 'ssh'), '#!/bin/sh\nexec git-upload-pack "$REVIEW_TEST_SOURCE"\n', { mode: 0o755 });
    const helper = join(root, 'git-remote-review-marker');
    writeFileSync(helper, '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$REVIEW_HELPER_MARKER"\nexit 1\n', { mode: 0o755 });
    const env = { ...process.env, PATH: `${root}:${process.env.PATH}`, REVIEW_TEST_SOURCE: source,
      REVIEW_HELPER_MARKER: marker, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    const git = (cwd, args) => execFileSync('git', args, { cwd, env: laneGitHardeningEnv(env),
      encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    const commit = cwd => git(cwd, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '--quiet', '--allow-empty', '-m', 'fixture']);
    git(source, ['init', '--quiet']); commit(source);
    const laneHead = git(source, ['rev-parse', 'HEAD']).trim();
    if (poison !== 'unborn') {
      git(lane, ['init', '--quiet']);
      // Seed only objects and HEAD, without a fixture network operation in the lane.
      const seedPack = spawnSync('git', ['pack-objects', '--all', '--stdout'], { cwd: source, env, timeout: 10_000 });
      expect(seedPack.status).toBe(0);
      expect(spawnSync('git', ['index-pack', '--stdin'], { cwd: lane, env, input: seedPack.stdout, timeout: 10_000 }).status).toBe(0);
      git(lane, ['update-ref', 'HEAD', laneHead]);
    } else git(lane, ['init', '--quiet']);
    writeFileSync(join(source, 'payload'), 'genuine fixture object\n'); git(source, ['add', 'payload']); commit(source);
    const head = git(source, ['rev-parse', 'HEAD']).trim();
    git(source, ['update-ref', `refs/pull/${pr}/head`, head]);
    git(lane, ['remote', 'add', 'origin', `git@github.com:${repo}.git`]);
    if (poison.startsWith('remote-')) {
      git(lane, ['update-ref', 'refs/heads/main', laneHead]);
      git(lane, ['update-ref', `refs/pull/${pr}/head`, laneHead]);
      git(lane, ['update-ref', 'refs/tags/keep', laneHead]);
      // Detach so the checked-out-branch guard cannot mask the remap control.
      git(lane, ['update-ref', '--no-deref', 'HEAD', laneHead]);
    }
    const templatePoison = poison.startsWith('template-');
    const template = join(root, 'template'), poisonUrl = 'git://template-poison.invalid/';
    if (templatePoison) {
      mkdirSync(template);
      writeFileSync(join(template, 'config'), `[url "${poisonUrl}"]\n\tinsteadOf = git@github.com:\n[core]\n\tgitProxy = ${helper}\n`);
      if (poison === 'template-env') env.GIT_TEMPLATE_DIR = template;
      else {
        env.GIT_CONFIG_GLOBAL = join(root, 'global');
        writeFileSync(env.GIT_CONFIG_GLOBAL, `[init]\n\ttemplateDir = ${template}\n`);
      }
    }
    let iso, networkCalls = 0, packCalls = 0, indexCalls = 0;
    const exec = (file, args, options) => {
      if (file === 'gh') return JSON.stringify({ headRefOid: failure === 'moved-head' ? laneHead : head });
      if (args[0] === 'init' && templatePoison) {
        expect(args).toContain('--template=');
        expect(options.env).not.toHaveProperty('GIT_TEMPLATE_DIR');
        expect(options.env.GIT_CONFIG_GLOBAL).not.toBe(env.GIT_CONFIG_GLOBAL);
        expect(readFileSync(options.env.GIT_CONFIG_GLOBAL, 'utf8')).toBe('');
        // Even a template setting replanted in the isolated global file loses to --template=.
        if (poison === 'template-global') {
          writeFileSync(options.env.GIT_CONFIG_GLOBAL, `[init]\n\ttemplateDir = ${template}\n`);
        }
        const control = join(root, 'control.git');
        const controlEnv = { ...options.env, ...(poison === 'template-env' ? { GIT_TEMPLATE_DIR: template } : {}) };
        execFileSync('git', ['init', '--bare', '--quiet', control], { ...options, env: controlEnv });
        // The rewrite selects git:// and its proxy helper, which exits before any connection.
        expect(() => execFileSync('git', ['ls-remote', `git@github.com:${repo}.git`], {
          ...options, cwd: control, env: controlEnv, stdio: ['ignore', 'pipe', 'pipe'],
        })).toThrow();
        expect(readFileSync(marker, 'utf8')).toContain('template-poison.invalid'); rmSync(marker);
      }
      const output = gitExec(file, args, options);
      if (args[0] === 'init') {
        iso = args.at(-1);
        if (templatePoison) {
          if (poison === 'template-global') writeFileSync(options.env.GIT_CONFIG_GLOBAL, '');
          const config = readFileSync(join(iso, 'config'), 'utf8');
          expect(config).not.toContain(poisonUrl);
          expect(config).not.toContain(helper);
          return output;
        }
        if (poison.startsWith('remote-')) {
          const url = `git@github.com:${repo}.git`;
          const ref = poison === 'remote-main' ? 'refs/heads/main' : `refs/pull/${pr}/head`;
          git(lane, ['config', `remote.${url}.url`, poison === 'remote-url' ? 'review-marker::attacker' : url]);
          git(lane, ['config', `remote.${url}.fetch`, poison === 'remote-main'
            ? `+refs/pull/${pr}/head:refs/heads/main` : '+refs/*:refs/*']);
          const control = join(root, 'remote-control.git');
          git(root, ['clone', '--bare', '--quiet', lane, control]);
          git(control, ['config', `remote.${url}.url`, poison === 'remote-url' ? 'review-marker::attacker' : url]);
          git(control, ['config', `remote.${url}.fetch`, poison === 'remote-main'
            ? `+refs/pull/${pr}/head:refs/heads/main` : '+refs/*:refs/*']);
          // The old plain in-lane fetch resolves the explicit URL as a remote name.
          if (poison === 'remote-url') {
            expect(() => git(control, ['fetch', url, `refs/pull/${pr}/head`])).toThrow();
            expect(readFileSync(marker, 'utf8')).toContain('attacker'); rmSync(marker);
          } else {
            git(control, ['fetch', url, `refs/pull/${pr}/head`]);
            expect(git(control, ['rev-parse', ref]).trim()).toBe(head);
            expect(head).not.toBe(laneHead);
          }
          return output;
        }
        const included = join(root, 'included');
        let target = ['--local'];
        if (poison === 'worktree') {
          git(lane, ['config', '--local', 'extensions.worktreeConfig', 'true']); target = ['--worktree'];
        } else if (poison === 'includeIf') {
          git(lane, ['config', '--local', `includeIf.gitdir:${realpathSync(lane)}/.path`, included]); target = ['--file', included];
        }
        git(lane, ['config', ...target, 'url.review-marker::poison.insteadOf', 'git@github.com:']);
        git(lane, ['config', ...target, 'url.review-marker::push.pushInsteadOf', 'git@github.com:']);
        git(lane, ['config', ...target, 'core.sshCommand', helper]);
        git(lane, ['config', ...target, 'ssh.variant', 'plink']);
        git(lane, ['config', ...target, 'protocol.ssh.allow', 'never']);
        git(lane, ['config', ...target, 'alias.review-unsafe', `!${helper}`]);
        // Positive control for every scope: these rewrites really select the hostile helper.
        expect(() => git(lane, ['-c', 'protocol.review-marker.allow=always', 'ls-remote', `git@github.com:${repo}.git`])).toThrow();
        expect(existsSync(marker)).toBe(true); rmSync(marker);
      }
      return output;
    };
    function gitExec(file, args, options) {
      if (args.includes('fetch')) {
        networkCalls++;
        expect(options.cwd).toBe(iso);
        expect(options.cwd).not.toBe(lane);
        expect(args).not.toContain(lane);
        expect(options.env.GIT_DIR).toBeUndefined();
        expect(git(iso, ['config', '--local', '--get-regexp', '^core.bare$']).trim()).toBe('core.bare true');
        expect(readFileSync(join(iso, 'objects', 'info', 'alternates'), 'utf8')).toBe(`${JSON.stringify(join(lane, '.git', 'objects'))}\n`);
        if (poison !== 'unborn') expect(git(iso, ['rev-parse', 'refs/haves/lane']).trim()).toBe(laneHead);
      }
      return execFileSync(file, args, { ...options, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    }
    const spawnPack = (file, args, options) => {
      expect(options).toMatchObject({ encoding: null, timeout: 180_000, maxBuffer: 1024 ** 3 });
      expect(options.env.GIT_CONFIG_NOSYSTEM).toBe('1');
      expect(readFileSync(options.env.GIT_CONFIG_GLOBAL, 'utf8')).toBe('');
      expect(args.slice(0, 6)).toEqual(['-c', 'protocol.allow=never', '-c', 'protocol.ssh.allow=always', '-c', 'protocol.ext.allow=never']);
      const packing = args.includes('pack-objects');
      if (packing) {
        packCalls++;
        expect(options.cwd).toBe(iso);
        expect(options.input).toBe(`${head}\n${poison === 'unborn' ? '' : `^${laneHead}\n`}`);
      } else {
        indexCalls++;
        expect(options.cwd).toBe(lane);
        expect(Buffer.isBuffer(options.input)).toBe(true);
        expect(args.slice(-4)).toEqual(['index-pack', '--stdin', '--fix-thin', '--strict']);
      }
      if (packing && failure?.startsWith('pack-')) {
        return { status: failure === 'pack-exit' ? 1 : ['pack-signal', 'pack-missing-buffer'].includes(failure) ? 0 : null,
          signal: failure === 'pack-signal' ? 'SIGTERM' : null,
          error: ['pack-timeout', 'pack-oversized'].includes(failure) ? Object.assign(Error(failure), {
            code: failure === 'pack-timeout' ? 'ETIMEDOUT' : 'ENOBUFS' }) : undefined,
          stdout: failure === 'pack-missing-buffer' ? '' : Buffer.alloc(0) };
      }
      if (!packing && ['index-failure', 'index-signal'].includes(failure)) return { status: failure === 'index-failure' ? 1 : 0,
        signal: failure === 'index-signal' ? 'SIGTERM' : null, stdout: Buffer.alloc(0) };
      return spawnSync(file, args, !packing && failure === 'index-corrupt'
        ? { ...options, input: Buffer.from('invalid pack') } : options);
    };
    const run = () => createReviewJobIo({ env, exec, spawnPack, log: () => {} })[method]({ repo, pr, lanePath: lane,
      head: failure === 'moved-head' ? laneHead : head });
    return { run, git, lane, head, marker, counts: () => ({ networkCalls, packCalls, indexCalls }), iso: () => iso };
  }

  it.each(['local', 'worktree', 'includeIf', 'unborn', 'template-env', 'template-global'])('ignores replanted %s config and imports the genuine commit', poison => {
    const f = fixture({ poison });
    expect(f.run()).toEqual({ head: f.head });
    expect(f.git(f.lane, ['rev-parse', '--verify', `${f.head}^{commit}`]).trim()).toBe(f.head);
    expect(f.git(f.lane, ['show', `${f.head}:payload`])).toBe('genuine fixture object\n');
    expect(existsSync(f.marker)).toBe(false);
    expect(existsSync(f.iso())).toBe(false);
    expect(f.counts()).toEqual({ networkCalls: 1, packCalls: 1, indexCalls: 1 });
  });

  it.each(['remote-url', 'remote-main', 'remote-wildcard'])(
    'isolates same-named %s remote: control contacts attacker or remaps refs, job preserves lane refs', poison => {
      const f = fixture({ poison });
      const before = f.git(f.lane, ['for-each-ref', '--format=%(refname) %(objectname)']);
      // The fixture replants the hostile remote after the scrub, before the isolated fetch.
      expect(f.run()).toEqual({ head: f.head });
      expect(f.git(f.lane, ['rev-parse', '--verify', `${f.head}^{commit}`]).trim()).toBe(f.head);
      expect(f.git(f.lane, ['show', `${f.head}:payload`])).toBe('genuine fixture object\n');
      expect(existsSync(f.marker)).toBe(false);
      expect(f.git(f.lane, ['for-each-ref', '--format=%(refname) %(objectname)'])).toBe(before);
      expect(f.counts()).toEqual({ networkCalls: 1, packCalls: 1, indexCalls: 1 });
    });

  it.each(['pack-exit', 'pack-signal', 'pack-timeout', 'pack-oversized', 'pack-null-status', 'pack-missing-buffer', 'index-failure', 'index-signal', 'index-corrupt', 'moved-head'])(
    'refuses %s without importing the fetched commit', failure => {
      const f = fixture({ failure });
      expect(f.run).toThrow(failure === 'moved-head' ? /head changed during fetch/ : /object handoff failed; inspect lane and retry/);
      expect(() => f.git(f.lane, ['cat-file', '-e', `${f.head}^{commit}`])).toThrow();
      expect(existsSync(f.marker)).toBe(false);
      expect(existsSync(f.iso())).toBe(false);
      expect(f.counts()).toEqual({ networkCalls: 1, packCalls: failure === 'moved-head' ? 0 : 1,
        indexCalls: failure.startsWith('index-') ? 1 : 0 });
    });
});

describe.each(['prepareLane', 'fetchRedTeamHead'])('%s fsck config validation', method => {
  const head = 'a'.repeat(40);
  const scrubError = 'review lane config scrub failed; inspect and repair lane configuration before retrying';

  it.each([
    ['fetch.fsck.missingEmail', 'ignore', 'local'],
    ['fetch.fsck.skipList', 'skip-list', 'local'],
    ['fsck.badTimezone', 'ignore', 'local'],
    ['transfer.fsck.missingEmail', 'ignore', 'local'],
    ['receive.fsck.skipList', 'skip-list', 'local'],
    ['fetch.fsck.missingEmail', 'ignore', 'worktree'],
    ['fsck.skipList', 'skip-list', 'include'],
    ['fetch.fsck.missingEmail', 'ignore', 'include'],
    ['fsck.skipList', 'skip-list', 'includeIf'],
    ['fetch.fsck.missingEmail', 'ignore', 'includeIf'],
  ])('refuses %s=%s from %s before any fetch', (key, value, scope) => {
    const lane = mkdtempSync(join(process.env.TMPDIR, 'review-fetch-fsck-')); roots.push(lane);
    const env = laneGitHardeningEnv(process.env);
    const git = args => execFileSync('git', args, { cwd: lane, env, encoding: 'utf8',
      timeout: 10_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    git(['init', '--quiet']);
    git(['remote', 'add', 'origin', `git@github.com:${repo}.git`]);
    if (scope === 'worktree') {
      git(['config', '--local', 'extensions.worktreeConfig', 'true']);
      git(['config', '--worktree', key, value]);
    } else if (scope === 'include' || scope === 'includeIf') {
      const included = join(lane, 'fsck-config');
      git(['config', '--file', included, key, value]);
      const includeKey = scope === 'include' ? 'include.path'
        : `includeIf.gitdir:${realpathSync(lane)}/.path`;
      git(['config', '--local', includeKey, included]);
    } else {
      git(['config', '--local', key, value]);
    }
    expect(git(['config', '--includes', '--get', key]).trim()).toBe(value);
    const calls = [];
    const exec = (file, args, options) => {
      calls.push(args);
      if (file === 'gh') return JSON.stringify({ headRefOid: head });
      if (args.includes('fetch')) throw Error('unexpected fetch');
      return execFileSync(file, args, { ...options, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    };
    expect(() => createReviewJobIo({ env, exec, log: () => {} })[method]({ repo, pr, lanePath: lane, head }))
      .toThrow(scrubError);
    expect(calls.some(args => args.includes('fetch'))).toBe(false);
  });

  it.each([
    ['no-match', { status: 1, stdout: '', stderr: '' }, true],
    ['keys-exist', { status: 0, stdout: 'fsck.badtimezone\n', stderr: '' }, false],
    ['status-zero-empty', { status: 0, stdout: '', stderr: '' }, false],
    ['status-one-output', { status: 1, stdout: 'fsck.badtimezone\n', stderr: '' }, false],
    ['status-one-stderr', { status: 1, stdout: '', stderr: 'read error' }, false],
    ['unreadable', { status: 128, stdout: '', stderr: '' }, false],
    ['signal', { status: 1, signal: 'SIGTERM', stdout: '', stderr: '' }, false],
    ['timeout', { status: 1, error: Object.assign(Error('timeout'), { code: 'ETIMEDOUT' }), stdout: '', stderr: '' }, false],
    ['oversized', { status: null, error: Object.assign(Error('oversized'), { code: 'ENOBUFS' }), stdout: '', stderr: '' }, false],
    ['missing-output', { status: 1 }, false],
  ])('fails closed except for empty no-match config (%s)', (kind, result, clean) => {
    const calls = [];
    let isolated;
    const readConfig = (file, args, options) => {
      expect(file).toBe('git');
      expect(args).toEqual(['config', '--includes', '--name-only', '--get-regexp',
        '^(fetch|transfer|receive)\\.fsck\\.|^fsck\\.']);
      expect(options).toEqual({ cwd: 'fixture-lane', env: expect.any(Object), encoding: 'utf8',
        timeout: 30_000, maxBuffer: 1024 * 1024 });
      isolated = options.env;
      return result;
    };
    const exec = (file, args, options) => {
      calls.push(args);
      if (file === 'gh') return JSON.stringify({ headRefOid: head });
      expectGitEnv(options, args, isolated);
      if (args[0] === 'config') return '';
      if (args[0] === 'remote') return `git@github.com:${repo}.git`;
      return args.includes('fetch') ? '' : head;
    };
    const run = () => createReviewJobIo({ env: {}, exec, readConfig, spawnPack: () => ({ status: 0, stdout: Buffer.alloc(0) }), log: () => {} })[method]({ repo, pr, lanePath: 'fixture-lane', head });
    if (clean) expect(run()).toEqual({ head });
    else expect(run).toThrow(scrubError);
    expect(calls.some(args => args.includes('fetch'))).toBe(clean);
    if (!clean) expect(calls).toHaveLength(method === 'prepareLane' ? 1 : 0);
  });

  it.each(['clean', 'local', 'worktree', 'includeIf'])(
    'uses the real default readers and refuses unsafe config before fetch (%s)', scope => {
      const root = mkdtempSync(join(process.env.TMPDIR, 'review-default-config-')); roots.push(root);
      const lane = join(root, 'lane'), bin = join(root, 'bin'), marker = join(root, 'fetch-ran');
      mkdirSync(lane); mkdirSync(bin);
      const realGit = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
      const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1', REVIEW_REAL_GIT: realGit, REVIEW_FETCH_MARKER: marker };
      const git = args => execFileSync(realGit, args, { cwd: lane, env: laneGitHardeningEnv(env),
        encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 });
      git(['init', '--quiet']);
      git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
        'commit', '--quiet', '--allow-empty', '-m', 'fixture']);
      const pinned = git(['rev-parse', 'HEAD']).trim();
      writeFileSync(join(lane, '.git', 'FETCH_HEAD'), `${pinned}\n`);
      git(['remote', 'add', 'origin', `git@github.com:${repo}.git`]);
      if (scope === 'local') git(['config', '--local', 'fetch.fsck.missingEmail', 'ignore']);
      if (scope === 'worktree') {
        git(['config', '--local', 'extensions.worktreeConfig', 'true']);
        git(['config', '--worktree', 'fetch.fsck.missingEmail', 'ignore']);
      }
      if (scope === 'includeIf') {
        const included = join(root, 'included');
        git(['config', '--file', included, 'fetch.fsck.missingEmail', 'ignore']);
        git(['config', '--local', `includeIf.gitdir:${realpathSync(lane)}/.path`, included]);
      }
      // Only transport and PR lookup are fixtures; both default config readers execute real Git.
      writeFileSync(join(bin, 'git'), '#!/bin/sh\nfor arg do\n  if [ "$arg" = fetch ]; then\n    printf fetched > "$REVIEW_FETCH_MARKER"\n    printf "%s\\n" "$REVIEW_PINNED" > FETCH_HEAD\n    exit 0\n  fi\ndone\nexec "$REVIEW_REAL_GIT" "$@"\n', { mode: 0o755 });
      writeFileSync(join(bin, 'gh'), `#!/bin/sh\nprintf '%s' '{"headRefOid":"${pinned}"}'\n`, { mode: 0o755 });
      env.PATH = `${bin}:${process.env.PATH}`;
      env.REVIEW_PINNED = pinned;
      const run = () => createReviewJobIo({ env, log: () => {} })[method]({ repo, pr, lanePath: lane, head: pinned });
      if (scope === 'clean') expect(run()).toEqual({ head: pinned });
      else expect(run).toThrow(scrubError);
      expect(existsSync(marker)).toBe(scope === 'clean');
      if (scope !== 'clean') expect(git(['config', '--includes', '--get', 'fetch.fsck.missingEmail']).trim()).toBe('ignore');
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
        expectGitEnv(options, args, isolated);
        expect(readFileSync(isolated.GIT_CONFIG_GLOBAL, 'utf8')).toBe('');
        if (args[0] === 'config') {
          if (failure === 'scrub-failure') throw Error('unreadable config');
          return '';
        }
        if (args[0] === 'remote') return `git@github.com:${failure === 'origin-mismatch' ? 'other/repo' : repo}.git`;
        if (file === 'gh' && args[0] === 'api') return args[1] === `repos/${repo}` ? '1' : '2';
        if (args.includes('fetch')) {
          if (failure === 'fetch-failure') throw Error('fetch refused');
          return '';
        }
        if (args[1] === 'FETCH_HEAD^{commit}') {
          if (failure === 'missing-commit') throw Error('unknown commit');
          return failure === 'moved-head' ? 'b'.repeat(40) : head;
        }
        if (args[0] === 'rev-parse' && args[2] === '--quiet') return head;
        return failure === 'wrong-commit' ? 'b'.repeat(40) : args.at(-1).replace('^{commit}', '');
      };
      const errors = {
        'invalid-repo': /invalid review repository/, 'invalid-head': /missing pinned red-team head/,
        'scrub-failure': /config scrub failed/, 'origin-mismatch': /origin repository mismatch/,
        'fetch-failure': /fetch refused/, 'moved-head': /red-team head changed during fetch/,
        'missing-commit': /unknown commit/, 'wrong-commit': /pinned review commit unavailable/,
      };
      expect(() => createReviewJobIo({ env: {}, exec, spawnPack: () => ({ status: 0, stdout: Buffer.alloc(0) }), readConfig: () => ({ status: 1, stdout: '', stderr: '' }), log: () => {} }).fetchRedTeamHead({
        lanePath: 'fixture-lane', repo: failure === 'invalid-repo' ? 'invalid' : repo, pr,
        head: failure === 'invalid-head' ? 'invalid' : head,
      })).toThrow(errors[failure]);
      if (isolated) expect(existsSync(isolated.GIT_CONFIG_GLOBAL)).toBe(false);
      if (['invalid-repo', 'invalid-head', 'scrub-failure', 'origin-mismatch'].includes(failure)) {
        expect(calls.some(args => args.includes('fetch'))).toBe(false);
      }
    });
});

describe.each(['prepareLane', 'fetchRedTeamHead'])('%s canonical repository identity', method => {
  const canonical = 'web-everything/web-everything', legacy = 'chalbert/web-everything';
  const head = 'a'.repeat(40);
  const identityError = 'review lane origin repository mismatch or unreadable; inspect lane before retrying';
  function fixture({ origin = `git@github.com:${legacy}.git`, lookup = () => '123\n' } = {}) {
    const calls = [], apiCalls = [], configs = [];
    let isolated;
    const exec = (file, args, options) => {
      calls.push([file, args]);
      if (file === 'gh' && args[0] === 'pr') return JSON.stringify({ headRefOid: head });
      if (args[0] === 'config') { isolated = options.env; configs.push(isolated.GIT_CONFIG_GLOBAL); return ''; }
      expect(options.cwd).toEqual(args.includes('fetch') || args[0] === 'update-ref' || args[1] === 'FETCH_HEAD^{commit}' ? expect.stringMatching(/iso\.git$/) : args[0] === 'init' ? expect.stringMatching(/review-git-config-/) : 'fixture-lane');
      expectGitEnv(options, args, isolated);
      expect(options).toMatchObject({ timeout: 180_000, maxBuffer: 1024 * 1024 });
      expect(isolated.GIT_CONFIG_NOSYSTEM).toBe('1');
      expect(isolated.GIT_CONFIG_SYSTEM).toBe(isolated.GIT_CONFIG_GLOBAL);
      expect(isolated.GIT_CONFIG_KEY_0).toBe('core.fsmonitor');
      expect(isolated.GIT_CONFIG_VALUE_0).toBe('false');
      expect(readFileSync(isolated.GIT_CONFIG_GLOBAL, 'utf8')).toBe('');
      if (file === 'gh') {
        expect(args).toEqual(['api', expect.stringMatching(/^repos\/[\w.-]+\/[\w.-]+$/), '--jq', '.id']);
        apiCalls.push(args[1]);
        return lookup(args[1]);
      }
      if (args[0] === 'remote') return origin;
      if (args.includes('fetch') || args[0] === 'init' || args[0] === 'update-ref') return '';
      if (args[0] === 'rev-parse') return head;
      throw Error('unexpected command');
    };
    const io = createReviewJobIo({ spawnPack: () => ({ status: 0, stdout: Buffer.alloc(0) }), readConfig: () => ({ status: 1, stdout: '', stderr: '' }), env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'unsafe', GIT_CONFIG_VALUE_0: 'unsafe' }, exec, log: () => {} });
    const run = (repo = canonical, entry = method) => io[entry]({ repo, pr, lanePath: 'fixture-lane', head });
    return { run, calls, apiCalls, configs };
  }

  it('accepts a transferred legacy-owner origin with the same numeric repository id', () => {
    const f = fixture();
    expect(f.run()).toEqual({ head });
    expect(f.apiCalls).toEqual([`repos/${legacy}`, `repos/${canonical}`]);
    expect(f.calls.some(([, args]) => args.includes('fetch'))).toBe(true);
    expect(f.configs.every(path => !existsSync(path))).toBe(true);
  });

  it('refuses a different repository id before fetching', () => {
    const f = fixture({ lookup: path => path === `repos/${legacy}` ? '123' : '456' });
    expect(() => f.run()).toThrow(identityError);
    expect(f.apiCalls).toHaveLength(2);
    expect(f.calls.some(([, args]) => args.includes('fetch'))).toBe(false);
  });

  it.each([legacy, canonical])('fails closed on invalid or unreadable id evidence for %s', slug => {
    for (const output of [null, 'not-a-number', '', '0', '-1', '1.5', '1e2', '9007199254740992']) {
      const f = fixture({ lookup: path => {
        if (path !== `repos/${slug}`) return '123';
        if (output === null) throw Error('API unavailable');
        return output;
      } });
      expect(() => f.run()).toThrow(identityError);
      expect(f.calls.some(([, args]) => args.includes('fetch'))).toBe(false);
      expect(f.configs.every(path => !existsSync(path))).toBe(true);
    }
  });

  it.each(['git@github.com:', 'ssh://git@github.com/', 'https://github.com/'])(
    'accepts a case-insensitive matching slug without an API call (%s)', prefix => {
      const f = fixture({ origin: `${prefix}${canonical.toUpperCase()}.git` });
      expect(f.run()).toEqual({ head });
      expect(f.apiCalls).toEqual([]);
    });

  it.each(['git://github.com/chalbert/web-everything.git', 'https://evil.example/chalbert/web-everything.git',
    'git@github.com:chalbert/web-everything?query.git', 'git@github.com:chalbert/web-everything/extra.git'])(
    'refuses unsupported URLs or malformed origin slugs without API calls (%s)', origin => {
      const f = fixture({ origin });
      expect(() => f.run()).toThrow(identityError);
      expect(f.apiCalls).toEqual([]);
      expect(f.calls.some(([, args]) => args.includes('fetch'))).toBe(false);
    });

  it('caches both ids by lowercase slug across jobs and entry points in the same IO instance', () => {
    const f = fixture();
    expect(f.run()).toEqual({ head });
    expect(f.run(canonical.toUpperCase(), method === 'prepareLane' ? 'fetchRedTeamHead' : 'prepareLane')).toEqual({ head });
    expect(f.apiCalls).toEqual([`repos/${legacy}`, `repos/${canonical}`]);
  });
});
