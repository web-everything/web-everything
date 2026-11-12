import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { sharedRepos, withGhStub } from './fixtures/shared-git-fixture.mjs';
import { readLaneJournal } from '../lib/lane-history.mjs';
import { laneGitConfigArgs, laneGitHardeningEnv, scrubGitRepoEnv } from '../lib/lane-git-hardening.mjs';
import { NO_REPO_CWD } from '../lib/lane-pool-salvage-push.mjs';

const script = resolve(process.cwd(), 'scripts/lane-pool.mjs');
const git = (args, cwd) => execFileSync('git', args, {
  cwd, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024,
}).trim();
let fixtureRoot, fixture, origin, reference, base, poolRoot, laneDir, marker, lease;
function runPool(args, fault = '', remoteFault = '', extraEnv = {}) {
  // `remoteFault` runs for the canonical-origin listing (the only ls-remote here: recovery is off), which executes
  // outside the lane (checked against the primary checkout, run outside any repository). `fs` lets a fault record calls.
  const preload = `import os from 'node:os'; import cp from 'node:child_process'; import fs from 'node:fs';
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
  // A failed canonical-origin listing's message carries the origin URL (execFileSync puts argv in it). With a
  // credentialed origin, the secret must reach none of stderr, the journal or `--json`.
  it('never echoes origin URL credentials from a failed listing into stderr, the journal or --json', () => {
    const sha = commitWork();
    const url = 'https://user:S3CRET-TOKEN@127.0.0.1:9/origin.git';
    const remoteFault = `const error = new Error(${JSON.stringify(`Command failed: git ls-remote ${url} refs/heads/*`)});
      error.stderr = ${JSON.stringify(`fatal: unable to access '${url}/': Failed to connect`)}; throw error;`;
    const result = release([], '', remoteFault);
    refused(result, sha);
    expect(result.stderr).toContain('https://127.0.0.1:9/origin.git');
    const journal = JSON.stringify(readLaneJournal(join(poolRoot, 'releaseguard')).filter(e => e.lane === 1));
    expect(journal).toContain('https://127.0.0.1:9/origin.git');
    for (const text of [result.stderr, result.stdout, journal]) expect(text).not.toContain('S3CRET-TOKEN');
  });
  // A lane config key can itself embed a credentialed URL; release scrubs it and must report it redacted.
  it('scrubs a credentialed url.<base>.insteadOf key and never echoes its token', () => {
    git(['config', 'url.https://oauth2:S3CRET-TOKEN@gitlab.example/.insteadOf', 'https://gitlab.example/'], laneDir);
    const result = release();
    released(result);
    expect(git(['config', '--local', '--list'], laneDir)).not.toContain('S3CRET-TOKEN');
    const journal = JSON.stringify(readLaneJournal(join(poolRoot, 'releaseguard')).filter(e => e.lane === 1 && e.action === 'config-scrub'));
    expect(journal).toContain('url.https://gitlab.example/.insteadof');
    for (const text of [result.stderr, result.stdout, journal]) expect(text).not.toContain('S3CRET-TOKEN');
  });
  // `--ignore-missing` (for unfetched origin tips) must not drop a LOCAL tip: a branch whose commit object the lane
  // deleted proves nothing, so the guard fails closed instead of releasing.
  it('fails closed when a local branch tip has no object', () => {
    const pushed = git(['rev-parse', 'HEAD'], laneDir);
    const sha = commitWork();
    git(['update-ref', 'refs/heads/work/gone', sha], laneDir);
    git(['reset', '--quiet', '--hard', pushed], laneDir);
    rmSync(join(laneDir, '.git', 'objects', sha.slice(0, 2), sha.slice(2)));
    expect(git(['for-each-ref', '--format=%(objectname)', 'refs/heads/work/gone'], laneDir)).toBe(sha);
    const result = release();
    refused(result);
    expect(result.stderr).toContain('commit evidence unreadable');
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
  // Stale stash entries must not pin a lane: with recovery on, release bundles every stash entry into the backup root
  // (verified) and proceeds, while a genuine unpushed branch commit still refuses.
  it('with recovery on, salvages stash entries to a bundle and releases', () => {
    const stash = text => {
      writeFileSync(join(laneDir, 'seed.txt'), text);
      git(['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'stash', '--quiet'], laneDir);
      return git(['rev-parse', 'refs/stash'], laneDir);
    };
    const older = stash('older stashed edit\n');
    const newer = stash('newer stashed edit\n');
    const result = release([], '', '', RECOVERY_ON);
    released(result);
    const dir = join(base, 'backups', 'lane-1-preserve');
    const record = readFileSync(join(dir, 'stash-bundles.txt'), 'utf8');
    expect(record).toContain(older);
    expect(record).toContain(newer);
    const bundle = record.split('\n')[0].split(' ')[1];
    expect(spawnSync('git', ['bundle', 'verify', join(dir, bundle)], { cwd: laneDir }).status).toBe(0);
    expect(git(['stash', 'list', '--format=%H'], laneDir).split('\n')).toEqual([newer, older]);
  });
  it.each(['truncated header', 'truncated pack', 'replaced bundle', 'deleted bundle'])(
    'with recovery on, refuses a recorded stash backup with a %s', damage => {
      writeFileSync(join(laneDir, 'seed.txt'), 'cached stashed edit\n');
      git(['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'stash', '--quiet'], laneDir);
      const sha = git(['rev-parse', 'refs/stash'], laneDir);
      const dir = join(base, 'backups', 'lane-1-preserve');
      mkdirSync(dir, { recursive: true });
      const bundle = join(dir, 'cached.bundle');
      git(['bundle', 'create', bundle, 'refs/stash'], laneDir);
      const record = `${sha} cached.bundle\n`;
      writeFileSync(join(dir, 'stash-bundles.txt'), record);
      if (damage === 'truncated header') writeFileSync(bundle, 'truncated');
      if (damage === 'truncated pack') {
        const content = readFileSync(bundle);
        writeFileSync(bundle, content.subarray(0, content.length - 20));
        // Header verification alone accepts this; the pack must actually be imported into an empty repository.
        expect(spawnSync('git', ['bundle', 'verify', bundle], { cwd: laneDir }).status).toBe(0);
      }
      if (damage === 'replaced bundle') {
        git(['bundle', 'create', bundle, 'HEAD'], laneDir);
        expect(spawnSync('git', ['bundle', 'verify', bundle], { cwd: laneDir }).status).toBe(0);
      }
      if (damage === 'deleted bundle') rmSync(bundle);
      refused(release([], '', '', RECOVERY_ON), sha);
      expect(readFileSync(join(dir, 'stash-bundles.txt'), 'utf8')).toBe(record);
      expect(git(['rev-parse', 'refs/stash'], laneDir)).toBe(sha);
    },
  );
  it('with recovery on, revalidates and reuses a recorded stash bundle without recreating it', () => {
    writeFileSync(join(laneDir, 'seed.txt'), 'cached stashed edit\n');
    git(['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'stash', '--quiet'], laneDir);
    released(release([], '', '', RECOVERY_ON));
    expect(runPool(['acquire', '--lane=1', '--no-reset']).status).toBe(0);
    const fault = `if (args[0] === 'bundle' && args[1] === 'create') throw new Error('unexpected rebundle');`;
    released(release([], fault, '', RECOVERY_ON));
  });
  const stashText = text => {
    writeFileSync(join(laneDir, 'seed.txt'), text);
    git(['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'stash', '--quiet'], laneDir);
    return git(['rev-parse', 'refs/stash'], laneDir);
  };
  const strayStashRefs = () => git(['for-each-ref', '--format=%(refname)', 'refs/release-stash'], laneDir);
  // The index of bundled stashes is append-only evidence: a later release must never drop the lines of earlier
  // bundles whose stash entries were since dropped.
  it('with recovery on, keeps the index lines of earlier bundles when later stashes are bundled', () => {
    const first = stashText('first stashed edit\n');
    released(release([], '', '', RECOVERY_ON));
    const recordFile = join(base, 'backups', 'lane-1-preserve', 'stash-bundles.txt');
    const firstLine = readFileSync(recordFile, 'utf8').trim();
    expect(firstLine.startsWith(`${first} `)).toBe(true);
    expect(runPool(['acquire', '--lane=1', '--no-reset']).status).toBe(0);
    git(['stash', 'drop', '--quiet'], laneDir);
    const second = stashText('second stashed edit\n');
    released(release([], '', '', RECOVERY_ON));
    const lines = readFileSync(recordFile, 'utf8').trim().split('\n');
    expect(lines[0]).toBe(firstLine);
    expect(lines).toHaveLength(2);
    expect(lines[1].startsWith(`${second} `)).toBe(true);
    expect(existsSync(join(base, 'backups', 'lane-1-preserve', firstLine.split(' ')[1]))).toBe(true);
    // The record is appended in place, so no temp file is left behind.
    expect(readdirSync(join(base, 'backups', 'lane-1-preserve')).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });
  it('with recovery on, closes a torn final index line instead of merging the new line into it', () => {
    const dir = join(base, 'backups', 'lane-1-preserve');
    mkdirSync(dir, { recursive: true });
    const torn = `${'a'.repeat(40)} old-stash.bund`;
    writeFileSync(join(dir, 'stash-bundles.txt'), torn);
    const sha = stashText('fresh stashed edit\n');
    released(release([], '', '', RECOVERY_ON));
    const lines = readFileSync(join(dir, 'stash-bundles.txt'), 'utf8').split('\n');
    expect(lines[0]).toBe(torn);
    expect(lines[1].startsWith(`${sha} stash-`)).toBe(true);
  });
  // Fail closed: a stash that cannot be bundled and verified stays unproven, the lane keeps refusing, nothing is
  // recorded, and the temporary refs are removed even on the failure path.
  it.each([
    ['update-ref fails', `if (args.includes('update-ref') && args.includes('--no-deref') && !args.includes('-d')) throw new Error('injected update-ref failure');`],
    ['bundle create fails', `if (args.includes('bundle') && args.includes('create')) throw new Error('injected bundle failure');`],
    ['bundle create writes a corrupt file', `if (args.includes('bundle') && args.includes('create')) { fs.writeFileSync(args[args.indexOf('create') + 1], 'garbage'); return ''; }`],
  ])('with recovery on, refuses and records nothing when %s', (_name, fault) => {
    const sha = stashText('unbundlable stashed edit\n');
    refused(release([], fault, '', RECOVERY_ON), sha);
    expect(existsSync(join(base, 'backups', 'lane-1-preserve', 'stash-bundles.txt'))).toBe(false);
    expect(git(['rev-parse', 'refs/stash'], laneDir)).toBe(sha);
    expect(strayStashRefs()).toBe('');
  });
  it('with recovery on, uses a fresh temporary ref namespace per release and leaves none behind', () => {
    const log = join(base, 'update-refs.log');
    const fault = `if (args.includes('update-ref') && !args.includes('-d')) fs.appendFileSync(${JSON.stringify(log)}, args.join(' ') + '\\n');`;
    stashText('first stashed edit\n');
    released(release([], fault, '', RECOVERY_ON));
    expect(strayStashRefs()).toBe('');
    expect(runPool(['acquire', '--lane=1', '--no-reset']).status).toBe(0);
    stashText('second stashed edit\n');
    released(release([], fault, '', RECOVERY_ON));
    expect(strayStashRefs()).toBe('');
    const namespaces = readFileSync(log, 'utf8').split('\n').map(line => /refs\/release-stash\/([^/\s]+)\//.exec(line)?.[1]).filter(Boolean);
    expect(new Set(namespaces).size).toBe(2);
  });
  // `bundle verify` and `unbundle` accept a bundle holding only the stash commit objects; the reachability walk
  // (rev-list --objects) is what rejects one whose parents/trees/blobs are missing.
  it('with recovery on, refuses a recorded stash bundle that holds the commit but not its history', () => {
    const sha = stashText('cached stashed edit\n');
    const dir = join(base, 'backups', 'lane-1-preserve');
    mkdirSync(dir, { recursive: true });
    const pack = spawnSync('git', ['pack-objects', '--stdout', '-q'], { cwd: laneDir, input: `${sha}\n` });
    expect(pack.status).toBe(0);
    writeFileSync(join(dir, 'partial.bundle'), Buffer.concat([Buffer.from(`# v2 git bundle\n${sha} refs/stash\n\n`), pack.stdout]));
    const record = `${sha} partial.bundle\n`;
    writeFileSync(join(dir, 'stash-bundles.txt'), record);
    const probe = join(base, 'probe.git');
    git(['init', '--quiet', '--bare', probe]);
    expect(spawnSync('git', ['bundle', 'unbundle', join(dir, 'partial.bundle')], { cwd: probe }).status).toBe(0);
    expect(spawnSync('git', ['rev-list', '--objects', '--quiet', sha], { cwd: probe }).status).not.toBe(0);
    refused(release([], '', '', RECOVERY_ON), sha);
    expect(readFileSync(join(dir, 'stash-bundles.txt'), 'utf8')).toBe(record);
  });
  // Builds a hand-made bundle of the stash commit and all its reachable objects (optionally minus blobs, optionally
  // plus extra loose objects), records it, and returns what a probe repository sees of it.
  const handMadeBundle = (sha, { skipBlobs = false, extra = [] } = {}) => {
    const dir = join(base, 'backups', 'lane-1-preserve');
    mkdirSync(dir, { recursive: true });
    const objects = git(['rev-list', '--objects', sha], laneDir).split('\n').map(line => line.split(' ')[0]);
    const types = spawnSync('git', ['cat-file', '--batch-check=%(objectname) %(objecttype)'], { cwd: laneDir, encoding: 'utf8', input: `${objects.join('\n')}\n` })
      .stdout.trim().split('\n');
    const kept = types.filter(line => !(skipBlobs && line.endsWith(' blob'))).map(line => line.split(' ')[0]);
    if (skipBlobs) expect(kept.length).toBeLessThan(objects.length);
    const pack = spawnSync('git', ['pack-objects', '--stdout', '-q'], { cwd: laneDir, input: `${[...kept, ...extra].join('\n')}\n` });
    expect(pack.status).toBe(0);
    writeFileSync(join(dir, 'hand.bundle'), Buffer.concat([Buffer.from(`# v2 git bundle\n${sha} refs/stash\n\n`), pack.stdout]));
    const record = `${sha} hand.bundle\n`;
    writeFileSync(join(dir, 'stash-bundles.txt'), record);
    const probe = join(base, 'probe.git');
    git(['init', '--quiet', '--bare', probe]);
    const run = args => spawnSync('git', args, { cwd: probe, encoding: 'utf8' });
    expect(run(['bundle', 'verify', join(dir, 'hand.bundle')]).status).toBe(0);
    expect(run(['bundle', 'unbundle', join(dir, 'hand.bundle')]).status).toBe(0);
    return { dir, record, walk: run(['rev-list', '--objects', '--quiet', sha]), fsck: run(['fsck', '--full', '--no-dangling', '--no-progress']) };
  };
  // The reachability walk (rev-list --objects) rejects a bundle whose trees point at blobs it does not hold, even though
  // `bundle verify` and `unbundle` accept it.
  it('with recovery on, refuses a recorded stash bundle whose trees point at missing blobs', () => {
    const sha = stashText('cached stashed edit\n');
    const { dir, record, walk } = handMadeBundle(sha, { skipBlobs: true });
    expect(walk.status).not.toBe(0);
    expect(walk.stderr).toContain('missing blob');
    refused(release([], '', '', RECOVERY_ON), sha);
    expect(readFileSync(join(dir, 'stash-bundles.txt'), 'utf8')).toBe(record);
  });
  // fsck is a separate guard: this bundle holds everything the stash reaches (the walk passes) plus one malformed,
  // unreachable tree (entries out of order), which only `fsck --full` rejects.
  it('with recovery on, refuses a recorded stash bundle carrying a malformed object (fsck, not the walk)', () => {
    const sha = stashText('cached stashed edit\n');
    const blob = Buffer.from(git(['rev-parse', `${sha}:seed.txt`], laneDir), 'hex');
    const entry = name => Buffer.concat([Buffer.from(`100644 ${name}\0`), blob]);
    const bad = spawnSync('git', ['hash-object', '-t', 'tree', '-w', '--literally', '--stdin'], { cwd: laneDir, input: Buffer.concat([entry('b'), entry('a')]) });
    expect(bad.status).toBe(0);
    const { dir, record, walk, fsck } = handMadeBundle(sha, { extra: [bad.stdout.toString().trim()] });
    expect(walk.status, walk.stderr).toBe(0);
    expect(fsck.status).not.toBe(0);
    refused(release([], '', '', RECOVERY_ON), sha);
    expect(readFileSync(join(dir, 'stash-bundles.txt'), 'utf8')).toBe(record);
  });
  // A record line may only name a file directly inside the backup directory; anything else is refused even when the
  // named bundle is a perfectly valid backup of the stash.
  it.each(['../outside.bundle', 'sub/inner.bundle'])('with recovery on, refuses a stash record naming %s', name => {
    const sha = stashText('cached stashed edit\n');
    const dir = join(base, 'backups', 'lane-1-preserve');
    mkdirSync(join(dir, 'sub'), { recursive: true });
    git(['bundle', 'create', join(dir, name), 'refs/stash'], laneDir);
    expect(spawnSync('git', ['bundle', 'verify', join(dir, name)], { cwd: laneDir }).status).toBe(0);
    const record = `${sha} ${name}\n`;
    writeFileSync(join(dir, 'stash-bundles.txt'), record);
    refused(release([], '', '', RECOVERY_ON), sha);
    expect(readFileSync(join(dir, 'stash-bundles.txt'), 'utf8')).toBe(record);
  });
  // Two releases bundling the same first stash sha in the same second (clock frozen below) must not share a file:
  // only the per-release nonce keeps the second from replacing the first's verified bundle.
  it('with recovery on, gives same-sha same-second bundles distinct names so neither replaces the other', () => {
    const sha = stashText('cached stashed edit\n');
    const freeze = `if (args[0] === 'reflog') Date.prototype.toISOString = function () { return '2026-01-01T00:00:00.000Z'; };`;
    const dir = join(base, 'backups', 'lane-1-preserve');
    released(release([], freeze, '', RECOVERY_ON));
    const first = readFileSync(join(dir, 'stash-bundles.txt'), 'utf8').trim().split(' ')[1];
    expect(runPool(['acquire', '--lane=1', '--no-reset']).status).toBe(0);
    rmSync(join(dir, 'stash-bundles.txt'));
    released(release([], freeze, '', RECOVERY_ON));
    const second = readFileSync(join(dir, 'stash-bundles.txt'), 'utf8').trim().split(' ')[1];
    expect(second).not.toBe(first);
    expect(first).toContain('20260101T000000');
    expect(second).toContain('20260101T000000');
    expect(first).toContain(sha.slice(0, 8));
    for (const file of [first, second]) expect(spawnSync('git', ['bundle', 'verify', join(dir, file)], { cwd: laneDir }).status).toBe(0);
  });
  // A concurrent release appends its own index line while this one is bundling (after this one read the index). The
  // append-only write keeps that line; a read-modify-write of the whole file would silently drop it.
  it('with recovery on, retains an index line another release appends while this one is bundling', () => {
    const sha = stashText('first stashed edit\n');
    const dir = join(base, 'backups', 'lane-1-preserve');
    mkdirSync(dir, { recursive: true });
    const recordFile = join(dir, 'stash-bundles.txt');
    const earlier = `${'b'.repeat(40)} earlier.bundle`;
    const racing = `${'c'.repeat(40)} racing.bundle`;
    writeFileSync(recordFile, `${earlier}\n`);
    const fault = `if (args.includes('bundle') && args.includes('create')) fs.appendFileSync(${JSON.stringify(recordFile)}, ${JSON.stringify(`${racing}\n`)});`;
    released(release([], fault, '', RECOVERY_ON));
    const lines = readFileSync(recordFile, 'utf8').trim().split('\n');
    expect(lines.slice(0, 2)).toEqual([earlier, racing]);
    expect(lines).toHaveLength(3);
    expect(lines[2].startsWith(`${sha} stash-`)).toBe(true);
  });
  // The stash's first parent (the commit it was made on) is a tip in its own right. Here that commit has no branch, no
  // HEAD and no remote ref — the stash is the only thing still pointing at it — so only the first-parent rule sees it.
  it('with recovery on, refuses an unpushed commit reachable only as the base of a stash', () => {
    git(['checkout', '--quiet', '-b', 'work/doomed'], laneDir);
    writeFileSync(join(laneDir, 'real.txt'), 'real work\n');
    git(['add', 'real.txt'], laneDir);
    git(['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--quiet', '-m', 'real'], laneDir);
    const sha = git(['rev-parse', 'HEAD'], laneDir);
    stashText('stashed edit on top\n');
    git(['checkout', '--quiet', '--detach', 'origin/main'], laneDir);
    git(['branch', '-D', 'work/doomed'], laneDir);
    expect(git(['for-each-ref', '--contains', sha, '--format=%(refname)', 'refs/heads', 'refs/remotes'], laneDir)).toBe('');
    expect(git(['rev-parse', 'refs/stash^1'], laneDir)).toBe(sha);
    refused(release([], '', '', RECOVERY_ON), sha);
  });
  it('with recovery on, still refuses a genuine unpushed commit when a stash is also present', () => {
    writeFileSync(join(laneDir, 'seed.txt'), 'stashed edit\n');
    git(['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'stash', '--quiet'], laneDir);
    git(['checkout', '--quiet', '-b', 'work/keep'], laneDir);
    writeFileSync(join(laneDir, 'real.txt'), 'real work\n');
    git(['add', 'real.txt'], laneDir);
    git(['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--quiet', '-m', 'real'], laneDir);
    const sha = git(['rev-parse', 'HEAD'], laneDir);
    git(['checkout', '--quiet', '--detach', 'origin/main'], laneDir);
    const result = release([], '', '', RECOVERY_ON);
    refused(result, sha);
  });
  it('with recovery on, still refuses an unpushed branch commit that sits beneath a stash entry', () => {
    git(['checkout', '--quiet', '-b', 'work/under'], laneDir);
    writeFileSync(join(laneDir, 'real.txt'), 'real work\n');
    git(['add', 'real.txt'], laneDir);
    git(['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--quiet', '-m', 'real'], laneDir);
    const sha = git(['rev-parse', 'HEAD'], laneDir);
    writeFileSync(join(laneDir, 'seed.txt'), 'stashed edit on top\n');
    git(['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'stash', '--quiet'], laneDir);
    git(['checkout', '--quiet', '--detach', 'origin/main'], laneDir);
    refused(release([], '', '', RECOVERY_ON), sha);
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
  // Same write-through class via the fetch's scratch file (PR #6319 self-review): a lane-made `.git/FETCH_HEAD ->
  // refs/heads/work/keep` let the recovery-on salvage fetch overwrite the unpushed branch before the guard looked.
  it('with recovery on, a FETCH_HEAD symlink onto a branch never moves it, and the release refuses', () => {
    const pushed = git(['rev-parse', 'HEAD'], laneDir);
    const sha = commitWork();
    git(['branch', 'work/keep', sha], laneDir);
    git(['reset', '--quiet', '--hard', pushed], laneDir);
    git(['switch', '--quiet', '-c', 'feature'], laneDir);
    writeFileSync(join(laneDir, 'other.txt'), 'head work\n');
    git(['add', 'other.txt'], laneDir);
    git(['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--quiet', '-m', 'head work'], laneDir);
    rmSync(join(laneDir, '.git', 'FETCH_HEAD'), { force: true });
    symlinkSync('refs/heads/work/keep', join(laneDir, '.git', 'FETCH_HEAD'));
    const result = release([], '', '', RECOVERY_ON);
    expect(git(['rev-parse', 'refs/heads/work/keep'], laneDir)).toBe(sha);
    refused(result, sha);
  });
  // Defense in depth: whatever the fetch does, a local branch, the stash or HEAD that moved during it refuses the
  // release naming the ref. One named mutation per snapshotted ref kind (PR #6319 referral): the work is an empty
  // commit (or a stash), so moving a ref never leaves a tracked edit behind. `losesWork` rows then release with no
  // fault, proving the moved state passes the recomputed proof: only the movement check kept that work.
  const emptyCommit = () => {
    git(['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '--quiet', '--allow-empty', '-m', 'unpushed work'], laneDir);
    return git(['rev-parse', 'HEAD'], laneDir);
  };
  const keepBranch = pushed => {
    git(['branch', 'work/keep', emptyCommit()], laneDir);
    git(['reset', '--quiet', '--hard', pushed], laneDir);
  };
  const stashEdit = () => {
    writeFileSync(join(laneDir, 'seed.txt'), 'stashed edit\n');
    git(['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'stash', '--quiet'], laneDir);
  };
  it.each([
    ['a local branch is moved', 'refs/heads/work/keep', true, keepBranch, pushed => ['update-ref', 'refs/heads/work/keep', pushed]],
    ['a local branch is deleted', 'refs/heads/work/keep', true, keepBranch, () => ['update-ref', '-d', 'refs/heads/work/keep']],
    ['a detached HEAD is moved', 'HEAD', true, pushed => {
      emptyCommit();
      git(['switch', '--quiet', '--detach'], laneDir);
      git(['branch', '--quiet', '-f', 'main', pushed], laneDir);
    }, pushed => ['update-ref', '--no-deref', 'HEAD', pushed]],
    ['HEAD is switched to another branch at the same commit', 'HEAD', false, () => {
      git(['branch', 'work/twin', emptyCommit()], laneDir);
    }, () => ['symbolic-ref', 'HEAD', 'refs/heads/work/twin']],
    ['the stash is moved', 'refs/stash', false, stashEdit, pushed => ['update-ref', 'refs/stash', pushed]],
    ['the stash is dropped with its reflog', 'refs/stash', true, stashEdit, () => ['update-ref', '-d', 'refs/stash']],
    // The tip stays put (and is preserved on the origin), so only the reflog entry in the snapshot sees the drop.
    ['an older stash entry is dropped', 'refs/stash@{reflog}', true, () => {
      stashEdit();
      writeFileSync(join(laneDir, 'seed.txt'), 'newer stashed edit\n');
      git(['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'stash', '--quiet'], laneDir);
      git(['push', '--quiet', origin, 'refs/stash:refs/heads/preserved-newer-stash'], laneDir);
    }, () => ['reflog', 'delete', 'refs/stash@{1}']],
  ])('refuses when %s during the verification fetch', (_shape, ref, losesWork, setup, mutation) => {
    const pushed = git(['rev-parse', 'HEAD'], laneDir);
    setup(pushed);
    const fault = `if (args.includes('fetch')) { const out = original(cmd, args, opts);
      original('git', ${JSON.stringify(mutation(pushed))}, { cwd: opts.cwd }); return out; }`;
    const result = release([], fault);
    expect(result.status, result.stderr).toBe(1);
    expect(result.data.released).toBe(0);
    // The ref is named in the moved list (a dropped stash moves both refs/stash and its reflog entry).
    const listed = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(result.stderr).toMatch(new RegExp(`fetch refused: (?:\\S+, )*${listed}(?:, \\S+)* changed during the verification fetch`));
    expect(readFileSync(marker, 'utf8')).toBe(lease);
    // Moves that hide no work leave it still refused on a fault-free retry; moves that hide it now pass the proof.
    if (losesWork) released(release());
    else refused(release());
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
  // Each commit-evidence read the guard makes: the local branch listing, HEAD, the tip-object check and the proof.
  const evidenceReads = {
    'unreadable status': "args.includes('--untracked-files=no')",
    'unreadable commits': "args.includes('rev-list') && args.includes('--stdin')",
    'oversized commits': "args.includes('rev-list') && args.includes('--stdin')",
    'unreadable local branches': "args.includes('for-each-ref') && args.includes('--format=%(objectname)') && args.includes('refs/heads/')",
    'unreadable HEAD': "args.includes('rev-parse') && args.includes('--verify') && args.includes('--quiet') && args.at(-1) === 'HEAD'",
    'unreadable tip objects': "args.includes('cat-file') && args.some(arg => arg.startsWith('--batch-check'))",
  };
  it.each(Object.keys(evidenceReads))(
    'fails closed on %s and names manual inspection and --discard as fallbacks', failure => {
      const condition = evidenceReads[failure];
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
  const release = (extra = [], fault = '') => runPool(['release', '--lane=1', ...extra], fault);
  // Records every `git hash-object` the guard runs in the lane (one line per call) without changing its result.
  const countHashes = () => {
    const log = join(base, 'hash-object-calls.log');
    return { fault: `if (args.includes('hash-object')) fs.appendFileSync(${JSON.stringify(log)}, 'call\\n');`,
      calls: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0) };
  };
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
      const hashes = countHashes();
      const result = release([], hashes.fault);
      expect(hashes.calls()).toBeGreaterThan(0); // control: the counter sees the guard's hash-object call
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
    const hashes = countHashes();
    const result = release([], hashes.fault);
    expect(hashes.calls()).toBe(0); // over the bound nothing is hashed, so cost stays bounded
    refused(result);
    expect(result.stderr).toContain('tracked status unreadable or exceeds');
    const override = release(['--discard']);
    released(override);
    expect(override.stderr).toMatch(/WARNING.*--discard.*tracked status unreadable or exceeds/);
  });
});

// PR #6319 send-back: a release run from INSIDE a lane keeps that lane as referencePath even when it discovers the
// pool's primary by name. The canonical-origin listing must never run there under the primary's auth exemption, or
// the invoking lane's own credential helper runs on an authenticating HTTPS origin. The interceptor stands in for that
// HTTPS ls-remote: it records where the listing ran and asks git for credentials in that same cwd and env, exactly as
// an authenticating transport would.
describe('release from inside a lane with a discoverable primary', () => {
  it('lists the canonical origin under the validated primary (outside any repository), never runs the invoking lane\'s credential helper, and keeps its lease', () => {
    const ws = join(base, 'ws');
    const lanesRoot = join(ws, '.lanes');
    const primary = join(ws, 'releaseguard');
    git(['clone', '--quiet', origin, primary]);
    git(['remote', 'set-url', 'origin', 'https://github.com/chalbert/releaseguard.git'], primary);
    const mainSha = git(['rev-parse', 'HEAD'], primary);
    const env = withGhStub({ ...process.env, LANE_POOL_NO_RECOVER: '1', LANE_POOL_AUTO_RECOVER: '0',
      LANE_POOL_ROOT: lanesRoot, WE_LANE_BACKUP_ROOT: join(base, 'backups') });
    delete env.LANE_POOL_CANONICAL_ORIGIN;
    const cwdLog = join(base, 'ls-remote-cwd.log');
    const helperMarker = join(base, 'lane-credential-helper-ran');
    const pool = (args, cwd, intercept = false) => {
      const preload = `import os from 'node:os'; import cp from 'node:child_process'; import fs from 'node:fs';
        import { syncBuiltinESMExports } from 'node:module';
        os.userInfo = () => ({ homedir: ${JSON.stringify(base)} });
        const original = cp.execFileSync;
        cp.execFileSync = (cmd, args, opts) => {
          if (${intercept} && args.includes('ls-remote')) {
            fs.appendFileSync(${JSON.stringify(cwdLog)}, opts.cwd + '\\n');
            try {
              original('git', ['credential', 'fill'], { cwd: opts.cwd, env: { ...opts.env, GIT_TERMINAL_PROMPT: '0' },
                input: 'protocol=https\\nhost=github.com\\npath=chalbert/releaseguard.git\\n\\n', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 });
            } catch { /* no credential available: the listing would fail closed */ }
            return ${JSON.stringify(`${mainSha}\trefs/heads/main\n`)};
          }
          return original(cmd, args, opts);
        }; syncBuiltinESMExports();`;
      const result = spawnSync(process.execPath, [`--import=data:text/javascript,${encodeURIComponent(preload)}`, script, ...args,
        '--branch=main', '--no-install', '--session=guard-holder', '--json'], {
        cwd, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024, env,
      });
      expect(result.error).toBeUndefined();
      return { ...result, data: result.stdout.trim() ? JSON.parse(result.stdout) : null };
    };
    const explicit = [`--origin=${origin}`, `--reference=${reference}`, '--name=releaseguard'];
    expect(pool(['provision', '--count=2', ...explicit], reference).status).toBe(0);
    for (const n of [1, 2]) expect(pool(['acquire', `--lane=${n}`, '--no-reset', ...explicit], reference).status).toBe(0);
    const invoking = join(lanesRoot, 'releaseguard', 'lane-1');
    const invokingMarker = join(invoking, '.git', '.lane-lease');
    const invokingLease = readFileSync(invokingMarker, 'utf8');
    git(['config', 'credential.helper', `!f() { touch ${JSON.stringify(helperMarker)}; }; f`], invoking);
    const result = pool(['release', '--lane=2'], invoking, true);
    expect(existsSync(helperMarker), 'the invoking lane\'s credential helper ran').toBe(false);
    const cwds = existsSync(cwdLog) ? readFileSync(cwdLog, 'utf8').split('\n').filter(Boolean) : [];
    expect(cwds.length, result.stderr).toBeGreaterThan(0);
    // The listing is checked against the primary but runs outside any repository (no lane, no primary local config).
    expect(cwds.every(dir => dir === NO_REPO_CWD), cwds.join(', ')).toBe(true);
    expect(primary).not.toBe(NO_REPO_CWD);
    expect(result.status, result.stderr).toBe(0);
    expect(result.data.released).toBe(1);
    expect(existsSync(join(lanesRoot, 'releaseguard', 'lane-2', '.git', '.lane-lease'))).toBe(false);
    expect(readFileSync(invokingMarker, 'utf8')).toBe(invokingLease);
  });
});

// PR #6319 operator ruling (R674 route a): a git call in a LANE keeps the `credential.helper` / `core.askPass` reset
// pins, so no helper or askpass the lane (or an inherited command-scope entry) names runs on an unattended transport.
// Only a call in the validated primary uses `credentialPins: false`, so the operator's own helper authenticates there
// (the realSalvageIo listing test in scripts/lib/__tests__/lane-pool-salvage-push.test.mjs drives that end to end).
describe('lane git hardening blocks lane credential helpers; the primary-only form keeps the operator helper', () => {
  let root, home, lane, evilRan, trustedRan, helper, base;
  const script = (file, body) => { writeFileSync(file, `#!/bin/sh\n${body}\n`); chmodSync(file, 0o755); return file; };
  const run = (args, env, input, cwd = lane) => spawnSync('git', args, { cwd, env, input, encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL' });
  const fill = (env, cwd = lane, pre = []) => run([...pre, 'credential', 'fill'], env, 'protocol=https\nhost=example.invalid\n\n', cwd);
  const pinsOf = env => Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]);
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lane-cred-'));
    [evilRan, trustedRan] = ['evil-ran', 'trusted-ran'].map(f => join(root, f));
    helper = script(join(root, 'trusted-helper'), `touch '${trustedRan}'\n[ "$1" = get ] && printf 'username=trusted-user\\npassword=trusted-pass\\n'\nexit 0`);
    const evil = script(join(root, 'evil'), `touch '${evilRan}'\n[ "$1" = get ] && printf 'username=evil\\npassword=evil\\n'\necho evil`);
    home = join(root, 'home');
    mkdirSync(home);
    git(['config', '--file', join(home, '.gitconfig'), 'credential.helper', helper], root);
    lane = join(root, 'lane');
    git(['init', '--quiet', lane], root);
    // The lane's own config: a malicious helper (plain and URL-scoped) and askpass.
    git(['config', 'credential.helper', `!f() { touch '${evilRan}'; }; f`], lane);
    git(['config', '--add', 'credential.https://example.invalid.helper', evil], lane);
    git(['config', 'core.askPass', evil], lane);
    base = { ...scrubGitRepoEnv(process.env), HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
    delete base.XDG_CONFIG_HOME;
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('a lane .git/config credential.helper=!evil is NOT run under the lane pins, nor the global helper (reset first)', () => {
    const env = laneGitHardeningEnv(base);
    const listed = run(['config', '--show-scope', '--get-all', 'credential.helper'], env).stdout.split('\n').filter(Boolean)
      .map(line => line.split('\t'));
    // The command-scope reset comes after every file scope, so the effective helper list is empty.
    expect(listed.at(-1)).toEqual(['command', '']);
    const filled = fill(env);
    expect(filled.status).not.toBe(0);
    expect(existsSync(evilRan), 'the lane credential helper or askpass ran').toBe(false);
  });

  it('credentialPins:false drops ONLY the two credential resets; every other pin, the env drops and the prompt-off stay', () => {
    const inherited = { ...base, GIT_ASKPASS: join(root, 'x'), SSH_ASKPASS: join(root, 'x'), GIT_SSH_COMMAND: 'x', GIT_SSH: 'x', GIT_EXTERNAL_DIFF: 'x' };
    const lanePins = pinsOf(laneGitHardeningEnv(inherited));
    const primary = laneGitHardeningEnv(inherited, { credentialPins: false, home });
    expect(pinsOf(primary)).toEqual(lanePins.filter(([k]) => !['credential.helper', 'core.askPass'].includes(k)));
    expect(primary.GIT_TERMINAL_PROMPT).toBe('0');
    for (const key of ['GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_SSH_COMMAND', 'GIT_SSH', 'GIT_EXTERNAL_DIFF']) expect(primary).not.toHaveProperty(key);
    expect(primary.HOME).toBe(home);
    // In a checkout with no lane-set helper (the primary), the operator's global helper then authenticates.
    const clean = join(root, 'primary');
    git(['init', '--quiet', clean], root);
    const filled = fill(primary, clean);
    expect(filled.status, filled.stderr).toBe(0);
    expect(filled.stdout).toContain('password=trusted-pass');
    expect(existsSync(trustedRan)).toBe(true);
  });

  it('the -c argv form keeps the reset pins, so a lane helper never runs through it', () => {
    const args = laneGitConfigArgs();
    expect(args).toEqual(expect.arrayContaining(['-c', 'credential.helper=', '-c', 'core.askPass=']));
    const filled = fill({ ...base, GIT_TERMINAL_PROMPT: '0' }, lane, args);
    expect(filled.status).not.toBe(0);
    expect(existsSync(evilRan), 'the lane credential helper ran').toBe(false);
  });

  it('an inherited command-scope helper is reset by the pins that follow it', () => {
    const inherited = { ...base, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: `!f() { touch '${evilRan}'; }; f` };
    const filled = fill(laneGitHardeningEnv(inherited));
    expect(filled.status).not.toBe(0);
    expect(existsSync(evilRan), 'the inherited command-scope helper ran').toBe(false);
  });

  it('an inherited GIT_CONFIG_PARAMETERS (applied after the pins by git) is dropped, so its helper and fsmonitor never run', () => {
    const fsmonitorRan = join(root, 'fsmonitor-ran');
    const inherited = { ...base, GIT_CONFIG_PARAMETERS:
      `'credential.helper'='!f() { touch ${evilRan}; }; f' 'core.fsmonitor'='touch ${fsmonitorRan}; false'` };
    const clean = join(root, 'primary');
    git(['init', '--quiet', clean], root);
    for (const [name, env, cwd] of [['lane pins', laneGitHardeningEnv(inherited), lane],
      ['primary form', laneGitHardeningEnv(inherited, { credentialPins: false, home }), clean]]) {
      expect(env, name).not.toHaveProperty('GIT_CONFIG_PARAMETERS');
      fill(env, cwd);
      expect(existsSync(evilRan), `${name}: the inherited GIT_CONFIG_PARAMETERS helper ran`).toBe(false);
      run(['status', '--porcelain'], env, undefined, cwd);
      expect(existsSync(fsmonitorRan), `${name}: the inherited GIT_CONFIG_PARAMETERS fsmonitor ran`).toBe(false);
    }
  });

  // Self-review of route (a): with no reset, a caller-chosen global / system config location would be read as trusted.
  it.each([
    ['HOME', dir => dir],
    ['XDG_CONFIG_HOME', dir => dir],
    ['GIT_CONFIG_GLOBAL', dir => join(dir, '.gitconfig')],
    ['GIT_CONFIG_SYSTEM', dir => join(dir, '.gitconfig')],
  ])('the primary form ignores a caller-chosen %s holding a helper; the account helper still answers', (key, location) => {
    const attacker = join(root, 'attacker');
    mkdirSync(join(attacker, 'git'), { recursive: true });
    const evilHelper = `!f() { touch '${evilRan}'; echo username=evil; echo password=evil; }; f`;
    for (const file of [join(attacker, '.gitconfig'), join(attacker, 'git', 'config')]) git(['config', '--file', file, 'credential.helper', evilHelper], root);
    const inherited = { ...base, [key]: location(attacker) };
    if (key === 'GIT_CONFIG_SYSTEM') delete inherited.GIT_CONFIG_NOSYSTEM;
    const env = laneGitHardeningEnv(inherited, { credentialPins: false, home });
    expect(env.HOME).toBe(home);
    for (const k of ['XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM']) expect(env, k).not.toHaveProperty(k);
    // A caller GIT_CONFIG (it replaces the repository config a `git config` read lists) is dropped by the form itself.
    expect(laneGitHardeningEnv({ ...inherited, GIT_CONFIG: '/dev/null' }, { credentialPins: false, home })).not.toHaveProperty('GIT_CONFIG');
    const clean = join(root, 'primary');
    git(['init', '--quiet', clean], root);
    const filled = fill(env, clean);
    expect(filled.status, filled.stderr).toBe(0);
    expect(filled.stdout).toContain('password=trusted-pass');
    expect(existsSync(evilRan), `the ${key} helper ran`).toBe(false);
  });

  // Self-review of route (a): the primary form hands a real credential to git, so no caller env may record it (a trace
  // file with redaction off) or route it through a caller proxy with TLS checks off / a caller CA.
  it('the primary form drops caller trace, proxy and TLS env; the lane form, which carries no credential, keeps them', () => {
    const routing = { GIT_TRACE: '1', GIT_TRACE_CURL: join(root, 'trace'), GIT_TRACE_REDACT: '0', GIT_TRACE2_EVENT: join(root, 't2'),
      GIT_CURL_VERBOSE: '1', GIT_SSL_NO_VERIFY: '1', GIT_SSL_CAINFO: join(root, 'ca'), GIT_SSL_CAPATH: root, GIT_SSL_CERT: join(root, 'c'),
      GIT_HTTP_PROXY_AUTHMETHOD: 'basic', GIT_PROXY_COMMAND: join(root, 'proxy'), GIT_PROXY_SSL_CAINFO: join(root, 'ca'), GIT_REDIRECT_STDERR: join(root, 'err'),
      SSL_CERT_FILE: join(root, 'ca'), SSL_CERT_DIR: root, CURL_CA_BUNDLE: join(root, 'ca'), CURL_HOME: root,
      HTTPS_PROXY: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', http_proxy: 'http://127.0.0.1:9',
      ALL_PROXY: 'http://127.0.0.1:9', all_proxy: 'http://127.0.0.1:9', NO_PROXY: '*', no_proxy: '*' };
    const inherited = { ...base, ...routing };
    const primary = laneGitHardeningEnv(inherited, { credentialPins: false, home });
    for (const key of Object.keys(routing)) expect(primary, key).not.toHaveProperty(key);
    expect(laneGitHardeningEnv(inherited)).toMatchObject(routing);
    const clean = join(root, 'primary');
    git(['init', '--quiet', clean], root);
    const filled = fill(primary, clean);
    expect(filled.status, filled.stderr).toBe(0);
    expect(filled.stdout).toContain('password=trusted-pass');
  });

  it('the primary form drops every inherited GIT_CONFIG_COUNT entry, so an inherited helper cannot outlive the missing reset', () => {
    const pre = 'GIT_CONFIG_';
    const inherited = { ...base, GIT_CONFIG_COUNT: '2', [`${pre}KEY_0`]: 'credential.helper', [`${pre}VALUE_0`]: `!f() { touch '${evilRan}'; }; f`,
      [`${pre}KEY_1`]: 'core.askPass', [`${pre}VALUE_1`]: join(root, 'evil'), [`${pre}KEY_7`]: 'credential.helper', [`${pre}VALUE_7`]: 'orphan' };
    const env = laneGitHardeningEnv(inherited, { credentialPins: false, home });
    expect(pinsOf(env).map(([k]) => k)).not.toContain('credential.helper');
    expect(Object.keys(env).filter(k => /^GIT_CONFIG_(KEY|VALUE)_/.test(k))).toHaveLength(2 * Number(env.GIT_CONFIG_COUNT));
    const clean = join(root, 'primary');
    git(['init', '--quiet', clean], root);
    const filled = fill(env, clean);
    expect(filled.status, filled.stderr).toBe(0);
    expect(filled.stdout).toContain('password=trusted-pass');
    expect(existsSync(evilRan), 'the inherited command-scope helper ran').toBe(false);
  });
});
