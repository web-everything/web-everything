import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, statSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { removeFixture } from './pinned-fixture.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lockDirFor } from '../../readiness/file-locks.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const launcher = join(repo, 'scripts/hooks/run-pinned-guard.mjs');
const settings = JSON.parse(readFileSync(join(repo, '.claude/settings.json'), 'utf8'));
const bashCommand = settings.hooks.PreToolUse.find(group => group.matcher === 'Bash').hooks[0].command;
const temps = [];
afterEach(() => { for (const temp of temps.splice(0)) removeFixture(temp); });
function fixture() {
  const temp = realpathSync(mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'pinned-guard-')));
  temps.push(temp);
  const primary = join(temp, 'web-everything');
  const cache = join(temp, 'cache');
  const outside = join(temp, 'outside');
  mkdirSync(primary); mkdirSync(outside);
  const env = { ...process.env, WE_PINNED_HOOKS_DIR: cache, FIXTURE_MARKER: 'environment', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  // Do not inherit a caller's index/worktree overrides into the hermetic repositories.
  for (const key of ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[key];
  const git = (cwd, ...args) => {
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git(primary, 'init', '-b', 'main');
  git(primary, 'config', 'user.email', 'fixture@example.test');
  git(primary, 'config', 'user.name', 'Fixture');
  mkdirSync(join(primary, 'scripts/hooks'), { recursive: true });
  mkdirSync(join(primary, 'scripts/lib'));
  copyFileSync(join(repo, 'scripts/lib/hook-root.mjs'), join(primary, 'scripts/lib/hook-root.mjs'));
  mkdirSync(join(primary, 'scripts/readiness'));
  copyFileSync(join(repo, 'scripts/readiness/file-locks.mjs'), join(primary, 'scripts/readiness/file-locks.mjs'));
  mkdirSync(join(primary, 'node_modules'));
  writeFileSync(join(primary, 'package.json'), '{"type":"module"}\n');
  const source = marker => `import { readFileSync } from 'node:fs';
const input = readFileSync(0, 'utf8');
console.log(JSON.stringify({ marker: ${JSON.stringify(marker)}, input, args: process.argv.slice(2), cwd: process.cwd(), env: process.env.FIXTURE_MARKER }));
console.error('guard stderr');
process.exitCode = input === 'deny' ? 7 : 0;\n`;
  const commit = marker => {
    writeFileSync(join(primary, 'scripts/guard-bash.mjs'), source(marker));
    git(primary, 'add', '.'); git(primary, 'commit', '-m', marker);
    const sha = git(primary, 'rev-parse', 'HEAD');
    git(primary, 'update-ref', 'refs/remotes/origin/main', sha);
    return sha;
  };
  const sha = commit('trusted');
  copyFileSync(launcher, join(primary, 'scripts/hooks/run-pinned-guard.mjs'));
  const run = (cwd = primary, script = 'scripts/guard-bash.mjs', input = '', args = []) =>
    spawnSync(process.execPath, [launcher, script, ...args], { cwd, env, input, encoding: 'utf8' });
  const shell = cwd => spawnSync('sh', ['-c', bashCommand], { cwd, env, input: '', encoding: 'utf8' });
  const common = realpathSync(git(primary, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  const scopedCache = join(cache, createHash('sha256').update(common).digest('hex'));
  return { temp, primary, outside, cache: scopedCache, env, git, commit, sha, run, shell };
}

// Event-driven child barriers keep concurrency tests independent of scheduling speed.
function launch(f, args = []) {
  const child = spawn(process.execPath, [launcher, 'scripts/guard-bash.mjs', ...args], {
    cwd: f.primary, env: f.env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  const waiters = [];
  function notify() {
    for (const waiter of waiters) if (waiter.pattern.test(stdout + stderr)) waiter.resolve();
  }
  child.stdout.on('data', data => { stdout += data; notify(); });
  child.stderr.on('data', data => { stderr += data; notify(); });
  const done = new Promise((resolveDone, reject) => {
    child.on('error', reject);
    child.on('close', status => {
      for (const waiter of waiters) if (!waiter.pattern.test(stdout + stderr)) waiter.reject(new Error(stderr || 'child exited before barrier'));
      resolveDone({ status, stdout, stderr });
    });
  });
  return { child, done, until(pattern) {
    return new Promise((resolveBarrier, reject) => {
      waiters.push({ pattern, resolve: resolveBarrier, reject }); notify();
    });
  } };
}

describe('pinned guard security boundary', () => {
  it('serializes concurrent cold-cache publication and all launches execute the trusted guard', async () => {
    const f = fixture();
    const launches = Array.from({ length: 6 }, () => launch(f));
    try {
      for (const run of launches) run.child.stdin.end('deny');
      const results = await Promise.all(launches.map(run => run.done));
      for (const result of results) {
        expect(result.status, result.stderr).toBe(7);
        expect(JSON.parse(result.stdout).marker).toBe('trusted');
      }
      expect(results.filter(result => result.stderr.includes('discarding and re-materializing'))).toHaveLength(1);
      expect(readdirSync(`${f.cache}.locks`)).toEqual([]);
    } finally {
      for (const run of launches) run.child.kill();
      await Promise.all(launches.map(run => run.done));
    }
  }, 15_000);

  it('protects an executing snapshot from concurrent repair and pruning until late imports finish', async () => {
    const f = fixture();
    writeFileSync(join(f.primary, 'scripts/late.mjs'), 'export const marker = "late import succeeded";');
    writeFileSync(join(f.primary, 'scripts/guard-bash.mjs'), `
if (process.argv.includes('--hold')) {
  console.log('guard entered');
  await new Promise(resolve => process.stdin.once('data', resolve));
}
const { marker } = await import('./late.mjs');
console.log(marker);
`);
    f.git(f.primary, 'add', '.'); f.git(f.primary, 'commit', '-m', 'late import guard');
    const sha = f.git(f.primary, 'rev-parse', 'HEAD');
    f.git(f.primary, 'update-ref', 'refs/remotes/origin/main', sha);
    const held = launch(f, ['--hold']);
    let contender;
    try {
      await held.until(/guard entered/);
      rmSync(join(f.cache, `${sha}.manifest`));
      contender = launch(f);
      contender.child.stdin.end();
      await contender.until(/waiting for snapshot lock/);
      for (const marker of ['second', 'third', 'fourth']) {
        f.commit(marker);
        expect(f.run().status).toBe(0);
      }
      expect(existsSync(join(f.cache, sha, 'scripts/late.mjs'))).toBe(true);
      held.child.stdin.end('release');
      expect(await held.done).toMatchObject({ status: 0, stdout: expect.stringContaining('late import succeeded') });
      expect(await contender.done).toMatchObject({ status: 0, stdout: 'late import succeeded\n', stderr: expect.stringContaining('discarding and re-materializing') });
      expect(readdirSync(`${f.cache}.locks`)).toEqual([]);
    } finally {
      held.child.kill(); contender?.child.kill();
      await Promise.all([held.done, contender?.done]);
    }
  }, 15_000);

  it('fails closed on an abandoned snapshot lock with an operator recovery message', () => {
    const f = fixture();
    mkdirSync(lockDirFor(`${f.cache}.locks`, f.sha), { recursive: true });
    expect(f.run()).toMatchObject({ status: 2, stdout: '', stderr: expect.stringContaining('snapshot lock busy after 5s; retry the hook; inspect abandoned locks') });
    expect(existsSync(join(f.cache, f.sha))).toBe(false);
  }, 10_000);

  it('runs the committed snapshot despite uncommitted marker edits in a lane clone', () => {
    const f = fixture();
    const lane = join(f.temp, 'lane');
    f.git(f.temp, 'clone', f.primary, lane);
    writeFileSync(join(lane, 'scripts/guard-bash.mjs'), 'console.log("LANE COPY EXECUTED");');
    const result = f.run(lane);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).marker).toBe('trusted');
    expect(result.stdout).not.toContain('LANE COPY EXECUTED');
  });

  it('preserves stdin, argv, cwd, environment, stdout, stderr and a denying exit code from a nested cwd', () => {
    const f = fixture();
    const cwd = join(f.primary, 'nested'); mkdirSync(cwd);
    const result = f.run(cwd, 'scripts/guard-bash.mjs', 'deny', ['--pre', 'space argument']);
    expect(result.status).toBe(7);
    expect(JSON.parse(result.stdout)).toEqual({ marker: 'trusted', input: 'deny', args: ['--pre', 'space argument'], cwd, env: 'environment' });
    expect(result.stderr).toContain('guard stderr\n');
    expect(result.stderr).toMatch(/snapshot verification [0-9.]+ ms/);
    expect(readlinkSync(join(f.cache, f.sha, 'node_modules'))).toBe(join(f.primary, 'node_modules'));
  });

  it('denies a missing guard even when a cwd copy exists', () => {
    const f = fixture();
    writeFileSync(join(f.primary, 'scripts/local-only.mjs'), 'console.log("UNTRUSTED");');
    const result = f.run(f.primary, 'scripts/local-only.mjs');
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/cannot load trusted guard; denying/);
    expect(result.stdout).toBe('');
  });

  it('denies an unresolvable repository without a snapshot', () => {
    const f = fixture();
    const result = f.run(f.outside);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/Pinned guard:.*denying/);
  });

  it('picks up a newer origin/main on the next call and keeps only three snapshots', () => {
    const f = fixture();
    expect(f.run().status).toBe(0);
    let newest;
    for (const marker of ['second', 'third', 'fourth']) {
      newest = f.commit(marker);
      expect(JSON.parse(f.run().stdout).marker).toBe(marker);
    }
    expect(readlinkSync(join(f.cache, 'latest'))).toBe(newest);
    expect(readdirSync(f.cache).filter(name => /^[a-f0-9]{40,64}$/.test(name))).toHaveLength(3);
    expect(existsSync(join(f.cache, f.sha))).toBe(false);
    expect(readdirSync(f.cache).some(name => name.startsWith('.'))).toBe(false);
  });

  it('falls back to latest when origin/main is unavailable, but refuses a cwd outside any repository', () => {
    const f = fixture();
    expect(f.run().status).toBe(0);
    f.git(f.primary, 'update-ref', '-d', 'refs/remotes/origin/main');
    for (const cwd of [f.primary]) {
      const result = f.run(cwd);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).marker).toBe('trusted');
      expect(result.stderr).toContain('origin/main unavailable; using latest snapshot');
    }
    expect(f.run(f.outside)).toMatchObject({ status: 2, stdout: '', stderr: expect.stringContaining('denying') });
  });

  it('repairs incomplete snapshots and escaping targets, and denies unsafe latest pointers', () => {
    const f = fixture();
    expect(f.run().status).toBe(0);
    chmodSync(join(f.cache, f.sha, 'scripts'), 0o755);
    rmSync(join(f.cache, f.sha, 'scripts/guard-bash.mjs'));
    expect(f.run()).toMatchObject({ status: 0, stderr: expect.stringContaining('discarding and re-materializing') });
    chmodSync(join(f.cache, f.sha, 'scripts'), 0o755);
    rmSync(join(f.cache, f.sha, 'scripts/guard-bash.mjs'));
    symlinkSync(join(f.primary, 'scripts/guard-bash.mjs'), join(f.cache, f.sha, 'scripts/guard-bash.mjs'));
    expect(f.run()).toMatchObject({ status: 0, stderr: expect.stringContaining('unsafe snapshot entry') });
    expect(f.run(f.primary, 'scripts/../../outside.mjs').status).toBe(2);
    rmSync(join(f.cache, 'latest'));
    symlinkSync('../primary', join(f.cache, 'latest'));
    f.git(f.primary, 'update-ref', '-d', 'refs/remotes/origin/main');
    const result = f.run();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('invalid latest snapshot pointer');
  });

  it('denies a dangling latest snapshot that cannot be reconstructed rather than using a working-tree guard', () => {
    const f = fixture();
    expect(f.run().status).toBe(0);
    removeFixture(join(f.cache, f.sha));
    rmSync(join(f.cache, 'latest'));
    symlinkSync('0'.repeat(40), join(f.cache, 'latest'));
    f.git(f.primary, 'update-ref', '-d', 'refs/remotes/origin/main');
    const result = f.run();
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('cannot load trusted guard; denying');
  });

  it('detects an exit-0 cache stub, restores the Git guard, and keeps the tree read-only', () => {
    const f = fixture();
    expect(f.run().status).toBe(0);
    const guard = join(f.cache, f.sha, 'scripts/guard-bash.mjs');
    const manifest = JSON.parse(readFileSync(join(f.cache, `${f.sha}.manifest`), 'utf8'));
    expect(manifest.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.files).toContainEqual(['scripts/guard-bash.mjs', 'file', createHash('sha256').update(readFileSync(guard)).digest('hex')]);
    for (const path of [join(f.cache, f.sha), dirname(guard), guard]) expect(statSync(path).mode & 0o222).toBe(0);
    chmodSync(guard, 0o644);
    writeFileSync(guard, 'console.log("CACHE STUB"); process.exit(0);');
    const result = f.run(f.primary, 'scripts/guard-bash.mjs', 'deny');
    expect(result).toMatchObject({ status: 7, stderr: expect.stringContaining('snapshot integrity mismatch') });
    expect(result.stdout).not.toContain('CACHE STUB');
    expect(statSync(guard).mode & 0o222).toBe(0);
  });

  it.each(['missing manifest', 'invalid root digest'])('rebuilds an online snapshot with %s', kind => {
    const f = fixture();
    expect(f.run().status).toBe(0);
    const path = join(f.cache, `${f.sha}.manifest`);
    if (kind === 'missing manifest') rmSync(path);
    else {
      const manifest = JSON.parse(readFileSync(path, 'utf8'));
      manifest.digest = '0'.repeat(64);
      chmodSync(path, 0o644); writeFileSync(path, JSON.stringify(manifest));
    }
    const result = f.run(f.primary, 'scripts/guard-bash.mjs', 'deny');
    expect(result).toMatchObject({ status: 7, stderr: expect.stringContaining('discarding and re-materializing') });
    expect(JSON.parse(result.stdout).marker).toBe('trusted');
  });

  it('denies a tampered snapshot when Git cannot re-materialize it', () => {
    const f = fixture();
    expect(f.run().status).toBe(0);
    const guard = join(f.cache, f.sha, 'scripts/guard-bash.mjs');
    chmodSync(guard, 0o644);
    writeFileSync(guard, 'console.log("CACHE STUB");');
    // The ref still resolves, but the tree object required by git archive is unavailable.
    const tree = f.git(f.primary, 'rev-parse', 'HEAD^{tree}');
    rmSync(join(f.primary, '.git/objects', tree.slice(0, 2), tree.slice(2)));
    const result = f.run();
    expect(result).toMatchObject({ status: 2, stdout: '', stderr: expect.stringContaining('discarding and re-materializing') });
    expect(existsSync(join(f.cache, f.sha))).toBe(false);
  });

  it.each(['missing', 'incompatible'])('denies pre-change origin/main with %s root-resolution support', kind => {
    const f = fixture();
    const helper = join(f.primary, 'scripts/lib/hook-root.mjs');
    if (kind === 'missing') rmSync(helper);
    else writeFileSync(helper, 'export function hookRoot() { return "/wrong-root"; }');
    f.commit('old root support');
    expect(f.run()).toMatchObject({ status: 2, stdout: '', stderr: expect.stringContaining('launcher-compatible root-resolution support') });
  });

  it('never uses another repository latest or the legacy global latest', () => {
    const a = fixture(), b = fixture();
    expect(a.run().status).toBe(0);
    b.env.WE_PINNED_HOOKS_DIR = a.env.WE_PINNED_HOOKS_DIR;
    symlinkSync(join(a.cache, a.sha), join(a.env.WE_PINNED_HOOKS_DIR, 'latest'));
    b.git(b.primary, 'update-ref', '-d', 'refs/remotes/origin/main');
    expect(b.run()).toMatchObject({ status: 2, stdout: '', stderr: expect.stringContaining('denying') });
    expect(a.run().status).toBe(0);
  });

  it('denies stale offline latest without refreshing its materialization time', () => {
    const f = fixture();
    expect(f.run().status).toBe(0);
    const path = join(f.cache, `${f.sha}.manifest`);
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    manifest.createdAt = Date.now() - 24 * 60 * 60 * 1000 - 1000;
    chmodSync(path, 0o644);
    writeFileSync(path, JSON.stringify(manifest));
    f.git(f.primary, 'update-ref', '-d', 'refs/remotes/origin/main');
    expect(f.run()).toMatchObject({ status: 2, stdout: '', stderr: expect.stringContaining('older than 24h') });
    expect(JSON.parse(readFileSync(path, 'utf8')).createdAt).toBe(manifest.createdAt);
  });

  it.each(['missing manifest', 'corrupt manifest'])('denies offline latest with %s', kind => {
    const f = fixture();
    expect(f.run().status).toBe(0);
    const manifest = join(f.cache, `${f.sha}.manifest`);
    if (kind === 'missing manifest') rmSync(manifest);
    if (kind === 'corrupt manifest') { chmodSync(manifest, 0o644); writeFileSync(manifest, '{}'); }
    f.git(f.primary, 'update-ref', '-d', 'refs/remotes/origin/main');
    expect(f.run()).toMatchObject({ status: 2, stdout: '', stderr: expect.stringContaining('failed verification') });
  });

  it.each(['extra file', 'tampered file', 'missing tree'])('repairs offline %s from Git without extending its age', kind => {
    const f = fixture();
    expect(f.run().status).toBe(0);
    const path = join(f.cache, `${f.sha}.manifest`);
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    manifest.createdAt = Date.now() - 60 * 60 * 1000;
    chmodSync(path, 0o644); writeFileSync(path, JSON.stringify(manifest));
    if (kind === 'extra file') { chmodSync(join(f.cache, f.sha), 0o755); writeFileSync(join(f.cache, f.sha, 'extra'), 'extra'); }
    if (kind === 'tampered file') {
      const guard = join(f.cache, f.sha, 'scripts/guard-bash.mjs');
      chmodSync(guard, 0o644); writeFileSync(guard, 'console.log("CACHE STUB");');
    }
    if (kind === 'missing tree') removeFixture(join(f.cache, f.sha));
    f.git(f.primary, 'update-ref', '-d', 'refs/remotes/origin/main');
    const result = f.run(f.primary, 'scripts/guard-bash.mjs', 'deny');
    expect(result).toMatchObject({ status: 7, stderr: expect.stringContaining('discarding and re-materializing') });
    expect(result.stdout).not.toContain('CACHE STUB');
    expect(JSON.parse(readFileSync(path, 'utf8')).createdAt).toBe(manifest.createdAt);
  });

  it('denies tampered offline latest if local Git reconstruction fails', () => {
    const f = fixture();
    expect(f.run().status).toBe(0);
    const guard = join(f.cache, f.sha, 'scripts/guard-bash.mjs');
    chmodSync(guard, 0o644); writeFileSync(guard, 'console.log("CACHE STUB");');
    f.git(f.primary, 'update-ref', '-d', 'refs/remotes/origin/main');
    const tree = f.git(f.primary, 'rev-parse', 'HEAD^{tree}');
    rmSync(join(f.primary, '.git/objects', tree.slice(0, 2), tree.slice(2)));
    expect(f.run()).toMatchObject({ status: 2, stdout: '', stderr: expect.stringContaining('discarding and re-materializing') });
  });

  it('fails closed on archive failure instead of running an older snapshot', () => {
    const f = fixture(); expect(f.run().status).toBe(0);
    f.git(f.primary, 'rm', '-r', 'scripts');
    f.git(f.primary, 'commit', '-m', 'remove scripts');
    f.git(f.primary, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    const result = f.run();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('denying');
    expect(result.stdout).toBe('');
  });
});

describe('settings security hook commands', () => {
  function clonedLane(f) {
    const pool = join(f.temp, '.lanes/web-everything');
    mkdirSync(pool, { recursive: true });
    const lane = join(pool, 'lane-1');
    f.git(f.temp, 'clone', f.primary, lane);
    mkdirSync(join(lane, 'scripts/hooks'), { recursive: true });
    writeFileSync(join(lane, 'scripts/hooks/run-pinned-guard.mjs'), 'console.log("LANE LAUNCHER EXECUTED"); process.exit(0);');
    writeFileSync(join(lane, 'scripts/guard-bash.mjs'), 'console.log("LANE GUARD EXECUTED"); process.exit(0);');
    return lane;
  }

  it('executes the wrapper from a clone lane without executing its replaced launcher or guard', () => {
    const f = fixture();
    const lane = clonedLane(f);
    // A lane-local ref must not choose the trusted snapshot either.
    f.git(lane, 'update-ref', '-d', 'refs/remotes/origin/main');
    const result = f.shell(lane);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).marker).toBe('trusted');
    expect(result.stdout).not.toContain('LANE LAUNCHER EXECUTED');
    expect(result.stdout).not.toContain('LANE GUARD EXECUTED');
    expect(readlinkSync(join(f.cache, 'latest'))).toBe(f.sha);
  });

  it('denies a clone lane with no trusted primary launcher instead of falling back to the lane', () => {
    const f = fixture();
    const lane = clonedLane(f);
    rmSync(join(f.primary, 'scripts/hooks/run-pinned-guard.mjs'));
    const result = f.shell(lane);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('primary launcher missing');
    expect(result.stdout).toBe('');
  });

  it('supports the legacy sibling primary name outside the clone lane', () => {
    const f = fixture();
    const lane = clonedLane(f);
    renameSync(f.primary, join(f.temp, 'webeverything'));
    const result = f.shell(lane);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).marker).toBe('trusted');
  });

  it('denies an unavailable or lane-symlinked primary without running the clone launcher', () => {
    const f = fixture();
    const lane = clonedLane(f);
    rmSync(f.primary, { recursive: true });
    const unavailable = f.shell(lane);
    expect(unavailable).toMatchObject({ status: 2, stdout: '', stderr: expect.stringContaining('primary checkout unavailable') });
    symlinkSync(lane, f.primary, 'dir');
    expect(f.shell(lane)).toMatchObject({ status: 2, stdout: '', stderr: expect.stringContaining('refusing a lane bootstrap') });
  });

  it('pins every PreToolUse/Stop/SubagentStop command with no bare cwd-relative invocation', () => {
    for (const event of ['PreToolUse', 'Stop', 'SubagentStop']) {
      for (const hook of settings.hooks[event].flatMap(group => group.hooks)) {
        expect(hook.command).not.toMatch(/\bnode scripts\//);
        expect(hook.command).toContain('git rev-parse --path-format=absolute --git-common-dir');
        expect(hook.command).toContain('node "$launcher" scripts/');
        expect(hook.command).toContain('exit 2');
      }
    }
  });

  it('uses the primary launcher from a linked worktree even with a malicious lane launcher', () => {
    const f = fixture();
    const lane = join(f.temp, 'linked lane');
    f.git(f.primary, 'worktree', 'add', '-b', 'lane', lane);
    mkdirSync(join(lane, 'scripts/hooks'), { recursive: true });
    writeFileSync(join(lane, 'scripts/hooks/run-pinned-guard.mjs'), 'console.log("LANE LAUNCHER");');
    writeFileSync(join(lane, 'scripts/guard-bash.mjs'), 'console.log("LANE GUARD");');
    const result = f.shell(lane);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).marker).toBe('trusted');
  });

  it('wrapper denies git failure, missing launcher, and a failed launcher with stderr', () => {
    const f = fixture();
    expect(f.shell(f.outside)).toMatchObject({ status: 2, stderr: expect.stringContaining('cannot locate primary repository') });
    rmSync(join(f.primary, 'scripts/hooks/run-pinned-guard.mjs'));
    expect(f.shell(f.primary)).toMatchObject({ status: 2, stderr: expect.stringContaining('primary launcher missing') });
    writeFileSync(join(f.primary, 'scripts/hooks/run-pinned-guard.mjs'), 'throw new Error("broken bootstrap");');
    expect(f.shell(f.primary)).toMatchObject({ status: 2, stderr: expect.stringContaining('broken bootstrap') });
  });
});
