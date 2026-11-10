import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const launcher = join(repo, 'scripts/hooks/run-pinned-guard.mjs');
const settings = JSON.parse(readFileSync(join(repo, '.claude/settings.json'), 'utf8'));
const bashCommand = settings.hooks.PreToolUse.find(group => group.matcher === 'Bash').hooks[0].command;
const temps = [];
afterEach(() => { for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true }); });
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
  return { temp, primary, outside, cache, env, git, commit, sha, run, shell };
}

describe('pinned guard security boundary', () => {
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
    expect(result.stderr).toBe('guard stderr\n');
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

  it('denies incomplete snapshots, escaping targets and unsafe latest pointers', () => {
    const f = fixture();
    expect(f.run().status).toBe(0);
    rmSync(join(f.cache, f.sha, 'scripts/guard-bash.mjs'));
    expect(f.run()).toMatchObject({ status: 2, stderr: expect.stringContaining('denying') });
    symlinkSync(join(f.primary, 'scripts/guard-bash.mjs'), join(f.cache, f.sha, 'scripts/guard-bash.mjs'));
    expect(f.run().status).toBe(2);
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
    rmSync(join(f.cache, f.sha), { recursive: true });
    rmSync(join(f.cache, 'latest'));
    symlinkSync('0'.repeat(40), join(f.cache, 'latest'));
    f.git(f.primary, 'update-ref', '-d', 'refs/remotes/origin/main');
    const result = f.run();
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('cannot load trusted guard; denying');
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
