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
  return spawnSync(process.execPath, [script, command, `--origin=${origin}`, `--reference=${reference}`, '--name=at-sha', '--no-install', '--no-reap', '--session=at-test', ...args], {
    encoding: 'utf8', env: { ...process.env, LANE_POOL_ROOT: pool, LANE_POOL_AUTO_RECOVER: '0', ...extraEnv },
  });
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
  it('release returns a pushed detached tip to main and clears the lease', () => {
    const r = acquire(); expect(r.status, r.stderr).toBe(0);
    const release = run('release', ['--lane=1']); expect(release.status, release.stderr).toBe(0);
    expect(git(['symbolic-ref', '--short', 'HEAD'], lane)).toBe('main');
    expect(git(['rev-parse', 'HEAD'], lane)).toBe(initial);
    expect(existsSync(lease())).toBe(false);
  });
});
