import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { LANE_GIT_CONFIG_PINS } from '../lane-git-hardening.mjs';

// Intentionally absent in this red-first change: no implementation or import stub.
let salvageStamp, salvageRefName, salvagePushLane, realSalvageIo;
beforeEach(async () => {
  ({ salvageStamp, salvageRefName, salvagePushLane, realSalvageIo } = await import('../lane-pool-salvage-push.mjs'));
});

const date = new Date('2026-01-02T03:04:59.999Z');
const head = 'a'.repeat(40), older = 'b'.repeat(40), other = 'c'.repeat(40);
const ref = 'salvage/lane-7-20260102-0304';
const laneDir = join('pool', 'lane-7');
function harness(overrides = {}) {
  const remote = new Map();
  const io = {
    aheadShas: vi.fn(() => [head, older]),
    unmatchedShas: vi.fn(() => [older]),
    push: vi.fn((_dir, name, sha) => { remote.set(name, sha); return { ok: true }; }),
    remoteSha: vi.fn(name => remote.get(name) ?? null),
    record: vi.fn(),
    ...overrides,
  };
  return { io, remote, run: () => salvagePushLane({ lane: 7, laneDir, io, now: () => date }) };
}

function expectFailed(result, io) {
  expect(result.status).toBe('failed');
  expect(result.reason).toEqual(expect.any(String));
  expect(result.reason.trim()).not.toBe('');
  expect(io.record).not.toHaveBeenCalled();
}

