import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { sharedRepos, withGhStub } from './fixtures/shared-git-fixture.mjs';

const script = resolve(process.cwd(), 'scripts/lane-pool.mjs');
const git = (args, cwd) => execFileSync('git', args, {
  cwd, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024,
}).trim();
let fixtureRoot, sharedFixture, origin, reference, base, poolRoot, backupRoot, laneDir, lane;
const poolArgs = (originUrl = origin) => [...(originUrl === null ? [] : [`--origin=${originUrl}`]), `--reference=${reference}`, '--name=releasesalvage', '--branch=main', '--no-install'];
function runPool(args, env = {}, { stderr, cwd, originUrl = origin } = {}) {
  const result = spawnSync(process.execPath, [script, ...args, ...poolArgs(originUrl), '--session=salvage-holder', '--json'], {
    cwd,
    encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024,
    env: withGhStub({ ...process.env, LANE_POOL_ROOT: poolRoot, WE_LANE_BACKUP_ROOT: backupRoot, ...env }),
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  if (stderr) expect(result.stderr).toMatch(stderr);
  else expect(result.stderr).not.toContain('SALVAGE PUSH FAILED');
  return JSON.parse(result.stdout);
}
const salvageBranches = () => git(['ls-remote', '--heads', origin, `refs/heads/salvage/lane-${lane}-*`], reference)
  .split('\n').filter(Boolean).map(line => line.split(/\s+/));
function assertReleased(result) {
  expect(result.released).toBe(1);
  expect(existsSync(join(laneDir, '.git', '.lane-lease'))).toBe(false);
}
function commitLocalWork() {
  writeFileSync(join(laneDir, 'local-work.txt'), 'work that must survive release\n');
  git(['add', 'local-work.txt'], laneDir);
  git(['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--quiet', '-m', 'local work'], laneDir);
  const sha = git(['rev-parse', 'HEAD'], laneDir);
  expect(git(['rev-list', 'origin/main..HEAD'], laneDir)).toBe(sha);
  expect(git(['ls-remote', '--heads', origin], laneDir)).not.toContain(sha);
  return sha;
}
function recordFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? recordFiles(path) : entry.isFile() ? [path] : [];
  });
}

function competingRelativeOrigin() {
  const cwd = join(base, 'caller'), competingOrigin = join(base, 'origin.git');
  mkdirSync(cwd);
  git(['clone', '--quiet', '--bare', origin, competingOrigin]);
  git(['remote', 'set-url', 'origin', '../origin.git'], reference);
  return { cwd, competingOrigin };
}

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'release-salvage-fixture-'));
  origin = join(fixtureRoot, 'origin.git');
  reference = join(fixtureRoot, 'reference');
  git(['init', '--quiet', '--bare', '--initial-branch=main', origin]);
  git(['clone', '--quiet', origin, reference]);
  writeFileSync(join(reference, 'seed.txt'), 'seed\n');
  git(['add', '.'], reference);
  git(['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--quiet', '-m', 'seed'], reference);
  git(['push', '--quiet', 'origin', 'main'], reference);
  sharedFixture = sharedRepos(fixtureRoot, [origin, reference]);
});
afterAll(() => sharedFixture?.dispose());
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'release-salvage-case-'));
  poolRoot = join(base, 'pool');
  backupRoot = join(base, 'backups');
  runPool(['provision', '--count=1']);
  const acquired = runPool(['acquire', '--lane=1', '--no-reset', '--purpose=salvage-test']);
  lane = acquired.lane;
  expect(lane).toBe(1);
  laneDir = join(poolRoot, 'releasesalvage', `lane-${lane}`);
  expect(existsSync(join(laneDir, '.git', '.lane-lease'))).toBe(true);
  expect(salvageBranches()).toEqual([]);
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  sharedFixture.restore();
});

