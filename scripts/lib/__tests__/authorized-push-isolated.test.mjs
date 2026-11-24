import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAuthorizedPushForTesting } from '../authorized-push-testing.mjs';
const authorizedPush = options => createAuthorizedPushForTesting(options.io).authorizedPush(options);
const readPushAuthority = options => createAuthorizedPushForTesting(options.io).readPushAuthority(options);
import { pushRefusal } from '../../conveyor/fix-procedure.mjs';

const roots = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  if (!process.env.TMPDIR) throw new Error('This fixture requires the task TMPDIR');
  const root = mkdtempSync(join(process.env.TMPDIR, 'push-isolated-')); roots.push(root);
  const lane = join(root, 'lane'), remote = join(root, 'remote.git'), home = join(root, 'home');
  mkdirSync(home); mkdirSync(lane);
  const env = { PATH: '/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: home, LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  const git = (dir, ...args) => {
    const r = spawnSync('/usr/bin/git', ['-C', dir, ...args], { env, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
    if (r.status !== 0) throw new Error(r.stderr || String(r.error));
    return r.stdout.trim();
  };
  git(root, 'init', '--bare', '-q', '--template=', remote);
  git(lane, 'init', '-q', '--template=');
  git(lane, 'config', 'user.name', 'Fixture'); git(lane, 'config', 'user.email', 'fixture@example.invalid');
  git(lane, 'commit', '-q', '--allow-empty', '-m', 'base');
  const expectedHead = git(lane, 'rev-parse', 'HEAD'), branch = 'lane/isolated';
  git(lane, 'commit', '-q', '--allow-empty', '-m', 'next');
  const sha = git(lane, 'rev-parse', 'HEAD'), url = pathToFileURL(remote).href;
  // Seed the bare remote by copying fixture objects, without any setup push/fetch.
  writeFileSync(join(remote, 'objects/info/alternates'), `${join(lane, '.git/objects')}\n`);
  git(remote, 'update-ref', `refs/heads/${branch}`, expectedHead);
  git(lane, 'remote', 'add', 'origin', url);
  const calls = [], temps = new Set();
  const remoteHead = () => git(remote, 'rev-parse', `refs/heads/${branch}`);
  const io = { stat: () => ({ isFile: () => true, uid: process.getuid(), mode: 0o755 }),
    readClaim: () => ({ meta: { repo: 'we', pr: 42, kind: 'fixing', branch, sessionId: 'mine' } }), isClaimHolder: () => true,
    branchClaimRefusal: () => null,
    ghPrView: () => ({ labels: [], state: 'OPEN', isDraft: false, isCrossRepository: false,
      headRefName: branch, headRefOid: remoteHead() }),
    // Phase-2 ports: only explicit injected IO can replace the slug-built production URL
    // or permit file transport. Neither value is obtained from repository config.
    remoteUrl: url, protocolAllow: 'file',
    spawn: (bin, args, options) => {
      calls.push({ bin, args, options });
      const cwd = args.includes('-C') ? resolve(args[args.indexOf('-C') + 1]) : options?.cwd;
      if (cwd && cwd !== lane && existsSync(join(cwd, 'objects'))) {
        expect(statSync(cwd).mode & 0o777).toBe(0o700); temps.add(cwd);
      }
      // Refuse unexpected transports even if the implementation under test is unsafe.
      if (args.includes('push') && !args.includes(url)) throw new Error('Fixture forbids non-literal transport');
      return spawnSync(bin, args, options);
    },
  };
  const options = { repo: 'we', pr: 42, branch, expectedHead, sha, gitDir: lane,
    holder: { sessionId: 'mine' }, purpose: 'repair', io };
  return { root, lane, remote, home, git, url, io, options, calls, temps, remoteHead,
    pushes: () => calls.filter(c => c.args.includes('push')) };
}
function pushed(f) {
  expect.soft(authorizedPush(f.options)).toMatchObject({ ok: true, pushed: f.options.sha });
  expect.soft(f.remoteHead()).toBe(f.options.sha); expect.soft(f.pushes()).toHaveLength(1);
}
function refused(f, code) {
  expect(authorizedPush(f.options)).toMatchObject({ ok: false, code });
  expect(f.pushes()).toHaveLength(0); expect(f.remoteHead()).toBe(f.options.expectedHead);
}
describe('Design A: isolated push (real Git, file-only transport)', () => {
  it('1: lane, global and env insteadOf/pushInsteadOf cannot redirect the literal destination', () => {
    for (const scope of ['lane', 'global', 'env']) for (const kind of ['insteadOf', 'pushInsteadOf']) {
      const f = fixture(), key = `url.${pathToFileURL(join(f.root, 'decoy.git')).href}.${kind}`;
      if (scope === 'lane') f.git(f.lane, 'config', key, f.url);
      if (scope === 'global') { const config = join(f.home, 'global'); writeFileSync(config, `[url "file:///nonexistent-decoy"]\n${kind} = ${f.url}\n`); vi.stubEnv('GIT_CONFIG_GLOBAL', config); }
      if (scope === 'env') { vi.stubEnv('GIT_CONFIG_COUNT', '1'); vi.stubEnv('GIT_CONFIG_KEY_0', key); vi.stubEnv('GIT_CONFIG_VALUE_0', f.url); }
      try { pushed(f); } finally { vi.unstubAllEnvs(); }
    }
  }, 30_000);
  it('2: remote.<literal-url>.pushurl is ignored', () => {
    const f = fixture(); f.git(f.lane, 'config', `remote.${f.url}.pushurl`, 'file:///nonexistent-decoy'); pushed(f);
  });
  it('3: spawned Git has no inherited GIT_DIR, GIT_CONFIG, config parameters or SSH command', () => {
    const f = fixture(), hostile = { GIT_DIR: f.remote, GIT_CONFIG: join(f.root, 'config'),
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'false',
      GIT_SSH_COMMAND: 'false', GIT_CONFIG_PARAMETERS: "'push.followTags=true'" };
    for (const [key, value] of Object.entries(hostile)) vi.stubEnv(key, value);
    const result = authorizedPush(f.options);
    expect(f.calls.length).toBeGreaterThan(0);
    for (const call of f.calls) for (const key of Object.keys(hostile)) expect.soft(call.options.env[key], key).toBeUndefined();
    expect(result.ok).toBe(true); expect(f.remoteHead()).toBe(f.options.sha);
  });
  it('4: neither lane nor global pre-push hooks execute', () => {
    for (const scope of ['lane', 'global']) {
      const f = fixture(), hooks = join(f.root, 'hooks'), marker = join(f.root, 'hook-ran'); mkdirSync(hooks);
      const hook = join(hooks, 'pre-push'); writeFileSync(hook, `#!/bin/sh\nprintf ran > '${marker}'\nexit 1\n`); chmodSync(hook, 0o700);
      if (scope === 'lane') f.git(f.lane, 'config', 'core.hooksPath', hooks);
      else { const config = join(f.home, 'global'); writeFileSync(config, `[core]\nhooksPath = ${hooks}\n`); vi.stubEnv('GIT_CONFIG_GLOBAL', config); }
      try { pushed(f); expect(existsSync(marker)).toBe(false); } finally { vi.unstubAllEnvs(); }
    }
  });
  it('5: replacement refs and grafts cannot forge ancestry', () => {
    for (const kind of ['replace', 'graft']) {
      const f = fixture(), tree = f.git(f.lane, 'rev-parse', 'HEAD^{tree}');
      const unrelated = f.git(f.lane, 'commit-tree', tree, '-m', 'unrelated');
      const forged = f.git(f.lane, 'commit-tree', tree, '-p', f.options.expectedHead, '-m', 'forged');
      if (kind === 'replace') f.git(f.lane, 'replace', unrelated, forged);
      else { mkdirSync(join(f.lane, '.git/info'), { recursive: true }); writeFileSync(join(f.lane, '.git/info/grafts'), `${unrelated} ${f.options.expectedHead}\n`); }
      f.options.sha = unrelated; refused(f, 'not-descendant');
    }
  });
  it('6: a missing object is unreadable', () => { const f = fixture(); f.options.sha = 'f'.repeat(40); refused(f, 'unreadable'); });
  it('7: an unreadable strict claim store refuses before transport', () => {
    const f = fixture();
    f.io.branchClaimRefusal = () => pushRefusal({ repo: 'we', branch: f.options.branch,
      sessionId: 'mine', strict: true, lockRoot: join(f.root, 'missing-claims') });
    refused(f, 'claim-store-unreadable');
  });
  it('8: a hold added after readPushAuthority is caught by the final live read', () => {
    const f = fixture(); expect(readPushAuthority(f.options).ok).toBe(true);
    const view = f.io.ghPrView; let reads = 0;
    f.io.ghPrView = () => ({ ...view(), labels: ++reads === 1 ? [] : [{ name: 'review:human' }] });
    refused(f, 'hold-label'); expect(reads).toBe(2);
  });
  it('9: redirects are disabled and transport rejection is never retried', () => {
    const f = fixture(), spawn = f.io.spawn;
    f.io.spawn = (bin, args, opts) => {
      if (!args.includes('push')) return spawn(bin, args, opts);
      f.calls.push({ bin, args, options: opts });
      return { status: 128, stdout: '', stderr: 'fatal: redirect refused' };
    };
    expect(authorizedPush(f.options)).toMatchObject({ ok: false, code: 'push-rejected' });
    expect(f.pushes()).toHaveLength(1); expect(f.remoteHead()).toBe(f.options.expectedHead);
    expect(f.pushes()[0].args).toContain('http.followRedirects=false');
  });
  it('10: forced, +, mismatched To and incomplete porcelain are rejected despite exit zero', () => {
    for (const [to, line, done] of [
      [null, '+', true], [null, 'forced update', true], ['file:///wrong', ' ', true],
      [null, ' ', false], [null, 'extra-ref', true],
    ]) {
      const f = fixture(), spawn = f.io.spawn;
      f.io.spawn = (bin, args, opts) => {
        if (!args.includes('push')) return spawn(bin, args, opts);
        f.calls.push({ bin, args, options: opts });
        const ref = `${f.options.sha}:refs/heads/${f.options.branch}`;
        return { status: 0, stderr: '', stdout: `To ${to || f.url}\n${line === 'forced update' ? '+' : line === 'extra-ref' ? ' ' : line}\t${ref}\t${line === 'forced update' ? '(forced update)' : 'a..b'}\n${line === 'extra-ref' ? ` \t${ref}\ta..b\n` : ''}${done ? 'Done\n' : ''}` };
      };
      expect.soft(authorizedPush(f.options)).toMatchObject({ ok: false, code: 'push-rejected' });
      expect.soft(f.pushes()).toHaveLength(1); expect(f.remoteHead()).toBe(f.options.expectedHead);
    }
  }, 30_000);
  it('11: the temporary bare repo is private, isolated and removed on success and failures', () => {
    for (const path of ['success', 'missing-object', 'push-error', 'post-hold']) {
      const f = fixture(), spawn = f.io.spawn;
      f.io.spawn = (bin, args, opts) => {
        if (args.includes('push') && path === 'push-error') {
          f.calls.push({ bin, args, options: opts }); throw new Error('transport failed');
        }
        const result = spawn(bin, args, opts);
        if (args.includes('push') && path === 'post-hold') f.io.ghPrView = () => { throw new Error('evidence lost'); };
        return result;
      };
      if (path === 'missing-object') f.options.sha = 'f'.repeat(40);
      const result = authorizedPush(f.options);
      expect.soft(result).toMatchObject(path === 'success' ? { ok: true } : { ok: false,
        code: path === 'missing-object' ? 'unreadable' : path === 'push-error' ? 'push-rejected' : 'pushed-under-hold' });
      expect.soft(f.temps.size).toBeGreaterThan(0);
      for (const temp of f.temps) { expect(existsSync(temp)).toBe(false); expect(existsSync(f.lane)).toBe(true); }
    }
  }, 30_000);
});
