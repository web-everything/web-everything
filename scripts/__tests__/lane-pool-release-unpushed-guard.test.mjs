import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { sharedRepos, withGhStub } from './fixtures/shared-git-fixture.mjs';

const script = resolve(process.cwd(), 'scripts/lane-pool.mjs');
const git = (args, cwd) => execFileSync('git', args, {
  cwd, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024,
}).trim();
let fixtureRoot, fixture, origin, reference, base, poolRoot, laneDir, marker, lease;
function runPool(args, fault = '') {
  const preload = `import os from 'node:os'; import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    os.userInfo = () => ({ homedir: ${JSON.stringify(base)} });
    const original = cp.execFileSync;
    cp.execFileSync = (cmd, args, opts) => {
      if (cmd === 'git' && opts?.cwd === ${JSON.stringify(laneDir)}) { ${fault} }
      return original(cmd, args, opts);
    }; syncBuiltinESMExports();`;
  const result = spawnSync(process.execPath, [`--import=data:text/javascript,${encodeURIComponent(preload)}`,
    script, ...args, `--origin=${origin}`, `--reference=${reference}`, '--name=releaseguard',
    '--branch=main', '--no-install', '--session=guard-holder', '--json'], {
    encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024,
    env: withGhStub({ ...process.env, LANE_POOL_NO_RECOVER: '1', LANE_POOL_AUTO_RECOVER: '0',
      LANE_POOL_ROOT: poolRoot, WE_LANE_BACKUP_ROOT: join(base, 'backups') }),
  });
  expect(result.error).toBeUndefined();
  return { ...result, data: result.stdout.trim() ? JSON.parse(result.stdout) : null };
}
function commitWork() {
  writeFileSync(join(laneDir, 'seed.txt'), 'local work\n');
  git(['add', 'seed.txt'], laneDir);
  git(['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--quiet', '-m', 'local work'], laneDir);
  return git(['rev-parse', 'HEAD'], laneDir);
}
function refused(result, sha) {
  expect(result.status, result.stderr).toBe(1);
  expect(result.data.released).toBe(0);
  expect(result.stderr).toContain('UNPUSHED_WORK');
  if (sha) expect(result.stderr).toContain(sha.slice(0, 12));
  expect(result.stderr).toContain(`git -C ${laneDir} push origin HEAD:refs/heads/`);
  expect(result.stderr).toContain('--discard');
  expect(readFileSync(marker, 'utf8')).toBe(lease);
  expect(existsSync(laneDir)).toBe(true);
}
function released(result) {
  expect(result.status, result.stderr).toBe(0);
  expect(result.data.released).toBe(1);
  expect(existsSync(marker)).toBe(false);
}
beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'release-guard-fixture-'));
  origin = join(fixtureRoot, 'origin.git');
  reference = join(fixtureRoot, 'reference');
  git(['init', '--quiet', '--bare', '--initial-branch=main', origin]);
  git(['clone', '--quiet', origin, reference]);
  writeFileSync(join(reference, 'seed.txt'), 'seed\n');
  git(['add', '.'], reference);
  git(['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--quiet', '-m', 'seed'], reference);
  git(['push', '--quiet', 'origin', 'main'], reference);
  fixture = sharedRepos(fixtureRoot, [origin, reference]);
});
afterAll(() => fixture?.dispose());
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'release-guard-case-'));
  poolRoot = join(base, 'pool');
  laneDir = join(poolRoot, 'releaseguard', 'lane-1');
  marker = join(laneDir, '.git', '.lane-lease');
  expect(runPool(['provision', '--count=1']).status).toBe(0);
  expect(runPool(['acquire', '--lane=1', '--no-reset']).status).toBe(0);
  lease = readFileSync(marker, 'utf8');
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  fixture.restore();
});

