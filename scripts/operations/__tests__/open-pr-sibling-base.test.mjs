import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createPrLandRunner } from '../open-pr-io.mjs';

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const cwd = mkdtempSync(join(process.env.TMPDIR, 'sibling-base-'));
  dirs.push(cwd);
  const git = (args, options = {}) => execFileSync('git', args, { cwd, encoding: 'utf8', ...options });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'fixture@example.test']);
  git(['config', 'user.name', 'Fixture']);
  const commit = (file, message) => {
    writeFileSync(join(cwd, file), `${message}\n`);
    git(['add', '--', file]);
    git(['commit', '-qm', message]);
  };
  commit('root', 'root');
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  git(['checkout', '-qb', 'lane/7357']);
  commit('one', 'first sibling change');
  commit('two', 'second sibling change');
  git(['checkout', '-qb', 'lane/own']);
  commit('own', 'own change');
  const calls = [];
  const run = (base = 'main', overrides = {}) => createPrLandRunner({
    cwd, git, canonicalAudit: () => ({ ok: true }), prePrReview: () => ({ action: 'pass' }),
    prepGate: () => ({ ok: true }), readPrepBody: () => '', env: {},
    spawn: (_cmd, argv) => {
      calls.push(argv);
      return { status: 0, stdout: JSON.stringify(argv.includes('--check') ? { reason: 'check-ok' } : { pr: 7379 }) };
    }, ...overrides,
  })({ argv: ['--ref=lane/own', `--base=${base}`] });
  return { git, commit, run, calls };
}

