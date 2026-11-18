import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPr } from '../review-pr-io.mjs';
import { computeNetDiffPaths, resolveNetDiffBasis } from '../../merge-ai-prs.mjs';

describe('review read pins real Git evidence before merge-base', () => {
  let root, base, executable, card;
  const git = (...args) => execFileSync('git', args, {
    cwd: root, encoding: 'utf8', env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
  }).trim();
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'review-pinned-head-'));
    git('init', '--quiet');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    writeFileSync(join(root, 'README.md'), 'base\n');
    git('add', '.');
    git('commit', '--quiet', '-m', 'base');
    base = git('rev-parse', 'HEAD');
    writeFileSync(join(root, 'executable.mjs'), 'console.log("security relevant");\n');
    git('add', '.');
    git('commit', '--quiet', '-m', 'executable change');
    executable = git('rev-parse', 'HEAD');
    git('checkout', '--quiet', '--detach', base);
    writeFileSync(join(root, 'card.md'), 'card only\n');
    git('add', '.');
    git('commit', '--quiet', '-m', 'card only');
    card = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/main', base);
    git('update-ref', 'refs/remotes/origin/lane/security', executable);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const read = hook => {
    const calls = [];
    const exec = (cmd, args, opts) => {
      expect(opts.env.GIT_NO_REPLACE_OBJECTS).toBe('1');
      calls.push(args);
      // Offline cached-ref operation: never perform a network call in this fixture.
      if (args[0] === 'fetch') throw new Error('offline fixture');
      hook?.(args);
      return execFileSync(cmd, args, { ...opts, cwd: root });
    };
    const result = readPr({ pr: 7, repo: 'o/n', cwd: root, exec, originRepo: () => 'o/n',
      readStack: () => null, readView: () => ({ number: 7, title: 'test', body: '',
        headRefName: 'lane/security', comments: [], labels: [], files: [] }) });
    return { result, calls };
  };
  const expectExecutable = result => {
    expect(result.net).toMatchObject({ scored: true, rev: executable, revSha: executable, base, paths: ['executable.mjs'] });
    expect(result.diff).toMatchObject({ scored: true, rev: executable, base });
    expect(result.diff.text).toContain('security relevant');
    expect(result.diff.text).not.toContain('card only');
  };

  it('keeps executable text and paths when the branch moves after merge-base and before scoring', () => {
    let raced = false;
    const { result, calls } = read(args => {
      if (args[0] === 'diff' && !raced) {
        // The merge-base has returned, but no scoring diff has executed yet.
        git('update-ref', 'refs/remotes/origin/lane/security', card);
        raced = true;
      }
    });
    expect(raced).toBe(true);
    expect(git('rev-parse', 'origin/lane/security')).toBe(card);
    expectExecutable(result);
    expect(calls.filter(a => a[0] === 'merge-base')).toEqual([
      ['merge-base', '--end-of-options', 'origin/main', executable],
    ]);
    for (const args of calls.filter(a => a[0] === 'diff')) expect(args.join(' ')).not.toContain('origin/lane/security');
    expect(calls.filter(a => a[0] === 'rev-parse')).toHaveLength(1);
  });

  it('ignores a real replace object that hides the executable tree', () => {
    git('replace', executable, card);
    // Prove the replacement would hide the executable without the protected env.
    const replaceEnv = { ...process.env };
    delete replaceEnv.GIT_NO_REPLACE_OBJECTS;
    expect(execFileSync('git', ['diff', '--name-only', base, executable], {
      cwd: root, encoding: 'utf8', env: replaceEnv,
    }).trim()).toBe('card.md');
    expectExecutable(read().result);
  });

  it('fails closed when the pinned object becomes unreadable before merge-base', () => {
    const { result } = read(args => {
      if (args[0] === 'merge-base') {
        rmSync(join(root, '.git', 'objects', executable.slice(0, 2), executable.slice(2)));
      }
    });
    expect(result.net.scored).toBe(false);
    expect(result.diff.scored).toBe(false);
    expect(result.net.revSha).toBeNull();
  });

  it('fails closed when no common ancestor exists', () => {
    git('update-ref', 'refs/remotes/origin/main', git('commit-tree', `${base}^{tree}`, '-m', 'unrelated root'));
    const { result } = read();
    expect(result.net).toMatchObject({ scored: false, reason: 'diff-failed' });
    expect(result.diff).toMatchObject({ scored: false, reason: 'diff-failed' });
  });

  it('fails closed when neither candidate resolves', () => {
    git('update-ref', '-d', 'refs/remotes/origin/lane/security');
    const { result } = read();
    expect(result.net).toMatchObject({ scored: false, revSha: null });
    expect(result.diff.scored).toBe(false);
  });

  it('rejects a shared paths basis for another request', () => {
    const exec = (cmd, args, opts) => {
      if (args[0] === 'fetch') throw new Error('offline fixture');
      return execFileSync(cmd, args, { ...opts, cwd: root });
    };
    const basis = resolveNetDiffBasis({ exec, rev: 'lane/security', pinRev: true });
    expect(basis.ok).toBe(true);
    expect(computeNetDiffPaths({ exec, rev: 'main', basis })).toMatchObject({ scored: false, reason: 'basis-mismatch' });
  });
});
