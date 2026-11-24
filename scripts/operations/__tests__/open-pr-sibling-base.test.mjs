import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkSiblingBase } from '../../lib/sibling-base-check.mjs';
import { createGitReader } from '../../lib/pr-size-admission.mjs';
import { createPrLandRunner, readSiblingBase } from '../open-pr-io.mjs';
import { ghRepoSlug } from '../../lib/constellation-repos.mjs';

const dirs = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
function fixture() {
  const dir = mkdtempSync(join(process.env.TMPDIR, 'sibling-base-'));
  dirs.push(dir);
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main');
  git('config', 'user.email', 'fixture@example.test');
  git('config', 'user.name', 'Fixture');
  const commit = name => {
    writeFileSync(join(dir, name), name + '\n');
    git('add', name); git('commit', '-m', name);
    return git('rev-parse', 'HEAD');
  };
  commit('root');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const openPrs = [];
  const sibling = number => {
    const headRefName = `lane/sibling-${number}`;
    git('checkout', '-b', headRefName);
    const headRefOid = commit(`change-${number}`);
    git('update-ref', `refs/remotes/origin/${headRefName}`, headRefOid);
    const pr = { number, headRefName, headRefOid };
    openPrs.push(pr); return pr;
  };
  const check = (opts = {}) => checkSiblingBase({ git: createGitReader(dir), base: 'main', sha: git('rev-parse', 'HEAD'), openPrs, ...opts });
  return { dir, git, commit, sibling, check, openPrs };
}

