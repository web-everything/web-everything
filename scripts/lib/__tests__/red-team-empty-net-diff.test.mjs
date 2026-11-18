import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyEmptyNetDiff } from '../red-team-empty-net-diff.mjs';
import { resolveNetDiffBasis, computeNetDiffText } from '../../merge-ai-prs.mjs';

describe('empty net diff provenance probes', () => {
  const base = 'a'.repeat(40), head = 'b'.repeat(40);
  const read = { netBasis: { base, rev: head, scored: true }, netChangedFiles: [], diffText: '', diffScored: true };
  it.each(['mismatch', 'missing ref', 'empty', 'malformed', 'multiple bases', 'oversized'])('refuses %s merge-base evidence before diff', kind => {
    const exec = vi.fn((_file, args, options) => {
      if (args.includes('rev-parse')) return base;
      if (kind === 'missing ref') throw Error('unknown base ref');
      const output = { mismatch: 'c'.repeat(40), empty: '', malformed: 'invalid',
        'multiple bases': `${base}\n${head}`, oversized: 'x'.repeat(1024 * 1024 + 1) }[kind];
      if (Buffer.byteLength(output) > options.maxBuffer) throw Object.assign(Error('maxBuffer'), { code: 'ENOBUFS' });
      return output;
    });
    expect(verifyEmptyNetDiff(read, head, { exec, cwd: 'subject' })).toBe(false);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls[1][1]).toEqual(['--no-replace-objects', 'merge-base', '--end-of-options', 'origin/main', head]);
    expect(exec.mock.calls[1][2]).toMatchObject({ cwd: 'subject', maxBuffer: 1024 * 1024, timeout: 30_000 });
  });
  it('accepts only after matching provenance and executing the hardened diff', () => {
    const exec = vi.fn().mockReturnValueOnce(base).mockReturnValueOnce(`${base}\n`).mockReturnValueOnce('');
    expect(verifyEmptyNetDiff(read, head, { exec })).toBe(true);
    expect(exec).toHaveBeenCalledTimes(3);
    expect(exec.mock.calls[1][1]).toEqual(['--no-replace-objects', 'merge-base', '--end-of-options', 'origin/main', head]);
    expect(exec.mock.calls[2][1]).toEqual(['--no-replace-objects', 'diff', '--no-ext-diff', '--no-textconv', '--no-renames',
      '--ignore-submodules=none', '--name-only', '-z', '--end-of-options', `${base}..${head}`, '--']);
  });
});

describe('empty net diff base provenance (real git)', () => {
  function fixture(run) {
    const cwd = mkdtempSync(join(tmpdir(), 'empty-diff-provenance-'));
    const git = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
    try {
      git('init', '--quiet');
      writeFileSync(join(cwd, 'file.txt'), 'base\n');
      git('add', 'file.txt');
      git('commit', '--quiet', '-m', 'base');
      const base = git('rev-parse', 'HEAD');
      git('update-ref', 'refs/remotes/origin/main', base);
      writeFileSync(join(cwd, 'file.txt'), 'real change\n');
      git('commit', '--quiet', '-am', 'change');
      const sameTree = git('rev-parse', 'HEAD');
      git('commit', '--quiet', '--allow-empty', '-m', 'head');
      const head = git('rev-parse', 'HEAD');
      const replacement = git('commit-tree', `${base}^{tree}`, '-p', sameTree, '-m', 'planted');
      git('replace', base, replacement);
      const poisonedBase = git('merge-base', 'origin/main', head);
      expect(poisonedBase).toBe(sameTree);
      expect(poisonedBase).not.toBe(head);
      expect(git('--no-replace-objects', 'diff', '--name-only', `${poisonedBase}..${head}`)).toBe('');
      expect(git('--no-replace-objects', 'merge-base', 'origin/main', head)).toBe(base);
      expect(git('--no-replace-objects', 'diff', '--name-only', `${base}..${head}`)).toBe('file.txt');
      run({ cwd, git, base, head, poisonedBase });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  }

  it('refuses a replaced merge-base distinct from head but sharing its tree', () => fixture(({ cwd, head, poisonedBase }) => {
    const exec = vi.fn(execFileSync);
    const read = { netBasis: { base: poisonedBase, rev: head, scored: true }, netChangedFiles: [], diffText: '', diffScored: true };
    expect(verifyEmptyNetDiff(read, head, { cwd, exec })).toBe(false);
    expect(exec).toHaveBeenCalledWith('git', ['--no-replace-objects', 'merge-base', '--end-of-options', 'origin/main', head], expect.anything());
  }));

  it('produces the legitimate merge-base despite a planted replace ref', () => fixture(({ cwd, base, head }) => {
    // No network: the real local tracking ref is already staged. Every read executes Git.
    const exec = vi.fn((file, args, options) => args[0] === 'fetch' ? '' : execFileSync(file, args, { ...options, cwd }));
    const basis = resolveNetDiffBasis({ exec, rev: head });
    expect(basis).toMatchObject({ ok: true, diffBase: base, basisKind: 'merge-base' });
    expect(exec.mock.calls.some(([, args]) => args.includes('merge-base'))).toBe(true);
    expect(exec.mock.calls.some(([, args]) => args.includes('diff'))).toBe(true);
  }));

  it('recomputes the pinned text payload base without replacements', () => fixture(({ cwd, base, head, poisonedBase }) => {
    const exec = vi.fn((file, args, options) => args[0] === 'fetch' ? '' : execFileSync(file, args, { ...options, cwd }));
    const basis = resolveNetDiffBasis({ exec, rev: head });
    exec.mockClear();
    const text = computeNetDiffText({ exec, rev: head, basis: { ...basis, diffBase: poisonedBase }, pinRev: true });
    expect(text).toMatchObject({ scored: true, base, revSha: head });
    expect(text.text).toContain('+real change');
    expect(exec.mock.calls.map(([, args]) => args[0])).toEqual(['rev-parse', 'merge-base', 'diff']);
    expect(exec.mock.calls[1][2].env.GIT_NO_REPLACE_OBJECTS).toBe('1');
  }));
});
