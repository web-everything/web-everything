import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readHumanSurfaceNetFiles, resolveHumanSurfaceNetSetting } from '../human-surface-net-diff.mjs';

const head = 'a'.repeat(40), base = 'b'.repeat(40);
const row = { repo: 'o/n', number: 5381, headRefOid: head };
const settings = extra => resolveHumanSurfaceNetSetting({ env: {}, platform: {}, readFile: () => '{}', ...extra });

describe('review.humanSurfaceUsesNetDiff cascade', () => {
  it('defaults true and inherits the platform preference', () => {
    expect(settings()).toEqual({ value: true, source: 'standard' });
    expect(settings({ platform: { humanSurfaceUsesNetDiff: false } })).toEqual({ value: false, source: 'platform' });
  });
  it('tool and env override platform, and the cascade logs provenance', () => {
    const log = vi.fn();
    expect(settings({ platform: { humanSurfaceUsesNetDiff: false }, readFile: () => '{"humanSurfaceUsesNetDiff":true}' }))
      .toEqual({ value: true, source: 'tool' });
    expect(settings({ platform: { humanSurfaceUsesNetDiff: false }, readFile: () => '{"humanSurfaceUsesNetDiff":true}',
      env: { WE_REVIEW_HUMAN_SURFACE_USES_NET_DIFF: 'false', WE_POLICY_CASCADE_LOG: '1' }, log }))
      .toEqual({ value: false, source: 'env' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('humanSurfaceUsesNetDiff=false (env)'));
  });
  it('ignores invalid layers and unreadable settings', () => {
    expect(settings({ env: { WE_REVIEW_HUMAN_SURFACE_USES_NET_DIFF: 'bad' },
      platform: { humanSurfaceUsesNetDiff: false }, readFile: () => '{"humanSurfaceUsesNetDiff":"bad"}' }).value).toBe(false);
    expect(settings({ readFile: () => { throw new Error('offline'); } }).value).toBe(true);
  });
});

function gitFixture({ fetchFails = false, missingHead = false } = {}) {
  const git = vi.fn((_dir, args) => {
    expect(['checkout', 'reset', 'switch', 'restore', 'clean', 'read-tree', 'update-ref']).not.toContain(args[0]);
    if (args[0] === 'cat-file' && missingHead) throw new Error('missing head commit');
    if (args[0] === 'fetch' && fetchFails) throw new Error('offline');
    if (args[0] === 'merge-base') {
      if (missingHead) throw new Error('missing head commit');
      return base;
    }
    if (args[0] === 'diff') return 'M\0scripts/example.mjs\0';
    return '';
  });
  return { git, gitDirFor: () => '.', log: vi.fn() };
}

describe('strict net file read', () => {
  it('requires a fresh main fetch and diffs the exact pinned SHA from its merge-base', () => {
    const io = gitFixture();
    expect(readHumanSurfaceNetFiles(row, io)).toEqual({ ok: true, files: ['scripts/example.mjs'], added: [] });
    expect(io.git).toHaveBeenCalledWith('.', ['fetch', '--quiet', '--no-write-fetch-head', '--end-of-options', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
    expect(io.git).toHaveBeenCalledWith('.', ['merge-base', '--end-of-options', 'origin/main', head]);
    expect(io.git).toHaveBeenCalledWith('.', ['diff', '--no-ext-diff', '--no-renames', '--name-status', '-z', '--end-of-options', base, head]);
    expect(io.git.mock.calls.map(([, args]) => args[0])).toEqual(['cat-file', 'fetch', 'merge-base', 'diff']);
  });
  it('rejects fetch failure even if the cached refs can produce a net set', () => {
    expect(readHumanSurfaceNetFiles(row, gitFixture({ fetchFails: true })))
      .toEqual({ ok: false, reason: 'fetch failed' });
  });
  it.each(['fetch', 'merge-base', 'diff'])('keeps private %s diagnostics in local logs only', command => {
    const io = gitFixture();
    const normalGit = io.git.getMockImplementation();
    const diagnostic = "fatal: '/Users/operator/private' https://secret:password@example.com/repo.git";
    io.git.mockImplementation((dir, args) => {
      if (args[0] === command) throw Object.assign(new Error('git failed'), { stderr: diagnostic });
      return normalGit(dir, args);
    });
    expect(readHumanSurfaceNetFiles(row, io)).toEqual({ ok: false, reason: command === 'fetch' ? 'fetch failed' : 'net diff failed' });
    expect(io.log).toHaveBeenCalledWith(expect.stringContaining(diagnostic));
  });
  it('reports a missing head and requests its PR objects without switching branches', () => {
    const io = gitFixture({ missingHead: true });
    expect(readHumanSurfaceNetFiles(row, io)).toEqual({ ok: false, reason: 'net diff failed' });
    expect(io.git.mock.calls.find(([, args]) => args[0] === 'fetch')[1]).toContain('refs/pull/5381/head');
    expect(io.git.mock.calls.map(([, args]) => args[0])).toEqual(['cat-file', 'fetch', 'merge-base']);
  });
  it('reports unavailable checkout or head ID', () => {
    expect(readHumanSurfaceNetFiles(row, { gitDirFor: () => null }).ok).toBe(false);
    expect(readHumanSurfaceNetFiles({ ...row, headRefOid: null }, gitFixture()).ok).toBe(false);
  });
  it('real git: a main identity change inherited by the branch is absent from its net contribution', () => {
    const root = mkdtempSync(join(tmpdir(), 'human-surface-net-'));
    const upstream = join(root, 'upstream'), lane = join(root, 'lane');
    const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const commit = (dir, message) => {
      git(dir, ['add', '.']);
      git(dir, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', message]);
    };
    try {
      git(root, ['init', '-q', '-b', 'main', upstream]);
      writeFileSync(join(upstream, 'base.txt'), 'base\n');
      commit(upstream, 'initial');
      git(root, ['clone', '-q', upstream, lane]);
      mkdirSync(join(upstream, 'scripts/settings'), { recursive: true });
      writeFileSync(join(upstream, 'scripts/settings/delivery-identity.json'), 'new main identity\n');
      commit(upstream, 'main identity change');
      git(lane, ['fetch', '-q', 'origin']);
      git(lane, ['merge', '--ff-only', 'origin/main']);
      writeFileSync(join(lane, 'contribution.txt'), 'PR contribution\n');
      commit(lane, 'own change');
      const read = () => {
        const pinnedHead = git(lane, ['rev-parse', 'HEAD']).trim();
        // Keep staged, unstaged and untracked contents present during the shared-checkout read.
        writeFileSync(join(lane, 'base.txt'), 'staged content\n');
        git(lane, ['add', 'base.txt']);
        writeFileSync(join(lane, 'base.txt'), 'unstaged content\n');
        writeFileSync(join(lane, 'untracked.txt'), 'untracked content\n');
        const snapshot = () => ({
          head: git(lane, ['rev-parse', 'HEAD']), branch: git(lane, ['symbolic-ref', 'HEAD']),
          status: git(lane, ['status', '--porcelain=v1']), index: git(lane, ['diff', '--cached']),
          tracked: readFileSync(join(lane, 'base.txt'), 'utf8'), untracked: readFileSync(join(lane, 'untracked.txt'), 'utf8'),
        });
        const before = snapshot();
        const result = readHumanSurfaceNetFiles({ ...row, headRefOid: pinnedHead }, { git, gitDirFor: () => lane });
        expect(snapshot()).toEqual(before);
        return result;
      };
      expect(read().files).toEqual(['contribution.txt']);
      // The next fixture commit contains only the intended identity change.
      writeFileSync(join(lane, 'base.txt'), 'base\n');
      git(lane, ['add', 'base.txt']);
      rmSync(join(lane, 'untracked.txt'));
      writeFileSync(join(lane, 'scripts/settings/delivery-identity.json'), 'PR changes identity\n');
      commit(lane, 'own identity change');
      expect(read().files).toEqual(['contribution.txt', 'scripts/settings/delivery-identity.json']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