describe('salvage push contract', () => {
  it('formats a zero-padded UTC stamp, discarding seconds', () => {
    expect(salvageStamp(date)).toBe('20260102-0304');
    expect(salvageStamp(new Date('2026-12-31T23:07:00-05:00'))).toBe('20270101-0407');
  });

  it('names an ordinary branch under salvage/lane-N-stamp', () => {
    expect(salvageRefName(7, date)).toBe(ref);
  });

  it('returns none-ahead without pushing when there are no ahead commits', async () => {
    const h = harness({ aheadShas: vi.fn(() => []) });
    expect(await h.run()).toMatchObject({ status: 'none-ahead', unmatched: [] });
    expect(h.io.aheadShas).toHaveBeenCalledWith(laneDir);
    expect(h.io.push).not.toHaveBeenCalled();
    expect(h.io.record).not.toHaveBeenCalled();
  });

  it('returns matched without pushing when every ahead commit is already preserved', async () => {
    const h = harness({ unmatchedShas: vi.fn(() => []) });
    expect(await h.run()).toMatchObject({ status: 'matched', unmatched: [] });
    expect(h.io.unmatchedShas).toHaveBeenCalledWith(laneDir, [head, older]);
    expect(h.io.push).not.toHaveBeenCalled();
    expect(h.io.record).not.toHaveBeenCalled();
  });

  it('pushes HEAD rather than only the unmatched ancestor, with exactly three arguments and no force option', async () => {
    const h = harness();
    expect(await h.run()).toMatchObject({ status: 'pushed', ref, unmatched: [older] });
    expect(h.io.push.mock.calls).toEqual([[laneDir, ref, head]]);
    expect(h.io.push.mock.calls.flat().some(arg => /force|^\+|^-f$/.test(String(arg)))).toBe(false);
  });

  it('checks the remote before pushing, verifies the pushed SHA, then records the ref and SHA exactly once', async () => {
    const h = harness();
    await h.run();
    expect(h.io.remoteSha.mock.calls).toEqual([[ref], [ref]]);
    expect(h.io.remoteSha.mock.invocationCallOrder[0]).toBeLessThan(h.io.push.mock.invocationCallOrder[0]);
    expect(h.io.push.mock.invocationCallOrder[0]).toBeLessThan(h.io.remoteSha.mock.invocationCallOrder[1]);
    expect(h.io.remoteSha.mock.invocationCallOrder[1]).toBeLessThan(h.io.record.mock.invocationCallOrder[0]);
    expect(h.io.record).toHaveBeenCalledTimes(1); expect(h.io.record).toHaveBeenCalledWith(7, expect.stringContaining(ref));
    expect(h.io.record.mock.calls[0][1]).toContain(head);
  });

  it.each([null, other])('fails closed and never records success when verification returns %s', async verifiedSha => {
    const h = harness({ remoteSha: vi.fn().mockReturnValueOnce(null).mockReturnValueOnce(verifiedSha) });
    expectFailed(await h.run(), h.io);
    expect(h.io.push).toHaveBeenCalledTimes(1);
    expect(h.io.remoteSha).toHaveBeenCalledTimes(2);
  });

  it('fails closed with a reason when the push returns ok:false', async () => {
    const h = harness({ push: vi.fn(() => ({ ok: false })) });
    expectFailed(await h.run(), h.io);
    expect(h.io.push).toHaveBeenCalledTimes(1);
  });

  it.each(['aheadShas', 'unmatchedShas', 'push', 'remoteSha'])('contains a %s exception and returns failed with a reason', async method => {
    const h = harness({ [method]: vi.fn(() => { throw new Error(`${method} unavailable`); }) });
    expectFailed(await h.run(), h.io);
  });

  it('contains a record exception rather than claiming a fully recorded push', async () => {
    const h = harness({ record: vi.fn(() => { throw new Error('record unavailable'); }) });
    const result = await h.run();
    expect(result.status).toBe('failed');
    expect(result.reason).toEqual(expect.stringMatching(/\S/));
  });

  it('returns failed without recording when asynchronous verification resolves to a mismatched SHA', async () => {
    const h = harness({ remoteSha: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(other) });
    expectFailed(await h.run(), h.io);
    expect(h.io.push).toHaveBeenCalledTimes(1); expect(h.io.push).toHaveBeenCalledWith(laneDir, ref, head);
    expect(h.io.remoteSha).toHaveBeenCalledTimes(2);
  });

  it('returns failed when the record write rejects despite a verified remote SHA', async () => {
    const h = harness({ record: vi.fn().mockRejectedValue(new Error('record write rejected')) });
    expect(await h.run()).toMatchObject({ status: 'failed', reason: expect.stringContaining('record write rejected') });
    expect(h.io.remoteSha).toHaveReturnedWith(head);
    expect(h.io.record).toHaveBeenCalledTimes(1); expect(h.io.record).toHaveBeenCalledWith(7, `${ref} ${head}\n`);
  });

  it('reports pushed only after remote verification and the pending record write both succeed', async () => {
    let finishRecord, recordStarted;
    const written = new Promise(resolve => { finishRecord = resolve; });
    const started = new Promise(resolve => { recordStarted = resolve; });
    const h = harness({ record: vi.fn(() => { recordStarted(); return written; }) });
    let settled = false;
    const pending = h.run().then(result => { settled = true; return result; });
    await started;
    await Promise.resolve();
    expect(h.io.remoteSha).toHaveReturnedWith(head);
    expect(h.io.record).toHaveBeenCalledTimes(1); expect(h.io.record).toHaveBeenCalledWith(7, `${ref} ${head}\n`);
    expect(settled).toBe(false);
    finishRecord();
    expect(await pending).toMatchObject({ status: 'pushed', ref, unmatched: [older] });
    expect(settled).toBe(true);
  });

  it('fails closed if the remote verification throws after a successful push', async () => {
    const h = harness({ remoteSha: vi.fn().mockReturnValueOnce(null).mockImplementationOnce(() => { throw new Error('verification unavailable'); }) });
    expectFailed(await h.run(), h.io);
    expect(h.io.push).toHaveBeenCalledTimes(1);
  });

  it.each([1, 2])('skips %i occupied names with -2/-3 suffixes and never overwrites them', async occupied => {
    const h = harness();
    const names = [ref, `${ref}-2`, `${ref}-3`];
    for (const name of names.slice(0, occupied)) h.remote.set(name, other);
    const expected = names[occupied];
    expect(await h.run()).toMatchObject({ status: 'pushed', ref: expected });
    expect(h.io.push.mock.calls).toEqual([[laneDir, expected, head]]);
    expect(h.io.remoteSha.mock.calls).toEqual([...names.slice(0, occupied + 1), expected].map(name => [name]));
    for (const name of names.slice(0, occupied)) expect(h.remote.get(name)).toBe(other);
  });

  it('exports realSalvageIo with the five IO functions', () => {
    const io = realSalvageIo({ repo: { name: 'fixture', poolDir: 'pool', referencePath: 'reference', originUrl: 'origin.git', branch: 'main' }, backupRoot: 'backups' });
    for (const method of ['aheadShas', 'unmatchedShas', 'push', 'remoteSha', 'record']) expect(io[method]).toBeTypeOf('function');
  });
});

