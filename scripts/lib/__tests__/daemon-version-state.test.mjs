/**
 * @file scripts/lib/__tests__/daemon-version-state.test.mjs
 * @description Card 89 S2 — dormant module, no runtime consumer yet.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync,
  rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { BUILT_IN_DAEMON_VERSIONS_SETTINGS } from '../daemon-versions-settings.mjs';
import { carryUntrackedSidecars, linkVersionState, reportOutgoingDirt } from '../daemon-version-state.mjs';

const temps = [];
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function temp() {
  const dir = mkdtempSync(join(tmpdir(), 'daemon-version-state-'));
  temps.push(dir);
  return dir;
}
const runner = root => args => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
function git(root, ...args) {
  const result = runner(root)(args);
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
function write(root, path, content = path) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}
function repo() {
  const root = temp();
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'config', 'user.name', 'Version State Test');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'config', 'core.hooksPath', '/dev/null');
  write(root, 'tracked.txt', 'original');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'fixture');
  return root;
}
const read = (root, path) => readFileSync(join(root, path), 'utf8');

describe('linkVersionState', () => {
  it.each([false, true])('links every configured entry and stays clean (worktree=%s)', worktree => {
    const root = repo();
    const versionDir = worktree ? join(temp(), 'worktree') : root;
    if (worktree) git(root, 'worktree', 'add', '--detach', versionDir);
    const stateDir = temp();
    const statePaths = [...BUILT_IN_DAEMON_VERSIONS_SETTINGS.statePaths];
    const alert = vi.fn();
    const exclude = resolve(versionDir, git(versionDir, 'rev-parse', '--git-path', 'info/exclude'));
    writeFileSync(exclude, '# preserve without final newline');
    const options = { versionDir, stateDir, statePaths, alert };
    expect(linkVersionState(options)).toEqual({ linked: statePaths, merged: [], refused: [] });
    for (const path of statePaths) {
      expect(lstatSync(join(versionDir, path)).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(versionDir, path))).toBe(join(stateDir, path));
      expect(existsSync(join(stateDir, path))).toBe(false);
      expect(existsSync(dirname(join(stateDir, path)))).toBe(true);
    }
    expect(git(versionDir, 'status', '--porcelain')).toBe('');
    expect(linkVersionState(options)).toEqual({ linked: statePaths, merged: [], refused: [] });
    const lines = readFileSync(exclude, 'utf8').split('\n');
    expect(lines[0]).toBe('# preserve without final newline');
    for (const path of statePaths) expect(lines.filter(line => line === `/${path}`)).toHaveLength(1);
    expect(lines.filter(line => line.startsWith('/'))).toHaveLength(statePaths.length);
    expect(git(versionDir, 'status', '--porcelain')).toBe('');
    expect(alert).not.toHaveBeenCalled();
  });

  it('refuses a foreign dangling symlink, tracked file, tracked directory and missing tracked file', () => {
    const versionDir = repo();
    const stateDir = temp();
    write(versionDir, 'tracked-dir/entry');
    write(versionDir, 'missing.txt');
    git(versionDir, 'add', '.');
    git(versionDir, 'commit', '-m', 'tracked collisions');
    rmSync(join(versionDir, 'missing.txt'));
    const foreign = join(temp(), 'missing');
    symlinkSync(foreign, join(versionDir, 'foreign'));
    const statePaths = ['foreign', 'tracked.txt', 'tracked-dir', 'missing.txt'];
    const alert = vi.fn();
    expect(linkVersionState({ versionDir, stateDir, statePaths, alert }))
      .toEqual({ linked: [], merged: [], refused: statePaths });
    expect(readlinkSync(join(versionDir, 'foreign'))).toBe(foreign);
    expect(read(versionDir, 'tracked.txt')).toBe('original');
    expect(read(versionDir, 'tracked-dir/entry')).toBe('tracked-dir/entry');
    expect(existsSync(join(versionDir, 'missing.txt'))).toBe(false);
    for (const path of statePaths) expect(alert).toHaveBeenCalledWith('state-link-collision', { path });
  });

  it('merges missing nested entries and files while retaining target conflicts', () => {
    const versionDir = repo();
    const stateDir = temp();
    write(versionDir, '.state/nested/new', 'new');
    write(versionDir, '.state/nested/conflict', 'old');
    write(versionDir, '.state/type-conflict/child', 'old');
    write(versionDir, 'state.json', 'file');
    write(stateDir, '.state/nested/conflict', 'keep');
    write(stateDir, '.state/type-conflict', 'keep-file');
    write(stateDir, '.state/extra', 'extra');
    const alert = vi.fn();
    const statePaths = ['.state', 'state.json'];
    expect(linkVersionState({ versionDir, stateDir, statePaths, alert }))
      .toEqual({ linked: [], merged: statePaths, refused: [] });
    expect(read(stateDir, '.state/nested/new')).toBe('new');
    expect(read(stateDir, '.state/nested/conflict')).toBe('keep');
    expect(read(stateDir, '.state/type-conflict')).toBe('keep-file');
    expect(read(stateDir, '.state/extra')).toBe('extra');
    expect(read(stateDir, 'state.json')).toBe('file');
    for (const path of statePaths) {
      expect(readlinkSync(join(versionDir, path))).toBe(join(stateDir, path));
      expect(alert).toHaveBeenCalledWith('state-link-merged', { path });
    }
    expect(git(versionDir, 'status', '--porcelain')).toBe('');
  });
});

describe('carryUntrackedSidecars', () => {
  it('carries provisional sidecars, prunes main-proven births, and skips exact paths and descendants', () => {
    const fromRoot = repo();
    const toRoot = repo();
    const base = git(fromRoot, 'rev-parse', 'HEAD');
    write(fromRoot, 'backlog/123-landed.md', '---\nbornAs: xabc123\n---\nLanded\n');
    git(fromRoot, 'add', '.');
    git(fromRoot, 'commit', '-m', 'landed on main');
    const mainSha = git(fromRoot, 'rev-parse', 'HEAD');
    git(fromRoot, 'checkout', '--detach', base);
    write(fromRoot, 'backlog/xabc123-landed.md', 'old sidecar');
    write(fromRoot, 'backlog/xdef456-provisional.md', 'provisional');
    write(fromRoot, '.state/nested/file');
    write(fromRoot, 'skip.txt');
    write(fromRoot, '.state-extra', 'carry sibling');
    const alert = vi.fn();
    const result = carryUntrackedSidecars({ git: runner(fromRoot), fromRoot, toRoot, mainSha,
      alert, skipPaths: ['.state', 'skip.txt'] });
    expect(result).toEqual({ carried: ['.state-extra', 'backlog/xdef456-provisional.md'],
      skipped: ['.state/nested/file', 'skip.txt'], refused: [] });
    expect(read(toRoot, 'backlog/xdef456-provisional.md')).toBe('provisional');
    expect(read(fromRoot, 'backlog/xdef456-provisional.md')).toBe('provisional');
    expect(read(toRoot, '.state-extra')).toBe('carry sibling');
    expect(existsSync(join(toRoot, '.state'))).toBe(false);
    expect(existsSync(join(toRoot, 'skip.txt'))).toBe(false);
    expect(existsSync(join(fromRoot, 'backlog/xabc123-landed.md'))).toBe(false);
    expect(existsSync(join(toRoot, 'backlog/xabc123-landed.md'))).toBe(false);
    expect(alert).toHaveBeenCalledWith('backlog-sidecar-pruned', {
      path: 'backlog/xabc123-landed.md', hash: 'xabc123', landedPath: 'backlog/123-landed.md', mainSha,
    });
  });

  it('refuses existing files, dangling symlinks, and tracked but deleted destinations', () => {
    const fromRoot = repo();
    const toRoot = repo();
    git(fromRoot, 'rm', 'tracked.txt');
    write(fromRoot, 'tracked.txt', 'incoming');
    rmSync(join(toRoot, 'tracked.txt'));
    write(fromRoot, 'collision', 'incoming');
    write(toRoot, 'collision', 'keep');
    write(fromRoot, 'dangling', 'incoming');
    symlinkSync(join(toRoot, 'missing'), join(toRoot, 'dangling'));
    const alert = vi.fn();
    expect(carryUntrackedSidecars({ git: runner(fromRoot), fromRoot, toRoot, alert }))
      .toEqual({ carried: [], skipped: [], refused: ['collision', 'dangling', 'tracked.txt'] });
    expect(read(toRoot, 'collision')).toBe('keep');
    expect(lstatSync(join(toRoot, 'dangling')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(toRoot, 'tracked.txt'))).toBe(false);
    for (const path of ['collision', 'dangling', 'tracked.txt'])
      expect(alert).toHaveBeenCalledWith('untracked-collision', { path });
  });

  it.each([1, 2])('reports a failed untracked listing on call %s', failOn => {
    const fromRoot = repo();
    const toRoot = repo();
    write(fromRoot, 'extra');
    let calls = 0;
    const git = args => ++calls === failOn ? { status: 1, stdout: '' } : runner(fromRoot)(args);
    const alert = vi.fn();
    expect(carryUntrackedSidecars({ git, fromRoot, toRoot, alert }))
      .toEqual({ carried: [], skipped: [], refused: [] });
    expect(alert).toHaveBeenCalledWith('status-failed');
    expect(existsSync(join(toRoot, 'extra'))).toBe(false);
  });
});

describe('reportOutgoingDirt', () => {
  it('reports changed paths with whitespace and both rename names', () => {
    const root = repo();
    const alert = vi.fn();
    expect(reportOutgoingDirt({ git: runner(root), alert })).toEqual([]);
    expect(alert).not.toHaveBeenCalled();
    git(root, 'mv', 'tracked.txt', 'renamed file.txt');
    write(root, 'new\nfile.txt', 'new');
    const paths = reportOutgoingDirt({ git: runner(root), alert });
    expect(paths).toEqual(['renamed file.txt', 'tracked.txt', 'new\nfile.txt']);
    expect(alert).toHaveBeenCalledWith('version-dirty', { paths });
    git(root, 'reset', '--hard', 'HEAD');
    rmSync(join(root, 'new\nfile.txt'));
    write(root, 'tracked.txt', 'modified');
    expect(reportOutgoingDirt({ git: runner(root), alert })).toEqual(['tracked.txt']);
    rmSync(join(root, 'tracked.txt'));
    expect(reportOutgoingDirt({ git: runner(root), alert })).toEqual(['tracked.txt']);
  });

  it('alerts on status failure', () => {
    const alert = vi.fn();
    expect(reportOutgoingDirt({ git: runner(temp()), alert })).toEqual([]);
    expect(alert).toHaveBeenCalledWith('status-failed');
  });
});
