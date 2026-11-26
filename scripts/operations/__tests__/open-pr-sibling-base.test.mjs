import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPrLandRunner } from '../open-pr-io.mjs';
import { createGitReader } from '../../lib/pr-size-admission.mjs';

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'sibling-base-'));
  dirs.push(cwd);
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'fixture@example.test']);
  git(['config', 'user.name', 'Fixture']);
  const commit = (file, text) => { writeFileSync(join(cwd, file), text); git(['add', file]); git(['commit', '-m', text]); };
  commit('root', 'root');
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  git(['checkout', '-b', 'lane/7357']);
  commit('one', 'one');
  commit('two', 'two');
  git(['checkout', '-b', 'lane/7379']);
  commit('own', 'own');
  const spawn = vi.fn((_cmd, argv) => ({ status: 0, stdout: JSON.stringify(argv.includes('--check') ? { reason: 'check-ok' } : { pr: 7379 }) }));
  const run = (base = 'main', reader = createGitReader(cwd), extra = [], ref = 'lane/7379') => createPrLandRunner({ cwd, git: reader, spawn,
    env: {}, canonicalAudit: () => ({ ok: true }), prePrReview: () => ({ action: 'pass' }),
    prepGate: () => ({ ok: true }), readPrepBody: () => '',
  })({ argv: [`--ref=${ref}`, `--base=${base}`, ...extra] });
  return { git, commit, run, spawn };
}

describe('open-pr sibling base', () => {
  it('refuses a branch whose history holds commits that belong to another open lane', () => {
    const f = fixture();
    expect(f.run()).toMatchObject({ outcome: 'refused', reason: 'sibling-base' });
    expect(f.spawn.mock.calls[0][1]).toContain('--check');
  });
  it('allows a branch cut on main, and a branch whose sibling commits already landed via their PRs', () => {
    const f = fixture();
    f.git(['checkout', 'main']);
    f.git(['merge', '--squash', 'lane/7357']);
    f.git(['commit', '-m', 'land sibling (#7357)']);
    f.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    f.git(['checkout', 'lane/7379']);
    expect(f.run()).toMatchObject({ outcome: 'opened' });
    f.git(['checkout', '-B', 'lane/7379', 'main']);
    f.commit('own', 'own');
    expect(f.run()).toMatchObject({ outcome: 'opened' });
  });
  it('the refusal names the sibling lanes and the fix command', () => {
    const f = fixture();
    f.git(['branch', 'lane/7366', 'lane/7357']);
    f.git(['branch', 'lane/7374', 'lane/7357']);
    const result = f.run();
    expect(result.detail).toMatch(/lane\/7357/);
    expect(result.detail).toMatch(/lane\/7366/);
    expect(result.detail).toMatch(/lane\/7374/);
    expect(result.detail).toContain('git rebase --onto origin/main');
    expect(result.blockers).toContainEqual(expect.objectContaining({ gate: 'sibling-base', hint: expect.any(String) }));
  });
  it('allows a legitimate stack with a declared parent base', () => {
    expect(fixture().run('lane/7357')).toMatchObject({ outcome: 'opened' });
  });
  it('allows a parent lane after its child and parent both advance', () => {
    const f = fixture();
    f.git(['checkout', 'lane/7357']);
    f.commit('parent-later', 'parent advances after child branches');
    expect(f.run('main', undefined, [], 'lane/7357')).toMatchObject({ outcome: 'opened' });
    expect(f.spawn.mock.calls[0][1]).not.toContain('--check');
    // The diverged child still carries the unmerged parent contribution.
    f.git(['checkout', 'lane/7379']);
    expect(f.run()).toMatchObject({ outcome: 'refused', reason: 'sibling-base' });
  });
  it.each(['unreadable', 'oversized'])('fails closed on %s branch provenance with an operator fallback', kind => {
    const f = fixture();
    f.git(['checkout', 'lane/7357']);
    f.commit('parent-later', 'parent advances');
    const real = createGitReader(dirs.at(-1));
    const reader = (args, opts) => {
      if (args[0] !== 'reflog') return real(args, opts);
      if (kind === 'unreadable') throw new Error('unreadable branch provenance');
      return Array.from({ length: 2049 }, () => `${'a'.repeat(40)}\tcommit: change\n`).join('');
    };
    expect(f.run('main', reader, [], 'lane/7357')).toMatchObject({ outcome: 'refused',
      reason: 'sibling-base-unconfirmed', detail: expect.stringMatching(/operator/i) });
    expect(f.spawn.mock.calls[0][1]).toContain('--check');
  });
  it('fails closed on unreadable git state, including --check and --dry-run', () => {
    const f = fixture();
    for (const extra of [[], ['--check'], ['--dry-run']]) {
      expect(f.run('main', () => { throw new Error('unreadable'); }, extra)).toMatchObject({ outcome: 'refused', reason: 'sibling-base-unconfirmed' });
    }
    expect(f.spawn.mock.calls.every(([, argv]) => argv.includes('--check'))).toBe(true);
  });
  it('fails closed on an oversized lane list with an operator fallback', () => {
    const f = fixture();
    const real = createGitReader(dirs.at(-1));
    const reader = (args, opts) => args[0] === 'for-each-ref'
      ? Array.from({ length: 257 }, (_, n) => `refs/heads/lane/${n}\t${'a'.repeat(40)}\n`).join('') : real(args, opts);
    expect(f.run('main', reader)).toMatchObject({ outcome: 'refused', reason: 'sibling-base-unconfirmed', detail: expect.stringMatching(/human|operator/i) });
  });
});
