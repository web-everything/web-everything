import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createPrLandRunner } from '../open-pr-io.mjs';
import { createGitReader, checkSiblingBase } from '../../lib/pr-size-admission.mjs';

const dirs = [];
afterEach(() => dirs.splice(0).forEach(cwd => rmSync(cwd, { recursive: true, force: true })));
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'sibling-base-'));
  dirs.push(cwd);
  const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  git(['init', '-q', '--initial-branch=main']);
  const commit = (file, content, message = file) => {
    writeFileSync(join(cwd, file), content);
    git(['add', '--', file]);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', message]);
    return git(['rev-parse', 'HEAD']).trim();
  };
  commit('root', 'root');
  git(['checkout', '-qb', 'lane/7357']);
  commit('one', 'one');
  commit('two', 'two');
  git(['checkout', '-qb', 'lane/7379']);
  commit('own', 'own');
  const spawn = vi.fn((_cmd, args) => ({ status: 0, stdout: JSON.stringify(
    args.includes('--check') ? { reason: 'check-ok' } : { pr: 7379, url: 'fixture' }) }));
  const run = (base = 'main', reader = createGitReader(cwd), extra = []) => createPrLandRunner({
    cwd, git: reader, spawn, env: {}, canonicalAudit: () => ({ ok: true }),
    prepGate: () => ({ ok: true }), prePrReview: () => ({ action: 'pass' }),
  })({ argv: [`--ref=${git(['symbolic-ref', '--short', 'HEAD']).trim()}`, `--base=${base}`, ...extra] });
  return { cwd, git, commit, spawn, run };
}

describe('open-pr sibling base', () => {
  it('refuses a branch whose history holds commits that belong to another open lane', () => {
    const f = fixture();
    expect(f.run()).toMatchObject({ outcome: 'refused', reason: 'sibling-base' });
    expect(f.spawn.mock.calls[0][1]).toContain('--check');
  });
  it('allows a branch cut on main, and a branch whose sibling commits already landed via their PRs', () => {
    const f = fixture();
    f.git(['checkout', '-q', 'main']);
    f.git(['checkout', '-qb', 'lane/clean']);
    f.commit('clean', 'clean');
    expect(f.run()).toMatchObject({ outcome: 'opened' });
    f.git(['checkout', '-q', 'main']);
    f.git(['merge', '--squash', 'lane/7357']);
    f.git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'lane one (#7357)']);
    f.git(['checkout', '-q', 'lane/7379']);
    expect(f.run()).toMatchObject({ outcome: 'opened' });
  });
  it('the refusal names the sibling lanes and the fix command', () => {
    const f = fixture();
    f.git(['branch', 'lane/7366', 'lane/7357']);
    f.git(['branch', 'lane/7374', 'lane/7357']);
    const out = f.run();
    expect(out.detail).toContain('lane/7357');
    expect(out.detail).toContain('lane/7366');
    expect(out.detail).toContain('lane/7374');
    expect(out.detail).toContain('git rebase --onto');
    expect(out.blockers).toContainEqual(expect.objectContaining({ gate: 'sibling-base', reason: 'sibling-base' }));
  });
  it('allows stacked lanes with their parent declared as the base', () => {
    expect(fixture().run('lane/7357')).toMatchObject({ outcome: 'opened' });
  });
  it('fails closed on unreadable git state and preserves the other gates', () => {
    const f = fixture();
    const out = f.run('main', () => { throw new Error('unreadable'); });
    expect(out).toMatchObject({ outcome: 'refused', reason: 'sibling-base-unreadable' });
    expect(out.detail).toContain('inspect');
    expect(f.spawn.mock.calls[0][1]).toContain('--check');
  });
  it('fails closed on oversized evidence with an operator fallback', () => {
    const f = fixture();
    const read = createGitReader(f.cwd);
    const out = f.run('main', (args, opts) => args.includes('--format=%(objectname) %(refname)')
      ? Array.from({ length: 257 }, (_, i) => `${'a'.repeat(40)} refs/heads/lane/${i}`).join('\n') + '\n'
      : read(args, opts));
    expect(out).toMatchObject({ outcome: 'refused', reason: 'sibling-base-unreadable' });
    expect(out.detail).toContain('inspect');
  });
  it('runs the history guard for --check and skips a dry-run rehearsal', () => {
    const f = fixture();
    expect(f.run('main', createGitReader(f.cwd), ['--check'])).toMatchObject({ outcome: 'refused', reason: 'sibling-base' });
    const read = vi.fn(() => { throw new Error('must not read'); });
    f.run('main', read, ['--dry-run']);
    expect(read).not.toHaveBeenCalled();
  });
  it('allows the current lane cut on main when --ref is omitted', () => {
    const f = fixture();
    f.git(['checkout', '-qb', 'lane/default-ref', 'main']);
    f.commit('default-ref', 'own change');
    expect(checkSiblingBase({ git: createGitReader(f.cwd) })).toEqual({ ok: true });
  });
  it('still refuses inherited sibling history when --ref is omitted', () => {
    const f = fixture();
    const out = checkSiblingBase({ git: createGitReader(f.cwd) });
    expect(out).toMatchObject({ ok: false, reason: 'sibling-base' });
    expect(out.detail).toContain('lane/7357');
    expect(out.detail).not.toContain('lane/7379');
  });
  it('fails closed when the omitted --ref cannot resolve the current branch', () => {
    const f = fixture();
    f.git(['checkout', '--detach', '-q']);
    expect(checkSiblingBase({ git: createGitReader(f.cwd) })).toMatchObject({
      ok: false, reason: 'sibling-base-unreadable',
    });
  });

});