describe('lane-pool release salvage push against a throwaway origin', () => {
  it('resolves a configured relative origin against the primary checkout when release runs elsewhere', () => {
    const sha = commitLocalWork();
    const { cwd, competingOrigin } = competingRelativeOrigin();
    assertReleased(runPool(['release', `--lane=${lane}`], {}, { cwd, originUrl: null }));
    expect(salvageBranches()).toEqual([[sha, expect.stringMatching(/^refs\/heads\/salvage\/lane-1-/)]]);
    expect(git(['ls-remote', '--heads', competingOrigin, 'refs/heads/salvage/*'], cwd)).toBe('');
  });

  it('keeps an explicit relative --origin invocation-relative despite a different configured primary origin', () => {
    const sha = commitLocalWork();
    const { cwd, competingOrigin } = competingRelativeOrigin();
    assertReleased(runPool(['release', `--lane=${lane}`], {}, { cwd, originUrl: '../origin.git' }));
    expect(salvageBranches()).toEqual([]);
    expect(git(['ls-remote', '--heads', competingOrigin, 'refs/heads/salvage/*'], cwd))
      .toMatch(new RegExp(`^${sha}\\s+refs/heads/salvage/lane-1-`));
  });

  it('pushes an unpushed local HEAD while still leased, records it under WE_LANE_BACKUP_ROOT, then releases', () => {
    const sha = commitLocalWork();
    // The origin observes the lease during receive, proving preservation precedes release.
    // The hook uses the child's private fixture env, never a developer-specific path.
    writeFileSync(join(origin, 'hooks', 'pre-receive'), `#!/bin/sh
set -eu
test -f "$LANE_POOL_ROOT/releasesalvage/lane-1/.git/.lane-lease"
printf 'lease present during receive\\n' > "$LANE_POOL_ROOT/push-observed"
`, { mode: 0o755 });
    const result = runPool(['release', `--lane=${lane}`]);
    assertReleased(result);
    const branches = salvageBranches();
    expect(branches).toHaveLength(1);
    expect(branches[0]).toEqual([sha, expect.stringMatching(/^refs\/heads\/salvage\/lane-1-\d{8}-\d{4}(?:-\d+)?$/)]);
    expect(readFileSync(join(poolRoot, 'push-observed'), 'utf8')).toContain('lease present');
    const ref = branches[0][1].replace(/^refs\/heads\//, '');
    const records = recordFiles(backupRoot);
    expect(records.length).toBeGreaterThan(0);
    expect(records.some(path => {
      const text = readFileSync(path, 'utf8');
      return text.includes(ref) && text.includes(sha);
    })).toBe(true);
  });

  it('releases a lane with no ahead commits without creating any salvage branch', () => {
    expect(git(['rev-list', 'origin/main..HEAD'], laneDir)).toBe('');
    assertReleased(runPool(['release', `--lane=${lane}`]));
    expect(salvageBranches()).toEqual([]);
  });

  it('salvages when a different SHA on another remote branch has the same patch', () => {
    const localSha = commitLocalWork();
    // Amend the message in a separate clone; leave the lane on its original, never-pushed SHA.
    const published = join(base, 'published');
    git(['clone', '--quiet', '--shared', laneDir, published]);
    git(['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--quiet', '--amend', '-m', 'same patch, published message'], published);
    const remoteSha = git(['rev-parse', 'HEAD'], published);
    expect(remoteSha).not.toBe(localSha);
    git(['push', '--quiet', origin, 'HEAD:refs/heads/work/renamed'], published);
    git(['fetch', '--quiet', 'origin'], laneDir);
    expect(git(['cherry', 'origin/work/renamed', 'HEAD'], laneDir)).toBe(`- ${localSha}`);
    expect(git(['ls-remote', '--heads', origin], laneDir)).not.toContain(localSha);
    assertReleased(runPool(['release', `--lane=${lane}`]));
    expect(salvageBranches()).toEqual([[localSha, expect.stringMatching(/^refs\/heads\/salvage\/lane-1-/)]]);
  });

  it('creates no salvage branch when the exact SHA is already reachable from a remote branch', () => {
    const sha = commitLocalWork();
    git(['push', '--quiet', origin, `${sha}:refs/heads/work/exact`], laneDir);
    assertReleased(runPool(['release', `--lane=${lane}`]));
    expect(salvageBranches()).toEqual([]);
  });

  it('still matches exact SHAs with more than 400 remote branches', () => {
    const sha = commitLocalWork();
    git(['push', '--quiet', origin, `${sha}:refs/heads/work/exact`], laneDir);
    execFileSync('git', ['update-ref', '--stdin'], {
      cwd: origin, encoding: 'utf8', timeout: 30_000,
      input: Array.from({ length: 401 }, (_, i) => `update refs/heads/work/extra-${i} ${sha}`).join('\n') + '\n',
    });
    assertReleased(runPool(['release', `--lane=${lane}`]));
    expect(salvageBranches()).toEqual([]);
  });

  it('prunes a deleted remote branch before checking exact-SHA preservation', () => {
    const sha = commitLocalWork();
    git(['push', '--quiet', origin, `${sha}:refs/heads/work/deleted`], laneDir);
    git(['fetch', '--quiet', 'origin'], laneDir);
    git(['push', '--quiet', origin, ':refs/heads/work/deleted'], laneDir);
    expect(git(['for-each-ref', '--contains', sha, 'refs/remotes/origin'], laneDir)).toContain('work/deleted');
    assertReleased(runPool(['release', `--lane=${lane}`]));
    expect(salvageBranches()).toEqual([[sha, expect.stringMatching(/^refs\/heads\/salvage\/lane-1-/)]]);
    expect(git(['for-each-ref', 'refs/remotes/origin/work/deleted'], laneDir)).toBe('');
  });

  it('creates no salvage branch for a different SHA patch-equivalent to the integration branch', () => {
    const localSha = commitLocalWork();
    const published = join(base, 'published');
    git(['clone', '--quiet', '--shared', laneDir, published]);
    git(['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--quiet', '--amend', '-m', 'integration patch'], published);
    expect(git(['rev-parse', 'HEAD'], published)).not.toBe(localSha);
    git(['push', '--quiet', origin, 'HEAD:refs/heads/main'], published);
    assertReleased(runPool(['release', `--lane=${lane}`]));
    expect(salvageBranches()).toEqual([]);
  });

  it('salvages before release --all-pools --session=salvage-holder drops the lease', () => {
    const sha = commitLocalWork();
    writeFileSync(join(origin, 'hooks', 'pre-receive'), `#!/bin/sh
test -f "$LANE_POOL_ROOT/releasesalvage/lane-1/.git/.lane-lease"
`, { mode: 0o755 });
    assertReleased(runPool(['release', '--all-pools']));
    expect(salvageBranches()).toEqual([[sha, expect.stringMatching(/^refs\/heads\/salvage\/lane-1-/)]]);
  });

  it('salvages each pool to its own canonical primary origin during a session sweep', () => {
    const sha = commitLocalWork();
    const otherOrigin = join(base, 'secondary.git');
    const otherReference = join(fixtureRoot, 'secondary');
    const otherPool = join(poolRoot, 'secondary');
    const otherLane = join(otherPool, 'lane-1');
    try {
      git(['init', '--quiet', '--bare', '--initial-branch=main', otherOrigin]);
      git(['clone', '--quiet', origin, otherReference]);
      git(['remote', 'set-url', 'origin', otherOrigin], otherReference);
      git(['push', '--quiet', 'origin', 'main'], otherReference);
      mkdirSync(otherPool);
      git(['clone', '--quiet', otherOrigin, otherLane]);
      writeFileSync(join(otherLane, 'secondary-work.txt'), 'secondary work\n');
      git(['add', '.'], otherLane);
      git(['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--quiet', '-m', 'secondary work'], otherLane);
      const otherSha = git(['rev-parse', 'HEAD'], otherLane);
      writeFileSync(join(otherLane, '.git', '.lane-lease'), readFileSync(join(laneDir, '.git', '.lane-lease')));
      // The lane's remote must not redirect a cross-pool salvage into the caller's repository.
      git(['remote', 'set-url', 'origin', origin], otherLane);
      expect(runPool(['release', '--all-pools']).released).toBe(2);
      expect(existsSync(join(otherLane, '.git', '.lane-lease'))).toBe(false);
      expect(salvageBranches()).toEqual([[sha, expect.stringMatching(/^refs\/heads\/salvage\/lane-1-/)]]);
      expect(git(['ls-remote', '--heads', otherOrigin, 'refs/heads/salvage/*'], reference))
        .toMatch(new RegExp(`^${otherSha}\\s+refs/heads/salvage/lane-1-`));
    } finally {
      rmSync(otherReference, { recursive: true, force: true });
    }
  });

  it('warns and still releases across pools when salvage is refused', () => {
    commitLocalWork();
    writeFileSync(join(origin, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    assertReleased(runPool(['release', '--all-pools'], {}, { stderr: /SALVAGE PUSH FAILED/ }));
    expect(salvageBranches()).toEqual([]);
  });

  it('keeps a replacement lease acquired during salvage in a session sweep', () => {
    const sha = commitLocalWork();
    const marker = join(laneDir, '.git', '.lane-lease');
    const replacement = { ...JSON.parse(readFileSync(marker, 'utf8')), session: 'new-holder', holder: 'new-holder' };
    writeFileSync(join(poolRoot, 'replacement-lease'), JSON.stringify(replacement));
    writeFileSync(join(origin, 'hooks', 'pre-receive'), `#!/bin/sh
cp "$LANE_POOL_ROOT/replacement-lease" "$LANE_POOL_ROOT/releasesalvage/lane-1/.git/.lane-lease"
`, { mode: 0o755 });
    expect(runPool(['release', '--all-pools']).released).toBe(0);
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual(replacement);
    expect(salvageBranches()).toEqual([[sha, expect.stringMatching(/^refs\/heads\/salvage\/lane-1-/)]]);
  });

  it.each([{ LANE_POOL_AUTO_RECOVER: '0' }, { LANE_POOL_NO_RECOVER: '1' }])('honours recovery opt-out on release across pools: %j', env => {
    commitLocalWork();
    assertReleased(runPool(['release', '--all-pools'], env));
    expect(salvageBranches()).toEqual([]);
  });
});
