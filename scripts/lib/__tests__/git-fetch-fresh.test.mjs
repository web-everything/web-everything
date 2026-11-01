import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchFresh, objectStoreOf, resolveFetchFreshSettings } from '../git-fetch-fresh.mjs';

const dirs = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'gff-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** origin (with main + 5 lane branches) and two clones: A owns its store, B borrows A's via alternates. */
function world() {
  const root = tmp();
  const origin = join(root, 'origin'); mkdirSync(origin);
  git(origin, 'init', '-q', '-b', 'main');
  writeFileSync(join(origin, 'f'), '1'); git(origin, 'add', '.'); git(origin, 'commit', '-qm', 'one');
  for (let i = 0; i < 5; i += 1) git(origin, 'branch', `lane/b${i}`);
  const a = join(root, 'a'); git(root, 'clone', '-q', origin, a);
  const b = join(root, 'b'); git(root, 'clone', '-q', '--reference', a, origin, b);
  const advance = (msg) => { writeFileSync(join(origin, 'f'), msg); git(origin, 'commit', '-qam', msg); return git(origin, 'rev-parse', 'main'); };
  return { root, origin, a, b, advance, stampDir: join(root, 'stamps') };
}
const counting = (cwdRun = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) => {
  const calls = [];
  const run = (args, cwd) => { calls.push(args); return cwdRun(args, cwd); };
  run.fetches = () => calls.filter((c) => c[0] === 'fetch');
  return run;
};

describe('fetchFresh', () => {
  it('skips a repeat fetch inside the window and refetches after it', () => {
    const w = world(); let t = 1000; const run = counting();
    const o = { cwd: w.a, stampDir: w.stampDir, run, now: () => t, maxAgeMs: 60_000 };
    expect(fetchFresh(o)).toMatchObject({ fetched: true });
    t += 59_999;
    expect(fetchFresh(o)).toMatchObject({ skipped: true });
    expect(run.fetches()).toHaveLength(1);
    t += 1;
    expect(fetchFresh(o)).toMatchObject({ fetched: true });
    expect(run.fetches()).toHaveLength(2);
  });

  it('fetches only the named branches, never all remote heads', () => {
    const w = world(); const run = counting();
    fetchFresh({ cwd: w.a, stampDir: w.stampDir, run, branches: ['main'] });
    expect(run.fetches()[0]).toEqual(['fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
    fetchFresh({ cwd: w.a, stampDir: w.stampDir, run, branches: ['lane/b3', 'main'], maxAgeMs: 0 });
    expect(run.fetches()[1].slice(3)).toEqual(['+refs/heads/lane/b3:refs/remotes/origin/lane/b3', '+refs/heads/main:refs/remotes/origin/main']);
  });

  it('lanes sharing an alternate share freshness and the skipping lane still sees the new main', () => {
    const w = world(); expect(objectStoreOf(w.b)).toBe(objectStoreOf(w.a));
    const sha = w.advance('two'); const run = counting();
    fetchFresh({ cwd: w.a, stampDir: w.stampDir, run, maxAgeMs: 60_000 });
    expect(git(w.b, 'rev-parse', 'origin/main')).not.toBe(sha);
    const r = fetchFresh({ cwd: w.b, stampDir: w.stampDir, run, maxAgeMs: 60_000 });
    expect(r.skipped).toBe(true);
    expect(run.fetches()).toHaveLength(1);
    expect(git(w.b, 'rev-parse', 'origin/main')).toBe(sha);
  });

  it('never caches a failed fetch', () => {
    const w = world(); let fail = true;
    const run = counting((args, cwd) => { if (fail && args[0] === 'fetch') throw new Error('offline'); return execFileSync('git', args, { cwd, encoding: 'utf8' }); });
    const o = { cwd: w.a, stampDir: w.stampDir, run, maxAgeMs: 60_000 };
    expect(() => fetchFresh(o)).toThrow('offline');
    expect(() => fetchFresh(o)).toThrow('offline');
    fail = false;
    expect(fetchFresh(o).fetched).toBe(true);
    expect(run.fetches()).toHaveLength(3);
  });

  it('does not skip on an incomplete stamp, or when the stamped object is missing locally', () => {
    const w = world(); const run = counting(); let t = 0;
    const o = { cwd: w.a, stampDir: w.stampDir, run, now: () => t, maxAgeMs: 60_000 };
    fetchFresh(o);
    const stampFile = join(w.stampDir, readdirSync(w.stampDir)[0]);
    writeFileSync(stampFile, JSON.stringify({ at: 0, refs: {} }));
    expect(fetchFresh(o).fetched).toBe(true);
    writeFileSync(stampFile, JSON.stringify({ at: 0, refs: { 'refs/remotes/origin/main': 'f'.repeat(40) } }));
    expect(fetchFresh(o).fetched).toBe(true);
  });

  it('a different remote url under the same store never shares a stamp', () => {
    const w = world(); const run = counting(); const o = { stampDir: w.stampDir, run, maxAgeMs: 60_000 };
    fetchFresh({ ...o, cwd: w.a });
    git(w.b, 'remote', 'set-url', 'origin', w.a);
    expect(fetchFresh({ ...o, cwd: w.b }).fetched).toBe(true);
  });

  it('wide fetch (branches:null) is throttled per clone only', () => {
    const w = world(); const run = counting();
    const o = { cwd: w.a, stampDir: w.stampDir, run, branches: null, maxAgeMs: 60_000 };
    fetchFresh(o); fetchFresh(o);
    expect(run.fetches()).toEqual([['fetch', '--quiet', 'origin']]);
    expect(fetchFresh({ ...o, cwd: w.b }).fetched).toBe(true);
  });
});

describe('window policy', () => {
  it('defaults to 60 s, env overrides, invalid env is ignored', () => {
    expect(resolveFetchFreshSettings({ env: {}, tool: undefined, platform: undefined }).value.maxAgeSeconds).toBe(60);
    expect(resolveFetchFreshSettings({ env: { WE_GIT_FETCH_FRESH_SECONDS: '5' }, tool: undefined, platform: undefined }).value.maxAgeSeconds).toBe(5);
    expect(resolveFetchFreshSettings({ env: { WE_GIT_FETCH_FRESH_SECONDS: 'x' }, tool: undefined, platform: undefined }).value.maxAgeSeconds).toBe(60);
  });
});

describe('identity is unprovable', () => {
  it('a url rewrite (insteadOf) disables sharing: every call fetches', () => {
    const w = world(); const run = counting();
    git(w.a, 'config', 'url.file:///x/.insteadOf', 'file:///y/');
    const o = { cwd: w.a, stampDir: w.stampDir, run, maxAgeMs: 60_000 };
    fetchFresh(o); fetchFresh(o);
    expect(run.fetches()).toHaveLength(2);
  });
});
