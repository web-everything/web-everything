import { afterEach, describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyDiffExemptionEvidence } from '../red-team-empty-net-diff.mjs';
import { emptyDiffFixture } from './red-team-empty-net-diff-fixture.mjs';
import { resolveNetDiffBasis, computeNetDiffText } from '../../merge-ai-prs.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function verify(read, head, options) {
  const f = emptyDiffFixture(); roots.push(f.root);
  f.writeStore([{ ...f.row, rev: head }]);
  return emptyDiffExemptionEvidence({ ...f.proof, read, head, seatRecord: { head }, ...options }).exempt;
}

describe('empty net diff provenance probes', () => {
  const base = 'a'.repeat(40), head = 'b'.repeat(40);
  const read = { netBasis: { base, rev: head, scored: true }, netChangedFiles: [], diffText: '', diffScored: true };
  it.each(['mismatch', 'missing ref', 'empty', 'malformed', 'unmatched multiple bases', 'malformed multiple bases', 'oversized'])('refuses %s merge-base evidence before diff', kind => {
    const exec = vi.fn((_file, args, options) => {
      if (args.includes('rev-parse')) return base;
      if (kind === 'missing ref') throw Error('unknown base ref');
      const output = { mismatch: 'c'.repeat(40), empty: '', malformed: 'invalid',
        'unmatched multiple bases': `${'c'.repeat(40)}\n${'d'.repeat(40)}`,
        'malformed multiple bases': `${base}\ninvalid`, oversized: 'x'.repeat(1024 * 1024 + 1) }[kind];
      if (Buffer.byteLength(output) > options.maxBuffer) throw Object.assign(Error('maxBuffer'), { code: 'ENOBUFS' });
      return output;
    });
    expect(verify(read, head, { exec, cwd: 'subject' })).toBe(false);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls[1][1]).toEqual(['--no-replace-objects', 'merge-base', '--all', '--end-of-options', 'origin/main', head]);
    expect(exec.mock.calls[1][2]).toMatchObject({ cwd: 'subject', maxBuffer: 1024 * 1024, timeout: 30_000 });
  });
  it('accepts only after matching provenance and executing the hardened diff', () => {
    const exec = vi.fn().mockReturnValueOnce(base).mockReturnValueOnce(`${base}\n`).mockReturnValueOnce('');
    expect(verify(read, head, { exec, cwd: 'subject' })).toBe(true);
    expect(exec).toHaveBeenCalledTimes(3);
    expect(exec.mock.calls[1][1]).toEqual(['--no-replace-objects', 'merge-base', '--all', '--end-of-options', 'origin/main', head]);
    expect(exec.mock.calls[2][1]).toEqual(['--no-replace-objects', 'diff', '--no-ext-diff', '--no-textconv', '--no-renames',
      '--ignore-submodules=none', '--name-only', '-z', '--end-of-options', `${base}..${head}`, '--']);
  });
  it('refuses an unresolvable second merge-base after probing the stored base', () => {
    const other = 'c'.repeat(40);
    const exec = vi.fn().mockReturnValueOnce(base).mockReturnValueOnce(`${base}\n${other}\n`)
      .mockReturnValueOnce('').mockImplementationOnce(() => { throw Error('bad object'); });
    const f = emptyDiffFixture(); roots.push(f.root);
    f.writeStore([{ ...f.row, rev: head }]);
    expect(emptyDiffExemptionEvidence({ ...f.proof, read, head, seatRecord: { head }, exec }))
      .toEqual({ exempt: false, reason: 'diff-unreadable' });
    expect(exec.mock.calls.slice(2).map(([, args]) => args.at(-2))).toEqual([`${base}..${head}`, `${other}..${head}`]);
  });
});

describe('empty net diff base provenance (real git)', () => {
  function fixture(run) {
    const cwd = mkdtempSync(join(tmpdir(), 'empty-diff-provenance-'));
    let gitClock = 1700000000;
    const git = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env,
        GIT_AUTHOR_DATE: `@${++gitClock} +0000`, GIT_COMMITTER_DATE: `@${gitClock} +0000` } }).trim();
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
      // A separate main tip keeps the replacement graph acyclic; its legitimate merge-base is base.
      const mainTip = git('commit-tree', `${base}^{tree}`, '-p', base, '-m', 'main tip');
      git('update-ref', 'refs/remotes/origin/main', mainTip);
      const replacement = git('commit-tree', `${base}^{tree}`, '-p', sameTree, '-m', 'planted');
      git('replace', mainTip, replacement);
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
    expect(verify(read, head, { cwd, exec })).toBe(false);
    expect(exec).toHaveBeenCalledWith('git', ['--no-replace-objects', 'merge-base', '--all', '--end-of-options', 'origin/main', head], expect.anything());
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


