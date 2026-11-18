import { resolvePinnedDiffBasis } from '../../lib/pinned-diff-basis.mjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPr } from '../review-pr-io.mjs';
import { hardenedGitDiffCommand } from '../../lib/hardened-git-diff.mjs';
import { stackNetDiffText, stackNetFiles } from '../../conveyor/review-stack-base.mjs';
import { readFixRange } from '../review-pr-io.mjs';
import { computeNetDiffText, computeNetDiffPaths, resolveNetDiffBasis } from '../../merge-ai-prs.mjs';

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

  const read = (hook, overrides = {}) => {
    const calls = [];
    const exec = (cmd, args, opts) => {
      expect(opts.env.GIT_NO_REPLACE_OBJECTS).toBe('1');
      calls.push(args);
      // Explicit successful fetch evidence; never perform a network call in this fixture.
      if (args[0] === 'fetch') return ''; // Simulated successful transport.
      if (args.at(-1) === 'FETCH_HEAD^{commit}') return base;
      if (args.includes('diff')) {
        // These policies are absent from origin/main, even where --no-ext-diff
        // already protected text. Assert them on the production reader too.
        expect(opts.env.GIT_ATTR_NOSYSTEM).toBe('1');
        expect(opts.env.GIT_CONFIG_NOSYSTEM).toBe('1');
        expect(opts.env).not.toHaveProperty('GIT_EXTERNAL_DIFF');
        expect(args).toContain('core.attributesFile=/dev/null');
        expect(args).toContain('diff.external=');
        for (const flag of ['--no-ext-diff', '--no-textconv', '--no-renames', '--no-color']) expect(args).toContain(flag);
      }
      hook?.(args, opts);
      return execFileSync(cmd, args, { ...opts, cwd: root });
    };
    const result = readPr({ pr: 7, repo: 'o/n', cwd: root, exec, originRepo: () => 'o/n',
      readStack: () => null, readView: () => ({ number: 7, title: 'test', body: '',
        headRefName: 'lane/security', headRefOid: git('rev-parse', '--verify', 'refs/remotes/origin/lane/security'), comments: [], labels: [], files: [] }), ...overrides });
    return { result, calls };
  };
  it('invalidates both outputs when the first rendered text omits the later listed path', () => {
    let renders = 0;
    const exec = (cmd, args, opts) => {
      if (args[0] === 'fetch') return '';
      if (args.at(-1) === 'FETCH_HEAD^{commit}') return base;
      if (args.includes('diff') && !args.some(a => ['--raw', '--numstat', '--name-only'].includes(a))) {
        renders++;
        if (renders === 1) return '';
      }
      if (args.includes('--raw') && renders === 1) return '';
      return execFileSync(cmd, args, { ...opts, cwd: root });
    };
    const { result } = read(null, { exec });
    expect(result.net).toMatchObject({ scored: false, paths: [] });
    expect(result.diff).toMatchObject({ scored: false, text: '' });
    expect(renders).toBe(2);
  });

  const expectExecutable = result => {
    expect(result.net).toMatchObject({ scored: true, rev: executable, revSha: executable, base, paths: ['executable.mjs'] });
    expect(result.diff).toMatchObject({ scored: true, rev: executable, base });
    expect(result.diff.text).toContain('security relevant');
    expect(result.diff.text).not.toContain('card only');
  };

  it.each(['branch', 'tag', 'both'])('ignores %s shadow of the fetched base and scores the real change', shadow => {
    if (shadow !== 'tag') git('update-ref', 'refs/heads/origin/main', executable);
    if (shadow !== 'branch') git('update-ref', 'refs/tags/origin/main', executable);
    // Reproduce the vulnerable DWIM basis with real Git: the raw and rendered
    // diffs both agree on empty evidence for the wrong base.
    expect(git('rev-parse', '--verify', '--end-of-options', 'origin/main^{commit}')).toBe(executable);
    expect(git('diff', '--name-only', 'origin/main', executable)).toBe('');
    const calls = [];
    const exec = (cmd, args, opts) => {
      calls.push(args);
      if (args[0] === 'fetch') {
        // Exercise the ordering contract: fetch replaces a previously wrong base.
        git('update-ref', 'refs/remotes/origin/main', base);
        writeFileSync(join(root, '.git/FETCH_HEAD'), base + '\n');
        return '';
      }
      return execFileSync(cmd, args, { ...opts, cwd: root });
    };
    git('update-ref', 'refs/remotes/origin/main', executable);
    const basis = resolvePinnedDiffBasis(pinRequest({ exec, rev: executable, pinRev: true }));
    expect(basis).toMatchObject({ ok: true, baseSha: base, mergeBaseSha: base, headSha: executable });
    expect(calls[0][0]).toBe('fetch');
    expect(calls[1]).toEqual(['rev-parse', '--verify', '--end-of-options', 'refs/remotes/origin/main^{commit}']);
    const result = computeNetDiffText(evidenceOptions({ exec, rev: executable, basis, pinRev: true }));
    expect(result).toMatchObject({ scored: true, base, revSha: executable });
    expect(result.text).toContain('security relevant');
  });

  it('fails closed when the qualified base is missing despite a matching shadow tag', () => {
    git('update-ref', '-d', 'refs/remotes/origin/main');
    git('update-ref', 'refs/tags/origin/main', executable);
    const { result } = read();
    expect(result.diff).toMatchObject({ scored: false, text: '', reason: 'ref-unresolved' });
    expect(result.net.scored).toBe(false);
  });

  it.each([false, true])('tags never satisfy a branch candidate (pinRev=%s)', pinRev => {
    git('update-ref', '-d', 'refs/remotes/origin/lane/security');
    git('update-ref', 'refs/tags/origin/lane/security', card);
    git('update-ref', 'refs/tags/lane/security', card);
    const exec = (cmd, args, opts) => {
      if (args[0] === 'fetch') return ''; // Simulated successful transport.
      if (args.at(-1) === 'FETCH_HEAD^{commit}') return base;
      return execFileSync(cmd, args, { ...opts, cwd: root });
    };
    expect(computeNetDiffText(evidenceOptions({ exec, rev: 'lane/security', pinRev }))).toMatchObject({ scored: false, reason: 'ref-unresolved' });
    git('update-ref', 'refs/heads/lane/security', executable);
    const result = computeNetDiffText(evidenceOptions({ exec, rev: executable, pinRev }));
    expect(result.scored).toBe(true);
    expect(result.text).toContain('security relevant');
  });

  it('reuses the pinned base when the tracking ref moves before merge-base', () => {
    const { result } = read(args => {
      if (args[0] === 'merge-base') git('update-ref', 'refs/remotes/origin/main', executable);
    });
    expectExecutable(result);
  });

  it('refuses paired scoring when binary paths need human review', () => {
    git('checkout', '--quiet', '--detach', executable);
    writeFileSync(join(root, 'payload'), Buffer.from([0, 255, 1]));
    git('add', '.'); git('commit', '--quiet', '-m', 'binary alongside text');
    git('update-ref', 'refs/remotes/origin/lane/security', git('rev-parse', 'HEAD'));
    const { result } = read();
    expect(result.diff).toMatchObject({ scored: false, text: '', reason: 'needs-human-review' });
    expect(result.net.scored).toBe(false);
  });

  it('keeps executable text and paths when the branch moves after merge-base and before scoring', () => {
    let raced = false;
    const { result, calls } = read(args => {
      if (args.includes('diff') && !raced) {
        // The merge-base has returned, but no scoring diff has executed yet.
        git('update-ref', 'refs/remotes/origin/lane/security', card);
        raced = true;
      }
    });
    expect(raced).toBe(true);
    expect(git('rev-parse', 'origin/lane/security')).toBe(card);
    expectExecutable(result);
    expect(calls.filter(a => a[0] === 'merge-base')).toEqual([
      ['merge-base', '--end-of-options', base, executable],
    ]);
    for (const args of calls.filter(a => a.includes('diff'))) expect(args.join(' ')).not.toContain('origin/lane/security');
    expect(calls.filter(a => a[0] === 'rev-parse')).toHaveLength(3);
  });

  it('pins the standalone text helper before merge-base and never repins after the race', () => {
    let pins = 0;
    const exec = (cmd, args, opts) => {
      if (args[0] === 'fetch') return ''; // Simulated successful transport.
      if (args.at(-1) === 'FETCH_HEAD^{commit}') return base;
      if (args[0] === 'rev-parse') pins++;
      if (args.includes('diff')) git('update-ref', 'refs/remotes/origin/lane/security', card);
      return execFileSync(cmd, args, { ...opts, cwd: root });
    };
    const result = computeNetDiffText(evidenceOptions({ exec, rev: executable, pinRev: true }));
    expect(result).toMatchObject({ scored: true, revSha: executable, rev: executable, base });
    expect(result.text).toContain('security relevant');
    expect(pins).toBe(2);
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

  // Legacy comparison: origin/main reads these with plain git diff (text allowed
  // external/textconv drivers), inherited attributes/config, and replace objects.
  // Each attack first proves that legacy command loses the executable hunk.
  it.each([
    ['textconv driver', '* diff=hide', 'diff.hide.textconv'],
    ['external config', '', 'diff.external'],
    ['external environment', '', 'GIT_EXTERNAL_DIFF'],
    ['attribute external driver', '* diff=hide', 'diff.hide.command'],
    ['attribute -diff', '* -diff', null],
    ['attribute binary', '* binary', null],
    ['attribute driver binary', '* diff=hide', 'diff.hide.binary'],
  ])('preserves scoring evidence against %s', (_name, attributes, setting) => {
    git('checkout', '--quiet', '--detach', executable);
    if (attributes) {
      writeFileSync(join(root, '.gitattributes'), attributes + '\n');
      git('add', '.');
      git('commit', '--quiet', '-m', 'hostile attributes in head');
      executable = git('rev-parse', 'HEAD');
      git('update-ref', 'refs/remotes/origin/lane/security', executable);
    }
    const marker = join(root, 'driver-ran');
    const driver = join(root, 'hide-driver');
    writeFileSync(driver, '#!/bin/sh\nprintf ran > "' + marker + '"\nprintf "hidden\\n"\n');
    chmodSync(driver, 0o755);
    const env = { ...process.env };
    if (setting === 'GIT_EXTERNAL_DIFF') env.GIT_EXTERNAL_DIFF = driver;
    else if (setting) git('config', setting, setting.endsWith('.binary') ? 'true' : driver);
    const legacy = execFileSync('git', ['diff', base, executable], { cwd: root, encoding: 'utf8', env });
    expect(legacy).not.toContain('+console.log("security relevant");');
    rmSync(marker, { force: true });
    const run = (_cmd, args, opts) => {
      expect(opts.env.GIT_NO_REPLACE_OBJECTS).toBe('1');
      expect(opts.env.GIT_ATTR_NOSYSTEM).toBe('1');
      expect(opts.env.GIT_CONFIG_NOSYSTEM).toBe('1');
      expect(opts.env).not.toHaveProperty('GIT_EXTERNAL_DIFF');
      return execFileSync('git', args, { ...opts, cwd: root });
    };
    const command = hardenedGitDiffCommand(['diff', '--end-of-options', base, executable], {}, env);
    const text = String(run('git', command.args, command.opts));
    expect(text).toContain('+console.log("security relevant");');
    expect(stackNetDiffText({ basis: { ok: true, baseSha: base, mergeBaseSha: base, headSha: executable }, run: (a, o) => String(run('git', a, o)) }).text).toContain('security relevant');
    expect(stackNetFiles({ basis: { ok: true, baseSha: base, mergeBaseSha: base, headSha: executable }, run: (a, o) => String(run('git', a, o)) }).paths).toContain('executable.mjs');
    expect(readFixRange({ exec: run, priorHead: base, head: executable }).files).toHaveProperty('executable.mjs');
    const inherited = process.env.GIT_EXTERNAL_DIFF;
    let result;
    try {
      // Exercise the real executor wrappers too: they must not re-introduce a
      // removed variable by merging process.env back into the protected env.
      process.env.GIT_EXTERNAL_DIFF = driver;
      result = read().result;
    } finally {
      if (inherited === undefined) delete process.env.GIT_EXTERNAL_DIFF;
      else process.env.GIT_EXTERNAL_DIFF = inherited;
    }
    expect(result.diff.text).toContain('security relevant');
    expect(result.net.paths).toContain('executable.mjs');
    expect(result.net.scored).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it('retains hunks with repo-local core.bigFileThreshold=1 (legacy helper loses them)', () => {
    git('config', 'core.bigFileThreshold', '1');
    const legacy = execFileSync('git', ['--attr-source=4b825dc642cb6eb9a060e54bf8d69288fbee4904',
      '-c', 'core.attributesFile=/dev/null', '-c', 'diff.external=', 'diff', '--no-ext-diff',
      '--no-textconv', '--no-renames', '--no-color', base, executable], { cwd: root, encoding: 'utf8' });
    expect(legacy).toContain('Binary files');
    expect(legacy).not.toContain('@@');
    const { result } = read();
    expect(result.net.scored).toBe(true);
    expect(result.diff.text).toContain('+console.log("security relevant");');
  });

  it.each([
    ['diff.algorithm', 'histogram'], ['diff.renames', 'copies'], ['diff.noprefix', 'true'],
    ['diff.context', '0'], ['diff.interHunkContext', '99'], ['diff.mnemonicPrefix', 'true'],
    ['diff.srcPrefix', 'old/'], ['diff.dstPrefix', 'new/'], ['diff.relative', 'true'],
    ['core.quotePath', 'true'],
  ])('pins repo-local %s rendering to the scorer defaults', (key, value) => {
    const before = read().result;
    expect(before.diff.scored).toBe(true);
    git('config', key, value);
    const after = read().result;
    expect(after.diff.scored).toBe(true);
    expect(after.diff.text).toBe(before.diff.text);
    expect(after.net.paths).toEqual(before.net.paths);
  });

  it('refuses an empty successful renderer when raw oids changed', () => {
    const exec = (cmd, args, opts) => {
      if (args[0] === 'fetch') return ''; // Simulated successful transport.
      if (args.at(-1) === 'FETCH_HEAD^{commit}') return base;
      if (args.includes('diff') && !args.some(a => ['--raw', '--numstat', '--name-only'].includes(a))) return '';
      return execFileSync(cmd, args, { ...opts, cwd: root });
    };
    expect(computeNetDiffText(evidenceOptions({ exec, rev: 'lane/security' }))).toMatchObject({ scored: false, text: '' });
    expect(computeNetDiffPaths(evidenceOptions({ exec, rev: 'lane/security' }))).toMatchObject({ scored: false, paths: [] });
  });

  // origin/main allowed one half to remain scored when the other command threw.
  it.each(['text', 'paths', 'numstat'])('invalidates both halves when %s fails', failed => {
    const { result } = read(args => {
      if (!args.includes('diff')) return;
      const kind = args.includes('--name-only') ? 'paths' : args.includes('--numstat') ? 'numstat' : 'text';
      if (kind === failed) throw new Error('injected real-Git boundary failure');
    });
    expect(result.net).toMatchObject({ scored: false, revSha: null });
    expect(result.diff.scored).toBe(false);
    expect(result.diff.text).toBe('');
    expect(result.net.paths).toEqual([]);
  });

  it('invalidates the complete score when the bounded text read overflows', () => {
    const { result } = read((args, opts) => {
      if (args.includes('diff') && !args.includes('--numstat') && !args.includes('--name-only')) opts.maxBuffer = 16;
    });
    expect(result.net).toMatchObject({ scored: false, revSha: null });
    expect(result.diff).toMatchObject({ scored: false, text: '' });
  });

  it.each(['stack text', 'stack paths', 'latestFix', 'delta text', 'delta numstat'])(
    'invalidates the complete score when %s fails', failed => {
      const comments = [{ author: { login: 'web-everything' }, body: `<!-- reviewed-sha: ${base} -->` }];
      const { result } = read(args => {
        if (!args.includes('diff')) return;
        if (failed === 'latestFix' && args.includes('--unified=0')) throw new Error('fix unreadable');
        if (args.includes('--unified=0') || args.includes('--end-of-options')) return;
        if (failed === 'delta text' && !args.includes('--numstat')) throw new Error('delta unreadable');
        if (failed === 'delta numstat' && args.includes('--numstat')) throw new Error('delta size unreadable');
      }, failed.startsWith('stack') ? {
        readStack: () => ({ topHead: executable, tree: base }),
        stackRead: {
          text: () => { if (failed === 'stack text') throw new Error('stack text unreadable'); return 'some diff'; },
          files: () => { throw new Error('stack paths unreadable'); },
        },
      } : {
        readView: () => ({ number: 7, headRefName: 'lane/security', comments, labels: [], files: [] }),
      });
      expect(result.net).toMatchObject({ scored: false, revSha: null });
      expect(result.diff).toMatchObject({ scored: false, text: '' });
      expect(result.deltaReview).toBeNull();
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
    const unrelated = git('commit-tree', `${base}^{tree}`, '-m', 'unrelated root');
    git('update-ref', 'refs/heads/main', unrelated);
    git('update-ref', 'refs/heads/lane/security', executable);
    // Let production fetch and verify the unrelated base from a real local origin.
    const origin = join(root, 'origin.git');
    git('clone', '--quiet', '--bare', root, origin);
    git('remote', 'add', 'origin', origin);
    const calls = [];
    const { result } = read(null, { exec: (cmd, args, opts) => {
      calls.push(args);
      return execFileSync(cmd, args, { ...opts, cwd: root });
    } });
    expect(git('rev-parse', 'FETCH_HEAD^{commit}')).toBe(unrelated);
    expect(git('rev-parse', 'refs/remotes/origin/main')).toBe(unrelated);
    expect(calls).toContainEqual(['merge-base', '--end-of-options', unrelated, executable]);
    expect(result.net).toMatchObject({ scored: false, reason: 'diff-failed' });
    expect(result.diff).toMatchObject({ scored: false, reason: 'diff-failed' });
  });

  it('fails closed when the reported commit is unavailable', () => {
    git('update-ref', '-d', 'refs/remotes/origin/lane/security');
    const { result } = read(null, { readView: () => ({ number: 7, headRefName: 'lane/security', headRefOid: 'f'.repeat(40), comments: [], labels: [], files: [] }) });
    expect(result.net).toMatchObject({ scored: false, revSha: null });
    expect(result.diff.scored).toBe(false);
  });

  it('rejects a shared paths basis for another request', () => {
    const exec = (cmd, args, opts) => {
      if (args[0] === 'fetch') return ''; // Simulated successful transport.
      if (args.at(-1) === 'FETCH_HEAD^{commit}') return base;
      return execFileSync(cmd, args, { ...opts, cwd: root });
    };
    const basis = resolvePinnedDiffBasis(pinRequest({ exec, rev: executable, pinRev: true }));
    expect(basis.ok).toBe(true);
    const paths = computeNetDiffPaths({ exec, basis: { ...basis, headSha: 'origin/main' } });
    expect(paths).toMatchObject({ scored: false, reason: 'basis-mismatch' });
  });
});

function pinRequest(options) {
  return { exec: options.exec, remote: options.remote, baseRef: options.base ?? 'main', headSha: options.rev };
}
function evidenceOptions(options) {
  return { exec: options.exec, baseRev: options.baseRev, basis: options.basis ?? resolvePinnedDiffBasis(pinRequest(options)) };
}
