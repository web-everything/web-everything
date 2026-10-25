/**
 * @file guard-git-identity.test.mjs — the lane pre-commit guard refuses a placeholder author, passes a real one.
 *   The end-to-end cases run REAL `git commit` in a throwaway repo whose path contains `/.lanes/`, with the
 *   committed `.githooks/pre-commit`'s guard line as its hook, and the global/system git config isolated away.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardDecision, isLaneRoot, main as guardMain } from '../guard-git-identity.mjs';
import { readGitIdentity, laneIdentityReport } from '../lib/git-identity.mjs';
import { appendFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD = resolve(HERE, '../guard-git-identity.mjs');
const REPO = resolve(HERE, '../..');
const real = { name: 'Ada Lovelace', email: 'ada@analytical.engine' };
const placeholder = { name: 'test', email: 'test@test.com' };

describe('guardDecision (pure)', () => {
  it('refuses a placeholder author in a lane, with the fix', () => {
    const d = guardDecision({ root: '/w/.lanes/web-everything/lane-3', identity: { author: placeholder, committer: real } });
    expect(d.allow).toBe(false);
    expect(d.message).toMatch(/PLACEHOLDER/);
    expect(d.message).toMatch(/git config --global user\.name/);
  });
  it('refuses a missing identity in a lane', () => {
    const d = guardDecision({ root: '/w/.lanes/p/lane-1', identity: { author: { name: '', email: '' }, committer: { name: '', email: '' } } });
    expect(d.allow).toBe(false);
    expect(d.message).toMatch(/MISSING/);
  });
  it('FAIL CLOSED: an unreadable identity (git timed out) refuses the commit', () => {
    const blank = { name: '', email: '' };
    const d = guardDecision({ root: '/w/.lanes/p/lane-1', identity: { author: blank, committer: blank, error: 'ETIMEDOUT' } });
    expect(d.allow).toBe(false);
    expect(d.message).toMatch(/could not verify.*fail-closed/);
  });
  it('passes a real identity in a lane', () => {
    expect(guardDecision({ root: '/w/.lanes/p/lane-1', identity: { author: real, committer: real } })).toEqual({ allow: true });
  });
  it('is lane-only: a non-lane checkout is never refused', () => {
    expect(guardDecision({ root: '/w/webeverything', identity: { author: placeholder, committer: placeholder } })).toEqual({ allow: true });
    expect(isLaneRoot('/w/lanes/x')).toBe(false);
    expect(isLaneRoot('/w/.lanes/p/lane-2')).toBe(true);
  });
  it('recognizes the pool lane name under any root, without an inherited pool environment', () => {
    expect(isLaneRoot('/custom pool/project/lane-12')).toBe(true);
    expect(isLaneRoot('C:\\custom pool\\project\\lane-12', '\\')).toBe(true);
    for (const root of ['/custom/project/lane-12-copy', '/custom/project/lane-x', '/custom/project/lane-12/nested']) {
      expect(isLaneRoot(root)).toBe(false);
    }
    expect(guardDecision({ root: '/custom pool/project/lane-12', identity: { author: placeholder, committer: real } }).allow).toBe(false);
  });
});

describe('main() — any unexpected error refuses the commit (fail closed)', () => {
  const laneExec = () => '/w/.lanes/p/lane-1\n';
  const realIdent = () => ({ author: real, committer: real });
  it.each([
    ['the identity read throws', { exec: laneExec, readIdentity: () => { throw new Error('boom'); } }],
    ['the settings resolve throws', { exec: laneExec, readIdentity: realIdent, resolveLists: () => { throw new Error('bad settings'); } }],
    ['git rev-parse throws', { exec: () => { throw new Error('EMFILE'); } }],
  ])('%s → exit 1 with a clear message', (_label, deps) => {
    const errs = [];
    expect(guardMain({ cwd: '/w', env: {}, err: (l) => errs.push(l), deps })).toBe(1);
    expect(errs.join('\n')).toMatch(/could not verify the git identity \(fail-closed\)[\s\S]*unexpected error/);
  });
  it('a real identity in a lane still exits 0', () => {
    expect(guardMain({ cwd: '/w', env: {}, err: () => {}, deps: { exec: laneExec, readIdentity: realIdent } })).toBe(0);
  });
});

describe('the committed pre-commit hook wires the guard', () => {
  it('.githooks/pre-commit runs guard-git-identity.mjs fail-fast', () => {
    const hook = readFileSync(join(REPO, '.githooks/pre-commit'), 'utf8');
    expect(hook).toMatch(/node scripts\/guard-git-identity\.mjs \|\| exit \$\?/);
  });
});

describe('end to end: real git commit through the hook', () => {
  let base;
  let env;
  const git = (dir, args, extra = {}) => execFileSync('git', args, { cwd: dir, env: { ...env, ...extra }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const commit = (dir, extra = {}) => spawnSync('git', ['commit', '-q', '--allow-empty', '-m', 'x'], { cwd: dir, env: { ...env, ...extra }, encoding: 'utf8' });
  const makeRepo = (rel) => {
    const dir = join(base, rel);
    mkdirSync(join(dir, 'hooks'), { recursive: true });
    git(dir, ['init', '-q']);
    writeFileSync(join(dir, 'hooks/pre-commit'), `#!/bin/sh\n"${process.execPath}" "${GUARD}" || exit $?\n`);
    chmodSync(join(dir, 'hooks/pre-commit'), 0o755);
    git(dir, ['config', 'core.hooksPath', 'hooks']);
    git(dir, ['config', 'commit.gpgsign', 'false']);
    return dir;
  };
  const setIdent = (dir, { name, email }) => { git(dir, ['config', 'user.name', name]); git(dir, ['config', 'user.email', email]); };

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'guard-git-identity-')));
    const home = join(base, 'home');
    mkdirSync(home);
    env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, '.gitconfig') };
    writeFileSync(env.GIT_CONFIG_GLOBAL, '');
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('BEFORE the fix the incident identity commits; with the guard a lane refuses it', () => {
    const lane = makeRepo('.lanes/web-everything/lane-1');
    setIdent(lane, placeholder);
    const r = commit(lane);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/commit refused/);
    expect(() => git(lane, ['rev-parse', 'HEAD'])).toThrow(); // nothing was committed
  });

  it('a real identity commits in a lane', () => {
    const lane = makeRepo('.lanes/web-everything/lane-2');
    setIdent(lane, real);
    const r = commit(lane);
    expect(r.status).toBe(0);
    expect(git(lane, ['log', '-1', '--format=%an']).trim()).toBe('Ada Lovelace');
  });

  it.each([undefined, 'custom pool'])('a custom pool lane refuses placeholders with pool env %s', (poolEnv) => {
    const lane = makeRepo('custom pool/web-everything/lane-12');
    setIdent(lane, placeholder);
    const extra = poolEnv ? { LANE_POOL_ROOT: join(base, poolEnv) } : {};
    const r = commit(lane, extra);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/commit refused/);
    expect(() => git(lane, ['rev-parse', 'HEAD'])).toThrow();
    setIdent(lane, real);
    expect(commit(lane, extra).status).toBe(0);
  });

  it('a placeholder AUTHOR from env (GIT_AUTHOR_*) is caught even with a real config identity', () => {
    const lane = makeRepo('.lanes/web-everything/lane-3');
    setIdent(lane, real);
    const r = commit(lane, { GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test.com' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/author:/);
  });

  it('lane-pool report: an INLINE `[user] name = test` lane config is caught (git resolves it, no file parsing)', () => {
    const ok = makeRepo('.lanes/web-everything/lane-4');
    setIdent(ok, real);
    const bad = makeRepo('.lanes/web-everything/lane-5');
    setIdent(bad, real);
    appendFileSync(join(bad, '.git/config'), '[user] name = test\n[author] email = a@test.com\n');
    const r = laneIdentityReport({ lanes: [{ lane: 4, dir: ok }, { lane: 5, dir: bad }], readIn: (d) => readGitIdentity(d, { env }) });
    expect(r.bad.map((b) => b.lane)).toEqual([5]);
    expect(r.status).toBe('placeholder');
  });

  it('a checkout path WITH A SPACE still runs the guard (run-as-script check uses pathToFileURL)', () => {
    const lane = makeRepo('has space/.lanes/web-everything/lane-6');
    setIdent(lane, placeholder);
    // A copy of the guard and its import chain inside the spaced path, so argv[1] really contains the space.
    for (const rel of ['guard-git-identity.mjs', 'lib/git-identity.mjs', 'lib/lane-git-hardening.mjs', 'lib/policy-cascade.mjs', 'lib/settings-files.mjs', 'lib/under-test.mjs', 'lib/under-test.cjs']) {
      mkdirSync(dirname(join(lane, 'scripts', rel)), { recursive: true });
      writeFileSync(join(lane, 'scripts', rel), readFileSync(join(REPO, 'scripts', rel)));
    }
    const r = spawnSync(process.execPath, [join(lane, 'scripts/guard-git-identity.mjs')], { cwd: lane, env, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/commit refused/);
  });

  it.each([[''], ['--preserve-symlinks-main']])('a SYMLINKED checkout path still runs the guard (NODE_OPTIONS=%j)', (nodeOptions) => {
    const lane = makeRepo('real/.lanes/web-everything/lane-7');
    setIdent(lane, placeholder);
    for (const rel of ['guard-git-identity.mjs', 'lib/git-identity.mjs', 'lib/lane-git-hardening.mjs', 'lib/policy-cascade.mjs', 'lib/settings-files.mjs', 'lib/under-test.mjs', 'lib/under-test.cjs']) {
      mkdirSync(dirname(join(lane, 'scripts', rel)), { recursive: true });
      writeFileSync(join(lane, 'scripts', rel), readFileSync(join(REPO, 'scripts', rel)));
    }
    const link = join(base, 'link');
    symlinkSync(join(base, 'real'), link, 'dir');
    const viaLink = join(link, '.lanes/web-everything/lane-7');
    const r = spawnSync(process.execPath, [join(viaLink, 'scripts/guard-git-identity.mjs')], { cwd: viaLink, env: { ...env, NODE_OPTIONS: nodeOptions }, encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/commit refused/);
  });

  it('outside a lane the guard never blocks', () => {
    const dir = makeRepo('plain/checkout');
    setIdent(dir, placeholder);
    expect(commit(dir).status).toBe(0);
  });
});
