import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, devNull } from 'node:os';
import { join } from 'node:path';
import { proveReplaceContainment, proveRetirement, remoteTip } from '../../daemon-overlay.mjs';
import { carriedBeyondMain } from '../prototype-retire.mjs';
import { scrubInheritedGitEnv } from '../../lib/lane-git-hardening.mjs';

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'overlay-scratch-hardening-'));
  dirs.push(base);
  const root = join(base, 'root');
  mkdirSync(root);
  const env = { ...scrubInheritedGitEnv(process.env), GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_SYSTEM: devNull, GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => {
    const r = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.test',
      '-c', 'commit.gpgsign=false', ...args], { cwd: root, env, encoding: 'utf8', timeout: 20_000 });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  writeFileSync(join(root, '.gitattributes'), 'value.txt filter=normalize\n');
  writeFileSync(join(root, 'value.txt'), 'BASE\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  const baseTip = git('rev-parse', 'HEAD');
  writeFileSync(join(root, 'value.txt'), 'GOOD\n');
  git('commit', '-qam', 'main');
  const mainTip = git('rev-parse', 'HEAD');
  git('checkout', '-qb', 'lane/test', baseTip);
  writeFileSync(join(root, 'value.txt'), 'BAD\n');
  git('commit', '-qam', 'unique work');
  const tip = git('rev-parse', 'HEAD');
  git('remote', 'add', 'origin', root);
  git('update-ref', 'refs/remotes/origin/main', mainTip);
  git('update-ref', 'refs/remotes/origin/lane/test', tip);
  return { base, root, env, git, tip };
}

it('refuses ext:: for both scratch fetch and remoteTip without executing the command', () => {
  const f = fixture();
  const marker = join(f.base, 'executed');
  f.git('remote', 'set-url', 'origin', `ext::sh -c touch% ${marker}`);
  // Even an inherited explicit ext allow must lose to the command-line deny.
  const env = { ...f.env, GIT_CONFIG_PARAMETERS: "'protocol.ext.allow=always'" };
  expect(proveReplaceContainment({ root: f.root, oldRef: 'main', newRef: 'lane/test', env }))
    .toEqual({ ok: false, reason: 'fetch-failed' });
  expect(remoteTip({ root: f.root, ref: 'main', env })).toBeUndefined();
  expect(existsSync(marker)).toBe(false);
});

it('allows an existing relative directory origin for scratch fetch and remoteTip', () => {
  const f = fixture();
  f.git('remote', 'set-url', 'origin', '.');
  expect(remoteTip({ root: f.root, ref: 'lane/test', env: f.env })).toBe(f.tip);
  expect(proveReplaceContainment({ root: f.root, oldRef: 'main', newRef: 'lane/test', env: f.env }))
    .toMatchObject({ ok: true, contained: false, newTip: f.tip });
});

describe('scratch proof rejects inherited renormalization', () => {
  const clean = "sed 's/.*/GOOD/'";
  it.each(['parameters', 'indexed'])('%s config cannot fabricate contentInMain', (source) => {
    const f = fixture();
    const injected = source === 'parameters'
      ? { GIT_CONFIG_PARAMETERS: `'merge.renormalize=true' 'filter.normalize.clean=${clean.replaceAll("'", "'\\''")}'` }
      : { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'merge.renormalize', GIT_CONFIG_VALUE_0: 'true',
        GIT_CONFIG_KEY_1: 'filter.normalize.clean', GIT_CONFIG_VALUE_1: clean };
    const env = { ...f.env, ...injected, GIT_CONFIG_KEY_orphan: 'merge.renormalize', GIT_CONFIG_VALUE_orphan: 'true' };
    // Prove the attack really fabricates equality before exercising the isolated production path.
    const rawGit = (args) => {
      const r = spawnSync('git', args, { cwd: f.root, env, encoding: 'utf8', timeout: 20_000 });
      return { code: r.status, stdout: r.stdout };
    };
    expect(carriedBeyondMain({ git: rawGit, ref: 'lane/test' })).toMatchObject({ ok: true, contentInMain: true });
    const scratchCalls = [];
    const run = (cmd, args, opts) => {
      if (opts.cwd !== f.root) scratchCalls.push({ args, env: opts.env });
      if (cmd === 'gh') return { status: 1, stdout: '' };
      return spawnSync(cmd, args, opts);
    };
    const result = proveRetirement({ root: f.root, entry: { ref: 'lane/test' }, env, run });
    expect(result).toMatchObject({ action: 'keep', evidence: { contentInMain: false } });
    expect(scratchCalls.length).toBeGreaterThan(0);
    for (const call of scratchCalls) {
      expect(Object.keys(call.env).filter(k => /^GIT_CONFIG_(PARAMETERS|COUNT|KEY_.*|VALUE_.*)$/.test(k))).toEqual([]);
    }
    expect(scratchCalls.find(c => c.args.includes('merge-tree')).args.slice(0, 2))
      .toEqual(['-c', 'merge.renormalize=false']);
  });
});

it.each(['https://example.test/repo.git', 'ssh://example.test/repo.git', 'ext::sh', 'file:///missing', 'missing', 'file.txt'])
  ('pins transport and object checks on fetch and ls-remote: %s', origin => {
    const f = fixture();
    writeFileSync(join(f.root, 'file.txt'), 'ordinary file');
    const calls = [];
    const run = (cmd, args, opts) => {
      calls.push(args);
      if (args.includes('get-url')) return { status: 0, stdout: origin };
      if (args.includes('--git-common-dir')) return { status: 0, stdout: join(f.root, '.git') };
      if (args.includes('ls-remote')) return { status: 0, stdout: '' };
      if (args.includes('fetch')) return { status: 0, stdout: '' };
      if (args[0] === 'init') return spawnSync(cmd, args, opts);
      return { status: 1, stdout: '' };
    };
    const env = f.env;
    proveReplaceContainment({ root: f.root, oldRef: 'main', newRef: 'lane/test', env, run });
    remoteTip({ root: f.root, ref: 'main', env, run });
    const transports = calls.filter(args => args.includes('fetch') || args.includes('ls-remote'));
    expect(transports).toHaveLength(2);
    for (const args of transports) {
      for (const pin of ['protocol.allow=never', 'protocol.https.allow=always', 'protocol.ssh.allow=always',
        'protocol.ext.allow=never', 'protocol.file.allow=never', 'transfer.fsckObjects=true',
        'fetch.fsckObjects=true', 'receive.fsckObjects=true']) expect(args).toContain(pin);
    }
  });
