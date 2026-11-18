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
  for (const branches of [['main'], null]) {
    it.each(['counted env', 'parameters env', 'global', 'system', 'xdg', 'included global', 'runner -c'])(
      `uses the effective destination from %s configuration (branches=${JSON.stringify(branches)})`,
      (source) => {
        const w = world();
        const mirror = join(w.root, 'mirror');
        git(w.root, 'clone', '-q', w.origin, mirror);
        writeFileSync(join(mirror, 'f'), 'mirror');
        git(mirror, 'commit', '-qam', 'mirror');
        const mirrorSha = git(mirror, 'rev-parse', 'main');
        let overrides = {};
        let configArgs = [];
        const invoke = (args, cwd) => execFileSync('git', [...configArgs, ...args], {
          cwd, env: { ...process.env, ...overrides }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        });
        const run = counting(invoke);
        const o = { cwd: w.a, stampDir: w.stampDir, run, branches, maxAgeMs: 60_000 };
        expect(fetchFresh(o).fetched).toBe(true);
        const key = `url.${mirror}.insteadOf`;
        const config = join(w.root, 'external-config');
        writeFileSync(config, `[url "${mirror}"]\n\tinsteadOf = ${w.origin}\n`);
        if (source === 'counted env') overrides = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: key, GIT_CONFIG_VALUE_0: w.origin };
        if (source === 'parameters env') overrides = { GIT_CONFIG_PARAMETERS: `'${key}=${w.origin}'` };
        if (source === 'global') overrides = { GIT_CONFIG_GLOBAL: config };
        if (source === 'system') overrides = { GIT_CONFIG_NOSYSTEM: '0', GIT_CONFIG_SYSTEM: config };
        if (source === 'xdg') {
          const xdg = join(w.root, 'xdg'); mkdirSync(join(xdg, 'git'), { recursive: true });
          writeFileSync(join(xdg, 'git', 'config'), `[include]\n\tpath = ${config}\n`);
          overrides = { GIT_CONFIG_GLOBAL: undefined, HOME: w.root, XDG_CONFIG_HOME: xdg };
        }
        if (source === 'included global') {
          const global = join(w.root, 'global-config');
          writeFileSync(global, `[include]\n\tpath = ${config}\n`);
          overrides = { GIT_CONFIG_GLOBAL: global };
        }
        if (source === 'runner -c') configArgs = ['-c', `${key}=${w.origin}`];

        // A separate read-only Git probe proves the destination changed before consulting the cache.
        expect(invoke(['remote', 'get-url', 'origin'], w.a).trim()).toBe(mirror);
        expect(fetchFresh(o)).toMatchObject({ fetched: true, skipped: false });
        expect(git(w.a, 'rev-parse', 'origin/main')).toBe(mirrorSha);
        expect(run.fetches()).toHaveLength(2);
        // Returning to the canonical configuration must restore the canonical identity too.
        overrides = {}; configArgs = [];
        expect(fetchFresh(o).key).not.toBeNull();
        expect(git(w.a, 'rev-parse', 'origin/main')).toBe(git(w.origin, 'rev-parse', 'main'));
      },
      60_000,
    );
  }

  it('keeps significant URL whitespace when a caller runner trims its output', () => {
    const w = world();
    let overrides = {};
    const run = counting((args, cwd) => execFileSync('git', args, {
      cwd, env: { ...process.env, ...overrides }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim());
    const o = { cwd: w.a, stampDir: w.stampDir, run, maxAgeMs: 60_000 };
    const keys = [];
    for (const suffix of ['', ' ']) {
      const mirror = join(w.root, `mirror${suffix}`);
      git(w.root, 'clone', '-q', w.origin, mirror);
      writeFileSync(join(mirror, 'f'), `mirror${suffix}`);
      git(mirror, 'commit', '-qam', `mirror${suffix}`);
      overrides = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${mirror}.insteadOf`, GIT_CONFIG_VALUE_0: w.origin };
      const result = fetchFresh(o);
      expect(result.fetched).toBe(true);
      keys.push(result.key);
      expect(git(w.a, 'rev-parse', 'origin/main')).toBe(git(mirror, 'rev-parse', 'main'));
    }
    expect(keys[0]).not.toBe(keys[1]);
  }, 60_000);

  it.each(['throw', 'empty', 'config throw', 'config truncated'])('fetches without cache reuse when effective configuration is unprovable: %s', (failure) => {
    const w = world();
    const run = counting((args, cwd) => {
      if (args[0] === 'remote' && args[1] === 'get-url' && !failure.startsWith('config')) {
        if (failure === 'throw') throw new Error('configuration unreadable');
        return '';
      }
      if (args[0] === 'config' && failure.startsWith('config')) {
        if (failure === 'config throw') throw new Error('configuration unreadable');
        return 'remote.origin.url\ntruncated';
      }
      return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    });
    const o = { cwd: w.a, stampDir: w.stampDir, run, maxAgeMs: 60_000 };
    expect(fetchFresh(o)).toMatchObject({ fetched: true, key: null });
    expect(fetchFresh(o)).toMatchObject({ fetched: true, key: null });
    expect(run.fetches()).toHaveLength(2);
  });

  it('a url rewrite (insteadOf) disables sharing: every call fetches', () => {
    const w = world(); const run = counting();
    git(w.a, 'config', 'url.file:///x/.insteadOf', 'file:///y/');
    const o = { cwd: w.a, stampDir: w.stampDir, run, maxAgeMs: 60_000 };
    fetchFresh(o); fetchFresh(o);
    expect(run.fetches()).toHaveLength(2);
  });
});
