/**
 * @file guard-git-identity.test.mjs — the lane pre-commit guard refuses a placeholder author, passes a real one.
 *   The end-to-end cases run REAL `git commit` in a throwaway repo whose path contains `/.lanes/`, with the
 *   committed `.githooks/pre-commit`'s guard line as its hook, and the global/system git config isolated away.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardDecision, isLaneRoot } from '../guard-git-identity.mjs';

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
  it('passes a real identity in a lane', () => {
    expect(guardDecision({ root: '/w/.lanes/p/lane-1', identity: { author: real, committer: real } })).toEqual({ allow: true });
  });
  it('is lane-only: a non-lane checkout is never refused', () => {
    expect(guardDecision({ root: '/w/webeverything', identity: { author: placeholder, committer: placeholder } })).toEqual({ allow: true });
    expect(isLaneRoot('/w/lanes/x')).toBe(false);
    expect(isLaneRoot('/w/.lanes/p/lane-2')).toBe(true);
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

  it('a placeholder AUTHOR from env (GIT_AUTHOR_*) is caught even with a real config identity', () => {
    const lane = makeRepo('.lanes/web-everything/lane-3');
    setIdent(lane, real);
    const r = commit(lane, { GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test.com' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/author:/);
  });

  it('outside a lane the guard never blocks', () => {
    const dir = makeRepo('plain/checkout');
    setIdent(dir, placeholder);
    expect(commit(dir).status).toBe(0);
  });
});
