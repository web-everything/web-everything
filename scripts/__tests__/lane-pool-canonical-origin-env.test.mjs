import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { scrubGitRepoEnv } from '../lib/lane-git-hardening.mjs';

const script = resolve('scripts/lane-pool.mjs');
let base, poolRoot, root, candidate, env;
function git(cwd, args) {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', timeout: 10_000 });
}
function list(cwd, extraEnv = {}, extraArgs = []) {
  return spawnSync(process.execPath, [script, 'list', '--acquirable', '--json', ...extraArgs], {
    cwd, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024,
  });
}
function expectRefusal(result, cwd) {
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`list requires a canonical origin outside lane config — pass --origin=<url> or --reference=<primary-checkout> (looked in ${realpathSync(cwd)})`);
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'lane-pool-canonical-origin-'));
  poolRoot = join(base, 'pool');
  root = join(poolRoot, 'daemon', 'code');
  candidate = join(base, 'project.candidate-1-abc');
  env = { ...scrubGitRepoEnv(process.env), LANE_POOL_ROOT: poolRoot };
  delete env.LANE_POOL_CANONICAL_ORIGIN;
  delete env.WE_SMOKE_LIVE_CLONE;
  mkdirSync(root, { recursive: true });
  git(root, ['init', '--quiet', '--initial-branch=main']);
  git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com',
    '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'seed']);
  git(root, ['remote', 'add', 'origin', 'https://example.com/project.git']);
  git(root, ['worktree', 'add', '--quiet', '--detach', candidate, 'HEAD']);
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('lane-pool canonical origin env', () => {
  it('uses the verified live owner for an old-daemon candidate with no canonical origin env', () => {
    expectRefusal(list(candidate), candidate);
    const smoke = list(candidate, { WE_SMOKE_LIVE_CLONE: root });
    expect(smoke.error).toBeUndefined();
    expect(smoke.status, smoke.stderr).toBe(0);
    expect(JSON.parse(smoke.stdout)).toEqual([]);
  });

  it('scrubs inherited Git config while reading a verified live owner through a real-path alias', () => {
    const alias = join(base, 'live-alias');
    symlinkSync(root, alias, 'dir');
    const smoke = list(candidate, {
      WE_SMOKE_LIVE_CLONE: alias,
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'remote.origin.url',
      GIT_CONFIG_VALUE_0: ' ',
    });
    expect(smoke.status, smoke.stderr).toBe(0);
    expect(JSON.parse(smoke.stdout)).toEqual([]);
  });

  it.each(['missing', 'elsewhere'])('refuses a %s live-clone marker', location => {
    const forged = join(base, location);
    if (location === 'elsewhere') {
      mkdirSync(forged);
      git(forged, ['init', '--quiet']);
      git(forged, ['remote', 'add', 'origin', 'https://example.com/forged.git']);
    }
    expectRefusal(list(candidate, { WE_SMOKE_LIVE_CLONE: forged }), candidate);
  });

  it('refuses an owner-matching marker on a worktree without the candidate name', () => {
    const other = join(base, 'ordinary-worktree');
    git(root, ['worktree', 'add', '--quiet', '--detach', other, 'HEAD']);
    expectRefusal(list(other, { WE_SMOKE_LIVE_CLONE: root }), other);
  });

  it('refuses a lane-N worktree even with the correct live-clone marker', () => {
    const lane = join(poolRoot, 'project', 'lane-7');
    git(root, ['worktree', 'add', '--quiet', '--detach', lane, 'HEAD']);
    expectRefusal(list(lane, { WE_SMOKE_LIVE_CLONE: root }), lane);
  });

  it('refuses a candidate owned by a lane checkout, including a symlinked live marker', () => {
    const lane = join(poolRoot, 'project', 'lane-7');
    mkdirSync(lane, { recursive: true });
    git(lane, ['init', '--quiet']);
    git(lane, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com',
      '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'seed']);
    git(lane, ['remote', 'add', 'origin', 'https://example.com/project.git']);
    const laneCandidate = join(base, 'lane-owned.candidate-1-abc');
    git(lane, ['worktree', 'add', '--quiet', '--detach', laneCandidate, 'HEAD']);
    const alias = join(base, 'live-alias');
    symlinkSync(lane, alias, 'dir');
    expectRefusal(list(lane, { WE_SMOKE_LIVE_CLONE: lane }), lane);
    expectRefusal(list(laneCandidate, { WE_SMOKE_LIVE_CLONE: lane }), laneCandidate);
    expectRefusal(list(laneCandidate, { WE_SMOKE_LIVE_CLONE: alias }), laneCandidate);
  });

  it('refuses when the verified live owner has no readable origin', () => {
    git(root, ['remote', 'remove', 'origin']);
    expectRefusal(list(candidate, { WE_SMOKE_LIVE_CLONE: root }), candidate);
  });

  it('refuses when candidate ownership is unreadable despite a live-clone marker', () => {
    const gitDir = git(candidate, ['rev-parse', '--git-dir']).trim();
    rmSync(join(gitDir, 'commondir'));
    expectRefusal(list(candidate, { WE_SMOKE_LIVE_CLONE: root }, [`--reference=${realpathSync(candidate)}`]), candidate);
  });

  it('refuses a candidate with a pool-owned common dir unless given the canonical origin env', () => {
    expect(realpathSync(git(candidate, ['rev-parse', '--git-common-dir']).trim()))
      .toBe(realpathSync(join(root, '.git')));
    expectRefusal(list(candidate), candidate);
    const result = list(candidate, { LANE_POOL_CANONICAL_ORIGIN: 'https://example.com/project.git' });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([]);
  });

  it('still refuses a lane-N checkout without a canonical origin', () => {
    const lane = join(base, 'elsewhere', 'lane-7');
    git(root, ['worktree', 'add', '--quiet', '--detach', lane, 'HEAD']);
    expectRefusal(list(lane), lane);
  });

  it('treats whitespace-only env as absent', () => {
    expectRefusal(list(candidate, { LANE_POOL_CANONICAL_ORIGIN: '  ' }), candidate);
  });

  it('gives an explicit origin flag precedence over the env', () => {
    const selectedLane = join(poolRoot, 'project', 'lane-1');
    mkdirSync(selectedLane, { recursive: true });
    mkdirSync(join(poolRoot, 'wrong', 'lane-1'), { recursive: true });
    const result = spawnSync(process.execPath, [script, 'path', '--lane=1', '--origin=https://example.com/project.git'], {
      cwd: candidate, env: { ...env, LANE_POOL_CANONICAL_ORIGIN: 'https://example.com/wrong.git' },
      encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(selectedLane);
  });

  it.each(['reference', 'repo'])(
    'resolves an explicit %s independently of the inherited canonical origin', selector => {
      const caller = join(base, 'caller');
      const selected = join(base, 'selected');
      for (const [dir, name] of [[caller, 'caller'], [selected, 'selected']]) {
        mkdirSync(dir);
        git(dir, ['init', '--quiet']);
        git(dir, ['remote', 'add', 'origin', `https://example.com/${name}.git`]);
      }
      const selectedLane = join(poolRoot, 'selected', 'lane-1');
      mkdirSync(selectedLane, { recursive: true });
      const result = spawnSync(process.execPath, [script, 'path', '--lane=1',
        `--${selector}=${selected}`], {
        cwd: caller, env: { ...env, LANE_POOL_CANONICAL_ORIGIN: 'https://example.com/caller.git' },
        encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(selectedLane);
    },
  );

  it.each([
    ['configured', 'sweep'], ['missing', 'sweep'], ['without origin', 'sweep'],
    ['configured', 'pool'], ['missing', 'pool'], ['without origin', 'pool'],
    ['configured', 'reference'], ['configured', 'repo'],
  ])(
    'never sends another pool\'s unpublished commit to the inherited origin (%s primary, %s)', (state, selector) => {
      const caller = join(base, 'caller');
      const callerOrigin = join(base, 'caller.git');
      const other = join(base, 'secondary');
      const otherOrigin = join(base, 'secondary.git');
      const lane = join(poolRoot, 'secondary', 'lane-1');
      git(base, ['clone', '--quiet', '--bare', root, callerOrigin]);
      git(base, ['clone', '--quiet', callerOrigin, caller]);
      git(base, ['clone', '--quiet', '--bare', root, otherOrigin]);
      if (state !== 'missing') {
        git(base, ['clone', '--quiet', otherOrigin, other]);
        if (state === 'without origin') git(other, ['remote', 'remove', 'origin']);
      }
      mkdirSync(join(poolRoot, 'secondary'), { recursive: true });
      git(base, ['clone', '--quiet', otherOrigin, lane]);
      git(lane, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com',
        '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'private work']);
      const sha = git(lane, ['rev-parse', 'HEAD']).trim();
      const marker = join(lane, '.git', '.lane-lease');
      writeFileSync(marker, JSON.stringify({ session: 'origin-env-holder', acquiredAt: new Date().toISOString() }));
      // Neither inherited environment nor lane-controlled config can authorize this destination.
      git(lane, ['remote', 'set-url', 'origin', callerOrigin]);
      const selection = selector === 'sweep' ? ['--all-pools']
        : ['--lane=1', '--pool=secondary', ...(selector === 'pool' ? [] : [`--${selector}=${other}`])];
      const result = spawnSync(process.execPath, [script, 'release', ...selection,
        '--session=origin-env-holder', '--json'], {
        cwd: caller, env: { ...env, LANE_POOL_CANONICAL_ORIGIN: callerOrigin,
          LANE_POOL_AUTO_RECOVER: '1', LANE_POOL_NO_RECOVER: '0', WE_LANE_BACKUP_ROOT: join(base, 'backups') },
        encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).released).toBe(1);
      expect(existsSync(marker)).toBe(false);
      expect(git(base, ['ls-remote', '--heads', callerOrigin, 'refs/heads/salvage/*']).trim()).toBe('');
      const salvaged = git(base, ['ls-remote', '--heads', otherOrigin, 'refs/heads/salvage/*']).trim();
      if (state === 'configured') {
        expect(result.stderr).not.toContain('SALVAGE PUSH FAILED');
        expect(salvaged).toMatch(new RegExp(`^${sha}\\s+refs/heads/salvage/lane-1-`));
      } else {
        expect(result.stderr).toContain('canonical origin unresolved');
        expect(salvaged).toBe('');
        expect(git(lane, ['rev-parse', 'HEAD']).trim()).toBe(sha);
      }
    }, 35_000,
  );
});
