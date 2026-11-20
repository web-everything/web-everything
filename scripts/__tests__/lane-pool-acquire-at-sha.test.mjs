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
  return spawnSync(process.execPath, [script, command, `--origin=${origin}`, `--reference=${reference}`, '--name=at-sha', ...(extraEnv.TEST_INSTALL ? [] : ['--no-install']), '--no-reap', '--session=at-test', ...args], {
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
  origin = join(root, 'origin.git'); reference = join(root, 'reference'); pool = join(root, 'pool');
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
  it.each([[false, false], [true, false], [false, true]])('prepares target dependencies and rolls back failed installs (skip=%s fail=%s)', (skip, installFails) => {
    writeFileSync(join(reference, 'package.json'), JSON.stringify({ name: 'target-only', version: '1.0.0' }));
    git(['add', 'package.json']); git(['commit', '-m', 'deps', '--quiet']);
    tip = git(['rev-parse', 'HEAD']); git(['push', '--quiet', 'origin', 'HEAD:lane/target']);
    const bin = join(root, 'npm-bin'); mkdirSync(bin);
    const evidence = join(root, 'install-head');
    writeFileSync(join(bin, 'npm'), '#!/usr/bin/env node\n' +
      `require('node:fs').writeFileSync(${JSON.stringify(evidence)}, require('node:fs').readFileSync('.git/HEAD', 'utf8')); process.exit(${installFails ? 1 : 0});\n`);
    chmodSync(join(bin, 'npm'), 0o755);
    const r = acquire(tip, [], { TEST_INSTALL: skip ? '' : '1', PATH: `${bin}:${process.env.PATH}` });
    if (installFails) refused(r);
    else expect(r.status, r.stderr).toBe(0);
    expect(existsSync(evidence)).toBe(!skip);
    if (!skip) expect(readFileSync(evidence, 'utf8').trim()).toBe(tip);
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
  it.each(['head', 'commit', 'tracked', 'untracked', 'holder'])('refuses late %s changes during pinned release', change => {
    expect(acquire().status).toBe(0);
    const replacement = { session: 'replacement', holder: 'replacement', acquiredAt: new Date().toISOString() };
    const mutation = change === 'head' ? `cp.execFileSync(realGit, ['checkout', '--detach', ${JSON.stringify(initial)}]);`
      : change === 'commit' ? "cp.execFileSync(realGit, ['-c', 'user.name=Test', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'late commit']);"
      : change === 'tracked' ? "fs.writeFileSync('file.txt', 'late edit');"
      : change === 'untracked' ? "fs.writeFileSync('late.txt', 'late work');"
      : `fs.writeFileSync('.git/.lane-lease', ${JSON.stringify(JSON.stringify(replacement))});`;
    const env = gitShim(`if (args.slice(-3).join(' ') === 'rev-parse --verify HEAD') { ${mutation} }`);
    const r = run('release', ['--lane=1'], env);
    expect(r.status, r.stderr).not.toBe(0);
    expect(existsSync(lease())).toBe(true);
    expect(spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: lane }).status).not.toBe(0);
    if (change === 'tracked') expect(readFileSync(join(lane, 'file.txt'), 'utf8')).toBe('late edit');
    if (change === 'untracked') expect(readFileSync(join(lane, 'late.txt'), 'utf8')).toBe('late work');
    if (change === 'holder') expect(JSON.parse(readFileSync(lease(), 'utf8'))).toEqual(replacement);
  });
  it.each([[false, false], [false, true], [true, false], [true, true]])('release never overwrites a collision (ignored=%s discard=%s)', (ignored, discard) => {
    // Main tracks a path which the pinned target deliberately deletes and ignores.
    writeFileSync(join(reference, 'collision.txt'), 'main version'); git(['add', '.']); git(['commit', '-m', 'main collision', '--quiet']);
    git(['push', '--quiet', 'origin', 'HEAD:main']);
    git(['rm', 'collision.txt']); writeFileSync(join(reference, '.gitignore'), ignored ? 'collision.txt\n' : ''); git(['add', '.']); git(['commit', '-m', 'target ignores collision', '--quiet']);
    tip = git(['rev-parse', 'HEAD']); git(['push', '--quiet', 'origin', 'HEAD:lane/target']);
    expect(acquire().status).toBe(0);
    writeFileSync(join(lane, 'collision.txt'), 'precious');
    const r = run('release', ['--lane=1', ...(discard ? ['--discard'] : [])]);
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
});
