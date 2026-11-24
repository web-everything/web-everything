/**
 * @file scripts/__tests__/lane-pool-wrong-origin.test.mjs
 * @description LANE-POOL-WRONG-REPO — behavioural proofs against throwaway git repos (spawns the real CLI):
 *   a wrong-origin lane is skipped and never handed out; a --branch not yet on origin is acquired from the
 *   pool base; `--pool=<name>` with no primary checkout fails closed instead of using the caller's origin.
 *   Plus the pure origin comparison.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { withGhStub } from './fixtures/shared-git-fixture.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { originsDiffer } from '../lib/lane-pool-origin.mjs';

const SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const commit = (cwd, msg) => git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', msg], cwd);

function runPool(args, extraEnv = {}, cwd = undefined) {
  const r = spawnSync('node', [SCRIPT, ...args], { cwd, encoding: 'utf8', env: withGhStub({ ...process.env, ...extraEnv }) });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

let base, originDir, otherDir, referenceDir, poolRoot;
const common = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, '--name=wrongorigin', '--branch=main', '--no-install'];

function seedOrigin(dir, file) {
  const bare = join(base, dir + '.git');
  const work = join(base, dir + '-work');
  git(['init', '--quiet', '--bare', '--initial-branch=main', bare]);
  git(['clone', '--quiet', bare, work]);
  writeFileSync(join(work, 'file.txt'), file);
  git(['add', 'file.txt'], work);
  commit(work, 'seed');
  git(['push', '--quiet', 'origin', 'main'], work);
  return { bare, work };
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'lane-pool-wrong-origin-'));
  poolRoot = join(base, 'pool');
  ({ bare: originDir, work: referenceDir } = seedOrigin('origin', 'right\n'));
  ({ bare: otherDir } = seedOrigin('other', 'wrong\n'));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('lane-pool wrong-origin / new-branch / missing-primary (behavioural)', () => {
  it('skips a wrong-origin lane on auto-pick and refuses it when named explicitly', () => {
    expect(runPool(['provision', '--count=2', ...common()], { LANE_POOL_ROOT: poolRoot }).code).toBe(0);
    const lane1 = join(poolRoot, 'wrongorigin', 'lane-1');
    git(['remote', 'set-url', 'origin', otherDir], lane1);

    const auto = runPool(['acquire', ...common(), '--json'], { LANE_POOL_ROOT: poolRoot });
    expect(auto.code).toBe(0);
    expect(JSON.parse(auto.out).path).toBe(join(poolRoot, 'wrongorigin', 'lane-2'));

    const explicit = runPool(['acquire', '--lane=1', ...common(), '--json'], { LANE_POOL_ROOT: poolRoot });
    expect(explicit.code).not.toBe(0);
    expect(explicit.err + explicit.out).toMatch(/WRONG-ORIGIN/);
  });

  it('acquires a --branch that is not on origin yet from the pool base, with no probe failure', () => {
    expect(runPool(['provision', '--count=1', ...common()], { LANE_POOL_ROOT: poolRoot }).code).toBe(0);
    const mainSha = git(['rev-parse', 'main'], originDir);
    const args = ['acquire', '--origin=' + originDir, `--reference=${referenceDir}`, '--name=wrongorigin', '--branch=lane/not-yet', '--no-install', '--json'];
    const r = runPool(args, { LANE_POOL_ROOT: poolRoot });
    expect(r.code).toBe(0);
    expect(r.err + r.out).not.toMatch(/not eligible this scan|probe failed/);
    const lane = JSON.parse(r.out).path;
    expect(git(['rev-parse', 'HEAD'], lane)).toBe(mainSha);
  });

  it('fails closed when --pool names a pool whose primary checkout is absent', () => {
    const r = runPool(['acquire', '--pool=zz-no-such-primary-pool', '--session=t', '--purpose=t'], { LANE_POOL_ROOT: poolRoot }, referenceDir);
    expect(r.code).not.toBe(0);
    expect(r.err + r.out).toMatch(/no primary checkout/);
  });

  function sameNamedForks(withPrimary) {
    mkdirSync(join(base, 'company'));
    mkdirSync(join(base, 'fork'));
    const canonical = join(base, 'company', 'project.git');
    const fork = join(base, 'fork', 'project.git');
    const caller = join(base, 'caller');
    git(['clone', '--quiet', '--bare', originDir, canonical]);
    git(['clone', '--quiet', '--bare', otherDir, fork]);
    git(['clone', '--quiet', fork, caller]);
    if (withPrimary) git(['clone', '--quiet', canonical, join(base, 'project')]);
    return { canonical, fork, caller };
  }

  it.each(['provision', 'acquire'])('%s uses the selected primary even when the caller origin has the same basename', (command) => {
    const { canonical, caller } = sameNamedForks(true);
    if (command === 'acquire') {
      const provision = runPool(['provision', '--origin=' + canonical, '--pool=project', '--count=1', '--no-install'], { LANE_POOL_ROOT: poolRoot }, caller);
      expect(provision.code, provision.err + provision.out).toBe(0);
    }
    const r = runPool([command, '--pool=project', '--count=1', '--no-install', '--session=t', '--purpose=t'], { LANE_POOL_ROOT: poolRoot }, caller);
    expect(r.code, r.err + r.out).toBe(0);
    expect(git(['remote', 'get-url', 'origin'], join(poolRoot, 'project', 'lane-1'))).toBe(canonical);
  });

  it.each(['provision', 'acquire'])('%s refuses a missing primary even when the caller origin has the pool basename', (command) => {
    const { caller } = sameNamedForks(false);
    const r = runPool([command, '--pool=project', '--count=1', '--no-install', '--session=t', '--purpose=t'], { LANE_POOL_ROOT: poolRoot }, caller);
    expect(r.code, r.err + r.out).not.toBe(0);
    expect(r.err + r.out).toMatch(/no primary checkout/);
  });

  it.each(['origin', 'reference'])('honours explicit --%s when the selected primary is absent', (option) => {
    const r = runPool(['provision', '--pool=project', '--count=1', '--no-install', `--${option}=${option === 'origin' ? originDir : referenceDir}`], { LANE_POOL_ROOT: poolRoot }, referenceDir);
    expect(r.code, r.err + r.out).toBe(0);
    expect(git(['remote', 'get-url', 'origin'], join(poolRoot, 'project', 'lane-1'))).toBe(originDir);
  });
});

describe('originsDiffer', () => {
  it('flags a web-everything clone inside the plateau-app pool', () => {
    expect(originsDiffer('git@github.com:chalbert/web-everything.git', 'git@github.com:plateauapp/plateau-app.git')).toBe(true);
  });
  it('treats ssh/https spellings of the same repo as equal', () => {
    expect(originsDiffer('git@github.com:plateauapp/plateau-app.git', 'https://github.com/plateauapp/plateau-app')).toBe(false);
  });
  it('keeps path case and ports distinct', () => {
    expect(originsDiffer('git@github.com:Org/Repo.git', 'git@github.com:org/repo.git')).toBe(true);
    expect(originsDiffer('ssh://git@host:2222/org/repo', 'git@host:2222/org/repo')).toBe(true);
  });
  it.each([
    ['alice@host:repo.git', 'bob@host:repo.git'],
    ['alice@host:team/repo.git', 'bob@host:team/repo.git'],
    ['ssh://alice@host/~/repo.git', 'ssh://bob@host/~/repo.git'],
    ['ssh://alice@host/~alice/repo.git', 'ssh://alice@host/~bob/repo.git'],
    ['alice@host:repo.git', 'https://host/repo.git'],
    ['alice@host:repo.git', 'ssh://alice@host/repo.git'],
    ['Alice@host:repo.git', 'alice@host:repo.git'],
    ['host:repo.git', 'alice@host:repo.git'],
    ['alice@[::1]:repo.git', 'bob@[::1]:repo.git'],
    ['ssh://alice@host:2222/~/repo.git', 'ssh://bob@host:2222/~/repo.git'],
    ['git@host:repo.git', 'https://host/repo.git'],
  ])('keeps distinct home-relative repositories apart: %s / %s', (a, b) => {
    expect(originsDiffer(a, b)).toBe(true);
  });
  it('normalizes equivalent home-relative and absolute SSH spellings', () => {
    expect(originsDiffer('alice@HOST:repo.git', 'ssh://alice@host/~/repo')).toBe(false);
    expect(originsDiffer('alice@host:/srv/repo.git', 'ssh://bob@host/srv/repo')).toBe(false);
  });
  it('never marks a lane wrong when an origin is unknown', () => {
    expect(originsDiffer(null, 'git@github.com:a/b.git')).toBe(false);
    expect(originsDiffer('git@github.com:a/b.git', '')).toBe(false);
  });
});