describe('open-pr sibling base', () => {
  it('admits a clean branch with 300 unrelated remote lane refs', () => {
    const f = fixture();
    f.git(['checkout', '-qb', 'lane/unrelated', 'main']);
    f.commit('unrelated', 'unrelated work');
    const tip = f.git(['rev-parse', 'HEAD']).trim();
    f.git(['update-ref', '--stdin'], { input: Array.from({ length: 300 }, (_, n) =>
      `update refs/remotes/origin/lane/unrelated-${n} ${tip}\n`).join('') });
    f.git(['checkout', 'lane/own']);
    f.git(['reset', '--hard', 'main']);
    f.commit('clean', 'clean own change');
    expect(f.run()).toMatchObject({ outcome: 'opened' });
  });

  it('excludes this PR own branch and its -vN renames from sibling candidates', () => {
    const f = fixture();
    f.git(['reset', '--hard', 'main']);
    f.commit('first', 'first own change');
    f.git(['branch', 'lane/own-v2']);
    f.commit('second', 'second own change');
    expect(f.run()).toMatchObject({ outcome: 'opened' });
  });

  it('fails closed when candidate ref reads fail', () => {
    const f = fixture();
    const result = f.run('main', { git: (args, opts) => {
      if (args[0] === 'for-each-ref') throw new Error('cannot read lane refs');
      return f.git(args, opts);
    } });
    expect(result).toMatchObject({ outcome: 'refused', reason: 'sibling-base-unknown' });
    expect(result.detail).toContain('cannot read lane refs');
    expect(f.calls[0]).toContain('--check');
  });

  it('refuses a branch whose history holds commits that belong to another open lane', () => {
    const f = fixture();
    expect(f.run()).toMatchObject({ outcome: 'refused', reason: 'sibling-base' });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toContain('--check');
  });

  it('allows a branch cut on main, and a branch whose sibling commits already landed via their PRs', () => {
    const f = fixture();
    f.git(['checkout', '-qb', 'lane/clean', 'main']);
    f.commit('clean', 'clean change');
    f.git(['branch', '-f', 'lane/own', 'HEAD']);
    expect(f.run()).toMatchObject({ outcome: 'opened' });
    f.git(['checkout', 'main']);
    f.git(['merge', '--squash', 'lane/7357']);
    f.git(['commit', '-qm', 'land sibling (#7357)']);
    f.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    f.git(['checkout', 'lane/own']);
    f.git(['reset', '--hard', 'lane/7357']);
    f.commit('own', 'own after squash');
    expect(f.run()).toMatchObject({ outcome: 'opened' });
  });

  it('the refusal names the sibling lanes and the fix command', () => {
    const f = fixture();
    for (const number of [7366, 7374]) {
      f.git(['checkout', '-qb', `lane/${number}`]);
      f.commit(`file-${number}`, `sibling ${number}`);
    }
    f.git(['branch', '-f', 'lane/own', 'HEAD']);
    f.git(['checkout', 'lane/own']);
    f.commit('final', 'final own change');
    const result = f.run();
    expect(result.blockers).toContainEqual(expect.objectContaining({ gate: 'sibling-base', reason: 'sibling-base' }));
    expect(result.detail).toMatch(/7357.*7366.*7374/s);
    expect(result.detail).toContain('git rebase --onto');
  });

  it('allows a legitimate stack with a declared parent', () => {
    expect(fixture().run('lane/7357')).toMatchObject({ outcome: 'opened' });
  });

  it('allows an advanced parent with an unmerged child sharing its earlier history', () => {
    const f = fixture();
    f.git(['reset', '--hard', 'main']);
    f.commit('parent-first', 'first parent change');
    f.git(['checkout', '-qb', 'lane/child']);
    f.commit('child', 'unmerged child change');
    f.git(['checkout', 'lane/own']);
    f.commit('parent-next', 'later parent change');
    expect(f.run()).toMatchObject({ outcome: 'opened' });
    expect(f.calls[0]).not.toContain('--check');
  });

  it('refuses inherited sibling commits when lane/7357 advances after lane/own forks', () => {
    const f = fixture();
    f.git(['checkout', 'lane/7357']);
    f.commit('later', 'later sibling work');
    f.git(['checkout', 'lane/own']);
    const result = f.run();
    expect(result).toMatchObject({ outcome: 'refused', reason: 'sibling-base' });
    expect(result.detail).toContain('lane/7357');
    expect(f.calls[0]).toContain('--check');
  });

  it('fails closed when shared history has no surviving lane creation evidence', () => {
    const f = fixture();
    f.git(['reflog', 'expire', '--expire=all', 'refs/heads/lane/7357']);
    const result = f.run();
    expect(result).toMatchObject({ outcome: 'refused', reason: 'sibling-base-unknown' });
    expect(result.detail).toContain('missing lane creation evidence');
    expect(result.detail).toContain('clean lane');
    expect(f.calls[0]).toContain('--check');
  });

  it('allows landed inherited sibling work even when the sibling advances with unmerged work', () => {
    const f = fixture();
    f.git(['checkout', 'main']);
    f.git(['merge', '--squash', 'lane/7357']);
    f.git(['commit', '-qm', 'land sibling (#7357)']);
    f.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    f.git(['checkout', 'lane/7357']);
    f.commit('later', 'later unmerged sibling work');
    f.git(['checkout', 'lane/own']);
    expect(f.run()).toMatchObject({ outcome: 'opened' });
  });

  it('fails closed on unreadable git state and names the operator fallback', () => {
    const f = fixture();
    const result = f.run('main', { git: () => { throw new Error('unreadable objects'); } });
    expect(result).toMatchObject({ outcome: 'refused', reason: 'sibling-base-unknown' });
    expect(result.detail).toMatch(/repair.*Git|clean lane/i);
    expect(f.calls[0]).toContain('--check');
  });

  it('fails closed on oversized lane evidence with a clean-lane fallback', () => {
    const f = fixture();
    const result = f.run('main', { git: (args, opts) => args[0] === 'for-each-ref'
      ? Array.from({ length: 257 }, (_, n) => `refs/heads/lane/${n} ${'a'.repeat(40)}\n`).join('')
      : f.git(args, opts) });
    expect(result).toMatchObject({ outcome: 'refused', reason: 'sibling-base-unknown' });
    expect(result.detail).toMatch(/clean lane/i);
  });
});