describe('real salvage preservation and transport', () => {
  const repo = { branch: 'main', originUrl: 'https://example.test/canonical.git', referencePath: 'reference' };
  describe.each(['local', 'worktree'])('%s signing configuration isolation', scope => {
    it.each(['gpg.ssh.defaultKeyCommand', 'gpg.program', 'push.gpgSign', 'user.signingKey',
      'commit.gpgSign', 'gpg.format', 'combined SSH signing payload'])(
      'refuses %s without executing a signer or publishing a ref', async key => {
        const dir = mkdtempSync(join(tmpdir(), 'salvage-signing-'));
        try {
          const lane = join(dir, 'lane'), origin = join(dir, 'origin.git');
          const marker = join(dir, 'signer-ran'), script = join(dir, 'signer.sh');
          writeFileSync(script, '#!/bin/sh\ntouch "$(dirname "$0")/signer-ran"\n', { mode: 0o700 });
          const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
          const git = (cwd, args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', timeout: 10000 });
          git(dir, ['init', '--bare', '-q', origin]);
          git(dir, ['init', '-q', '-b', 'main', lane]);
          const commit = message => git(lane, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test',
            '-c', 'commit.gpgSign=false', 'commit', '--allow-empty', '-qm', message]);
          commit('base');
          git(lane, ['-c', 'push.gpgSign=false', 'push', '-q', origin, 'HEAD:refs/heads/main']);
          git(lane, ['fetch', '-q', origin, 'refs/heads/main:refs/remotes/origin/main']);
          writeFileSync(join(lane, 'work.txt'), 'unique lane work\n');
          git(lane, ['add', 'work.txt']);
          commit('unpushed');
          const sha = git(lane, ['rev-parse', 'HEAD']).trim();
          const before = git(origin, ['for-each-ref', '--format=%(refname) %(objectname)']);
          if (scope === 'worktree') git(lane, ['config', 'extensions.worktreeConfig', 'true']);
          const config = {
            'gpg.ssh.defaultKeyCommand': script, 'gpg.program': script, 'push.gpgSign': 'true',
            'user.signingKey': script, 'commit.gpgSign': 'true', 'gpg.format': 'ssh',
          };
          const keys = key === 'combined SSH signing payload'
            ? ['push.gpgSign', 'gpg.format', 'gpg.ssh.defaultKeyCommand'] : [key];
          for (const setting of keys) git(lane, ['config', `--${scope}`, setting, config[setting]]);
          const runGit = (command, args, options) => execFileSync(command, args, {
            ...options, env: { ...options.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
          });
          const io = realSalvageIo({ repo: { ...repo, originUrl: origin, referencePath: lane },
            backupRoot: join(dir, 'backups'), runGit });
          // Exercise the release/recovery entry and each shared transport boundary with real Git.
          const result = await salvagePushLane({ lane: 7, laneDir: lane, io, now: () => date });
          expect.soft(result).toMatchObject({ status: 'failed', reason: expect.stringMatching(/lane-controlled transport/i) });
          for (const operation of [() => io.unmatchedShas(lane, [sha]),
            () => io.push(lane, ref, sha), () => io.remoteSha(ref)]) {
            expect.soft(operation).toThrow(/lane-controlled transport.*inspect/i);
          }
          expect.soft(existsSync(marker)).toBe(false);
          expect.soft(git(origin, ['for-each-ref', '--format=%(refname) %(objectname)'])).toBe(before);
          // Release scrubbing must not erase the refusal captured by preflight.
          const releaseIo = realSalvageIo({ repo: { ...repo, originUrl: origin, referencePath: lane },
            preflightLaneDir: lane, runGit });
          for (const setting of keys) git(lane, ['config', `--${scope}`, '--unset-all', setting]);
          expect.soft(() => releaseIo.push(lane, ref, sha)).toThrow(/lane-controlled transport/i);
        } finally { rmSync(dir, { recursive: true, force: true }); }
      });
  });

  describe.each(['local', 'worktree'])('%s remote alias isolation', scope => {
    it.each([
      ['url', origin => origin],
      ['pushurl', origin => origin],
      ['url', origin => `${origin.toUpperCase()}.git/`],
      ['pushurl', origin => `${origin.toUpperCase()}.git/`],
      ['url', () => 'other'],
      ['fetch', () => 'Origin'],
      ['url', origin => `${origin}/\u2028quoted.with.dots`],
    ])('refuses alias %s configuration (case %#) before every transport', (setting, aliasFor) => {
      const dir = mkdtempSync(join(tmpdir(), 'salvage-remote-alias-'));
      try {
        const lane = join(dir, 'lane.git'), origin = join(dir, 'canonical');
        const otherRepo = join(dir, 'other.git');
        const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
        for (const path of [lane, origin, otherRepo]) git(dir, ['init', '--bare', '-q', path]);
        git(lane, ['config', 'remote.origin.url', origin]);
        if (scope === 'worktree') git(lane, ['config', 'extensions.worktreeConfig', 'true']);
        git(lane, ['config', `--${scope}`, `remote.${aliasFor(origin)}.${setting}`, otherRepo]);
        const commands = [];
        const io = realSalvageIo({ repo: { ...repo, originUrl: origin, referencePath: lane },
          runGit: (command, args, options) => {
            commands.push(args);
            // A failing regression must not leak even fixture commits to an alias.
            if (!args.includes('config')) throw new Error('unguarded transport reached');
            return execFileSync(command, args, { ...options,
              env: { ...options.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
          } });
        for (const operation of [() => io.unmatchedShas(lane, [head]),
          () => io.push(lane, ref, head), () => io.remoteSha(ref)]) {
          expect(operation).toThrow(/lane-controlled transport.*inspect/i);
        }
        expect(commands.every(args => args.includes('config'))).toBe(true);
        expect(git(otherRepo, ['for-each-ref', '--format=%(refname)'])).toBe('');
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it('allows ordinary exact-origin URL and fetch configuration', () => {
      const runGit = vi.fn((_command, args) => args.includes('config')
        ? args.includes('--show-scope')
          ? `${scope}\0file:.git/config\0remote.origin.url\0${scope}\0file:.git/config\0remote.origin.fetch\0`
          : 'remote.origin.url\0remote.origin.fetch\0' : '');
      const io = realSalvageIo({ repo, runGit });
      expect(io.push(laneDir, ref, head)).toEqual({ ok: true });
      expect(runGit.mock.calls.some(([, args]) => args.includes('push'))).toBe(true);
    });
  });

  it.each(['local', 'worktree'])('follows real %s includes before allowing any transport', scope => {
    const dir = mkdtempSync(join(tmpdir(), 'salvage-transport-config-'));
    try {
      const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
      git(['init', '-q']);
      const included = join(dir, 'transport.config'), sentinel = join(dir, 'helper-ran');
      // Git rejects LF in config keys; U+2028 is a valid subsection line separator.
      const key = 'credential.https://example.test/\u2028quoted.helper';
      git(['config', '--file', included, key, `!touch '${sentinel}'`]);
      expect(git(['config', '--file', included, '--null', '--name-only', '--list'])).toBe(`${key}\0`);
      if (scope === 'worktree') git(['config', 'extensions.worktreeConfig', 'true']);
      git(['config', `--${scope}`, 'include.path', included]);
      const commands = [];
      const io = realSalvageIo({ repo: { ...repo, referencePath: dir }, runGit: (command, args, options) => {
        commands.push(args);
        // A regression must fail without attempting a real network connection.
        if (!args.includes('config')) throw new Error('unguarded transport reached');
        return execFileSync(command, args, options);
      } });
      for (const operation of [() => io.unmatchedShas(dir, [head]),
        () => io.push(dir, ref, head), () => io.remoteSha(ref)]) {
        expect(operation).toThrow(/lane-controlled transport/);
      }
      expect(commands.every(args => args.includes('config'))).toBe(true);
      expect(existsSync(sentinel)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  describe('unattended transport config regression', () => {
    it.each(['credential.helper', 'credential.https://example.test.helper', 'core.gitproxy',
      'core.askpass', 'http.proxy', 'http.https://example.test.extraheader',
      'credential.https://example.test/\nquoted.helper', 'https.proxy', 'remote.origin.proxy',
      'remote.other.vcs', 'core.sshcommand', 'ssh.variant', 'fetch.bundleuri'])(
      'refuses lane-controlled %s before every transport', key => {
        for (const scope of ['local', 'worktree']) {
          const runGit = vi.fn((_command, args) => args.includes('config')
            ? args.includes('--show-scope') ? `${scope}\0file:.git/config\0${key}\0` : `${key}\0` : '');
          const io = realSalvageIo({ repo, runGit });
          for (const operation of [() => io.unmatchedShas(laneDir, [head]),
            () => io.push(laneDir, ref, head), () => io.remoteSha(ref)]) {
            expect(operation).toThrow(/lane-controlled transport.*inspect/i);
          }
          expect(runGit.mock.calls.every(([, args]) => args.includes('config'))).toBe(true);
        }
      });

    it('retains a credential refusal observed before release scrubs the lane', async () => {
      let scrubbed = false;
      const runGit = vi.fn((_command, args) => {
        if (args.includes('config')) return scrubbed ? '' : args.includes('--show-scope')
          ? 'local\0file:.git/config\0credential.helper\0' : 'credential.helper\0';
        return args.includes('rev-list') ? head : '';
      });
      const io = realSalvageIo({ repo, runGit, preflightLaneDir: laneDir });
      scrubbed = true;
      expect(await salvagePushLane({ lane: 7, laneDir, io })).toMatchObject({
        status: 'failed', reason: expect.stringMatching(/lane-controlled transport/i),
      });
      expect(runGit.mock.calls.some(([, args]) => args.includes('fetch'))).toBe(false);
    });

    it.each(['global', 'system'])('preserves operator transport credentials from %s scope', scope => {
      const runGit = vi.fn((_command, args) => args.includes('config')
        ? args.includes('--show-scope') ? `${scope}\0file:/operator/gitconfig\0credential.helper\0` : 'credential.helper\0' : '');
      const io = realSalvageIo({ repo, runGit });
      expect(io.push(laneDir, ref, head)).toEqual({ ok: true });
      expect(runGit.mock.calls.some(([, args]) => args.includes('push'))).toBe(true);
    });

    it.each(['credential.helper', 'init.defaultbranch'])(
      'allows unknown scope from an absolute external toolchain file for %s', key => {
        const runGit = vi.fn((_command, args) => {
          if (args.includes('config')) return args.includes('--show-scope')
            ? `unknown\0file:${join(tmpdir(), 'toolchain', 'gitconfig')}\0${key}\0` : `${key}\0`;
          if (args.includes('--is-bare-repository')) return 'false';
          if (args.includes('--git-dir')) return `${resolve(laneDir, '.git')}\n${resolve(laneDir, '.git')}`;
          if (args.includes('--show-toplevel')) return resolve(laneDir);
          return '';
        });
        const io = realSalvageIo({ repo, runGit });
        expect(io.push(laneDir, ref, head)).toEqual({ ok: true });
        expect(runGit.mock.calls.find(([, args]) => args.includes('--show-scope'))[1]).toContain('--show-origin');
      });

    it.each([
      'file:relative/gitconfig', 'file:.git/config', `file:${resolve(laneDir, 'included.config')}`,
      `file:${resolve(laneDir, '.git', 'config')}`, 'command line:', 'blob:HEAD:config', 'standard input', '',
      `file:${resolve('separate-git', 'config')}`, `file:${resolve('separate-worktree', 'config')}`,
    ])('refuses unknown scope from untrusted origin %j before transport', origin => {
      const runGit = vi.fn((_command, args) => {
        if (args.includes('config')) return args.includes('--show-scope')
          ? `unknown\0${origin}\0credential.helper\0` : 'credential.helper\0';
        if (args.includes('--is-bare-repository')) return 'false';
        if (args.includes('--git-dir')) return `${resolve('separate-git')}\n${resolve('separate-git')}`;
        if (args.includes('--show-toplevel')) return resolve('separate-worktree');
        return '';
      });
      const io = realSalvageIo({ repo, runGit });
      expect(() => io.push(laneDir, ref, head)).toThrow('unknown transport config scope; inspect the lane manually');
      expect(runGit.mock.calls.some(([, args]) => args.includes('push'))).toBe(false);
    });

    it.each(['', 'relative/gitdir', 'unreadable'])(
      'refuses unknown scope when repository path evidence is %j', evidence => {
        const runGit = vi.fn((_command, args) => {
          if (args.includes('config')) return args.includes('--show-scope')
            ? `unknown\0file:${join(tmpdir(), 'toolchain', 'gitconfig')}\0credential.helper\0` : 'credential.helper\0';
          if (evidence === 'unreadable') throw new Error('cannot read repository paths');
          return evidence;
        });
        const io = realSalvageIo({ repo, runGit });
        expect(() => io.push(laneDir, ref, head)).toThrow('unknown transport config scope; inspect the lane manually');
        expect(runGit.mock.calls.some(([, args]) => args.includes('push'))).toBe(false);
      });

    it('reads real Git scope/origin/key NUL triples and permits an external system file', () => {
      const dir = mkdtempSync(join(tmpdir(), 'salvage-origin-layout-'));
      try {
        const lane = join(dir, 'lane'), system = join(dir, 'toolchain.gitconfig');
        writeFileSync(system, '[credential]\nhelper = osxkeychain\n[init]\ndefaultBranch = main\n');
        const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '0', GIT_CONFIG_SYSTEM: system, GIT_CONFIG_GLOBAL: '/dev/null' };
        execFileSync('git', ['init', '-q', lane], { env });
        const runGit = vi.fn((command, args, options) => {
          if (args.includes('push')) return ''; // Probe config and repo paths without transport.
          const output = execFileSync(command, args, { ...options, env: { ...options.env,
            GIT_CONFIG_NOSYSTEM: '0', GIT_CONFIG_SYSTEM: system, GIT_CONFIG_GLOBAL: '/dev/null' } });
          if (!args.includes('--show-scope')) return output;
          const parts = output.split('\0');
          expect(parts.at(-1)).toBe('');
          expect((parts.length - 1) % 3).toBe(0);
          const records = [];
          for (let i = 0; i < parts.length - 1; i += 3) records.push(parts.slice(i, i + 3));
          expect(records).toContainEqual(['system', `file:${system}`, 'credential.helper']);
          // Reproduce Apple Git's toolchain scope while preserving real origin/key bytes.
          return records.map(([scope, origin, key]) =>
            `${origin === `file:${system}` ? 'unknown' : scope}\0${origin}\0${key}\0`).join('');
        });
        expect(realSalvageIo({ repo, runGit }).push(lane, ref, head)).toEqual({ ok: true });
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it.each(['local\0file:.git/config\0credential.helper', 'local\0', 'local\0file:.git/config\0', 'mystery\0file:/operator/gitconfig\0credential.helper\0'])(
      'fails closed on incomplete or unknown config evidence %j', scoped => {
        const runGit = vi.fn((_command, args) => args.includes('--show-scope') ? scoped : '');
        const io = realSalvageIo({ repo, runGit });
        expect(() => io.push(laneDir, ref, head)).toThrow(/transport config.*inspect/);
        expect(runGit.mock.calls.some(([, args]) => args.includes('push'))).toBe(false);
      });
  });
  it.each(['insteadOf', 'pushInsteadOf', 'newline subsection'])(
    'refuses %s rewrites before fetch, push, and remote verification', key => {
      const runGit = vi.fn((_command, args) => args.includes('config')
        ? (key === 'newline subsection' ? 'url./untrusted\nremote.insteadof\0' : `url./untrusted/remote.${key.toLowerCase()}\0`) : '');
      const io = realSalvageIo({ repo, runGit });
      for (const operation of [() => io.unmatchedShas(laneDir, [head]),
        () => io.push(laneDir, ref, head), () => io.remoteSha(ref)]) {
        expect(operation).toThrow(/URL rewriting.*canonical origin/);
      }
      expect(runGit.mock.calls.some(([, args]) => args.some(arg => ['fetch', 'push', 'ls-remote'].includes(arg)))).toBe(false);
    });

  it('fails closed when the effective transport configuration cannot be read', () => {
    const runGit = vi.fn((_command, args) => {
      if (args.includes('config')) throw new Error('configuration unreadable');
      return '';
    });
    const io = realSalvageIo({ repo, runGit });
    expect(() => io.unmatchedShas(laneDir, [head])).toThrow(/configuration unreadable/);
    expect(runGit.mock.calls.some(([, args]) => args.includes('fetch'))).toBe(false);
  });

  it.each(['URL rewrite', 'unreadable config'])(
    'retains a pre-scrub %s refusal after lane config is cleaned', async failure => {
      let scrubbed = false;
      const runGit = vi.fn((_command, args) => {
        if (args.includes('config')) {
          if (scrubbed) return '';
          if (failure === 'unreadable config') throw new Error('configuration unreadable');
          return 'url./untrusted/remote.insteadof\0';
        }
        if (args.includes('rev-list')) return head;
        return '';
      });
      const io = realSalvageIo({ repo, preflightLaneDir: laneDir, runGit });
      scrubbed = true;
      expect(await salvagePushLane({ lane: 7, laneDir, io })).toMatchObject({
        status: 'failed', reason: expect.stringMatching(failure === 'URL rewrite'
          ? /URL rewriting.*canonical origin/ : /configuration unreadable/),
      });
      expect(runGit.mock.calls.filter(([, args]) => args.includes('config'))).toHaveLength(1);
      expect(runGit.mock.calls.some(([, args]) => args.some(arg => ['fetch', 'push', 'ls-remote'].includes(arg)))).toBe(false);
    });

  it('still checks transport config when a rewrite appears after a clean preflight', () => {
    let rewritten = false;
    const runGit = vi.fn((_command, args) => args.includes('config') && rewritten
      ? 'url./untrusted/remote.pushinsteadof\0' : '');
    const io = realSalvageIo({ repo, preflightLaneDir: laneDir, runGit });
    rewritten = true;
    expect(() => io.push(laneDir, ref, head)).toThrow(/URL rewriting.*canonical origin/);
    expect(runGit.mock.calls.some(([, args]) => args.includes('push'))).toBe(false);
  });

  function realHarness({ cherry = `+ ${head}\n+ ${older}`, contains = '', fail } = {}) {
    const runGit = vi.fn((_command, args) => {
      if (fail && args.includes(fail)) throw new Error(`${fail} unavailable`);
      if (args.includes('rev-list')) return `${head}\n${older}`;
      if (args.includes('cherry')) return cherry;
      if (args.includes('for-each-ref')) return contains;
      return '';
    });
    return { runGit, io: realSalvageIo({ repo, runGit }) };
  }

  it('fetches pruned branch refs and pushes/verifies against the explicit canonical URL with transport pins and hardened env', () => {
    const { io, runGit } = realHarness();
    io.aheadShas(laneDir);
    io.unmatchedShas(laneDir, [head, older]);
    io.push(laneDir, ref, head);
    io.remoteSha(ref);
    for (const command of ['fetch', 'push', 'ls-remote']) {
      const call = runGit.mock.calls.find(([, args]) => args.includes(command));
      expect(call).toBeDefined();
      const [, args, options] = call;
      expect(args).toEqual(expect.arrayContaining([
        '-c', 'remote.origin.uploadpack=git-upload-pack',
        '-c', 'remote.origin.receivepack=git-receive-pack', '-c', 'remote.origin.pushurl=', repo.originUrl,
        '-c', 'push.gpgSign=false', '-c', 'gpg.ssh.defaultKeyCommand=',
      ]));
      expect(LANE_GIT_CONFIG_PINS).toContainEqual(['push.gpgSign', 'false']);
      expect(args).not.toContain('origin');
      for (const [key, value] of LANE_GIT_CONFIG_PINS) {
        const index = Object.keys(options.env).find(k => /^GIT_CONFIG_KEY_\d+$/.test(k) && options.env[k] === key).replace('KEY', 'VALUE');
        expect(options.env[index]).toBe(value);
      }
    }
    const fetchArgs = runGit.mock.calls.find(([, args]) => args.includes('fetch'))[1];
    expect(fetchArgs).toEqual(expect.arrayContaining(['--recurse-submodules=no', '--prune', '--no-tags', '+refs/heads/*:refs/remotes/origin/*', '^refs/heads/ops/*']));
    const pushArgs = runGit.mock.calls.find(([, args]) => args.includes('push'))[1];
    expect(pushArgs.slice(pushArgs.indexOf('push'))).toEqual(['push', '--recurse-submodules=no', repo.originUrl, `${head}:refs/heads/${ref}`]);
    expect(runGit.mock.calls.findIndex(([, args]) => args.includes('fetch')))
      .toBeLessThan(runGit.mock.calls.findIndex(([, args]) => args.includes('for-each-ref')));
  });

  it('uses one integration-branch patch check and exact-SHA reachability without enumerating or capping remote refs', () => {
    const { io, runGit } = realHarness({ cherry: `- ${head}\n+ ${older}` });
    expect(io.unmatchedShas(laneDir, [head, older])).toEqual([older]);
    expect(runGit.mock.calls.filter(([, args]) => args.includes('cherry')).map(([, args]) => args))
      .toEqual([['cherry', 'origin/main', 'HEAD']]);
    expect(runGit.mock.calls.filter(([, args]) => args.includes('for-each-ref')).map(([, args]) => args))
      .toEqual([['for-each-ref', '--exclude=refs/remotes/origin/ops/*', '--contains', older, 'refs/remotes/origin', '--count=1']]);
  });

  it('returns matched without pushing when the exact SHAs are reachable from remote branches', async () => {
    const { io, runGit } = realHarness({ contains: 'refs/remotes/origin/work/published' });
    expect(await salvagePushLane({ lane: 7, laneDir, io })).toMatchObject({ status: 'matched', unmatched: [] });
    expect(runGit.mock.calls.some(([, args]) => args.includes('push'))).toBe(false);
    expect(runGit.mock.calls.filter(([, args]) => args.includes('for-each-ref'))).toHaveLength(2);
  });

  it.each(['fetch', 'cherry', 'for-each-ref'])('fails closed without pushing when %s evidence is unreadable', async fail => {
    const { io, runGit } = realHarness({ fail });
    expect(await salvagePushLane({ lane: 7, laneDir, io })).toMatchObject({ status: 'failed', reason: expect.stringContaining(fail) });
    expect(runGit.mock.calls.some(([, args]) => args.includes('push'))).toBe(false);
  });

  it.each([undefined, laneDir])('fails closed with an operator fallback when the canonical origin is unresolved (preflight %s)', async preflightLaneDir => {
    const runGit = vi.fn(() => head);
    const io = realSalvageIo({ repo: { ...repo, originUrl: null }, preflightLaneDir, runGit });
    expect(await salvagePushLane({ lane: 7, laneDir, io })).toMatchObject({
      status: 'failed', reason: expect.stringContaining('supply --origin or a primary --reference'),
    });
    expect(runGit.mock.calls.map(([, args]) => args)).toEqual([['rev-list', 'origin/main..HEAD']]);
  });

  it('rejects every transport operation before reading config when the canonical origin is unresolved', () => {
    const runGit = vi.fn(() => { throw new Error('configuration unreadable'); });
    const io = realSalvageIo({ repo: { ...repo, originUrl: null }, preflightLaneDir: laneDir, runGit });
    for (const operation of [() => io.unmatchedShas(laneDir, [head]),
      () => io.push(laneDir, ref, head), () => io.remoteSha(ref)]) {
      expect(operation).toThrow('canonical origin unresolved; supply --origin or a primary --reference');
    }
    expect(runGit).not.toHaveBeenCalled();
  });
});

