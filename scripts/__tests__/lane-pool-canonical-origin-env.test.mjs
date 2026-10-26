import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { scrubGitRepoEnv } from '../lib/lane-git-hardening.mjs';

const script = resolve('scripts/lane-pool.mjs');
let base, poolRoot, root, candidate, env;
function git(cwd, args) {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', timeout: 10_000 });
}
function list(cwd, extraEnv = {}) {
  return spawnSync(process.execPath, [script, 'list', '--acquirable', '--json'], {
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
  candidate = join(base, 'candidate');
  env = { ...scrubGitRepoEnv(process.env), LANE_POOL_ROOT: poolRoot };
  delete env.LANE_POOL_CANONICAL_ORIGIN;
  mkdirSync(root, { recursive: true });
  git(root, ['init', '--quiet', '--initial-branch=main']);
  git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com',
    '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'seed']);
  git(root, ['remote', 'add', 'origin', 'https://example.com/project.git']);
  git(root, ['worktree', 'add', '--quiet', '--detach', candidate, 'HEAD']);
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('lane-pool canonical origin env', () => {
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
});
