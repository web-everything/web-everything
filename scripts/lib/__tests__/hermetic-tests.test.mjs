/** @file hermetic-tests.test.mjs — the hermetic-tests decision, shims, guard and declared settings (card xcu4cqf). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realHomedir, setupHermeticTestFile } from '../hermetic-tests-vitest.mjs';
import {
  DEBT_ENV, GH_FIXTURE_ENV, HERMETIC_ENV, HERMETIC_MODE_ENV, HermeticAccessError, LIVE_ACCESS_MESSAGE, LIVE_GITHUB_ENV_KEYS, REAL_REPOS_ENV, REPORT_FILE_ENV, TEST_ID_ENV, TEST_NAME_ENV,
  VIOLATIONS_DIR_ENV, VIOLATIONS_FILE, buildGuardContext, classifyFetchUrl, classifyFsPath, classifyGitArgs,
  fakeGhScript, fakeHomeEnv, hermeticDebtFiles, gitShimScript, gitTargetDir, urlToFsPath, hermeticMode, installHermeticGuards, isHermetic, liveSuiteFiles,
  loadHermeticSettings, parseHermeticSettings, parseViolationLog,
} from '../hermetic-tests.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const HOME = '/home/op';
const SETTINGS = {
  liveSuite: { schedule: { cron: '0 * * * *', intervalHours: 1 }, tests: [] },
  guardedRoots: [
    { id: 'conveyor-state', path: '~/.claude/daemon-self-sync-state' },
    { id: 'lane-pool', path: '~/workspace/.lanes' },
    { id: 'primary-backlog', path: '~/workspace/webeverything/backlog' },
  ],
  ambientRootEnv: ['CONVEYOR_STATE_ROOT'],
  siblingRepos: ['frontierui'],
};

describe('hermetic mode switch', () => {
  it('is ON unless explicitly "0"', () => {
    expect(isHermetic({})).toBe(true);
    expect(isHermetic({ [HERMETIC_ENV]: '1' })).toBe(true);
    expect(isHermetic({ [HERMETIC_ENV]: '0' })).toBe(false);
  });
  it('report mode is a local diagnostic only — CI always enforces', () => {
    expect(hermeticMode({})).toBe('enforce');
    expect(hermeticMode({ WE_HERMETIC_MODE: 'report' })).toBe('report');
    expect(hermeticMode({ WE_HERMETIC_MODE: 'report', CI: 'true' })).toBe('enforce');
    expect(hermeticMode({ WE_HERMETIC_MODE: 'report', GITHUB_ACTIONS: 'true' })).toBe('enforce');
  });
});

describe('fs classification', () => {
  const ctx = buildGuardContext({ home: HOME, repoRoot: `${HOME}/workspace/.lanes/web-everything/lane-2`, settings: SETTINGS, ambient: { CONVEYOR_STATE_ROOT: '/srv/state' } });
  it.each([
    [`${HOME}/.claude/daemon-self-sync-state/conveyor-state/queue.json`, 'conveyor-state'],
    [`${HOME}/workspace/.lanes/web-everything/lane-7/backlog/x.md`, 'lane-pool'],
    [`${HOME}/workspace/.lanes/web-everything/.free-lanes.json`, 'lane-pool'],
    [`${HOME}/workspace/webeverything/backlog/4382-x.md`, 'primary-backlog'],
    ['/srv/state/queue.json', 'env:CONVEYOR_STATE_ROOT'],
  ])('%s is live (%s)', (p, id) => {
    expect(classifyFsPath(p, ctx)).toMatchObject({ id });
  });
  it.each([
    `${HOME}/workspace/.lanes/web-everything/lane-2/backlog/4382-x.md`, // the checkout under test
    `${HOME}/workspace/.lanes/web-everything/frontierui/plugs/index.ts`, // its sibling repo
    `${HOME}/workspace/.lanes/web-everything/lane-7/node_modules/x/index.js`, // module resolution
    `${HOME}/.claude/daemon-self-sync-state-not/x`, // a prefix, not the dir
    '/tmp/we-vitest/x/daemon-state/queue.json',
  ])('%s is not live', (p) => {
    expect(classifyFsPath(p, ctx)).toBeNull();
  });
  it('the primary checkout under test is exempt from its own backlog guard', () => {
    const own = buildGuardContext({ home: HOME, repoRoot: `${HOME}/workspace/webeverything`, settings: SETTINGS });
    expect(classifyFsPath(`${HOME}/workspace/webeverything/backlog/4382-x.md`, own)).toBeNull();
  });
});

// One case table drives BOTH the JS rule and the generated sh shim, so they cannot drift.
const GIT_CASES = [
  [['ls-tree', '--name-only', 'origin/main', 'backlog/'], 'origin/main'],
  [['show', 'origin/main:backlog/4382-x.md'], 'origin/main:backlog/4382-x.md'],
  [['rev-list', 'HEAD..origin/main'], 'HEAD..origin/main'],
  [['fetch', '-q', 'origin', 'main'], 'fetch'],
  [['-C', '.', 'ls-remote', 'origin'], 'ls-remote'],
  [['rev-parse', '@{u}'], '@{u}'],
  [['log', 'refs/remotes/origin/main'], 'refs/remotes/origin/main'],
  [['-c', 'core.x=1', 'push', 'origin', 'HEAD'], 'push'],
  [['status', '--porcelain'], null],
  [['ls-files', '-z'], null],
  [['show', 'HEAD:backlog/x.md'], null],
  [['-c', 'origin/main=1', 'status'], null],
  [['commit', '-m', 'fix'], null],
  [['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], null],
  [['ls-remote', '--heads', '/tmp/fixture/origin.git'], null],
  [['ls-remote', 'git@example.invalid:o/r.git'], null],
  [['ls-remote', 'https://github.com/o/r.git'], 'ls-remote'],
  [['fetch', '--quiet', '--end-of-options', 'origin', '+main:refs/remotes/origin/main'], '+main:refs/remotes/origin/main'],
];

describe('git remote-read classification', () => {
  it.each(GIT_CASES)('%j → %s', (args, hit) => {
    expect(classifyGitArgs(args)?.hit ?? null).toBe(hit);
  });
  it('resolves -C relative to cwd', () => {
    expect(gitTargetDir(['-C', 'sub', 'status'], '/r')).toBe('/r/sub');
    expect(gitTargetDir(['status'], '/r')).toBe('/r');
  });
  it('a --git-dir throwaway repo is the target, whatever the cwd', () => {
    expect(gitTargetDir(['--git-dir', '/tmp/a/.git', 'rev-parse', 'origin/main'], '/r')).toBe('/tmp/a/.git');
    expect(gitTargetDir(['--git-dir=/tmp/b', '-c', 'x=y', 'log', 'origin/main'], '/r')).toBe('/tmp/b');
    expect(gitTargetDir(['status'], '/r', { GIT_DIR: '/tmp/c' })).toBe('/tmp/c');
  });
  it('--work-tree never picks the repository: git still finds it from cwd / -C / --git-dir', () => {
    expect(gitTargetDir(['-C', 'sub', '--work-tree', 'w', 'status'], '/r')).toBe('/r/sub');
    expect(gitTargetDir(['--work-tree=/tmp/w', 'fetch', 'origin'], '/r')).toBe('/r');
    expect(gitTargetDir(['--work-tree', '/tmp/w', '--git-dir', '/tmp/g', 'status'], '/r')).toBe('/tmp/g');
  });
  it('a relative --git-dir / GIT_DIR resolves after every -C, in either order (git applies -C first)', () => {
    expect(gitTargetDir(['--git-dir=.git', '-C', '/real', 'status'], '/elsewhere')).toBe('/real/.git');
    expect(gitTargetDir(['-C', '/real', '--git-dir', '.git', 'status'], '/elsewhere')).toBe('/real/.git');
    expect(gitTargetDir(['-C', '/real', 'status'], '/elsewhere', { GIT_DIR: '.git' })).toBe('/real/.git');
  });
});

describe('fake home', () => {
  const settings = { fakeHome: { toolEnv: { npm_config_cache: '~/.npm', CARGO_HOME: '~/.cargo' } } };
  it('HOME moves to the fixture; present tool caches stay on the real home unless the caller set them', () => {
    const env = fakeHomeEnv({ realHome: '/home/op', fakeHome: '/tmp/f/home', settings, env: { CARGO_HOME: '/opt/cargo' }, exists: (p) => p === '/home/op/.npm' });
    expect(env).toEqual({ HOME: '/tmp/f/home', npm_config_cache: '/home/op/.npm' });
  });
  it('os.homedir() in this worker follows the per-file fake HOME, not the real home', async () => {
    const { homedir } = await import('node:os');
    expect(homedir()).toBe(process.env.HOME);
    expect(process.env.HOME).toMatch(/\/home$/);
  });
});

describe('module path', () => {
  it('survives the vite /@fs file-URL form a config module can be handed', () => {
    expect(urlToFsPath('file:///@fs/Users/x/repo/')).toBe('/Users/x/repo/');
    expect(urlToFsPath('file:///Users/x/repo/')).toBe('/Users/x/repo/');
  });
});

describe('fetch classification', () => {
  it('flags GitHub hosts only', () => {
    expect(classifyFetchUrl('https://api.github.com/repos/x')).toMatchObject({ host: 'api.github.com' });
    expect(classifyFetchUrl('https://raw.githubusercontent.com/x')).toBeTruthy();
    expect(classifyFetchUrl('http://127.0.0.1:4000/')).toBeNull();
    expect(classifyFetchUrl('not a url')).toBeNull();
  });
});

describe('shims (real sh processes)', () => {
  const box = () => realpathSync(mkdtempSync(join(tmpdir(), 'hermetic-shim-')));

  it('fake gh records the call against the running test and fails with the live-access message', () => {
    const dir = box();
    try {
      writeFileSync(join(dir, 'gh'), fakeGhScript()); chmodSync(join(dir, 'gh'), 0o755);
      const viol = join(dir, 'v');
      const r = spawnSync(join(dir, 'gh'), ['pr', 'list'], { encoding: 'utf8', env: { PATH: process.env.PATH, [VIOLATIONS_DIR_ENV]: viol, [TEST_ID_ENV]: 't1', [TEST_NAME_ENV]: 'a > b' } });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(LIVE_ACCESS_MESSAGE);
      expect(r.stderr).toContain('a > b');
      expect(parseViolationLog(readFileSync(join(viol, VIOLATIONS_FILE), 'utf8'))).toEqual([{ testId: 't1', kind: 'gh', target: 'gh pr list' }]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('fake gh with the declared unauthenticated fixture fails like a logged-out gh and records nothing', () => {
    const dir = box();
    try {
      writeFileSync(join(dir, 'gh'), fakeGhScript()); chmodSync(join(dir, 'gh'), 0o755);
      const viol = join(dir, 'v');
      const r = spawnSync(join(dir, 'gh'), ['auth', 'status'], { encoding: 'utf8', env: { PATH: process.env.PATH, [VIOLATIONS_DIR_ENV]: viol, [GH_FIXTURE_ENV]: 'unauthenticated' } });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('gh auth login');
      expect(existsSync(join(viol, VIOLATIONS_FILE))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a multi-line gh argument is logged as ONE violation line', () => {
    const dir = box();
    try {
      writeFileSync(join(dir, 'gh'), fakeGhScript()); chmodSync(join(dir, 'gh'), 0o755);
      const viol = join(dir, 'v');
      spawnSync(join(dir, 'gh'), ['api', 'graphql', '-f', 'query=query {\n  viewer\t{ login }\n}'], { encoding: 'utf8', env: { PATH: process.env.PATH, [VIOLATIONS_DIR_ENV]: viol, [TEST_ID_ENV]: 't2' } });
      const rows = parseViolationLog(readFileSync(join(viol, VIOLATIONS_FILE), 'utf8'));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ testId: 't2', kind: 'gh' });
      expect(rows[0].target).toContain('viewer');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('git shim: a --git-dir throwaway repo is not the real checkout, even when cwd is', () => {
    const dir = box();
    try {
      const realGit = join(dir, 'real-git');
      writeFileSync(realGit, '#!/bin/sh\necho PASSED-THROUGH\n'); chmodSync(realGit, 0o755);
      writeFileSync(join(dir, 'git'), gitShimScript({ realGit })); chmodSync(join(dir, 'git'), 0o755);
      const repo = join(dir, 'repo'); mkdirSync(repo);
      const other = join(dir, 'other'); mkdirSync(other);
      const env = { PATH: process.env.PATH, [REAL_REPOS_ENV]: repo, [VIOLATIONS_DIR_ENV]: join(dir, 'v') };
      const r = spawnSync(join(dir, 'git'), ['--git-dir', other, 'rev-parse', 'origin/main'], { cwd: repo, encoding: 'utf8', env });
      expect(r.stdout).toContain('PASSED-THROUGH');
      const r2 = spawnSync(join(dir, 'git'), [`--git-dir=${repo}`, 'rev-parse', 'origin/main'], { cwd: other, encoding: 'utf8', env });
      expect(r2.status).toBe(128);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  // `[label, build(repo, other) → {args, env}, cwd, refused?]` — ONE table drives the shim (real sh) AND the JS mirror
  // (gitTargetDir): the repository a command acts on is the real checkout exactly when the command is refused.
  const TARGET_CASES = [
    ['--work-tree <other> in the real checkout', (repo, other) => ({ args: ['--work-tree', other, 'rev-parse', 'origin/main'] }), 'repo', true],
    ['--work-tree=<other> in the real checkout', (repo, other) => ({ args: [`--work-tree=${other}`, 'fetch', 'origin'] }), 'repo', true],
    ['-C <repo> --work-tree <other> from elsewhere', (repo, other) => ({ args: ['-C', repo, '--work-tree', other, 'fetch', 'origin'] }), 'other', true],
    ['--work-tree=<repo> from elsewhere does not make the repo the target', (repo) => ({ args: [`--work-tree=${repo}`, 'rev-parse', 'origin/main'] }), 'other', false],
    ['relative --git-dir then -C <repo>', (repo) => ({ args: ['--git-dir=.git', '-C', repo, 'rev-parse', 'origin/main'] }), 'other', true],
    ['-C <repo> then relative --git-dir', (repo) => ({ args: ['-C', repo, '--git-dir', '.git', 'rev-parse', 'origin/main'] }), 'other', true],
    ['absolute GIT_DIR=<other> in the real checkout (a throwaway repo)', (repo, other) => ({ args: ['rev-parse', 'origin/main'], env: { GIT_DIR: join(other, '.git') } }), 'repo', false],
    ['absolute GIT_DIR=<repo> from elsewhere', (repo) => ({ args: ['rev-parse', 'origin/main'], env: { GIT_DIR: join(repo, '.git') } }), 'other', true],
    ['relative GIT_DIR with -C <other> from the real checkout (a throwaway repo)', (repo, other) => ({ args: ['-C', other, 'rev-parse', 'origin/main'], env: { GIT_DIR: '.git' } }), 'repo', false],
    ['relative GIT_DIR with -C <repo> from elsewhere', (repo) => ({ args: ['-C', repo, 'rev-parse', 'origin/main'], env: { GIT_DIR: '.git' } }), 'other', true],
    ['--git-dir=<a gitfile inside the repo> (cannot be cd-ed into: judged by its directory, not failed open)', (repo) => ({ args: ['--git-dir', join(repo, 'link', '.git'), 'rev-parse', 'origin/main'] }), 'other', true],
  ];
  const targetBox = () => {
    const dir = box();
    const repo = join(dir, 'repo'); mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, 'link')); writeFileSync(join(repo, 'link', '.git'), `gitdir: ${join(repo, '.git')}\n`);
    const other = join(dir, 'other'); mkdirSync(join(other, '.git'), { recursive: true });
    return { dir, repo, other };
  };
  it.each(TARGET_CASES)('git shim target: %s', (_label, build, where, refused) => {
    const { dir, repo, other } = targetBox();
    try {
      const realGit = join(dir, 'real-git');
      writeFileSync(realGit, '#!/bin/sh\necho PASSED-THROUGH\n'); chmodSync(realGit, 0o755);
      writeFileSync(join(dir, 'git'), gitShimScript({ realGit })); chmodSync(join(dir, 'git'), 0o755);
      const { args, env: extra } = build(repo, other);
      const env = { PATH: process.env.PATH, [REAL_REPOS_ENV]: repo, [VIOLATIONS_DIR_ENV]: join(dir, 'v'), [TEST_ID_ENV]: 't5', ...extra };
      const r = spawnSync(join(dir, 'git'), args, { cwd: where === 'repo' ? repo : other, encoding: 'utf8', env });
      if (refused) expect(r.status).toBe(128);
      else expect(r.stdout).toContain('PASSED-THROUGH');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each(TARGET_CASES)('gitTargetDir (the JS mirror) agrees with the shim: %s', (_label, build, where, refused) => {
    const repo = '/box/repo'; const other = '/box/other';
    const { args, env } = build(repo, other);
    const target = gitTargetDir(args, where === 'repo' ? repo : other, env);
    expect(target === repo || target.startsWith(`${repo}/`)).toBe(refused);
  });

  it.each([
    ['DEBT_ENV=1 (a hermeticDebt file)', { [DEBT_ENV]: '1' }],
    ['local report mode', { [HERMETIC_MODE_ENV]: 'report' }],
  ])('git shim: %s records the remote read in the real checkout but lets it through', (_label, extra) => {
    const dir = box();
    try {
      const realGit = join(dir, 'real-git');
      writeFileSync(realGit, '#!/bin/sh\necho PASSED-THROUGH\n'); chmodSync(realGit, 0o755);
      writeFileSync(join(dir, 'git'), gitShimScript({ realGit })); chmodSync(join(dir, 'git'), 0o755);
      const repo = join(dir, 'repo'); mkdirSync(repo);
      const viol = join(dir, 'v');
      const env = { PATH: process.env.PATH, [REAL_REPOS_ENV]: repo, [VIOLATIONS_DIR_ENV]: viol, [TEST_ID_ENV]: 't7', ...extra };
      const r = spawnSync(join(dir, 'git'), ['fetch', 'origin'], { cwd: repo, encoding: 'utf8', env });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('PASSED-THROUGH');
      expect(parseViolationLog(readFileSync(join(viol, VIOLATIONS_FILE), 'utf8'))[0]).toMatchObject({ testId: 't7', kind: 'git' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each(GIT_CASES)('git shim agrees with classifyGitArgs inside a real checkout: %j', (args, hit) => {
    const dir = box();
    try {
      const realGit = join(dir, 'real-git');
      writeFileSync(realGit, '#!/bin/sh\necho PASSED-THROUGH\n'); chmodSync(realGit, 0o755);
      writeFileSync(join(dir, 'git'), gitShimScript({ realGit })); chmodSync(join(dir, 'git'), 0o755);
      const repo = join(dir, 'repo'); mkdirSync(repo);
      const viol = join(dir, 'v');
      const env = { PATH: process.env.PATH, [REAL_REPOS_ENV]: `/nowhere:${repo}`, [VIOLATIONS_DIR_ENV]: viol, [TEST_ID_ENV]: 't9' };
      const r = spawnSync(join(dir, 'git'), args, { cwd: repo, encoding: 'utf8', env });
      if (hit) {
        expect(r.status).toBe(128);
        expect(r.stderr).toContain(LIVE_ACCESS_MESSAGE);
        expect(parseViolationLog(readFileSync(join(viol, VIOLATIONS_FILE), 'utf8'))[0]).toMatchObject({ testId: 't9', kind: 'git' });
      } else {
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('PASSED-THROUGH');
      }
      // Outside every real checkout (a fixture repo in tmp) the same command always passes through.
      const elsewhere = spawnSync(join(dir, 'git'), args, { cwd: dir, encoding: 'utf8', env });
      expect(elsewhere.stdout).toContain('PASSED-THROUGH');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('in-process guard', () => {
  const stubFs = () => ({
    readFileSync: () => 'real-bytes', existsSync: () => true, writeFileSync: () => undefined, readFile: (p, cb) => cb(null, 'x'),
  });
  const ctx = buildGuardContext({ home: HOME, repoRoot: '/repo', settings: SETTINGS });

  it('enforce: a live read throws HermeticAccessError, existsSync answers false, both are recorded', async () => {
    const fs = stubFs(); const fsPromises = { readFile: async () => 'x' }; const host = { fetch: async () => 'net' };
    const seen = [];
    installHermeticGuards({ fs, fsPromises, syncBuiltinESMExports: () => {}, fetchHost: host, state: { ctx, enforce: true, enabled: true, onViolation: (v) => seen.push(v) } });
    expect(() => fs.readFileSync(`${HOME}/.claude/daemon-self-sync-state/q.json`)).toThrow(HermeticAccessError);
    expect(fs.existsSync(`${HOME}/workspace/.lanes/p/lane-9`)).toBe(false);
    await expect(fsPromises.readFile(`${HOME}/workspace/webeverything/backlog/a.md`)).rejects.toMatchObject({ code: 'EHERMETIC' });
    await expect(host.fetch('https://api.github.com/repos/a/b')).rejects.toThrow(LIVE_ACCESS_MESSAGE);
    expect(fs.readFileSync('/repo/backlog/a.md')).toBe('real-bytes');
    expect(await host.fetch('http://localhost/')).toBe('net');
    expect(seen.map((v) => v.kind)).toEqual(['fs.readFileSync', 'fs.existsSync', 'fs.readFile', 'fetch']);
  });

  it('report: records and lets the access through', () => {
    const fs = stubFs(); const seen = [];
    installHermeticGuards({ fs, fsPromises: {}, syncBuiltinESMExports: () => {}, fetchHost: null, state: { ctx, enforce: false, enabled: true, onViolation: (v) => seen.push(v) } });
    expect(fs.readFileSync(`${HOME}/.claude/daemon-self-sync-state/q.json`)).toBe('real-bytes');
    expect(seen).toHaveLength(1);
  });

  it('the real node:fs in this worker is guarded (named imports included)', () => {
    // vitest.setup.ts installed the guard. Proven by identity, not by touching a live path (that would be recorded
    // and fail this very test): the named-import binding IS the guard wrapper.
    expect(readFileSync.name).toBe('hermeticFs');
    expect(existsSync.name).toBe('existsSync');
    expect(String(existsSync)).toContain('check(');
  });
});

// The per-file lifecycle (setupHermeticTestFile): drives the REAL function with captured hook callbacks, a stub fs (so
// the worker's own guard is never re-pointed) and a throwaway checkout — see hermetic-tests-vitest.mjs#guardFs.
describe('setupHermeticTestFile lifecycle (beforeEach / afterEach / afterAll)', () => {
  const ENV_KEYS = [HERMETIC_MODE_ENV, DEBT_ENV, TEST_ID_ENV, TEST_NAME_ENV, REAL_REPOS_ENV, VIOLATIONS_DIR_ENV, 'CI', 'GITHUB_ACTIONS', ...LIVE_GITHUB_ENV_KEYS];
  let saved; let box;
  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    box = realpathSync(mkdtempSync(join(tmpdir(), 'hermetic-lifecycle-')));
  });
  afterEach(() => {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    rmSync(box, { recursive: true, force: true });
  });

  /** A throwaway checkout + a live root beside it; returns the driven hooks and the stub fs. */
  function harness({ ambient = {}, testFile = 'a/some.test.mjs', debt = [] } = {}) {
    const repo = join(box, 'repo'); const live = join(box, 'live'); const violationsDir = join(box, 'viol');
    mkdirSync(join(repo, 'scripts'), { recursive: true }); mkdirSync(live, { recursive: true });
    writeFileSync(join(repo, 'scripts', 'hermetic-tests.settings.json'), JSON.stringify({
      liveSuite: { schedule: { cron: '0 * * * *', intervalHours: 1 }, tests: [] },
      hermeticDebt: { files: debt.map((file) => ({ file, reason: 'declared debt for the lifecycle test' })) },
      guardedRoots: [{ id: 'live-root', path: live }],
      primaryCheckout: join(box, 'primary'),
    }));
    const hooks = { beforeEach: [], afterEach: [], afterAll: [] };
    const fs = { readFileSync: () => 'bytes', existsSync: () => true };
    setupHermeticTestFile({
      beforeEach: (fn) => hooks.beforeEach.push(fn), afterEach: (fn) => hooks.afterEach.push(fn), afterAll: (fn) => hooks.afterAll.push(fn),
      expect: { getState: () => ({ testPath: join(repo, testFile), currentTestName: 'case one' }) },
      repoRoot: repo, ambient, violationsDir, guardFs: { fs, fsPromises: {}, fetchHost: null },
    });
    const run = (hook) => hooks[hook].forEach((fn) => fn());
    const logRow = (testId, kind, target) => {
      mkdirSync(violationsDir, { recursive: true });
      appendFileSync(join(violationsDir, VIOLATIONS_FILE), `${testId}\t${kind}\t${target}\n`);
    };
    return { fs, live, repo, run, logRow, violationsDir };
  }

  it('a clean test passes, and a failing one does not poison the next', () => {
    const h = harness();
    h.run('beforeEach');
    expect(() => h.run('afterEach')).not.toThrow();
    h.run('beforeEach');
    expect(() => h.fs.readFileSync(join(h.live, 'q.json'))).toThrow(HermeticAccessError);
    expect(() => h.run('afterEach')).toThrow(LIVE_ACCESS_MESSAGE);
    h.run('beforeEach');
    expect(() => h.run('afterEach')).not.toThrow();
    expect(() => h.run('afterAll')).not.toThrow();
  });

  it('a live read the code under test SWALLOWED still fails the test in afterEach', () => {
    const h = harness();
    h.run('beforeEach');
    let swallowed = 'not-run';
    try { h.fs.readFileSync(join(h.live, 'state.json')); } catch { swallowed = 'caught'; }
    expect(swallowed).toBe('caught');
    expect(() => h.run('afterEach')).toThrow(/fs\.readFileSync .*\(live-root\)/);
  });

  it('a child shim row for this test fails afterEach; an unattributed row is charged to the running test', () => {
    const h = harness();
    h.run('beforeEach');
    h.logRow(process.env[TEST_ID_ENV], 'gh', 'gh pr list');
    expect(() => h.run('afterEach')).toThrow(/gh gh pr list/);
    h.run('beforeEach');
    h.logRow('unattributed', 'git', 'git fetch origin (in /real)');
    expect(() => h.run('afterEach')).toThrow(/git git fetch origin/);
  });

  it('a row from a child that outlived its test fails the FILE in afterAll, not an unrelated test', () => {
    const h = harness();
    h.run('beforeEach');
    h.logRow('999-some-earlier-test', 'git', 'git fetch origin (in /real)');
    expect(() => h.run('afterEach')).not.toThrow();
    expect(() => h.run('afterAll')).toThrow(/outside any single test, or a child that outlived its test/);
    expect(existsSync(h.violationsDir)).toBe(false); // afterAll removes the shim log dir even when it fails the file
  });

  it('an in-process access made after its test ended also fails in afterAll', () => {
    const h = harness();
    h.run('beforeEach'); h.run('afterEach');
    expect(() => h.fs.readFileSync(join(h.live, 'late.json'))).toThrow(HermeticAccessError);
    expect(() => h.run('afterAll')).toThrow(LIVE_ACCESS_MESSAGE);
  });

  it('debt mode (a file listed in hermeticDebt): recorded and printed, never failed, and the access is let through', () => {
    const h = harness({ testFile: 'a/debt.test.mjs', debt: ['a/debt.test.mjs'] });
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      h.run('beforeEach');
      expect(process.env[DEBT_ENV]).toBe('1');
      expect(h.fs.readFileSync(join(h.live, 'q.json'))).toBe('bytes');
      expect(() => h.run('afterEach')).not.toThrow();
      expect(err.mock.calls.map((c) => String(c[0])).join('')).toMatch(/\[hermetic-debt\].*1 live access/);
    } finally { err.mockRestore(); }
  });

  it('report mode (local only): appends JSON lines to the report file and does not fail', () => {
    delete process.env.CI; delete process.env.GITHUB_ACTIONS;
    const reportFile = join(box, 'out', 'report.jsonl');
    const h = harness({ ambient: { [HERMETIC_MODE_ENV]: 'report', [REPORT_FILE_ENV]: reportFile } });
    h.run('beforeEach');
    expect(h.fs.readFileSync(join(h.live, 'q.json'))).toBe('bytes');
    h.logRow(process.env[TEST_ID_ENV], 'gh', 'gh pr list');
    expect(() => h.run('afterEach')).not.toThrow();
    const rows = readFileSync(reportFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows.map((r) => r.kind)).toEqual(['fs.readFileSync', 'gh']);
    expect(rows[0].test).toContain('case one');
  });

  it('CI always enforces, even if the launching env asked for report mode', () => {
    process.env.CI = 'true';
    const h = harness({ ambient: { [HERMETIC_MODE_ENV]: 'report' } });
    h.run('beforeEach');
    expect(() => h.fs.readFileSync(join(h.live, 'q.json'))).toThrow(HermeticAccessError);
    expect(() => h.run('afterEach')).toThrow(LIVE_ACCESS_MESSAGE);
  });

  // Through the REAL vitest hooks (vitest.setup.ts registered the same function on this file): `it.fails` passes only
  // when the test body OR its afterEach throws, and the bodies below swallow every error themselves, so these prove
  // the wiring end to end — a swallowed in-process read and a child `gh` call each fail the test that made them.
  // Skipped in a local `WE_HERMETIC_MODE=report` diagnostic run, where nothing is meant to throw.
  const enforcing = process.env[HERMETIC_MODE_ENV] !== 'report';
  it.skipIf(!enforcing).fails('real hooks: a swallowed in-process read of live state fails its own test (afterEach)', () => {
    try { readFileSync(join(realHomedir(), '.claude', 'jobs', 'x.json'), 'utf8'); } catch { /* swallowed on purpose */ }
  });
  it.skipIf(!enforcing).fails('real hooks: a child gh call fails its own test (afterEach), the shim being first on PATH', () => {
    spawnSync('gh', ['pr', 'list'], { encoding: 'utf8' });
  });
});