describe('complete positive exemption evidence (real Git)', () => {
  function crissCross(f, { sameTrees = false, storedOutside = false } = {}) {
    const root = f.base;
    const left = f.git('commit-tree', `${root}^{tree}`, '-p', root, '-m', 'left base');
    writeFileSync(join(f.root, 'file.txt'), 'other base\n');
    f.git('add', 'file.txt');
    const rightTree = sameTrees ? `${root}^{tree}` : f.git('write-tree');
    const right = f.git('commit-tree', rightTree, '-p', root, '-m', 'right base');
    const head = f.git('commit-tree', `${left}^{tree}`, '-p', left, '-p', right, '-m', 'left merge');
    const main = f.git('commit-tree', `${left}^{tree}`, '-p', right, '-p', left, '-m', 'right merge');
    f.git('update-ref', 'refs/remotes/origin/main', main);
    const bases = f.git('--no-replace-objects', 'merge-base', '--all', 'origin/main', head).split('\n');
    expect(new Set(bases)).toEqual(new Set([left, right]));
    expect(f.git('--no-replace-objects', 'diff', '--name-only', `${left}..${head}`)).toBe('');
    expect(f.git('--no-replace-objects', 'diff', '--name-only', `${right}..${head}`)).toBe(sameTrees ? '' : 'file.txt');
    f.head = f.proof.head = f.status.head = f.row.rev = f.read.netBasis.rev = head;
    f.read.netBasis.base = storedOutside ? root : left;
    f.writeStore();
    f.expectedDiffBases = storedOutside ? [] : [left, right];
  }

  it.each([
    ['all present (single base)', () => {}, true, 'empty-net-diff', 'diff'],
    ['criss-cross: empty against stored base but changed against other base', f => crissCross(f),
      false, 'diff-nonempty-vs-base', 'diff'],
    ['criss-cross: empty against every base', f => crissCross(f, { sameTrees: true }),
      true, 'empty-net-diff', 'diff'],
    ['criss-cross: stored base is not a merge base', f => crissCross(f, { storedOutside: true }),
      false, 'base-ambiguous', 'merge-base'],
    ['missing store', f => rmSync(f.storePath), false, 'store-missing'],
    ['unreadable store', f => { rmSync(f.storePath); mkdirSync(f.storePath); }, false, 'store-unreadable'],
    ['malformed store', f => writeFileSync(f.storePath, '{broken'), false, 'store-unparseable'],
    ['empty file', f => writeFileSync(f.storePath, ''), false, 'store-unparseable'],
    ['invalid store shape', f => writeFileSync(f.storePath, '{}'), false, 'store-unparseable'],
    ['missing seat', f => f.writeStore([]), false, 'seat-record-missing'],
    ['wrong seat head', f => f.writeStore([{ ...f.row, rev: 'a'.repeat(40) }]), false, 'seat-record-missing'],
    ['wrong seat repo', f => f.writeStore([{ ...f.row, repo: 'other/repo' }]), false, 'seat-record-missing'],
    ['wrong seat PR', f => f.writeStore([{ ...f.row, pr: 123 }]), false, 'seat-record-missing'],
    ['missing checkout', f => { delete f.proof.cwd; }, false, 'cwd-missing'],
    ['unresolvable base', f => { f.read.netBasis.base = 'missing-ref'; }, false, 'base-unresolvable', 'rev-parse'],
    ['missing main ref', f => f.git('update-ref', '-d', 'refs/remotes/origin/main'), false, 'base-unresolvable', 'merge-base'],
    ['mismatched base', f => { f.read.netBasis.base = f.head; }, false, 'base-mismatch', 'merge-base'],
    ['unreadable diff', f => { f.failDiff = true; }, false, 'diff-unreadable', 'diff'],
    ['oversized diff', f => { f.oversizeDiff = true; }, false, 'diff-unreadable', 'diff'],
    ['unscored read', f => { f.read.diffScored = false; }, false, 'read-unproven'],
    ['moved source', f => { f.loopPayload.carriedFrom = f.base; }, false, 'read-unproven'],
  ])('%s => %s / %s', (_name, mutate, exempt, reason, reached) => {
    const f = emptyDiffFixture(); roots.push(f.root); mutate(f);
    const calls = [];
    const exec = (file, args, options) => {
      calls.push([file, args, options]);
      if (args.includes('diff') && f.failDiff) throw Error('diff unavailable');
      if (args.includes('diff') && f.oversizeDiff) return 'x'.repeat(1024 * 1024 + 1);
      return execFileSync(file, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    };
    expect(emptyDiffExemptionEvidence({ ...f.proof, exec })).toEqual({ exempt, reason });
    if (reached) expect(calls.some(([, args]) => args.includes(reached))).toBe(true);
    else expect(calls).toHaveLength(0);
    if (f.expectedDiffBases) {
      expect(calls.find(([, args]) => args.includes('merge-base'))[1]).toContain('--all');
      expect(calls.filter(([, args]) => args.includes('diff')).map(([, args]) => args.at(-2)))
        .toEqual(f.expectedDiffBases.map(base => `${base}..${f.head}`));
    }
    for (const [, args, options] of calls) {
      expect(args[0]).toBe('--no-replace-objects');
      expect(options.env.GIT_NO_REPLACE_OBJECTS).toBe('1');
      expect(options.cwd).toBe(f.root);
    }
  });

  it.each([false, true])('refuses a real nonempty diff (planted head replace ref: %s)', replace => {
    const f = emptyDiffFixture({ realDiff: true }); roots.push(f.root);
    if (replace) {
      const planted = f.git('commit-tree', `${f.base}^{tree}`, '-p', f.base, '-m', 'planted');
      f.git('replace', f.head, planted);
      expect(f.git('diff', '--name-only', `${f.base}..${f.head}`)).toBe('');
    }
    const exec = vi.fn(execFileSync);
    expect(emptyDiffExemptionEvidence({ ...f.proof, exec })).toEqual({ exempt: false, reason: 'diff-nonempty' });
    expect(exec.mock.calls.at(-1)[1]).toContain('diff');
    expect(exec.mock.results.at(-1).value).toBe('file.txt\0');
  });
});