describe('sibling base admission', () => {
  it('refuses a branch whose history holds commits that belong to another open lane', () => {
    const f = fixture(), pr = f.sibling(236);
    f.git('checkout', '-b', 'lane/child'); f.commit('child');
    expect(f.check()).toEqual([{ number: 236, headRefName: pr.headRefName, count: 1 }]);
    expect(f.check({ openPrs: [{ number: 237, headRefName: 'lane/child', headRefOid: f.git('rev-parse', 'HEAD') }] })).toEqual([]);
  });

  it('allows a branch cut on main, and a branch whose sibling commits already landed via their PRs', () => {
    const f = fixture(), pr = f.sibling(236);
    f.git('checkout', '-b', 'lane/clean', 'main'); f.commit('clean');
    expect(f.check()).toEqual([]);
    f.git('checkout', '-b', 'lane/child', pr.headRefOid); f.commit('child');
    f.git('checkout', 'main'); f.git('merge', '--squash', pr.headRefName);
    f.git('commit', '-m', 'squash landing with different metadata');
    f.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    expect(f.git('rev-parse', 'HEAD')).not.toBe(pr.headRefOid);
    expect(f.check({ sha: 'lane/child' })).toEqual([]);
  });

  it('the refusal names the sibling lanes and the fix command', () => {
    const f = fixture();
    f.sibling(7357); f.sibling(7366); f.sibling(7374);
    f.git('checkout', '-b', 'lane/child'); f.commit('child');
    const result = runner(f)({ argv: ['--ref=lane/child', '--check'] });
    expect(result.outcome).toBe('refused');
    for (const pr of f.openPrs) {
      expect(result.detail).toContain(`#${pr.number}`);
      expect(result.detail).toContain(pr.headRefName);
      expect(result.detail).toContain(`git rebase --onto origin/main ${pr.headRefName} lane/child`);
    }
  });

  it('allows a stacked PR whose declared base is the sibling lane', () => {
    const f = fixture(), pr = f.sibling(236);
    f.git('checkout', '-b', 'lane/237'); f.commit('child');
    expect(f.check({ base: pr.headRefName })).toEqual([]);
  });

  it('fails closed when git state is unreadable', () => {
    const f = fixture(); f.sibling(236); f.commit('child');
    f.git('update-ref', '-d', 'refs/remotes/origin/main');
    expect(f.check()).toMatchObject({ reason: 'sibling-base-unreadable' });
    expect(f.check({ git: () => { throw new Error('unreadable'); } })).toMatchObject({ reason: 'sibling-base-unreadable' });
    expect(f.check({ openPrs: null })).toMatchObject({ reason: 'sibling-base-unreadable' });
  });

  it('surfaces the sibling blocker in runner --check output and retains other gates', () => {
    const f = fixture(); f.sibling(236); f.commit('child');
    const spawn = vi.fn(() => ({ status: 3, stdout: JSON.stringify({ reason: 'verify-red', blockers: [{ gate: 'verify', reason: 'verify-red', detail: 'red' }] }) }));
    const result = runner(f, { spawn })({ argv: ['--ref=lane/child', '--check'] });
    expect(result.blockers.map(b => b.reason)).toEqual(['sibling-base', 'verify-red']);
    expect(result.detail).toContain('sibling-base');
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn.mock.calls[0][1]).toContain('--check');
  });

  it('reads open PRs once with the runner env and excludes this ref', () => {
    const f = fixture(); f.sibling(236); f.commit('child');
    const env = { PATH: 'fixture-path' };
    const gh = vi.fn(() => JSON.stringify([...f.openPrs,
      { number: 237, headRefName: 'lane/child', headRefOid: 'missing-self-is-excluded' }]));
    expect(readSiblingBase({ cwd: f.dir, env, branch: 'lane/child', git: createGitReader(f.dir), base: 'main', sha: 'HEAD' }, gh))
      .toEqual([{ number: 236, headRefName: 'lane/sibling-236', count: 1 }]);
    expect(gh).toHaveBeenCalledOnce();
    expect(gh).toHaveBeenCalledWith(['pr', 'list', '--repo', ghRepoSlug('we'), '--state', 'open', '--limit', '1000', '--json', 'number,headRefName,headRefOid'],
      expect.objectContaining({ cwd: f.dir, env, timeout: 30000, maxBuffer: 8 * 1024 * 1024 }));
  });

  it('refuses an oversized or malformed open PR listing with an operator fallback', () => {
    const f = fixture();
    for (const evidence of [Array(1000).fill({}), null, '{bad-json']) {
      const siblingBase = opts => readSiblingBase({ ...opts, cwd: f.dir },
        () => typeof evidence === 'string' ? evidence : JSON.stringify(evidence));
      const result = runner(f, { siblingBase })({ argv: ['--ref=lane/child', '--check'] });
      expect(result).toMatchObject({ outcome: 'refused', reason: 'sibling-base-unreadable' });
      expect(result.detail).toContain('retry --check');
      if (Array.isArray(evidence)) expect(result.detail).toContain('ask a human');
    }
  });

  it('refuses unreadable PR and Git evidence in the runner, including read limits', () => {
    const f = fixture();
    for (const siblingBase of [() => { throw new Error('GitHub unavailable'); }, () => undefined,
      () => f.check({ git: () => { throw new Error('maxBuffer exceeded'); } })]) {
      const result = runner(f, { siblingBase })({ argv: ['--ref=lane/child', '--check'] });
      expect(result).toMatchObject({ outcome: 'refused', reason: 'sibling-base-unreadable' });
      expect(result.detail).toContain('retry --check');
    }
  });

  it('fails closed on missing sibling objects and bounds each Git read', () => {
    const f = fixture(); f.sibling(236); f.commit('child');
    expect(f.check({ openPrs: [{ ...f.openPrs[0], headRefOid: 'f'.repeat(40) }] }))
      .toMatchObject({ reason: 'sibling-base-unreadable' });
    const real = createGitReader(f.dir), git = vi.fn((...args) => real(...args));
    expect(f.check({ git })).toHaveLength(1);
    for (const [, opts] of git.mock.calls) expect(opts).toMatchObject({ timeout: 5000, maxBuffer: 8 * 1024 * 1024,
      env: { GIT_NO_LAZY_FETCH: '1' } });
  });
});

function runner(f, opts = {}) {
  return createPrLandRunner({ cwd: f.dir, env: {},
    spawn: () => ({ status: 0, stdout: '{"reason":"check-ok"}' }),
    prepGate: () => ({ ok: true }), prePrReview: () => ({ action: 'pass' }),
    canonicalAudit: () => ({ ok: true }),
    siblingBase: ({ base, sha }) => f.check({ base, sha }), ...opts });
}