describe.each(['--lane=1', '--all-pools'])('release unpushed guard %s', selector => {
  const release = (extra = [], fault = '') => runPool(['release', selector, ...extra], fault);
  it('refuses an unpushed commit and keeps the exact lease, even with --force', () => {
    const sha = commitWork();
    refused(release(['--force']), sha);
    const branch = git(['symbolic-ref', '--short', 'HEAD'], laneDir);
    expect(release().stderr).toContain(`git -C ${laneDir} push origin HEAD:refs/heads/${branch}`);
    expect(git(['rev-parse', 'HEAD'], laneDir)).toBe(sha);
  });
  it('bulk release keeps unsafe work, releases a clean lane, and exits 1 at the end', () => {
    const sha = commitWork();
    expect(runPool(['provision', '--count=2']).status).toBe(0);
    expect(runPool(['acquire', '--lane=2', '--no-reset']).status).toBe(0);
    const result = runPool(['release', selector === '--lane=1' ? '--all' : selector, '--force']);
    expect(result.status, result.stderr).toBe(1);
    expect(result.data.released).toBe(1);
    expect(result.stderr).toContain('UNPUSHED_WORK');
    expect(result.stderr).toContain(sha.slice(0, 12));
    expect(readFileSync(marker, 'utf8')).toBe(lease);
    expect(existsSync(join(poolRoot, 'releaseguard', 'lane-2', '.git', '.lane-lease'))).toBe(false);
  });
  it('releases a pushed commit without requiring a particular upstream ref', () => {
    commitWork();
    git(['push', '--quiet', 'origin', 'HEAD:refs/heads/work/preserved'], laneDir);
    released(release());
  });
  it('--discard releases with a WARNING listing both commits and tracked changes', () => {
    const sha = commitWork();
    writeFileSync(join(laneDir, 'seed.txt'), 'unfinished edit\n');
    const result = release(['--discard']);
    released(result);
    expect(result.stderr).toMatch(/WARNING.*--discard/);
    expect(result.stderr).toContain(sha.slice(0, 12));
    expect(result.stderr).toContain('seed.txt');
    expect(git(['rev-parse', 'HEAD'], laneDir)).toBe(sha);
    expect(readFileSync(join(laneDir, 'seed.txt'), 'utf8')).toBe('unfinished edit\n');
  });
  it.each([false, true])('refuses tracked uncommitted changes (staged=%s) after litter cleanup', staged => {
    writeFileSync(join(laneDir, 'seed.txt'), 'unfinished edit\n');
    if (staged) git(['add', 'seed.txt'], laneDir);
    writeFileSync(join(laneDir, '.commit-msg.txt'), 'known litter\n');
    refused(release());
    expect(existsSync(join(laneDir, '.commit-msg.txt'))).toBe(false);
    expect(readFileSync(join(laneDir, 'seed.txt'), 'utf8')).toBe('unfinished edit\n');
  });
  it('refuses work reachable only from another local branch', () => {
    const sha = commitWork();
    git(['branch', 'work/other', sha], laneDir);
    git(['reset', '--hard', 'origin/main'], laneDir);
    refused(release(), sha);
  });
  it('refuses a detached unpushed HEAD and prints a usable lane branch fallback', () => {
    const sha = commitWork();
    git(['checkout', '--quiet', '--detach'], laneDir);
    const result = release();
    refused(result, sha);
    expect(result.stderr).toContain(`git -C ${laneDir} push origin HEAD:refs/heads/lane/lane-1-preserve`);
  });
  it('compares only existing remote refs when no remote-tracking refs remain', () => {
    git(['remote', 'remove', 'origin'], laneDir);
    refused(release(), git(['rev-parse', 'HEAD'], laneDir));
  });
  it('does not block on untracked files outside the litter allowlist', () => {
    writeFileSync(join(laneDir, 'notes.txt'), 'notes\n');
    released(release());
    expect(readFileSync(join(laneDir, 'notes.txt'), 'utf8')).toBe('notes\n');
  });
  it.each(['unreadable status', 'unreadable commits', 'oversized commits'])(
    'fails closed on %s and names manual inspection and --discard as fallbacks', failure => {
      const condition = failure === 'unreadable status' ? "args.includes('--untracked-files=no')"
        : "args.includes('--branches')";
      const fault = `if (${condition}) { const error = new Error('forced evidence failure');
        error.code = ${JSON.stringify(failure === 'oversized commits' ? 'ENOBUFS' : 'EIO')}; throw error; }`;
      const result = release([], fault);
      refused(result);
      expect(result.stderr).toContain('inspect');
      expect(result.stderr).toContain('unreadable or exceeds');
      const override = release(['--discard'], fault);
      released(override);
      expect(override.stderr).toMatch(/WARNING.*--discard.*unreadable or exceeds/);
    });
});
