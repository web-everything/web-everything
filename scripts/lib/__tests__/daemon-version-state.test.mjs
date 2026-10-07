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

  it.each([
    ['newline plus glob', 'x\n*'],
    ['glob star', 'a*b'],
    ['glob question', 'a?b'],
    ['glob bracket', 'a[b]'],
    ['backslash escape', 'a\\b'],
    ['carriage return', 'a\rb'],
    ['control character', 'a\u0007b'],
    ['trailing space', 'state '],
    ['parent traversal', '../escape'],
    ['inner parent traversal', 'a/../../escape'],
    ['absolute path', '/etc/escape'],
    ['empty segment', 'a//b'],
    ['dot segment', './a'],
    ['empty path', ''],
  ])('refuses an unsafe state path before touching anything (%s)', (_name, path) => {
    const versionDir = repo();
    const stateDir = temp();
    const exclude = resolve(versionDir, git(versionDir, 'rev-parse', '--git-path', 'info/exclude'));
    const before = existsSync(exclude) ? readFileSync(exclude, 'utf8') : null;
    const alert = vi.fn();
    expect(linkVersionState({ versionDir, stateDir, statePaths: [path, 'ok'], alert }))
      .toEqual({ linked: ['ok'], merged: [], refused: [path] });
    expect(alert).toHaveBeenCalledWith('state-link-invalid', { path });
    expect(existsSync(join(dirname(stateDir), 'escape'))).toBe(false);
    const lines = readFileSync(exclude, 'utf8').split('\n');
    expect(lines.filter(line => line.startsWith('/'))).toEqual(['/ok']);
    expect(before === null || path === '' || !before.includes(path)).toBe(true);
    expect(git(versionDir, 'status', '--porcelain')).toBe('');
  });

  it('refuses a state path whose parent directory is a symlink and leaves the pointee alone', () => {
    const versionDir = repo();
    const stateDir = temp();
    const outside = temp();
    write(outside, 'victim/keep', 'keep');
    symlinkSync(outside, join(versionDir, '.claude'));
    mkdirSync(join(versionDir, 'plain-parent'));
    const alert = vi.fn();
    const statePaths = ['.claude/victim', '.claude/new', 'plain-parent/ok'];
    expect(linkVersionState({ versionDir, stateDir, statePaths, alert }))
      .toEqual({ linked: ['plain-parent/ok'], merged: [], refused: ['.claude/victim', '.claude/new'] });
    expect(read(outside, 'victim/keep')).toBe('keep');
    expect(existsSync(join(outside, 'new'))).toBe(false);
    expect(lstatSync(join(versionDir, '.claude')).isSymbolicLink()).toBe(true);
    for (const path of ['.claude/victim', '.claude/new'])
      expect(alert).toHaveBeenCalledWith('state-link-invalid', { path });
  });

  it.each(['.git', '.GIT/hooks', '.git/info', 'a/.Git'])('refuses a reserved .git state path (%s) and keeps the repository', path => {
    const versionDir = repo();
    const stateDir = temp();
    const alert = vi.fn();
    expect(linkVersionState({ versionDir, stateDir, statePaths: [path], alert }))
      .toEqual({ linked: [], merged: [], refused: [path] });
    expect(lstatSync(join(versionDir, '.git')).isDirectory()).toBe(true);
    expect(git(versionDir, 'status', '--porcelain')).toBe('');
    expect(alert).toHaveBeenCalledWith('state-link-invalid', { path });
  });

  it.each([[['.claude/x.json', '.claude']], [['.claude', '.claude/x.json']]])(
    'refuses overlapping state paths in either order instead of linking a path into itself (%j)', statePaths => {
      const versionDir = repo();
      const stateDir = temp();
      const alert = vi.fn();
      expect(linkVersionState({ versionDir, stateDir, statePaths: [...statePaths, 'other'], alert }))
        .toEqual({ linked: ['other'], merged: [], refused: statePaths });
      expect(existsSync(join(versionDir, '.claude'))).toBe(false);
      for (const path of statePaths) expect(alert).toHaveBeenCalledWith('state-link-invalid', { path });
    });

  it('refuses a state directory holding a fifo instead of hanging, and removes nothing', () => {
    const versionDir = repo();
    const stateDir = temp();
    write(versionDir, '.op/kept', 'kept');
    expect(spawnSync('mkfifo', [join(versionDir, '.op/pipe')]).status).toBe(0);
    const alert = vi.fn();
    expect(linkVersionState({ versionDir, stateDir, statePaths: ['.op'], alert }))
      .toEqual({ linked: [], merged: [], refused: ['.op'] });
    expect(read(versionDir, '.op/kept')).toBe('kept');
    expect(lstatSync(join(versionDir, '.op')).isSymbolicLink()).toBe(false);
    expect(existsSync(join(stateDir, '.op'))).toBe(false);
    expect(alert).toHaveBeenCalledWith('state-link-invalid', { path: '.op' });
  });

  it('refuses a state path whose parent is a regular file instead of throwing', () => {
    const versionDir = repo();
    const stateDir = temp();
    write(versionDir, 'blocker', 'file');
    const alert = vi.fn();
    expect(linkVersionState({ versionDir, stateDir, statePaths: ['blocker/child'], alert }))
      .toEqual({ linked: [], merged: [], refused: ['blocker/child'] });
    expect(alert).toHaveBeenCalledWith('state-link-invalid', { path: 'blocker/child' });
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

  it('carries untracked source symlinks as symlinks (valid, dangling, to a directory) without reading the target', () => {
    const fromRoot = repo();
    const toRoot = repo();
    const outside = temp();
    write(outside, 'secret', 'credentials');
    mkdirSync(join(outside, 'dir'));
    symlinkSync(join(outside, 'secret'), join(fromRoot, 'valid'));
    symlinkSync(join(outside, 'missing'), join(fromRoot, 'dangling'));
    symlinkSync(join(outside, 'dir'), join(fromRoot, 'to-dir'));
    mkdirSync(join(fromRoot, 'nested'));
    symlinkSync('../relative-target', join(fromRoot, 'nested/relative'));
    write(fromRoot, 'plain', 'regular');
    const alert = vi.fn();
    const result = carryUntrackedSidecars({ git: runner(fromRoot), fromRoot, toRoot, alert });
    expect(result).toEqual({ carried: ['dangling', 'nested/relative', 'plain', 'to-dir', 'valid'],
      skipped: [], refused: [] });
    for (const [name, target] of [['valid', join(outside, 'secret')], ['dangling', join(outside, 'missing')],
      ['to-dir', join(outside, 'dir')], ['nested/relative', '../relative-target']]) {
      expect(lstatSync(join(toRoot, name)).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(toRoot, name))).toBe(target);
    }
    expect(lstatSync(join(toRoot, 'plain')).isSymbolicLink()).toBe(false);
    expect(read(toRoot, 'plain')).toBe('regular');
    expect(alert).not.toHaveBeenCalled();
  });

  it('refuses a nested-repo directory entry and keeps carrying the rest', () => {
    const fromRoot = repo();
    const toRoot = repo();
    const nested = join(fromRoot, 'vendored');
    mkdirSync(nested);
    git(nested, 'init', '-b', 'main');
    write(nested, 'file', 'inside');
    write(fromRoot, 'zz-after', 'after');
    const alert = vi.fn();
    const result = carryUntrackedSidecars({ git: runner(fromRoot), fromRoot, toRoot, alert });
    expect(result.carried).toEqual(['zz-after']);
    expect(result.refused).toEqual(['vendored/']);
    expect(existsSync(join(toRoot, 'vendored'))).toBe(false);
    expect(read(toRoot, 'zz-after')).toBe('after');
    expect(alert).toHaveBeenCalledWith('untracked-unsupported', { path: 'vendored/' });
  });

  it('refuses an untracked entry whose destination parent is a symlink or a file, and keeps carrying', () => {
    const fromRoot = repo();
    const toRoot = repo();
    const outside = temp();
    write(fromRoot, 'link/x', 'payload');
    write(fromRoot, 'file/x', 'payload');
    write(fromRoot, 'zz-after', 'after');
    symlinkSync(outside, join(toRoot, 'link'));
    write(toRoot, 'file', 'tracked-or-not regular file');
    const alert = vi.fn();
    const result = carryUntrackedSidecars({ git: runner(fromRoot), fromRoot, toRoot, alert });
    expect(result).toEqual({ carried: ['zz-after'], skipped: [], refused: ['file/x', 'link/x'] });
    expect(existsSync(join(outside, 'x'))).toBe(false);
    expect(read(toRoot, 'file')).toBe('tracked-or-not regular file');
    for (const path of ['file/x', 'link/x']) expect(alert).toHaveBeenCalledWith('untracked-unsupported', { path });
  });

  it('refuses an untracked entry that vanished before the copy instead of throwing', () => {
    const fromRoot = repo();
    const toRoot = repo();
    write(fromRoot, 'gone', 'x');
    write(fromRoot, 'stays', 'y');
    let listings = 0;
    const git = args => {
      const out = runner(fromRoot)(args);
      if (args[0] === 'ls-files' && ++listings === 2) rmSync(join(fromRoot, 'gone'));
      return out;
    };
    const alert = vi.fn();
    const result = carryUntrackedSidecars({ git, fromRoot, toRoot, alert });
    expect(result.carried).toEqual(['stays']);
    expect(result.refused).toEqual(['gone']);
    expect(alert).toHaveBeenCalledWith('untracked-unsupported', { path: 'gone' });
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
