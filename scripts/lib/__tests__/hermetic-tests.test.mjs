/** @file hermetic-tests.test.mjs — the hermetic-tests decision, shims, guard and declared settings (card xcu4cqf). */
import { describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GH_FIXTURE_ENV, HERMETIC_ENV, HermeticAccessError, LIVE_ACCESS_MESSAGE, REAL_REPOS_ENV, TEST_ID_ENV, TEST_NAME_ENV,
  VIOLATIONS_DIR_ENV, VIOLATIONS_FILE, buildGuardContext, classifyFetchUrl, classifyFsPath, classifyGitArgs,
  fakeGhScript, fakeHomeEnv, gitShimScript, gitTargetDir, urlToFsPath, hermeticMode, installHermeticGuards, isHermetic, liveSuiteFiles,
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
  it('a --git-dir / --work-tree throwaway repo is the target, whatever the cwd', () => {
    expect(gitTargetDir(['--git-dir', '/tmp/a/.git', 'rev-parse', 'origin/main'], '/r')).toBe('/tmp/a/.git');
    expect(gitTargetDir(['--git-dir=/tmp/b', '-c', 'x=y', 'log', 'origin/main'], '/r')).toBe('/tmp/b');
    expect(gitTargetDir(['-C', 'sub', '--work-tree', 'w', 'status'], '/r')).toBe('/r/sub/w');
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

describe('declared settings', () => {
  const settings = loadHermeticSettings(ROOT);
  it('parse, and every live-suite test exists with a reason', () => {
    for (const f of liveSuiteFiles(settings)) expect(existsSync(join(ROOT, f)), f).toBe(true);
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
