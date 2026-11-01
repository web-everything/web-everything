import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, realpathSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalRepoSlug, sameRepoUrl, ensureLaneAlternates, poolNameFromLanePath, findPrimaryForPool } from '../lane-alternates.mjs';
import { boundedGitCommand } from '../git-bounded.mjs';

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'lane-alt-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
const mkRepo = (dir) => { mkdirSync(join(dir, '.git', 'objects'), { recursive: true }); return dir; };

describe('canonical origin match', () => {
  it('treats the chalbert redirect, the org URL, https and ssh as one repo', () => {
    expect(sameRepoUrl('git@github.com:chalbert/web-everything.git', 'git@github.com:web-everything/web-everything.git')).toBe(true);
    expect(sameRepoUrl('https://github.com/chalbert/web-everything', 'git@github.com:web-everything/web-everything.git')).toBe(true);
    expect(canonicalRepoSlug('git@github.com:chalbert/web-everything.git')).toBe('github.com/web-everything/web-everything');
  });
  it('keeps different repos apart', () => {
    expect(sameRepoUrl('git@github.com:chalbert/web-everything.git', 'git@github.com:chalbert/plateau-app.git')).toBe(false);
    expect(sameRepoUrl('git@github.com:other/web-everything.git', 'git@github.com:web-everything/web-everything.git')).toBe(false);
  });
});

describe('ensureLaneAlternates', () => {
  it('writes alternates for a lane that has none, and leaves objects alone', () => {
    const primary = mkRepo(join(root, 'primary')), lane = mkRepo(join(root, 'lane-1'));
    writeFileSync(join(lane, '.git', 'objects', 'keep'), 'x');
    const r = ensureLaneAlternates({ laneDir: lane, referencePath: primary, laneOrigin: 'git@github.com:chalbert/web-everything.git', referenceOrigin: 'git@github.com:web-everything/web-everything.git' });
    expect(r.status).toBe('added');
    expect(readFileSync(join(lane, '.git', 'objects', 'info', 'alternates'), 'utf8').trim()).toBe(realpathSync(join(primary, '.git', 'objects')));
    expect(existsSync(join(lane, '.git', 'objects', 'keep'))).toBe(true);
  });
  it('keeps an existing alternate and never switches it', () => {
    const primary = mkRepo(join(root, 'primary')), lane = mkRepo(join(root, 'lane-1'));
    mkdirSync(join(lane, '.git', 'objects', 'info'), { recursive: true });
    writeFileSync(join(lane, '.git', 'objects', 'info', 'alternates'), '/some/other/objects\n');
    expect(ensureLaneAlternates({ laneDir: lane, referencePath: primary }).status).toBe('present');
    expect(readFileSync(join(lane, '.git', 'objects', 'info', 'alternates'), 'utf8')).toBe('/some/other/objects\n');
  });
  it('refuses a reference of a different repository or a missing store', () => {
    const primary = mkRepo(join(root, 'primary')), lane = mkRepo(join(root, 'lane-1'));
    expect(ensureLaneAlternates({ laneDir: lane, referencePath: primary, laneOrigin: 'git@github.com:chalbert/plateau-app.git', referenceOrigin: 'git@github.com:web-everything/web-everything.git' }).status).toBe('skipped');
    expect(ensureLaneAlternates({ laneDir: lane, referencePath: join(root, 'nope') }).status).toBe('skipped');
    expect(existsSync(join(lane, '.git', 'objects', 'info', 'alternates'))).toBe(false);
  });
});

describe('primary lookup for a release run from inside a lane', () => {
  it('reads the pool name from the lane path and finds the workspace checkout by repo name', () => {
    expect(poolNameFromLanePath('/w/.lanes/web-everything/lane-46/scripts')).toBe('web-everything');
    const ws = join(root, 'ws');
    mkRepo(join(ws, 'webeverything')); mkRepo(join(ws, 'other'));
    mkdirSync(join(ws, 'plain'), { recursive: true });
    const origins = { webeverything: 'git@github.com:chalbert/web-everything.git', other: 'git@github.com:x/other.git' };
    const found = findPrimaryForPool({ workspaceDir: ws, poolName: 'web-everything', readOrigin: (d) => origins[d.split('/').pop()] ?? null });
    expect(found.path).toBe(join(ws, 'webeverything'));
    expect(findPrimaryForPool({ workspaceDir: ws, poolName: 'missing', readOrigin: () => null })).toBeNull();
  });
});

