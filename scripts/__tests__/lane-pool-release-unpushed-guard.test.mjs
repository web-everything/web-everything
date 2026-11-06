import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { sharedRepos, withGhStub } from './fixtures/shared-git-fixture.mjs';
import { readLaneJournal } from '../lib/lane-history.mjs';

const script = resolve(process.cwd(), 'scripts/lane-pool.mjs');
const git = (args, cwd) => execFileSync('git', args, {
  cwd, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024,
}).trim();
let fixtureRoot, fixture, origin, reference, base, poolRoot, laneDir, marker, lease;
function runPool(args, fault = '', remoteFault = '', extraEnv = {}) {
  // `remoteFault` runs for the canonical-origin listing (the only ls-remote here: recovery is off), which executes
  // in the primary checkout rather than the lane.
  const preload = `import os from 'node:os'; import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    os.userInfo = () => ({ homedir: ${JSON.stringify(base)} });
    const original = cp.execFileSync;
    cp.execFileSync = (cmd, args, opts) => {
      if (opts?.cwd === ${JSON.stringify(laneDir)}) { ${fault} }
      if (opts?.cwd !== ${JSON.stringify(laneDir)} && args.includes('ls-remote')) { ${remoteFault} }
      return original(cmd, args, opts);
    }; syncBuiltinESMExports();`;
  const result = spawnSync(process.execPath, [`--import=data:text/javascript,${encodeURIComponent(preload)}`,
    script, ...args, `--origin=${origin}`, `--reference=${reference}`, '--name=releaseguard',
    '--branch=main', '--no-install', '--session=guard-holder', '--json'], {
    encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024,
    env: withGhStub({ ...process.env, LANE_POOL_NO_RECOVER: '1', LANE_POOL_AUTO_RECOVER: '0',
      LANE_POOL_ROOT: poolRoot, WE_LANE_BACKUP_ROOT: join(base, 'backups'), ...extraEnv }),
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
  // The preservation command names the canonical origin the guard proves against, never the lane-writable `origin`.
  expect(result.stderr).toContain(`git -C ${laneDir} push ${origin} HEAD:refs/heads/`);
  expect(result.stderr).not.toContain(`git -C ${laneDir} push origin `);
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
  const release = (extra = [], fault = '', remoteFault = '', extraEnv = {}) => runPool(['release', selector, ...extra], fault, remoteFault, extraEnv);
  it('refuses an unpushed commit and keeps the exact lease, even with --force', () => {
    const sha = commitWork();
    refused(release(['--force']), sha);
    const branch = git(['symbolic-ref', '--short', 'HEAD'], laneDir);
    expect(release().stderr).toContain(`git -C ${laneDir} push ${origin} HEAD:refs/heads/${branch}`);
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
  // Callers that parse the JSON (the drain's release-on-land reads it from a non-zero exit's stdout) must see WHICH
  // lane was kept and why, and the refusal must leave a loud journal line, so a kept lease is never a silent ghost.
  it('reports the kept lane in --json and journals the refusal loud', () => {
    const sha = commitWork();
    const result = release();
    refused(result, sha);
    expect(result.data.kept).toEqual([expect.objectContaining({
      ...(selector === '--all-pools' ? { pool: 'releaseguard' } : {}), lane: 1, reason: 'unpushed-work',
      details: expect.stringContaining(sha.slice(0, 12)),
    })]);
    const journal = readLaneJournal(join(poolRoot, 'releaseguard')).filter(e => e.lane === 1 && e.action === 'release-refused');
    expect(journal).toEqual([expect.objectContaining({ loud: true, unpushed: true, reason: expect.stringContaining('UNPUSHED_WORK') })]);
    release();
    expect(readLaneJournal(join(poolRoot, 'releaseguard')).filter(e => e.lane === 1 && e.action === 'release-refused')).toHaveLength(1);
  });
  it('reports a clean release with an empty kept list', () => {
    commitWork();
    git(['push', '--quiet', 'origin', 'HEAD:refs/heads/work/preserved'], laneDir);
    const result = release();
    released(result);
    expect(result.data.kept).toEqual([]);
  });
  // The operator's primary commonly carries extra remotes; they must not break the canonical-origin proof.
  it('releases a pushed commit when the primary checkout also has an upstream remote', () => {
    git(['remote', 'add', 'upstream', join(base, 'upstream.git')], reference);
    commitWork();
    git(['push', '--quiet', 'origin', 'HEAD:refs/heads/work/preserved'], laneDir);
    released(release());
  });
  it('releases a pushed commit without requiring a particular upstream ref', () => {
    commitWork();
    git(['push', '--quiet', 'origin', 'HEAD:refs/heads/work/preserved'], laneDir);
    released(release());
  });
  it.each(['origin/ops/x', 'origin/HEAD', 'elsewhere/work'])('refuses a commit reachable only from a stale refs/remotes/%s ref', ref => {
    const sha = commitWork();
    git(['update-ref', '--no-deref', `refs/remotes/${ref}`, sha], laneDir);
    refused(release(), sha);
  });
  // Local remote-tracking refs are lane-writable and can be stale, so none of them counts as proof:
  // only what the canonical origin lists right now does.
  it.each(['stale origin/main', 'forged origin/fake', 'symbolic origin/alias'])('refuses a commit hidden behind a %s tracking ref', shape => {
    const sha = commitWork();
    if (shape === 'stale origin/main') git(['update-ref', 'refs/remotes/origin/main', sha], laneDir);
    if (shape === 'forged origin/fake') git(['update-ref', 'refs/remotes/origin/fake', sha], laneDir);
    if (shape === 'symbolic origin/alias') {
      git(['symbolic-ref', 'refs/remotes/origin/alias', `refs/heads/${git(['symbolic-ref', '--short', 'HEAD'], laneDir)}`], laneDir);
    }
    refused(release(), sha);
  });
  // A lane can rewrite what a listed origin sha "contains" instead of forging the sha itself.
  it.each(['replace ref', 'graft file'])('refuses a commit grafted under the origin tip by a lane %s', shape => {
    const main = git(['rev-parse', 'HEAD'], laneDir);
    const sha = commitWork();
    if (shape === 'replace ref') {
      const fake = git(['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit-tree', `${main}^{tree}`, '-p', main, '-p', sha, '-m', 'fake'], laneDir);
      git(['replace', main, fake], laneDir);
    } else {
      writeFileSync(join(laneDir, '.git', 'info', 'grafts'), `${main} ${sha}\n`);
    }
    git(['reset', '--quiet', '--hard', main], laneDir);
    git(['branch', 'work/hidden', sha], laneDir);
    refused(release(), sha);
  });
  // A lane-written commit-graph is trusted for parent links, so it can graft without a replace ref or graft file.
  it('refuses a commit grafted under the origin tip by a forged commit-graph', () => {
    const main = git(['rev-parse', 'HEAD'], laneDir);
    const sha = commitWork();
    git(['reset', '--quiet', '--hard', main], laneDir);
    git(['branch', 'work/hidden', sha], laneDir);
    git(['-c', 'commitGraph.generationVersion=1', 'commit-graph', 'write', '--reachable', '--no-progress'], laneDir);
    const file = join(laneDir, '.git', 'objects', 'info', 'commit-graph');
    const graph = readFileSync(file);
    const chunk = id => {
      for (let at = 8; at < 8 + 12 * graph[6]; at += 12) {
        if (graph.toString('latin1', at, at + 4) === id) return Number(graph.readBigUInt64BE(at + 4));
      }
      throw new Error(`no ${id} chunk`);
    };
    const oids = chunk('OIDL'), cdat = chunk('CDAT');
    const count = graph.readUInt32BE(chunk('OIDF') + 255 * 4);
    const index = oid => [...Array(count).keys()].find(i => graph.toString('hex', oids + 20 * i, oids + 20 * i + 20) === oid);
    const entry = cdat + 36 * index(main);
    const slot = graph.readUInt32BE(entry + 20) === 0x70000000 ? entry + 20 : entry + 24;
    graph.writeUInt32BE(index(sha), slot);
    chmodSync(file, 0o644); // git writes the graph read-only
    writeFileSync(file, graph);
    expect(git(['rev-list', 'work/hidden', '--not', main], laneDir)).toBe('');
    refused(release(), sha);
  });
  // A lane-written `.git/commondir` moves refs, objects and config to another repository; every evidence read
  // would then judge a decoy clone and never see the lane's own unpushed branch. The refusal must come before any
  // release work, which would otherwise scrub the other repository's config, and --discard must not override it.
  it.each(['without', 'with'])('refuses a lane whose .git/commondir redirects refs to a decoy repository, %s --discard', mode => {
    const extra = mode === 'with' ? ['--discard'] : [];
    const main = git(['rev-parse', 'HEAD'], laneDir);
    const sha = commitWork();
    git(['reset', '--quiet', '--hard', main], laneDir);
    git(['branch', 'work/hidden', sha], laneDir);
    const decoy = join(base, 'decoy');
    git(['clone', '--quiet', origin, decoy]);
    git(['config', 'credential.helper', 'decoy-helper'], decoy);
    writeFileSync(join(laneDir, '.git', 'commondir'), `${join(decoy, '.git')}\n`);
    expect(git(['branch', '--list', 'work/hidden'], laneDir)).toBe('');
    const result = release(extra);
    expect(result.status, result.stderr).toBe(1);
    expect(result.data.released).toBe(0);
    expect(result.data.kept).toEqual([expect.objectContaining({ lane: 1, reason: 'git-dir-redirected' })]);
    expect(result.stderr).toContain('commondir');
    expect(readFileSync(marker, 'utf8')).toBe(lease);
    expect(git(['config', '--get', 'credential.helper'], decoy)).toBe('decoy-helper');
    expect(git(['ls-remote', origin], reference)).not.toContain(sha);
  });
  // A symlinked `.git` keeps the lease readable but points every git call at whatever the link names.
  it.each(['without', 'with'])('refuses a symlinked .git before release work, %s --discard', mode => {
    const extra = mode === 'with' ? ['--discard'] : [];
    const moved = join(base, 'moved-git');
    renameSync(join(laneDir, '.git'), moved);
    symlinkSync(moved, join(laneDir, '.git'));
    git(['config', 'credential.helper', 'linked-helper'], laneDir);
    const result = release(extra);
    expect(result.status, result.stderr).toBe(1);
    expect(result.data.released).toBe(0);
    expect(result.data.kept).toEqual([expect.objectContaining({ lane: 1, reason: 'git-dir-redirected' })]);
    expect(result.stderr).toContain('not a directory');
    expect(readFileSync(marker, 'utf8')).toBe(lease);
    expect(git(['config', '--get', 'credential.helper'], laneDir)).toBe('linked-helper');
  });
  // With recovery ON, a release that ran its work before the redirect refusal would push the ahead commit it sees
  // (the decoy's, or the moved .git's) to the canonical origin as salvage/lane-1-*, and reap the lane's known litter.
  // Each shape gives salvage something to push and no transport config to stop it, so only the ordering keeps both off.
  const RECOVERY_ON = { LANE_POOL_NO_RECOVER: '0', LANE_POOL_AUTO_RECOVER: '1' };
  const salvageSeen = () => ({
    refs: git(['ls-remote', origin, 'refs/heads/salvage/*'], reference),
    record: existsSync(join(base, 'backups', 'lane-1-preserve', 'salvage-ref.txt')),
  });
  it.each(['commondir', 'symlinked .git'])('runs no salvage push and no litter cleanup for a %s-redirected lane with recovery on', shape => {
    let ahead;
    if (shape === 'commondir') {
      const decoy = join(base, 'decoy');
      git(['clone', '--quiet', origin, decoy]);
      writeFileSync(join(decoy, 'decoy.txt'), 'decoy work\n');
      git(['add', 'decoy.txt'], decoy);
      git(['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--quiet', '-m', 'decoy work'], decoy);
      ahead = git(['rev-parse', 'HEAD'], decoy);
      writeFileSync(join(laneDir, '.git', 'commondir'), `${join(decoy, '.git')}\n`);
    } else {
      ahead = commitWork();
      const moved = join(base, 'moved-git');
      renameSync(join(laneDir, '.git'), moved);
      symlinkSync(moved, join(laneDir, '.git'));
    }
    expect(git(['rev-list', 'origin/main..HEAD'], laneDir)).toBe(ahead);
    writeFileSync(join(laneDir, '.commit-msg.txt'), 'known litter\n');
    const result = release([], '', '', RECOVERY_ON);
    expect(result.status, result.stderr).toBe(1);
    expect(result.data.released).toBe(0);
    expect(result.data.kept).toEqual([expect.objectContaining({ lane: 1, reason: 'git-dir-redirected' })]);
    expect(result.stderr).not.toContain('salvaged to');
    expect(salvageSeen()).toEqual({ refs: '', record: false });
    expect(git(['ls-remote', origin], reference)).not.toContain(ahead);
    expect(readFileSync(join(laneDir, '.commit-msg.txt'), 'utf8')).toBe('known litter\n');
    expect(readFileSync(marker, 'utf8')).toBe(lease);
  });
  // Control for the spy above: the same recovery-on release of an un-redirected lane does salvage and reap litter.
  it('salvage-pushes and reaps litter for an un-redirected lane with recovery on (spy control)', () => {
    const sha = commitWork();
    writeFileSync(join(laneDir, '.commit-msg.txt'), 'known litter\n');
    const result = release([], '', '', RECOVERY_ON);
    released(result);
    expect(salvageSeen()).toEqual({ refs: expect.stringContaining(sha), record: true });
    expect(existsSync(join(laneDir, '.commit-msg.txt'))).toBe(false);
  });
  it.each(['with its reflog', 'with an expired reflog'])('refuses tracked work parked in a stash %s', shape => {
    writeFileSync(join(laneDir, 'seed.txt'), 'stashed edit\n');
    git(['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'stash', '--quiet'], laneDir);
    if (shape === 'with an expired reflog') git(['reflog', 'expire', '--expire=now', 'refs/stash'], laneDir);
    expect(git(['status', '--porcelain', '--untracked-files=no'], laneDir)).toBe('');
    refused(release(), git(['rev-parse', 'refs/stash'], laneDir));
  });
  // `refs/stash` names only the newest entry; each older entry is a sibling commit off HEAD that only the stash reflog
  // reaches. With the newest entry preserved on the origin, the older one is the sole unpushed work and must refuse.
  it('refuses an older stash entry reachable only through the stash reflog', () => {
    const stash = text => {
      writeFileSync(join(laneDir, 'seed.txt'), text);
      git(['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'stash', '--quiet'], laneDir);
      return git(['rev-parse', 'refs/stash'], laneDir);
    };
    const older = stash('older stashed edit\n');
    const newer = stash('newer stashed edit\n');
    expect(spawnSync('git', ['merge-base', '--is-ancestor', older, newer], { cwd: laneDir }).status).toBe(1);
    expect(git(['rev-parse', 'stash@{1}'], laneDir)).toBe(older);
    git(['push', '--quiet', origin, `${newer}:refs/heads/preserved-newer-stash`], laneDir);
    const result = release();
    refused(result, older);
    expect(result.stderr).not.toContain(newer.slice(0, 12));
    expect(git(['stash', 'list', '--format=%H'], laneDir).split('\n')).toEqual([newer, older]);
  });
  it('releases a lane whose HEAD is behind an origin tip it has not fetched yet', () => {
    const other = join(base, 'other');
    git(['clone', '--quiet', origin, other]);
    writeFileSync(join(other, 'later.txt'), 'later\n');
    git(['add', 'later.txt'], other);
    git(['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--quiet', '-m', 'later'], other);
    git(['push', '--quiet', 'origin', 'HEAD:main'], other);
    released(release());
  });
  // PR #6319 send-back (R639): the verification fetch must never write through a lane-controlled ref. A symbolic
  // origin/main aimed at an unpushed branch would otherwise be reset to the pushed tip, erasing the work it guards.
  it.each(['origin/main', 'origin/HEAD'])('refuses, and keeps the branch, when refs/remotes/%s is a symbolic ref to unpushed work', ref => {
    const pushed = git(['rev-parse', 'HEAD'], laneDir);
    const sha = commitWork();
    git(['branch', 'work/keep', sha], laneDir);
    git(['reset', '--quiet', '--hard', pushed], laneDir);
    git(['symbolic-ref', `refs/remotes/${ref}`, 'refs/heads/work/keep'], laneDir);
    const result = release();
    expect(git(['rev-parse', 'refs/heads/work/keep'], laneDir)).toBe(sha);
    refused(result, sha);
    expect(result.stderr).toContain(`refs/remotes/${ref}`);
  });
  // The recovery-on salvage fetches origin heads into refs/remotes/origin/* BEFORE the guard runs: it must refuse the
  // same symbolic ref (salvage fails closed) so the guard still sees, and keeps, the unpushed branch.
  it('with recovery on, the salvage fetch refuses a symbolic origin/main and the branch is kept', () => {
    const pushed = git(['rev-parse', 'HEAD'], laneDir);
    const sha = commitWork();
    git(['branch', 'work/keep', sha], laneDir);
    git(['reset', '--quiet', '--hard', pushed], laneDir);
    writeFileSync(join(laneDir, 'other.txt'), 'head work\n');
    git(['add', 'other.txt'], laneDir);
    git(['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--quiet', '-m', 'head work'], laneDir);
    git(['symbolic-ref', 'refs/remotes/origin/main', 'refs/heads/work/keep'], laneDir);
    const result = release([], '', '', RECOVERY_ON);
    expect(git(['rev-parse', 'refs/heads/work/keep'], laneDir)).toBe(sha);
    expect(result.stderr).toMatch(/SALVAGE PUSH FAILED: .*refs\/remotes\/origin\/main is a symbolic ref to refs\/heads\/work\/keep/);
    refused(result, sha);
    expect(salvageSeen()).toEqual({ refs: '', record: false });
  });
  // A filesystem symlink redirects the same fetch writes without showing as a symbolic ref (PR #6319 self-review):
  // `refs/remotes/origin -> ../heads` made the pruning salvage fetch reset main and delete work/keep, and a symlinked
  // `refs/release-verify` sent the verify fetch's writes into another repository.
  it.each([
    ['refs/remotes/origin', false], ['refs/remotes/origin', true], ['refs/release-verify', false], ['logs/refs/remotes/origin', false],
  ])('refuses, and keeps every branch, when .git/%s is a filesystem symlink (recovery on: %s)', (link, recovery) => {
    const pushed = git(['rev-parse', 'HEAD'], laneDir);
    const sha = commitWork();
    git(['branch', 'work/keep', sha], laneDir);
    git(['reset', '--quiet', '--hard', pushed], laneDir);
    if (recovery) {
      // HEAD on its own branch, ahead of origin/main, so the salvage reaches its fetch.
      git(['switch', '--quiet', '-c', 'feature'], laneDir);
      writeFileSync(join(laneDir, 'other.txt'), 'head work\n');
      git(['add', 'other.txt'], laneDir);
      git(['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--quiet', '-m', 'head work'], laneDir);
    }
    const heads = git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/'], laneDir);
    const decoy = join(base, 'decoy');
    git(['init', '--quiet', decoy]);
    const target = link === 'refs/release-verify' ? join(decoy, '.git', 'refs', 'heads') : link.startsWith('logs/')
      ? join(decoy, '.git', 'logs-target') : '../heads';
    mkdirSync(join(laneDir, '.git', link, '..'), { recursive: true });
    if (existsSync(join(laneDir, '.git', link))) renameSync(join(laneDir, '.git', link), join(base, 'moved-aside'));
    if (link.startsWith('logs/')) mkdirSync(target, { recursive: true });
    symlinkSync(target, join(laneDir, '.git', link));
    const result = release([], '', '', recovery ? RECOVERY_ON : {});
    expect(git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/'], laneDir)).toBe(heads);
    expect(result.stderr).toContain(`${link} is a filesystem symlink`);
    if (recovery) expect(result.stderr).toMatch(/SALVAGE PUSH FAILED: .*filesystem symlink/);
    refused(result, sha);
    expect(git(['for-each-ref', '--format=%(refname)'], decoy)).toBe('');
  });
  // Defense in depth: whatever the fetch does, a local branch or stash that moved during it refuses the release.
  it('refuses when a local branch moves during the verification fetch', () => {
    const pushed = git(['rev-parse', 'HEAD'], laneDir);
    const sha = commitWork();
    git(['branch', 'work/keep', sha], laneDir);
    git(['reset', '--quiet', '--hard', pushed], laneDir);
    const fault = `if (args.includes('fetch')) { const out = original(cmd, args, opts);
      original('git', ['update-ref', 'refs/heads/work/keep', ${JSON.stringify(pushed)}], { cwd: opts.cwd }); return out; }`;
    const result = release([], fault);
    expect(result.status, result.stderr).toBe(1);
    expect(result.data.released).toBe(0);
    expect(result.stderr).toContain('refs/heads/work/keep changed during the verification fetch');
    expect(readFileSync(marker, 'utf8')).toBe(lease);
  });
  it('verification fetch writes no ref and no FETCH_HEAD in the lane', () => {
    const other = join(base, 'other');
    git(['clone', '--quiet', origin, other]);
    writeFileSync(join(other, 'later.txt'), 'later\n');
    git(['add', 'later.txt'], other);
    git(['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--quiet', '-m', 'later'], other);
    git(['push', '--quiet', 'origin', 'HEAD:main'], other);
    const sha = commitWork();
    rmSync(join(laneDir, '.git', 'FETCH_HEAD'), { force: true });
    const refsBefore = git(['for-each-ref', '--format=%(refname) %(objectname)'], laneDir);
    refused(release(), sha);
    expect(git(['for-each-ref', '--format=%(refname) %(objectname)'], laneDir)).toBe(refsBefore);
    expect(existsSync(join(laneDir, '.git', 'FETCH_HEAD'))).toBe(false);
  });
  it.each(['unreadable', 'malformed', 'oversized'])('fails closed on a %s canonical origin listing', failure => {
    const remoteFault = failure === 'malformed' ? "return 'not-a-sha\\trefs/heads/main\\n';"
      : `const error = new Error('forced listing failure'); error.code = ${JSON.stringify(failure === 'oversized' ? 'ENOBUFS' : 'EIO')}; throw error;`;
    const result = release([], '', remoteFault);
    refused(result);
    expect(result.stderr).toContain('canonical origin');
    const override = release(['--discard'], '', remoteFault);
    released(override);
    expect(override.stderr).toMatch(/WARNING.*--discard.*canonical origin/);
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
  // `git status` trusts index flags and submodule-ignore config, so a plain porcelain read can report clean
  // over a real tracked edit. Each shape below must still refuse.
  it.each(['assume-unchanged edit', 'assume-unchanged deletion', 'assume-unchanged mode change', 'assume-unchanged mode drop',
    'skip-worktree edit', 'skip-worktree deletion', 'skip-worktree mode change', 'skip-worktree mode drop'])('refuses a tracked %s hidden by index flags', shape => {
    const file = join(laneDir, 'seed.txt');
    if (shape.endsWith('mode drop')) {
      // Index mode 100755 on a pushed commit, so only the hidden chmod back to 644 is unpreserved.
      chmodSync(file, 0o755);
      git(['add', 'seed.txt'], laneDir);
      git(['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--quiet', '-m', 'executable'], laneDir);
      git(['push', '--quiet', 'origin', 'HEAD:refs/heads/work/exec'], laneDir);
    }
    git(['update-index', shape.startsWith('assume') ? '--assume-unchanged' : '--skip-worktree', 'seed.txt'], laneDir);
    if (shape.endsWith('deletion')) rmSync(file);
    // An executable-bit flip keeps the blob sha, so a content compare alone reads it as clean.
    else if (shape.endsWith('mode change')) chmodSync(file, 0o755);
    else if (shape.endsWith('mode drop')) chmodSync(file, 0o644);
    else writeFileSync(file, 'hidden edit\n');
    expect(git(['status', '--porcelain', '--untracked-files=no'], laneDir)).toBe('');
    const result = release();
    refused(result);
    expect(result.stderr).toContain('seed.txt');
    if (/mode (?:change|drop)$/.test(shape)) expect(result.stderr).toContain('seed.txt (hidden by index flags: mode changed)');
  });
  it('refuses a same-size edit with a restored mtime that lane stat config would hide', () => {
    const file = join(laneDir, 'seed.txt');
    // Age the file and refresh the index first, so the entry is not "racy" (git would rehash a racy entry anyway).
    const past = new Date(Date.now() - 3600_000);
    utimesSync(file, past, past);
    git(['update-index', '--refresh'], laneDir);
    // Cross a second boundary so the edit's ctime differs at git's (seconds) stat resolution.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);
    writeFileSync(file, 'SEED\n');
    utimesSync(file, past, past);
    git(['config', 'core.checkStat', 'minimal'], laneDir);
    git(['config', 'core.trustctime', 'false'], laneDir);
    // Read-only status: a refreshing status would write the new stat into the index and hide the edit by itself.
    expect(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
      cwd: laneDir, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    }).trim()).toBe('');
    const result = release();
    refused(result);
    expect(result.stderr).toContain('seed.txt');
  });
  // Lane config that changes what status reports is refused outright, whatever the worktree holds.
  it.each(['core.fileMode', 'core.worktree'])('refuses a tracked change hidden by lane %s config', key => {
    if (key === 'core.fileMode') {
      chmodSync(join(laneDir, 'seed.txt'), 0o755);
      git(['config', 'core.fileMode', 'false'], laneDir);
    } else {
      const decoy = join(base, 'decoy');
      git(['clone', '--quiet', origin, decoy]);
      writeFileSync(join(laneDir, 'seed.txt'), 'edit behind a redirect\n');
      git(['config', 'core.worktree', decoy], laneDir);
    }
    expect(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
      cwd: laneDir, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    }).trim()).toBe('');
    const result = release();
    refused(result);
    expect(result.stderr).toContain(`lane config ${key.toLowerCase()}`);
  });
  it.each(['diff.ignoreSubmodules', 'submodule.sub.ignore', '.gitmodules ignore'])('refuses a submodule change hidden by %s', shape => {
    const sub = join(laneDir, 'sub');
    git(['init', '--quiet', sub]);
    const commitSub = message => git(['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--quiet', '--allow-empty', '-m', message], sub);
    commitSub('one');
    writeFileSync(join(laneDir, '.gitmodules'),
      `[submodule "sub"]\n\tpath = sub\n\turl = ./sub\n${shape === '.gitmodules ignore' ? '\tignore = all\n' : ''}`);
    git(['add', 'sub', '.gitmodules'], laneDir);
    git(['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--quiet', '-m', 'add gitlink'], laneDir);
    git(['push', '--quiet', 'origin', 'HEAD:refs/heads/work/gitlink'], laneDir);
    commitSub('two');
    if (shape === 'diff.ignoreSubmodules') git(['config', 'diff.ignoreSubmodules', 'all'], laneDir);
    if (shape === 'submodule.sub.ignore') git(['config', 'submodule.sub.ignore', 'all'], laneDir);
    expect(git(['status', '--porcelain', '--untracked-files=no'], laneDir)).toBe('');
    const result = release();
    refused(result);
    expect(result.stderr).toContain('sub');
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
    expect(result.stderr).toContain(`git -C ${laneDir} push ${origin} HEAD:refs/heads/lane/lane-1-preserve`);
  });
  it('names the canonical origin in the preservation command even when the lane origin points elsewhere', () => {
    const sha = commitWork();
    const decoy = join(base, 'decoy.git');
    git(['init', '--quiet', '--bare', decoy]);
    git(['remote', 'set-url', 'origin', decoy], laneDir);
    const result = release();
    refused(result, sha);
    expect(result.stderr).not.toContain(`push ${decoy}`);
  });
  // Inherited git config env (command scope) outranks the lane's own config and, for GIT_CONFIG_PARAMETERS, even the
  // indexed honest-reporting pins. Every release evidence read must drop it before installing its pins.
  it.each([
    ['GIT_CONFIG_PARAMETERS', { GIT_CONFIG_PARAMETERS: "'core.fileMode'='false'" }],
    ['GIT_CONFIG_COUNT/KEY/VALUE', { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fileMode', GIT_CONFIG_VALUE_0: 'false' }],
  ])('refuses a pushed lane whose chmod is hidden by inherited %s', (_, env) => {
    commitWork();
    git(['push', '--quiet', 'origin', 'HEAD:refs/heads/work/preserved'], laneDir);
    chmodSync(join(laneDir, 'seed.txt'), 0o755);
    expect(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
      cwd: laneDir, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...env },
    }).trim()).toBe('');
    const result = release([], '', '', env);
    refused(result);
    expect(result.stderr).toContain('seed.txt');
  });
  it('refuses on a failed origin fetch rather than trusting unfetched origin tips', () => {
    const other = join(base, 'other');
    git(['clone', '--quiet', origin, other]);
    writeFileSync(join(other, 'later.txt'), 'later\n');
    git(['add', 'later.txt'], other);
    git(['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--quiet', '-m', 'later'], other);
    git(['push', '--quiet', 'origin', 'HEAD:main'], other);
    const fault = "if (args.includes('fetch')) { const error = new Error('forced fetch failure'); error.code = 'EIO'; throw error; }";
    const result = release([], fault);
    refused(result, git(['rev-parse', 'HEAD'], laneDir));
    expect(result.stderr).toContain('unpushed commits');
  });
  // Links and gitlinks are never content-compared: a flagged one is reported, not trusted, even when unchanged.
  it.each(['symlink', 'gitlink'])('refuses a flagged %s entry without content-comparing it', shape => {
    const name = shape === 'symlink' ? 'link' : 'sub';
    if (shape === 'symlink') symlinkSync('seed.txt', join(laneDir, name));
    else {
      git(['init', '--quiet', join(laneDir, name)]);
      git(['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--quiet', '--allow-empty', '-m', 'one'], join(laneDir, name));
    }
    git(['add', name], laneDir);
    git(['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--quiet', '-m', `add ${shape}`], laneDir);
    git(['push', '--quiet', 'origin', `HEAD:refs/heads/work/${shape}`], laneDir);
    git(['update-index', '--assume-unchanged', name], laneDir);
    const result = release();
    refused(result);
    expect(result.stderr).toContain(`${name} (hidden by index flags)`);
  });
  it('proves against the canonical origin even when the lane has no remote-tracking refs', () => {
    git(['remote', 'remove', 'origin'], laneDir);
    released(release());
  });
  it('refuses an unpushed commit when the lane has no remote-tracking refs', () => {
    const sha = commitWork();
    git(['remote', 'remove', 'origin'], laneDir);
    refused(release(), sha);
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

// Single-lane only: the bound is per lane, and the fixture is heavy enough not to repeat for --all-pools.
describe('release guard hidden-entry hash bound', () => {
  const HIDDEN_ENTRY_HASH_LIMIT = 1000; // scripts/lane-pool.mjs
  // Zero-padded names keep this array in `git ls-files` order, so "first" and "last" are the first and last entries
  // the guard hashes. Only the first `flagged` files get assume-unchanged; the rest stay plain tracked files.
  const release = (extra = []) => runPool(['release', '--lane=1', ...extra]);
  const flagFiles = flagged => {
    const files = Array.from({ length: HIDDEN_ENTRY_HASH_LIMIT + 1 }, (_, i) => `many/f${String(i).padStart(4, '0')}.txt`);
    mkdirSync(join(laneDir, 'many'));
    for (const file of files) writeFileSync(join(laneDir, file), `${file}\n`);
    git(['add', 'many'], laneDir);
    git(['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--quiet', '-m', 'many'], laneDir);
    git(['push', '--quiet', 'origin', 'HEAD:refs/heads/work/many'], laneDir);
    git(['update-index', '--assume-unchanged', ...files.slice(0, flagged)], laneDir);
    expect(git(['ls-files', '-v', 'many'], laneDir).split('\n').filter(line => line.startsWith('h ')).length).toBe(flagged);
    return files;
  };
  // Exactly LIMIT flagged entries are all content-compared: a same-mode content edit to ONLY the last (then ONLY the
  // first) one refuses by name, never as the over-limit fallback, and the restored lane then releases clean.
  it('compares every one of exactly LIMIT flagged entries: tampering only the last, then only the first, refuses', () => {
    const files = flagFiles(HIDDEN_ENTRY_HASH_LIMIT);
    for (const file of [files[HIDDEN_ENTRY_HASH_LIMIT - 1], files[0]]) {
      writeFileSync(join(laneDir, file), 'tampered\n');
      expect(git(['status', '--porcelain', '--untracked-files=no'], laneDir)).toBe('');
      const result = release();
      refused(result);
      expect(result.stderr).toContain(`${file} (hidden by index flags: modified)`);
      expect(result.stderr).not.toContain('exceeds');
      writeFileSync(join(laneDir, file), `${file}\n`);
    }
    released(release());
  });
  // LIMIT+1 flagged entries are not hashed at all: the guard fails closed as unreadable/oversized evidence, and
  // --discard is the documented operator fallback.
  it('fails closed with LIMIT+1 flagged entries, with --discard as the fallback', () => {
    flagFiles(HIDDEN_ENTRY_HASH_LIMIT + 1);
    const result = release();
    refused(result);
    expect(result.stderr).toContain('tracked status unreadable or exceeds');
    const override = release(['--discard']);
    released(override);
    expect(override.stderr).toMatch(/WARNING.*--discard.*tracked status unreadable or exceeds/);
  });
});
