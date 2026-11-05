import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { sharedRepos, withGhStub } from './fixtures/shared-git-fixture.mjs';
import { readLaneJournal } from '../lib/lane-history.mjs';

const script = resolve(process.cwd(), 'scripts/lane-pool.mjs');
const git = (args, cwd) => execFileSync('git', args, {
  cwd, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024,
}).trim();
let fixtureRoot, fixture, origin, reference, base, poolRoot, laneDir, marker, lease;
function runPool(args, fault = '', remoteFault = '') {
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
  const release = (extra = [], fault = '', remoteFault = '') => runPool(['release', selector, ...extra], fault, remoteFault);
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
  // would then judge a decoy clone and never see the lane's own unpushed branch.
  it('refuses a lane whose .git/commondir redirects refs to a decoy repository', () => {
    const main = git(['rev-parse', 'HEAD'], laneDir);
    const sha = commitWork();
    git(['reset', '--quiet', '--hard', main], laneDir);
    git(['branch', 'work/hidden', sha], laneDir);
    const decoy = join(base, 'decoy');
    git(['clone', '--quiet', origin, decoy]);
    writeFileSync(join(laneDir, '.git', 'commondir'), `${join(decoy, '.git')}\n`);
    expect(git(['branch', '--list', 'work/hidden'], laneDir)).toBe('');
    const result = release();
    refused(result);
    expect(result.stderr).toContain('commondir');
  });
  it.each(['with its reflog', 'with an expired reflog'])('refuses tracked work parked in a stash %s', shape => {
    writeFileSync(join(laneDir, 'seed.txt'), 'stashed edit\n');
    git(['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'stash', '--quiet'], laneDir);
    if (shape === 'with an expired reflog') git(['reflog', 'expire', '--expire=now', 'refs/stash'], laneDir);
    expect(git(['status', '--porcelain', '--untracked-files=no'], laneDir)).toBe('');
    refused(release(), git(['rev-parse', 'refs/stash'], laneDir));
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
  it.each(['assume-unchanged edit', 'assume-unchanged deletion', 'skip-worktree edit', 'skip-worktree deletion'])('refuses a tracked %s hidden by index flags', shape => {
    git(['update-index', shape.startsWith('assume') ? '--assume-unchanged' : '--skip-worktree', 'seed.txt'], laneDir);
    if (shape.endsWith('deletion')) rmSync(join(laneDir, 'seed.txt'));
    else writeFileSync(join(laneDir, 'seed.txt'), 'hidden edit\n');
    expect(git(['status', '--porcelain', '--untracked-files=no'], laneDir)).toBe('');
    const result = release();
    refused(result);
    expect(result.stderr).toContain('seed.txt');
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
    expect(result.stderr).toContain(`git -C ${laneDir} push origin HEAD:refs/heads/lane/lane-1-preserve`);
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