describe('declared settings', () => {
  const settings = loadHermeticSettings(ROOT);
  it('parse, and every live-suite test exists with a reason', () => {
    for (const f of liveSuiteFiles(settings)) expect(existsSync(join(ROOT, f)), f).toBe(true);
  });
  it('hermetic debt may only shrink: at most HERMETIC_DEBT_MAX files, each real, each with a reason, none live', () => {
    // Lower this number when you fix a debt file. Never raise it: a new live access is fixed, not listed.
    const HERMETIC_DEBT_MAX = 4;
    const debt = hermeticDebtFiles(settings);
    expect(debt.length).toBeLessThanOrEqual(HERMETIC_DEBT_MAX);
    for (const f of debt) {
      expect(existsSync(join(ROOT, f)), f).toBe(true);
      expect(liveSuiteFiles(settings), f).not.toContain(f);
    }
    expect(() => parseHermeticSettings({ ...settings, hermeticDebt: { files: [{ file: 'x.test.mjs' }] } })).toThrow(/hermeticDebt/);
  });
  it('a malformed allowlist fails closed', () => {
    expect(() => parseHermeticSettings({ liveSuite: { tests: [{ file: 'x' }] }, guardedRoots: [] })).toThrow(/reason/);
    expect(() => parseHermeticSettings({ guardedRoots: [] })).toThrow(/liveSuite/);
  });
  it('the scheduled workflow runs the live suite on the declared cron and never gates a PR', () => {
    const wf = readFileSync(join(ROOT, '.github/workflows/live-tests.yml'), 'utf8');
    expect(wf).toContain(`cron: '${settings.liveSuite.schedule.cron}'`);
    expect(wf).toContain('npm run test:live');
    expect(wf).not.toMatch(/^\s*pull_request/m);
    expect(wf).toContain(settings.liveSuite.issueLabel);
  });
  it('only the live config turns hermetic mode off; every blocking config excludes the live suite', () => {
    const live = readFileSync(join(ROOT, 'vitest.live.config.ts'), 'utf8');
    expect(live).toMatch(/WE_TEST_HERMETIC:\s*'0'/);
    for (const cfg of ['vitest.config.ts', 'vitest.integration.config.ts', 'vitest.soak.config.ts']) {
      const text = readFileSync(join(ROOT, cfg), 'utf8');
      expect(text, cfg).not.toMatch(/WE_TEST_HERMETIC:\s*'0'/);
      expect(text, cfg).toMatch(/WE_TEST_HERMETIC:\s*'1'/);
    }
    for (const cfg of ['vitest.config.ts', 'vitest.integration.config.ts']) {
      expect(readFileSync(join(ROOT, cfg), 'utf8'), cfg).toContain('liveSuiteFiles(');
    }
  });
});
