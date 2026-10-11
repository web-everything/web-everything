import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearRestackEquivalenceCache, isRestackOf } from '../restack-equivalence.mjs';

let root, fromHead, oldMain;
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (file, content) => {
  writeFileSync(join(root, file), content);
  git('add', file);
  git('commit', '-m', file);
  return git('rev-parse', 'HEAD');
};
const check = (extra = {}) => isRestackOf({ root, fromHead, toHead: git('rev-parse', 'HEAD'), ...extra });
const mergeMain = () => git('merge', '--no-ff', '-m', 'restack', 'main');

beforeEach(() => {
  clearRestackEquivalenceCache();
  root = mkdtempSync(join(tmpdir(), 'restack-equivalence-'));
  git('init', '-b', 'main');
  git('config', 'user.name', 'Restack Test');
  git('config', 'user.email', 'restack@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  oldMain = commit('base.txt', 'old main\n');
  git('checkout', '-b', 'pr');
  fromHead = commit('pr.txt', 'own contribution\n');
  git('checkout', 'main');
  commit('base.txt', 'new main\n');
  git('checkout', 'pr');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('isRestackOf', () => {
  it('accepts a conflict-free merge of the base with the same own contribution', () => {
    mergeMain();
    expect(check()).toBe(true);
  });
  it('rejects a merge that also edits the PR contribution', () => {
    git('merge', '--no-ff', '--no-commit', 'main');
    commit('pr.txt', 'changed contribution\n');
    expect(check()).toBe(false);
  });
  it('rejects a new own non-merge commit after the merge', () => {
    mergeMain();
    commit('extra.txt', 'own extra\n');
    expect(check()).toBe(false);
  });
  it('rejects a merge whose first-parent chain does not start at from', () => {
    git('checkout', 'main');
    git('merge', '--no-ff', '-m', 'reversed merge', 'pr');
    expect(check()).toBe(false);
  });
  it('rejects heads without the required ancestry', () => {
    expect(check({ toHead: git('rev-parse', 'main') })).toBe(false);
  });
  it('rejects unknown commit objects without fetching', () => {
    const exec = vi.fn(execFileSync);
    expect(check({ toHead: 'f'.repeat(40), exec })).toBe(false);
    expect(exec.mock.calls.some(([, args]) => args.includes('fetch'))).toBe(false);
  });
  it('rejects identical heads', () => expect(check()).toBe(false));
  it('accepts two successive base merges', () => {
    mergeMain();
    git('checkout', 'main');
    commit('base.txt', 'newer main\n');
    git('checkout', 'pr');
    mergeMain();
    expect(check()).toBe(true);
  });
  it('rejects an empty PR contribution', () => {
    git('checkout', '-b', 'empty-pr', oldMain);
    const emptyHead = git('rev-parse', 'HEAD');
    mergeMain();
    expect(check({ fromHead: emptyHead })).toBe(false);
  });
  it('uses only local commit objects and never resolves refs or invokes network verbs', () => {
    mergeMain();
    const exec = vi.fn(execFileSync);
    expect(check({ exec })).toBe(true);
    for (const [, args] of exec.mock.calls) {
      expect(['cat-file', 'merge-base', 'rev-list', 'show', 'diff']).toContain(args[2]);
      expect(args.some((arg) => /refs\/remotes\/|origin\//.test(arg))).toBe(false);
    }
  });
  it('rejects malformed heads', () => {
    mergeMain();
    const exec = vi.fn(execFileSync);
    expect(check({ fromHead: 'main', exec })).toBe(false);
    expect(check({ toHead: null, exec })).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });
  it('rejects diff output that is not a raw patch', () => {
    mergeMain();
    const exec = (command, args, options) => args[2] === 'diff'
      ? 'unexpected output' : execFileSync(command, args, options);
    expect(check({ exec })).toBe(false);
  });
  it('memoizes results and can clear them', () => {
    mergeMain();
    const exec = vi.fn(execFileSync);
    expect(check({ exec })).toBe(true);
    const calls = exec.mock.calls.length;
    expect(check({ exec })).toBe(true);
    expect(exec).toHaveBeenCalledTimes(calls);
    clearRestackEquivalenceCache();
    expect(check({ exec })).toBe(true);
    expect(exec.mock.calls.length).toBeGreaterThan(calls);
  });
  it('fails closed on a runner error or unexpected output', () => {
    mergeMain();
    expect(check({ exec: () => { throw new Error('timeout'); } })).toBe(false);
    clearRestackEquivalenceCache();
    expect(check({ exec: () => 'unexpected output' })).toBe(false);
  });
});