describe('git-bounded', () => {
  it('kills the whole process group on timeout, including grandchildren', () => {
    const marker = join(root, 'grandchild.pid');
    const script = `sleep 300 & echo $! > ${marker}; wait`;
    const cmd = boundedGitCommand([], 1000);
    const res = spawnSync(process.execPath, [cmd.args[0], '--timeout-ms=1000', '--', 'sh', '-c', script], { encoding: 'utf8' });
    expect(res.status).toBe(124);
    const pid = Number(readFileSync(marker, 'utf8').trim());
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    expect(alive).toBe(false);
  });
  it('passes through the exit status of a fast command', () => {
    const cmd = boundedGitCommand([], 5000);
    expect(spawnSync(process.execPath, [cmd.args[0], '--timeout-ms=5000', '--', 'sh', '-c', 'exit 3']).status).toBe(3);
  });
});

describe('hardening', () => {
  it('does not treat another host or an unrelated chalbert repo as the same', () => {
    expect(sameRepoUrl('git@evil.example:web-everything/web-everything.git', 'git@github.com:web-everything/web-everything.git')).toBe(false);
    expect(canonicalRepoSlug('git@github.com:chalbert/plateau-app.git')).toBe('github.com/chalbert/plateau-app');
  });
  it('never writes through a symlinked alternates path', () => {
    const primary = mkRepo(join(root, 'primary')), lane = mkRepo(join(root, 'lane-1'));
    const outside = join(root, 'outside'); mkdirSync(outside);
    mkdirSync(join(lane, '.git', 'objects', 'info'), { recursive: true });
    symlinkSync(join(outside, 'x'), join(lane, '.git', 'objects', 'info', 'alternates'));
    expect(ensureLaneAlternates({ laneDir: lane, referencePath: primary }).status).toBe('skipped');
    expect(existsSync(join(outside, 'x'))).toBe(false);
  });
  it('never promotes a symlinked or wrong-owner checkout to primary', () => {
    const ws = join(root, 'ws'); mkdirSync(ws);
    const lane = mkRepo(join(root, '.lanes', 'web-everything', 'lane-3'));
    symlinkSync(lane, join(ws, 'sneaky'));
    mkRepo(join(ws, 'fork'));
    const origins = { sneaky: 'git@github.com:chalbert/web-everything.git', fork: 'git@evil.example:chalbert/web-everything.git' };
    expect(findPrimaryForPool({ workspaceDir: ws, poolName: 'web-everything', readOrigin: (d) => origins[d.split('/').pop()] })).toBeNull();
  });
});

describe('review round 2', () => {
  it('refuses a lane directory that is itself a symlink and a primary with a commondir', () => {
    const primary = mkRepo(join(root, 'primary')), real = mkRepo(join(root, 'real-lane'));
    symlinkSync(real, join(root, 'lane-9'));
    expect(ensureLaneAlternates({ laneDir: join(root, 'lane-9'), referencePath: primary }).status).toBe('skipped');
    const ws = join(root, 'ws'); mkdirSync(ws);
    mkRepo(join(ws, 'wt')); writeFileSync(join(ws, 'wt', '.git', 'commondir'), '../x');
    expect(findPrimaryForPool({ workspaceDir: ws, poolName: 'web-everything', readOrigin: () => 'git@github.com:chalbert/web-everything.git' })).toBeNull();
  });
  it('fills an existing EMPTY alternates file without truncating, and refuses a reference under .lanes', () => {
    const primary = mkRepo(join(root, 'primary')), lane = mkRepo(join(root, 'lane-1'));
    mkdirSync(join(lane, '.git', 'objects', 'info'), { recursive: true });
    writeFileSync(join(lane, '.git', 'objects', 'info', 'alternates'), '');
    expect(ensureLaneAlternates({ laneDir: lane, referencePath: primary }).status).toBe('added');
    const other = mkRepo(join(root, '.lanes', 'p', 'lane-2')), lane3 = mkRepo(join(root, 'lane-3'));
    expect(ensureLaneAlternates({ laneDir: lane3, referencePath: other }).status).toBe('skipped');
  });
});

it('refuses a reference whose .git/objects is a symlink into a lane', () => {
  const lane = mkRepo(join(root, 'lane-1')), victim = mkRepo(join(root, '.lanes', 'p', 'lane-2'));
  const ref = join(root, 'ref'); mkdirSync(join(ref, '.git'), { recursive: true });
  symlinkSync(join(victim, '.git', 'objects'), join(ref, '.git', 'objects'));
  expect(ensureLaneAlternates({ laneDir: lane, referencePath: ref }).status).toBe('skipped');
});
