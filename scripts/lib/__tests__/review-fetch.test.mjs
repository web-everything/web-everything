import { it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { reviewFetchExec, withReviewFetchTick, resolveReviewFetchSettings } from '../review-fetch.mjs';

it('shares real branch fetches per clone and tick, targets a missing ref, and preserves diff output', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-fetch-'));
  const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    const origin = join(root, 'origin'); mkdirSync(origin);
    g(origin, 'init', '-q', '-b', 'main');
    g(origin, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'base');
    const base = g(origin, 'rev-parse', 'HEAD');
    g(origin, 'checkout', '-q', '-b', 'lane/a');
    writeFileSync(join(origin, 'feature.txt'), 'review me\n');
    g(origin, 'add', 'feature.txt');
    g(origin, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'feature');
    g(origin, 'checkout', '-q', 'main');
    g(origin, 'branch', 'lane/b');
    const expectedDiff = execFileSync('git', ['diff', 'main', 'lane/a'], { cwd: origin, encoding: 'utf8' });
    g(origin, 'update-ref', 'refs/pull/7/head', base);
    const clones = ['one', 'two'].map(name => {
      const dir = join(root, name); mkdirSync(dir); g(dir, 'init', '-q');
      g(dir, 'remote', 'add', 'origin', '../origin'); return dir;
    });
    const fetches = [];
    const exec = reviewFetchExec((cmd, args, opts) => {
      if (args[0] === 'fetch') fetches.push({ cwd: opts.cwd, args });
      return execFileSync(cmd, args, opts);
    });
    const check = (cwd, head) => {
      exec('git', ['fetch', '--quiet', '--no-tags', '--end-of-options', 'origin', '+main:refs/remotes/origin/main', `+${head}:refs/remotes/origin/${head}`], { cwd, encoding: 'utf8' });
      return exec('git', ['diff', 'origin/main', `origin/${head}`], { cwd, encoding: 'utf8' });
    };
    withReviewFetchTick(() => {
      expect(check(clones[0], 'lane/a')).toBe(expectedDiff);
      expect(check(clones[0], 'lane/b')).toBe('');
      expect(fetches).toHaveLength(1);
      expect(check(clones[1], 'lane/a')).toBe(expectedDiff);
      // This branch appeared AFTER the shared fetch: only it gets fetched, not main again.
      g(origin, 'branch', 'lane/new');
      expect(check(clones[0], 'lane/new')).toBe('');
      expect(fetches.at(-1).args.slice(5)).toEqual(['+lane/new:refs/remotes/origin/lane/new']);
      exec('git', ['fetch', '--quiet', '--end-of-options', 'origin', '+refs/pull/7/head:refs/already-landed/pr/7'], { cwd: clones[0], encoding: 'utf8' });
      expect(g(clones[0], 'rev-parse', 'refs/already-landed/pr/7')).toBe(base);
      expect(fetches).toHaveLength(4);
    }, { sharedPerTick: true });
    withReviewFetchTick(() => check(clones[0], 'lane/b'), { sharedPerTick: true });
    expect(fetches).toHaveLength(5);
    g(origin, 'branch', '-d', 'lane/b');
    withReviewFetchTick(() => {
      expect(() => check(clones[0], 'lane/b')).toThrow();
      // A cached local tracking ref for the deleted branch cannot attest fetch success.
      expect(g(clones[0], 'rev-parse', 'origin/lane/b')).toBe(base);
      expect(fetches.at(-1).args.slice(5)).toEqual(['+lane/b:refs/remotes/origin/lane/b']);
    }, { sharedPerTick: true });
    withReviewFetchTick(() => { check(clones[0], 'lane/a'); check(clones[0], 'lane/a'); }, { sharedPerTick: false });
    check(clones[0], 'lane/a'); // outside a tick is unchanged too
    expect(fetches).toHaveLength(10);
  } finally { rmSync(root, { recursive: true }); }
});

it('keeps fetch failure behavior and never treats a failed shared fetch as coverage', () => {
  const run = vi.fn(() => { throw new Error('unavailable'); });
  const exec = reviewFetchExec(run);
  withReviewFetchTick(() => {
    for (const head of ['main', 'lane/a']) expect(() => exec('git', ['fetch', '-q', 'origin', head])).toThrow('unavailable');
  }, { sharedPerTick: true });
  expect(run.mock.calls.map(c => c[1])).toEqual([
    ['fetch', '--verbose', '--porcelain', '--no-tags', '--no-write-fetch-head', '--end-of-options', 'origin', '+refs/heads/*:refs/remotes/origin/*'],
    ['fetch', '-q', 'origin', 'main'], ['fetch', '-q', 'origin', 'lane/a'],
  ]);
});

it('resolves the boolean through all cascade layers and logs its source', () => {
  const log = vi.fn();
  const resolve = o => resolveReviewFetchSettings({ env: {}, review: {}, platform: {}, ...o });
  expect(resolve().value.sharedPerTick).toBe(true);
  expect(resolve({ platform: { fetch: { sharedPerTick: false } } }).sources.sharedPerTick).toBe('platform');
  expect(resolve({ platform: { fetch: { sharedPerTick: false } }, review: { fetch: { sharedPerTick: true } } }).sources.sharedPerTick).toBe('tool');
  const r = resolve({ env: { WE_REVIEW_FETCH_SHARED_PER_TICK: 'false', WE_POLICY_CASCADE_LOG: '1' }, log });
  expect(r.value.sharedPerTick).toBe(false);
  expect(r.sources.sharedPerTick).toBe('env');
  expect(log).toHaveBeenCalledWith(expect.stringContaining('review.fetch: sharedPerTick=false (env)'));
  expect(resolve({ env: { WE_REVIEW_FETCH_SHARED_PER_TICK: 'invalid' }, review: { fetch: { sharedPerTick: 'invalid' } } }).value.sharedPerTick).toBe(true);
});
