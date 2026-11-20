import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const script = resolve('scripts/lane-pool.mjs');
let root, origin, reference, pool, lane, initial, tip;
const git = (args, cwd = reference) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const lease = () => join(lane, '.git', '.lane-lease');
function run(command, args = [], extraEnv = {}) {
  return spawnSync(process.execPath, [script, command, `--origin=${origin}`, `--reference=${reference}`, '--name=at-sha', ...(extraEnv.TEST_INSTALL ? [] : ['--no-install']), ...(extraEnv.TEST_REAP ? [] : ['--no-reap']), '--session=at-test', ...args], {
    encoding: 'utf8', env: { ...process.env, LANE_POOL_ROOT: pool, LANE_POOL_AUTO_RECOVER: '0', ...extraEnv },
  });
}
function gitShim(body) {
  const bin = join(root, 'shim-bin'); mkdirSync(bin);
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(bin, 'git'), '#!/usr/bin/env node\n' +
    "const fs = require('node:fs'), cp = require('node:child_process'); const args = process.argv.slice(2);\n" +
    `const realGit = ${JSON.stringify(realGit)};\n` + body + '\n' +
    "process.exit(cp.spawnSync(realGit, args, { stdio: 'inherit' }).status ?? 1);\n");
  chmodSync(join(bin, 'git'), 0o755);
  return { PATH: `${bin}:${process.env.PATH}` };
}
const acquire = (sha = tip, args = [], extraEnv = {}) => run('acquire', [`--at=${sha}`, '--branch=lane/target', '--lane=1', ...args], extraEnv);
function refused(result) {
  expect(result.status, result.stderr).not.toBe(0);
  expect(existsSync(lease())).toBe(false);
  expect(git(['symbolic-ref', '--short', 'HEAD'], lane)).toBe('main');
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lane-at-sha-'));
  origin = join(root, 'origin.git'); reference = join(root, 'reference'); pool = join(root, '.lanes');
  git(['init', '--quiet', '--bare', '--initial-branch=main', origin], root);
  git(['clone', '--quiet', origin, reference], root);
  writeFileSync(join(reference, 'file.txt'), 'initial'); git(['add', '.']); git(['commit', '--quiet', '-m', 'initial']);
  initial = git(['rev-parse', 'HEAD']); git(['push', '--quiet', 'origin', 'HEAD:main']);
  writeFileSync(join(reference, 'file.txt'), 'target'); git(['commit', '-am', 'target', '--quiet']);
  tip = git(['rev-parse', 'HEAD']); git(['push', '--quiet', 'origin', 'HEAD:lane/target']);
  const provision = run('provision', ['--count=1']); expect(provision.status, provision.stderr).toBe(0);
  lane = join(pool, 'at-sha', 'lane-1');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
describe('acquire at an exact pushed branch tip', () => {
  it.each([false, true])('restores main after a partially failed pinned checkout (prior lease=%s)', prior => {
    if (prior) expect(run('acquire', ['--lane=1']).status).toBe(0);
    const originalLease = prior ? readFileSync(lease(), 'utf8') : null;
    const marker = join(root, 'checkout-failed');
    const env = gitShim(`if (args.includes('checkout') && args.includes('--detach') && !fs.existsSync(${JSON.stringify(marker)})) {
      fs.writeFileSync(${JSON.stringify(marker)}, 'failed');
      const result = cp.spawnSync(realGit, args, { stdio: 'inherit' });
      process.exit(result.status === 0 ? 1 : result.status);
    }`);
    const r = acquire(tip, [], env);
    expect(r.status).not.toBe(0);
    if (prior) expect(readFileSync(lease(), 'utf8')).toBe(originalLease);
    else expect(existsSync(lease())).toBe(false);
    expect(git(['symbolic-ref', '--short', 'HEAD'], lane)).toBe('main');
    expect(existsSync(marker)).toBe(true);
    expect(git(['rev-parse', 'HEAD'], lane)).toBe(initial);
  });
  it.each(['1', 'auto'])('detaches at the tip and records lease and JSON fields (--lane=%s)', selection => {
    const r = acquire(tip, [`--lane=${selection}`, '--json', '--wait-ms=0']);
    expect(r.status, r.stderr).toBe(0);
    expect(git(['rev-parse', 'HEAD'], lane)).toBe(tip);
    expect(spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: lane }).status).not.toBe(0);
    expect(JSON.parse(readFileSync(lease(), 'utf8'))).toMatchObject({ at: tip, branch: 'lane/target' });
    expect(JSON.parse(r.stdout)).toMatchObject({ at: tip, branch: 'lane/target' });
  });
  it('keeps the default integration branch when origin HEAD names trunk', () => {
    git(['update-ref', 'refs/heads/trunk', initial], origin);
    git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk']);
    const r = acquire(); expect(r.status, r.stderr).toBe(0);
    expect(git(['rev-parse', 'refs/heads/trunk'], lane)).toBe(initial);
    expect(git(['rev-parse', 'HEAD'], lane)).toBe(tip);
  });
  it('refuses unpushed lane work and releases its claim', () => {
    writeFileSync(join(lane, 'file.txt'), 'unpushed lane');
    git(['commit', '-am', 'unpushed lane', '--quiet'], lane);
    const before = git(['rev-parse', 'HEAD'], lane);
    refused(acquire());
    expect(git(['rev-parse', 'HEAD'], lane)).toBe(before);
  });
  it('refuses a non-tip commit', () => refused(acquire(initial)));
  it('refuses an unpushed sha', () => {
    writeFileSync(join(reference, 'file.txt'), 'unpushed'); git(['commit', '-am', 'unpushed', '--quiet']);
    refused(acquire(git(['rev-parse', 'HEAD'])));
  });
  it('refuses an unknown sha', () => refused(acquire('f'.repeat(40))));
  it('refuses a missing branch', () => refused(acquire(tip, ['--branch=lane/missing'])));
  it('refuses an unreadable branch fetch despite a matching cached tip', () => {
    const bin = join(root, 'bin'); mkdirSync(bin);
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const shim = join(bin, 'git');
    writeFileSync(shim, '#!/usr/bin/env node\n' +
      "const args = process.argv.slice(2);\n" +
      "if (args.includes('+refs/heads/lane/target:refs/remotes/origin/lane/target')) process.exit(1);\n" +
      `process.exit(require('node:child_process').spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' }).status ?? 1);\n`);
    chmodSync(shim, 0o755);
    refused(acquire(tip, [], { PATH: `${bin}:${process.env.PATH}` }));
  });
  it('auto selection rolls back a non-tip target', () => refused(acquire(initial, ['--lane=auto', '--wait-ms=0'])));
  it('requires an explicit target branch', () => refused(run('acquire', [`--at=${tip}`, '--lane=1'])));
  it('refuses an invalid target ref', () => refused(acquire(tip, ['--branch=lane/../bad'])));
  it('refuses a dirty lane without losing edits', () => {
    writeFileSync(join(lane, 'file.txt'), 'dirty'); refused(acquire());
    expect(readFileSync(join(lane, 'file.txt'), 'utf8')).toBe('dirty');
  });
  it.each(['--force', '--base=main', '--no-reset', '--reserve'])('refuses incompatible %s', flag => refused(acquire(tip, [flag])));
  it.each(['short', 'a'.repeat(40) + '\n'])('refuses malformed sha %j', sha => refused(acquire(sha)));
  it.each(['--branch=main', '--branch='])('requires a lane target branch %s', branch => refused(acquire(tip, [branch])));
  it('prepare-item rejects --at before claiming the lane', () => {
    const r = acquire(tip, ['--purpose=conveyor-prepare-item']); refused(r);
    expect(r.stderr).toMatch(/requires a fresh origin\/main/);
  });
  it.each([false, true])('never installs branch-controlled target dependencies (no-install=%s)', skip => {
    writeFileSync(join(reference, 'package.json'), JSON.stringify({ name: 'target-only', version: '1.0.0',
      scripts: { postinstall: 'node -e "process.exit(42)"' } }));
    git(['add', 'package.json']); git(['commit', '-m', 'deps', '--quiet']);
    tip = git(['rev-parse', 'HEAD']); git(['push', '--quiet', 'origin', 'HEAD:lane/target']);
    const bin = join(root, 'npm-bin'); mkdirSync(bin);
    const evidence = join(root, 'install-head');
    writeFileSync(join(bin, 'npm'), '#!/usr/bin/env node\n' +
      `require('node:fs').writeFileSync(${JSON.stringify(evidence)}, require('node:fs').readFileSync('.git/HEAD', 'utf8')); process.exit(1);\n`);
    chmodSync(join(bin, 'npm'), 0o755);
    const r = acquire(tip, [], { TEST_INSTALL: skip ? '' : '1', PATH: `${bin}:${process.env.PATH}` });
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(evidence)).toBe(false);
    expect(git(['rev-parse', 'HEAD'], lane)).toBe(tip);
  });
  it('rejects an explicit HEAD push to main from a pinned lane after a worker commit', () => {
    expect(acquire().status).toBe(0);
    const hooks = join(lane, '.git', 'hooks');
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, 'pre-push'), '#!/bin/sh\nexec ' +
      `'${process.execPath}' '${resolve('scripts/guard-git-push.mjs')}' "$@"\n`);
    chmodSync(join(hooks, 'pre-push'), 0o755);
    git(['config', 'core.hooksPath', hooks], lane);
    writeFileSync(join(lane, 'file.txt'), 'worker edit');
    git(['commit', '-am', 'worker edit', '--quiet'], lane);
    const workerHead = git(['rev-parse', 'HEAD'], lane);
    const r = spawnSync('git', ['push', 'origin', 'HEAD:refs/heads/main'], {
      cwd: lane, encoding: 'utf8', env: { ...process.env, MAIN_PUSH_OK: '' },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/pre-push BLOCKED/);
    expect(git(['rev-parse', 'refs/heads/main'], origin)).toBe(initial);
    expect(git(['rev-parse', 'refs/heads/lane/target'], origin)).toBe(tip);
    expect(git(['rev-parse', 'HEAD'], lane)).toBe(workerHead);
    expect(readFileSync(join(lane, 'file.txt'), 'utf8')).toBe('worker edit');
  });
  it('bash guard rejects destructive operations from a foreign pinned-lane holder', () => {
    expect(acquire(tip, [], { CLAUDE_CODE_SESSION_ID: 'pinned-owner' }).status).toBe(0);
    writeFileSync(join(lane, 'file.txt'), 'precious edit');
    const beforeLease = readFileSync(lease(), 'utf8');
    const r = spawnSync(process.execPath, [resolve('scripts/guard-bash.mjs')], {
      cwd: lane, encoding: 'utf8',
      input: JSON.stringify({ cwd: lane, session_id: 'foreign-worker',
        tool_input: { command: 'git checkout -- .' } }),
      env: { ...process.env, WE_HOOK_ROOT: reference, CLAUDE_CODE_SESSION_ID: 'foreign-worker', LANE_SESSION: '', LANE_CLOBBER_OK: '' },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput).toMatchObject({ permissionDecision: 'deny' });
    expect(r.stdout).toMatch(/ANOTHER session/);
    expect(readFileSync(join(lane, 'file.txt'), 'utf8')).toBe('precious edit');
    expect(readFileSync(lease(), 'utf8')).toBe(beforeLease);
    expect(git(['rev-parse', 'HEAD'], lane)).toBe(tip);
    expect(git(['rev-parse', 'refs/heads/lane/target'], origin)).toBe(tip);
  });
  it('restores the original live lease when its own pinned target is refused', () => {
    expect(run('acquire', ['--lane=1']).status).toBe(0);
    const original = readFileSync(lease(), 'utf8');
    expect(acquire(initial).status).not.toBe(0);
    expect(readFileSync(lease(), 'utf8')).toBe(original);
    expect(git(['symbolic-ref', '--short', 'HEAD'], lane)).toBe('main');
  });
  it.each([false, true])('failed pinned fetch preserves a replacement lease (prior=%s)', prior => {
    if (prior) expect(run('acquire', ['--lane=1']).status).toBe(0);
    const replacement = { session: 'replacement', holder: 'replacement', acquiredAt: new Date().toISOString(), ttlMinutes: 240 };
    const env = gitShim(`if (args.includes('+refs/heads/lane/target:refs/remotes/origin/lane/target')) { fs.writeFileSync('.git/.lane-lease', ${JSON.stringify(JSON.stringify(replacement))}); process.exit(1); }`);
    const r = acquire(tip, [], env);
    expect(r.status).not.toBe(0);
    expect(JSON.parse(readFileSync(lease(), 'utf8'))).toEqual(replacement);
  });
  it.each([false, true].flatMap(allPools => ['head', 'commit', 'tracked', 'untracked', 'holder'].map(change => [change, allPools])))('refuses late %s changes during pinned release (all-pools=%s)', (change, allPools) => {
    expect(acquire().status).toBe(0);
    const replacement = { session: 'replacement', holder: 'replacement', acquiredAt: new Date().toISOString() };
    const mutation = change === 'head' ? `cp.execFileSync(realGit, ['checkout', '--detach', ${JSON.stringify(initial)}]);`
      : change === 'commit' ? "cp.execFileSync(realGit, ['-c', 'user.name=Test', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'late commit']);"
      : change === 'tracked' ? "fs.writeFileSync('file.txt', 'late edit');"
      : change === 'untracked' ? "fs.writeFileSync('late.txt', 'late work');"
      : `fs.writeFileSync('.git/.lane-lease', ${JSON.stringify(JSON.stringify(replacement))});`;
    const env = gitShim(`if (args.slice(-3).join(' ') === 'rev-parse --verify HEAD') { ${mutation} }`);
    const r = run('release', allPools ? ['--all-pools'] : ['--lane=1'], env);
    expect(r.status, r.stderr).not.toBe(0);
    expect(existsSync(lease())).toBe(true);
    expect(spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: lane }).status).not.toBe(0);
    if (change === 'tracked') expect(readFileSync(join(lane, 'file.txt'), 'utf8')).toBe('late edit');
    if (change === 'untracked') expect(readFileSync(join(lane, 'late.txt'), 'utf8')).toBe('late work');
    if (change === 'holder') expect(JSON.parse(readFileSync(lease(), 'utf8'))).toEqual(replacement);
  });
  it.each([false, true].flatMap(allPools => [[false, false], [false, true], [true, false], [true, true]].map(pair => [...pair, allPools])))('release never overwrites a collision (ignored=%s discard=%s all-pools=%s)', (ignored, discard, allPools) => {
    // Main tracks a path which the pinned target deliberately deletes and ignores.
    writeFileSync(join(reference, 'collision.txt'), 'main version'); git(['add', '.']); git(['commit', '-m', 'main collision', '--quiet']);
    git(['push', '--quiet', 'origin', 'HEAD:main']);
    git(['rm', 'collision.txt']); writeFileSync(join(reference, '.gitignore'), ignored ? 'collision.txt\n' : ''); git(['add', '.']); git(['commit', '-m', 'target ignores collision', '--quiet']);
    tip = git(['rev-parse', 'HEAD']); git(['push', '--quiet', 'origin', 'HEAD:lane/target']);
    expect(acquire().status).toBe(0);
    writeFileSync(join(lane, 'collision.txt'), 'precious');
    const r = run('release', [...(allPools ? ['--all-pools'] : ['--lane=1']), ...(discard ? ['--discard'] : [])]);
    expect(r.status, r.stderr).not.toBe(0);
    expect(readFileSync(join(lane, 'collision.txt'), 'utf8')).toBe('precious');
    expect(git(['rev-parse', 'HEAD'], lane)).toBe(tip);
    expect(existsSync(lease())).toBe(true);
  });
  it('release returns a pushed detached tip to main and clears the lease', () => {
    const r = acquire(); expect(r.status, r.stderr).toBe(0);
    const release = run('release', ['--lane=1']); expect(release.status, release.stderr).toBe(0);
    expect(git(['symbolic-ref', '--short', 'HEAD'], lane)).toBe('main');
    expect(git(['rev-parse', 'HEAD'], lane)).toBe(initial);
    expect(existsSync(lease())).toBe(false);
  });
  it.each(['commit', 'checkout', 'stranded claim'])('release --discard recovers a pinned lane after %s', change => {
    expect(acquire().status).toBe(0);
    if (change === 'commit') git(['commit', '--allow-empty', '-m', 'worker commit'], lane);
    else git(['checkout', ...(change === 'checkout' ? ['--detach', initial] : ['main'])], lane);
    const r = run('release', ['--lane=1', '--discard']);
    expect(r.status, r.stderr).toBe(0);
    expect(git(['symbolic-ref', '--short', 'HEAD'], lane)).toBe('main');
    expect(git(['rev-parse', 'HEAD'], lane)).toBe(initial);
    expect(existsSync(lease())).toBe(false);
  });
  it.each(['commit', 'checkout', 'stranded claim'])('release --force preserves a moved pinned HEAD after %s', change => {
    expect(acquire().status).toBe(0);
    if (change === 'commit') git(['commit', '--allow-empty', '-m', 'worker commit'], lane);
    else git(['checkout', ...(change === 'checkout' ? ['--detach', initial] : ['main'])], lane);
    const before = git(['rev-parse', 'HEAD'], lane);
    const r = run('release', ['--lane=1', '--force']);
    expect(r.status).not.toBe(0);
    expect(git(['rev-parse', 'HEAD'], lane)).toBe(before);
    expect(existsSync(lease())).toBe(true);
  });
  it('release --force --discard recovers a moved pinned HEAD for a foreign holder', () => {
    expect(acquire(tip, [], { CLAUDE_CODE_SESSION_ID: 'other-holder' }).status).toBe(0);
    git(['commit', '--allow-empty', '-m', 'worker commit'], lane);
    const r = run('release', ['--lane=1', '--session=foreign', '--force', '--discard']);
    expect(r.status, r.stderr).toBe(0);
    expect(git(['symbolic-ref', '--short', 'HEAD'], lane)).toBe('main');
    expect(existsSync(lease())).toBe(false);
  });
  it.each([false, true])('cross-pool release returns a pinned lane to main (discard=%s)', discard => {
    expect(acquire().status).toBe(0);
    if (discard) git(['commit', '--allow-empty', '-m', 'worker commit'], lane);
    const r = run('release', ['--all-pools', ...(discard ? ['--discard'] : [])]);
    expect(r.status, r.stderr).toBe(0);
    expect(git(['symbolic-ref', '--short', 'HEAD'], lane)).toBe('main');
    expect(git(['rev-parse', 'HEAD'], lane)).toBe(initial);
    expect(existsSync(lease())).toBe(false);
  });
  it.each([false, true])('terminal pinned lease reaping resets only a lane without new work (moved=%s)', moved => {
    mkdirSync(join(reference, 'backlog'));
    writeFileSync(join(reference, 'backlog', '123-item.md'), '---\nstatus: resolved\n---\n');
    git(['add', 'backlog']); git(['commit', '-m', 'resolved item']);
    git(['push', '--quiet', 'origin', 'HEAD:main']);
    const main = git(['rev-parse', 'HEAD']);
    expect(acquire(tip, ['--session=conveyor-123']).status).toBe(0);
    const expired = { ...JSON.parse(readFileSync(lease(), 'utf8')), acquiredAt: '2000-01-01T00:00:00Z', ttlMinutes: 1 };
    writeFileSync(lease(), JSON.stringify(expired));
    if (moved) git(['commit', '--allow-empty', '-m', 'new work'], lane);
    const before = git(['rev-parse', 'HEAD'], lane);
    const env = gitShim('');
    writeFileSync(join(root, 'shim-bin', 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const r = run('list', ['--acquirable', '--json'], { ...env, TEST_REAP: '1' });
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(lease())).toBe(moved);
    expect(git(['rev-parse', 'HEAD'], lane)).toBe(moved ? before : main);
    if (!moved) expect(git(['symbolic-ref', '--short', 'HEAD'], lane)).toBe('main');
  });
});
