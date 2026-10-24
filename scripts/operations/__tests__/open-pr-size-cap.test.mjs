/**
 * @file open-pr-size-cap.test.mjs — red-first contract for the pre-submit size cap.
 * Runner submissions are injected; real git fixtures exercise NUL-delimited evidence.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as openPr from '../open-pr.mjs';
import { createPrLandRunner, createPrDiffStatReader } from '../open-pr-io.mjs';

// Explicitly opt into the production Git reader while keeping every other runner IO hermetic.
const submit = vi.fn(() => { throw new Error('unexpected submission'); });
const defaultReaderRunner = (options = {}) => createPrLandRunner({
  ...options, spawn: submit, diffStat: createPrDiffStatReader(options),
});

afterEach(() => {
  vi.clearAllMocks();
  submit.mockReset().mockImplementation(() => { throw new Error('unexpected submission'); });
});

const argv = ['--ref=lane/size-cap'];
const opened = { outcome: 'opened', pr: 7, url: 'u' };
const fixture = (numstatText, overrides = {}) => {
  const prePrReview = vi.fn(() => ({ action: 'pass' }));
  const diffStat = vi.fn(() => numstatText);
  const spawn = vi.fn(() => ({ status: 0, stdout: JSON.stringify({ pr: 7, url: 'u' }) }));
  const run = createPrLandRunner({ prePrReview, diffStat, spawn, ...overrides });
  return { run, prePrReview, diffStat, spawn };
};

describe('measureNonTestLines — pure numstat accounting', () => {
  it('exports a 300-line non-test limit', () => {
    expect(openPr.OPEN_PR_MAX_NON_TEST_LINES).toBe(300);
  });

  it('treats empty input as zero changes without a backlog exemption', () => {
    expect(openPr.measureNonTestLines('')).toEqual({ lines: 0, exempt: false });
  });

  it('sums additions and deletions across non-test paths, with or without a trailing newline', () => {
    const text = '100\t50\tscripts/operations/open-pr.mjs\n20\t30\tdocs/a guide.md';
    expect(openPr.measureNonTestLines(text)).toEqual({ lines: 200, exempt: false });
    expect(openPr.measureNonTestLines(`${text}\n`)).toEqual({ lines: 200, exempt: false });
  });

  it('reads NUL-delimited paths containing non-ASCII characters, tabs, newlines and quotes literally', () => {
    expect(openPr.measureNonTestLines('700\t100\tbacklog/é.md\0'))
      .toEqual({ lines: 800, exempt: true });
    expect(openPr.measureNonTestLines('1\t2\tscripts/a\tb\nc"d.mjs\0'))
      .toEqual({ lines: 3, exempt: false });
    expect(openPr.measureNonTestLines('200\t50\tscripts/a.mjs\0' + '600\t300\tscripts/__tests__/é.mjs\0'))
      .toEqual({ lines: 250, exempt: false });
  });

  it('counts renames by their numstat counts and classifies both paths', () => {
    expect(openPr.measureNonTestLines('0\t0\t\0scripts/old.mjs\0scripts/new.mjs\0'))
      .toEqual({ lines: 0, exempt: false });
    expect(openPr.measureNonTestLines('1\t1\t\0scripts/old.test.mjs\0scripts/new.mjs\0'))
      .toEqual({ lines: 2, exempt: false });
    expect(openPr.measureNonTestLines('400\t0\t\0scripts/old.mjs\0scripts/new.test.mjs\0'))
      .toEqual({ lines: 400, exempt: false });
    expect(openPr.measureNonTestLines('400\t0\t\0docs/old.md\0backlog/new.md\0'))
      .toEqual({ lines: 400, exempt: false });
    expect(openPr.measureNonTestLines('400\t0\t\0backlog/old.md\0docs/new.md\0'))
      .toEqual({ lines: 400, exempt: false });
    expect(openPr.measureNonTestLines('400\t0\t\0scripts/old.test.mjs\0scripts/__tests__/new.mjs\0'))
      .toEqual({ lines: 0, exempt: false });
    expect(openPr.measureNonTestLines('400\t0\t\0backlog/old.md\0backlog/new.md\0'))
      .toEqual({ lines: 400, exempt: true });
  });

  it.each([
    'assets/image.png',
    'scripts/a.mjs',
    'scripts/a.test.mjs',
    'backlog/a.md',
  ])('throws for unmeasurable binary counts on %s', (path) => {
    for (const terminator of ['\n', '\0']) {
      expect(() => openPr.measureNonTestLines(`-\t-\t${path}${terminator}`)).toThrow(/unmeasurable/);
    }
  });

  it.each([
    '__tests__/a.mjs',
    'scripts/x/__tests__/a.test.mjs',
    'scripts/x/__tests__/fixtures/input.json',
    'a.test.mjs',
    'scripts/x/a.spec.ts',
  ])('excludes additions and deletions for test path %s', (path) => {
    expect(openPr.measureNonTestLines(`200\t50\tscripts/x.mjs\n600\t300\t${path}\n`))
      .toEqual({ lines: 250, exempt: false });
  });

  it('counts similarly named non-test paths', () => {
    expect(openPr.measureNonTestLines('10\t5\tscripts/__tests__helpers/a.mjs\n20\t5\tscripts/a.testing.mjs\n'))
      .toEqual({ lines: 40, exempt: false });
  });

  it('exempts a nonempty diff only when every path starts with backlog/', () => {
    expect(openPr.measureNonTestLines('700\t100\tbacklog/a.md\n150\t50\tbacklog/nested/b.md\n'))
      .toEqual({ lines: 1000, exempt: true });
    expect(openPr.measureNonTestLines('0\t0\tbacklog/a.md\n'))
      .toEqual({ lines: 0, exempt: true });
  });

  it('does not exempt mixed paths, even when the outside path is a test', () => {
    expect(openPr.measureNonTestLines('1000\t0\tbacklog/a.md\n1\t0\tscripts/a.mjs\n'))
      .toEqual({ lines: 1001, exempt: false });
    expect(openPr.measureNonTestLines('1000\t0\tbacklog/a.md\n900\t0\tscripts/a.test.mjs\n'))
      .toEqual({ lines: 1000, exempt: false });
  });

  it.each([
    ['non-numeric additions', 'oops\t1\tscripts/a.mjs\n'],
    ['non-numeric deletions', '1\toops\tscripts/a.mjs\n'],
    ['missing count', '1\tscripts/a.mjs\n'],
    ['missing path', '1\t2\n'],
    ['empty path', '1\t2\t\n'],
    ['malformed line after valid evidence', '1\t2\tscripts/a.mjs\nmalformed\n'],
    ['quoted legacy path without NUL evidence', '1\t2\t"backlog/\\303\\251.md"\n'],
    ['mixed binary and numeric counts', '-\t1\tassets/image.png\0'],
    ['mixed numeric and binary counts', '1\t-\tassets/image.png\0'],
    ['unterminated NUL record', '1\t0\tscripts/a.mjs\0' + '2\t0\tscripts/b.mjs'],
    ['truncated rename', '1\t1\t\0scripts/old.mjs\0'],
    ['empty rename source', '1\t1\t\0\0scripts/new.mjs\0'],
    ['empty rename destination', '1\t1\t\0scripts/old.mjs\0\0'],
    ['malformed NUL row after valid evidence', '1\t0\tbacklog/a.md\0malformed\0'],
    ['unsafe count', '9007199254740992\t0\tscripts/a.mjs\0'],
    ['unsafe total', '9007199254740991\t0\tscripts/a.mjs\0' + '1\t0\tscripts/b.mjs\0'],
  ])('throws rather than silently undercounting %s', (_name, text) => {
    expect(openPr.measureNonTestLines).toBeTypeOf('function');
    expect(() => openPr.measureNonTestLines(text)).toThrow();
  });
});

describe('default git reader — filename encoding', () => {
  const encodedFixture = ({ numstat, topLevel = Buffer.from('/repo\n'), entry, blob = Buffer.from('code\n') }) => {
    const exec = vi.fn((_command, args, options) => {
      let output;
      if (args.includes('--show-toplevel')) output = topLevel;
      else if (args.includes('rev-parse')) output = Buffer.from('resolved-sha\n');
      else if (args.includes('diff')) output = numstat;
      else if (args.includes('merge-base')) output = Buffer.from('base-sha\n');
      else if (args.includes('ls-tree')) output = entry ?? Buffer.alloc(0);
      else if (args.includes('cat-file')) output = blob;
      else throw new Error(`unexpected git call: ${args}`);
      return options.encoding ? output.toString(options.encoding) : output;
    });
    return { exec, ...fixture(undefined, { diffStat: createPrDiffStatReader({ cwd: '/repo', exec }) }) };
  };

  it.each([
    ['ordinary path', Buffer.from('production-'), Buffer.from('.mjs')],
    ['rename source', Buffer.from('\0production-'), Buffer.from('.mjs\0replacement.mjs')],
    ['rename destination', Buffer.from('\0original.mjs\0production-'), Buffer.from('.mjs')],
  ])('refuses lossy UTF-8 decoding in a binary %s before submission', (_kind, prefix, suffix) => {
    const numstat = Buffer.concat([Buffer.from('-\t-\t'), prefix, Buffer.from([0xff]), suffix, Buffer.from('\0')]);
    const { exec, run, spawn } = encodedFixture({ numstat });
    expect(run({ argv })).toMatchObject({ outcome: 'refused', reason: 'pr-size-unreadable' });
    expect(spawn).not.toHaveBeenCalled();
    expect(exec.mock.calls.some(([, args]) => args.includes('ls-tree'))).toBe(false);
  });

  it('refuses an invalid UTF-8 repository root before using it as cwd', () => {
    const { exec, run, spawn } = encodedFixture({
      numstat: Buffer.from('1\t0\tproduction.mjs\0'),
      topLevel: Buffer.concat([Buffer.from('/repo-'), Buffer.from([0xff]), Buffer.from('\n')]),
    });
    expect(run({ argv })).toMatchObject({ outcome: 'refused', reason: 'pr-size-unreadable' });
    expect(spawn).not.toHaveBeenCalled();
    expect(exec.mock.calls.some(([, args]) => args.includes('diff'))).toBe(false);
  });

  it.each([' ', '\t', '\r', '\n'])('preserves trailing repository whitespace %j when selecting the diff cwd', (suffix) => {
    const root = `/repo${suffix}`;
    const { exec, run, spawn } = encodedFixture({
      numstat: Buffer.from('301\t0\tproduction.mjs\0'),
      topLevel: Buffer.from(`${root}\n`),
    });
    expect(run({ argv })).toMatchObject({ outcome: 'refused', reason: 'pr-too-large' });
    expect(spawn).not.toHaveBeenCalled();
    expect(exec.mock.calls.find(([, args]) => args.includes('diff'))[1].slice(0, 2))
      .toEqual(['-C', root]);
  });

  it('refuses invalid UTF-8 tree metadata instead of accepting a substituted filename', () => {
    const { run, spawn } = encodedFixture({
      numstat: Buffer.from('-\t-\tproduction-\ufffd.mjs\0'),
      entry: Buffer.concat([Buffer.from(`100644 blob ${'a'.repeat(40)}\tproduction-`), Buffer.from([0xff]), Buffer.from('.mjs\0')]),
    });
    expect(run({ argv })).toMatchObject({ outcome: 'refused', reason: 'pr-size-unreadable' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(['production-\ufffd.mjs', '\ufeffproduction-é.mjs'])(
    'preserves the valid UTF-8 path %j and counts arbitrary binary blob bytes', (path) => {
      const { exec, run, spawn } = encodedFixture({
        numstat: Buffer.from(`-\t-\t${path}\0`),
        entry: Buffer.from(`100644 blob ${'a'.repeat(40)}\t${path}\0`),
        blob: Buffer.concat([Buffer.from([0xff]), Buffer.from('\n'.repeat(301))]),
      });
      expect(run({ argv })).toMatchObject({ outcome: 'refused', reason: 'pr-too-large' });
      expect(spawn).not.toHaveBeenCalled();
      expect(exec.mock.calls.filter(([, args]) => args.includes('ls-tree')).map(([, args]) => args.at(-1)))
        .toEqual([path, path]);
    },
  );
});

describe('real git numstat evidence', () => {
  it('counts production outside a subdirectory and keeps backlog paths rooted with diff.relative enabled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'open-pr-relative-'));
    const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    try {
      git(['init', '--quiet', '--initial-branch=main']);
      git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'base']);
      git(['update-ref', 'refs/remotes/origin/main', 'main']);
      git(['checkout', '--quiet', '-b', 'lane/size-cap']);
      git(['config', 'diff.relative', 'true']);
      mkdirSync(join(dir, 'backlog'));
      writeFileSync(join(dir, 'production.mjs'), 'code\n'.repeat(301));
      writeFileSync(join(dir, 'backlog/card.md'), 'card\n'.repeat(400));
      git(['add', '.']);
      git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'oversized']);
      expect(git(['-C', join(dir, 'backlog'), 'diff', '--numstat', '-z', 'main...HEAD']))
        .toBe('400\t0\tcard.md\0');
      const run = defaultReaderRunner({ cwd: join(dir, 'backlog'), prePrReview: () => ({ action: 'pass' }), dupBornAs: () => [], env: {} });
      expect(run({ argv })).toMatchObject({ outcome: 'refused', reason: 'pr-too-large', detail: expect.stringMatching(/701/) });
      expect(submit).not.toHaveBeenCalled();

      git(['rm', '--quiet', 'production.mjs']);
      git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'backlog only']);
      const sha = git(['rev-parse', 'HEAD']).trim();
      submit.mockReturnValueOnce({ status: 0, stdout: JSON.stringify({ pr: 7, url: 'u' }) });
      expect(run({ argv: [...argv, '--sha=HEAD'] })).toMatchObject(opened);
      expect(submit).toHaveBeenCalledTimes(1);
      expect(submit.mock.calls[0][1].filter((a) => a.startsWith('--sha='))).toEqual([`--sha=${sha}`]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(['worktree -diff', 'worktree binary', 'info -diff', 'global -diff', 'NUL bytes'])(
    'the production reader counts oversized production content despite %s', (kind) => {
      const dir = mkdtempSync(join(tmpdir(), 'open-pr-size-reader-'));
      const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
      try {
        git(['init', '--quiet', '--initial-branch=main']);
        git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'base']);
        git(['update-ref', 'refs/remotes/origin/main', 'main']);
        git(['checkout', '--quiet', '-b', 'lane/size-cap']);
        if (kind.startsWith('worktree')) writeFileSync(join(dir, '.gitattributes'), `production.mjs ${kind === 'worktree binary' ? 'binary' : '-diff'}\n`);
        if (kind === 'info -diff') writeFileSync(join(dir, '.git/info/attributes'), 'production.mjs -diff\n');
        if (kind === 'global -diff') {
          writeFileSync(join(dir, 'global-attributes'), 'production.mjs -diff\n');
          git(['config', 'core.attributesFile', join(dir, 'global-attributes')]);
        }
        writeFileSync(join(dir, 'production.mjs'), `${kind === 'NUL bytes' ? '\0' : ''}${'code\n'.repeat(301)}`);
        git(['add', '.']);
        git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'oversized']);
        // Prove the fixture really hides the production count without the hardened reader.
        expect(git(['diff', '--numstat', '-z', 'main...HEAD'])).toContain('-\t-\tproduction.mjs\0');
        const run = defaultReaderRunner({ cwd: dir, prePrReview: () => ({ action: 'pass' }), env: {} });
        expect(run({ argv })).toMatchObject({ outcome: 'refused', reason: 'pr-too-large' });
        expect(submit).not.toHaveBeenCalled();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('exempts a non-ASCII backlog path and counts a renamed 400-line production file with two changed lines as two', () => {
    const dir = mkdtempSync(join(tmpdir(), 'open-pr-numstat-'));
    const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    try {
      git(['init', '--quiet']);
      mkdirSync(join(dir, 'backlog'));
      const lines = Array.from({ length: 400 }, (_, i) => `line ${i}\n`);
      writeFileSync(join(dir, 'old.mjs'), lines.join(''));
      git(['add', '.']);
      git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'base']);
      writeFileSync(join(dir, 'backlog/é.md'), 'card\n'.repeat(400));
      git(['add', '.']);
      const backlog = git(['-c', 'core.quotePath=true', 'diff', '--cached', '--numstat', '-z', '--find-renames']);
      expect(backlog).toBe('400\t0\tbacklog/é.md\0');
      expect(openPr.measureNonTestLines(backlog)).toEqual({ lines: 400, exempt: true });
      const { run, spawn } = fixture(backlog);
      expect(run({ argv })).toMatchObject(opened);
      expect(spawn).toHaveBeenCalledTimes(1);

      renameSync(join(dir, 'old.mjs'), join(dir, 'new.mjs'));
      lines[200] = 'changed\n';
      writeFileSync(join(dir, 'new.mjs'), lines.join(''));
      git(['add', '.']);
      const renamed = git(['diff', '--cached', '--numstat', '-z', '--find-renames', '--', '*.mjs']);
      expect(renamed).toBe('1\t1\t\0old.mjs\0new.mjs\0');
      expect(openPr.measureNonTestLines(renamed)).toEqual({ lines: 2, exempt: false });
      const renameRun = fixture(renamed);
      expect(renameRun.run({ argv })).toMatchObject(opened);
      expect(renameRun.spawn).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('default size reader — binary fallback evidence', () => {
  const headBlob = 'a'.repeat(40);
  const baseBlob = 'b'.repeat(40);
  const binaryFixture = ({ paths = ['scripts/a.mjs'], read = () => undefined } = {}) => {
    const git = vi.fn((args, options) => {
      const result = read(args, options);
      if (result !== undefined) return result;
      if (args.includes('--show-toplevel')) return 'repo-top\n';
      if (args[0] === 'rev-parse') return 'resolved-sha\n';
      if (args.includes('diff')) return paths.map((path) => `-\t-\t${path}\0`).join('');
      if (args.includes('merge-base')) return 'merge-base-sha\n';
      if (args.includes('ls-tree')) {
        return `100644 blob ${args.includes('resolved-sha') ? headBlob : baseBlob}\t${args.at(-1)}\0`;
      }
      if (args.includes('cat-file')) return 'code\n';
      throw new Error('unexpected git read');
    });
    // A fail-open regression must reach a successful submission rather than a throwing mock.
    submit.mockReturnValue({ status: 0, stdout: JSON.stringify({ pr: 7, url: 'u' }) });
    return { git, run: defaultReaderRunner({ prePrReview: () => ({ action: 'pass' }), env: {}, git }) };
  };

  it.each(['resolved-sha', 'merge-base-sha'])(
    'fails closed with pr-size-unreadable and no submission when the binary fallback tree read fails for %s', (revision) => {
      const { git, run } = binaryFixture({ read: (args) => {
        if (args.includes('ls-tree') && args.includes(revision)) throw new Error('tree unavailable');
      } });
      expect(run({ argv })).toMatchObject({ outcome: 'refused', reason: 'pr-size-unreadable' });
      expect(git).toHaveBeenCalledWith(expect.arrayContaining(['ls-tree', revision]), expect.any(Object));
      expect(submit).not.toHaveBeenCalled();
    },
  );

  it.each([['head', headBlob], ['base', baseBlob]])(
    'fails closed with pr-size-unreadable and no submission when the binary fallback %s blob read fails', (_side, blob) => {
      const { git, run } = binaryFixture({ read: (args) => {
        if (args.includes('cat-file') && args.includes(blob)) throw new Error('blob unavailable');
      } });
      expect(run({ argv })).toMatchObject({ outcome: 'refused', reason: 'pr-size-unreadable' });
      expect(git).toHaveBeenCalledWith(expect.arrayContaining(['cat-file', 'blob', blob]), expect.any(Object));
      expect(submit).not.toHaveBeenCalled();
    },
  );

  it.each(['resolved-sha', 'merge-base-sha'])(
    'admits a binary addition or deletion only after a successful empty tree result proves the absent side at %s', (revision) => {
      const { git, run } = binaryFixture({ read: (args) => {
        if (args.includes('ls-tree') && args.includes(revision)) return '';
      } });
      expect(run({ argv })).toMatchObject(opened);
      expect(git.mock.calls.filter(([args]) => args.includes('ls-tree'))).toHaveLength(2);
      const blobReads = git.mock.calls.filter(([args]) => args.includes('cat-file'));
      expect(blobReads).toHaveLength(1);
      expect(blobReads[0][0]).toContain(revision === 'resolved-sha' ? baseBlob : headBlob);
      expect(submit).toHaveBeenCalledTimes(1);
    },
  );

  it('fails closed with pr-size-unreadable and no submission when multiple binary rows exhaust the shared 60-second budget', () => {
    let elapsed = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    try {
      const { git, run } = binaryFixture({ paths: ['scripts/a.mjs', 'scripts/b.mjs'], read: (args) => {
        if (args.includes('merge-base') || args.includes('ls-tree') || args.includes('cat-file')) elapsed += 10_000;
      } });
      expect(run({ argv })).toMatchObject({ outcome: 'refused', reason: 'pr-size-unreadable' });
      const fallbackReads = git.mock.calls.filter(([args]) =>
        args.includes('merge-base') || args.includes('ls-tree') || args.includes('cat-file'));
      expect(fallbackReads.map(([, options]) => options.timeout)).toEqual([60_000, 50_000, 40_000, 30_000, 20_000, 10_000]);
      // The first row finished; the second tree read consumed the remaining shared budget.
      expect(fallbackReads.at(-1)[0]).toEqual(expect.arrayContaining(['ls-tree', 'scripts/b.mjs']));
      expect(git.mock.calls.filter(([args]) => args.includes('cat-file'))).toHaveLength(2);
      expect(elapsed).toBe(60_000);
      expect(submit).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });
});

describe('createPrLandRunner — non-test size admission', () => {
  it('keeps spawn-injected defaults hermetic unless a size reader is explicitly supplied', () => {
    const git = vi.fn(() => { throw new Error('unexpected Git access'); });
    submit.mockReturnValueOnce({ status: 0, stdout: JSON.stringify({ pr: 7, url: 'u' }) });
    const run = createPrLandRunner({ prePrReview: () => ({ action: 'pass' }), spawn: submit, git });
    expect(run({ argv })).toMatchObject(opened);
    expect(git).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['--ref=lane/4368-prepare-item-x'],
    ['--ref=lane/prepare-batch', '--title=prepare: 4368, 4341'],
  ])('keeps the default size reader hermetic with only git injected for %j', (...requested) => {
    const git = vi.fn(() => { throw new Error('prepare evidence unavailable'); });
    const run = createPrLandRunner({
      prePrReview: () => ({ action: 'pass' }), env: {}, dupBornAs: () => [], git,
    });
    expect(run({ argv: requested })).toEqual({ outcome: 'refused', reason: 'prepare evidence unavailable' });
    expect(git).toHaveBeenCalledTimes(1);
    expect(git).toHaveBeenCalledWith(['fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
  });

  it.each([
    ['--ref=lane/4368-prepare-item-x'],
    ['--ref=lane/prepare-batch', '--title=prepare: 4368, 4341'],
    ['--ref=lane/4400-prepare-decision-x'],
  ])('enforces explicit size evidence for prepare argv %j', (...requested) => {
    const git = vi.fn(() => { throw new Error('prepare guard must not run'); });
    const { run, diffStat, spawn } = fixture('301\t0\tscripts/a.mjs\0', { git });
    expect(run({ argv: requested })).toMatchObject({ outcome: 'refused', reason: 'pr-too-large' });
    expect(diffStat).toHaveBeenCalledTimes(1);
    expect(diffStat).toHaveBeenCalledWith({ base: 'main', sha: 'HEAD' });
    expect(git).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([300, 301])('enforces the inclusive 300-line boundary at %i lines', (lines) => {
    const { run, diffStat, spawn } = fixture(`${lines - 100}\t100\tscripts/a.mjs\n`);
    const result = run({ argv });
    if (lines === 300) {
      expect(result).toMatchObject(opened);
      expect(spawn).toHaveBeenCalledTimes(1);
    } else {
      expect(result).toMatchObject({ outcome: 'refused', reason: 'pr-too-large' });
      expect(result.detail).toMatch(/301/);
      expect(result.detail).toMatch(/300/);
      expect(result.detail).toMatch(/split/i);
      expect(spawn).not.toHaveBeenCalled();
    }
    expect(diffStat).toHaveBeenCalledTimes(1);
  });

  it('admits 250 non-test lines plus 900 lines in a nested __tests__ file', () => {
    const { run, diffStat, spawn } = fixture('200\t50\tscripts/a.mjs\n600\t300\tscripts/x/__tests__/a.test.mjs\n');
    expect(run({ argv })).toMatchObject(opened);
    expect(diffStat).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('admits a backlog-only diff of 1000 lines', () => {
    const { run, diffStat, spawn } = fixture('700\t100\tbacklog/a.md\n150\t50\tbacklog/b.md\n');
    expect(run({ argv })).toMatchObject(opened);
    expect(diffStat).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('refuses an oversized mixed backlog and code diff without the exemption', () => {
    const { run, spawn } = fixture('1000\t0\tbacklog/a.md\n1\t0\tscripts/a.mjs\n');
    expect(run({ argv })).toMatchObject({ outcome: 'refused', reason: 'pr-too-large' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    ['backlog', 'backlog/new.md'],
    ['a test filename', 'scripts/new.test.mjs'],
  ])('counts and refuses an oversized production rename into %s', (_name, destination) => {
    const { run, diffStat, spawn } = fixture(`301\t0\t\0scripts/old.mjs\0${destination}\0`);
    expect(run({ argv })).toMatchObject({ outcome: 'refused', reason: 'pr-too-large', detail: expect.stringMatching(/301/) });
    expect(diffStat).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    ['a throwing reader', () => { throw new Error('diff unavailable'); }],
    ['malformed numstat', () => 'not numstat\n'],
    ['partially readable numstat', () => '1\t0\tscripts/a.mjs\nmalformed\n'],
    ['unmeasurable production counts', () => '-\t-\tscripts/a.mjs\0'],
  ])('fails closed with pr-size-unreadable for %s and never spawns', (_name, read) => {
    const diffStat = vi.fn(read);
    const { run, spawn } = fixture('', { diffStat });
    expect(run({ argv })).toMatchObject({ outcome: 'refused', reason: 'pr-size-unreadable', detail: expect.stringMatching(/Restore readable git numstat evidence/) });
    expect(diffStat).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('refuses binary evidence even alongside an oversized text diff', () => {
    const binary = '-\t-\tassets/image.png\0-\t-\tscripts/a.test.mjs\0-\t-\tbacklog/a.md\0';
    const unmeasurable = fixture(binary);
    expect(unmeasurable.run({ argv })).toMatchObject({ outcome: 'refused', reason: 'pr-size-unreadable' });
    expect(unmeasurable.spawn).not.toHaveBeenCalled();
    const refused = fixture(binary + '301\t0\tscripts/a.mjs\0');
    expect(refused.run({ argv })).toMatchObject({ outcome: 'refused', reason: 'pr-size-unreadable' });
    expect(refused.spawn).not.toHaveBeenCalled();
  });

  it('the default reader pins the commit, clears attributes, disables external diff/textconv and forces text numstat', () => {
    const git = vi.fn((args) => args.includes('diff') ? '301\t0\tscripts/a.mjs\0'
      : args.includes('--show-toplevel') ? 'repo-top\n' : 'resolved-sha\n');
    // Select the same reader as production without enabling any other production IO.
    const run = defaultReaderRunner({ prePrReview: () => ({ action: 'pass' }), env: {}, git });
    expect(run({ argv: [...argv, '--base=release', '--sha=abc123'] }))
      .toMatchObject({ outcome: 'refused', reason: 'pr-too-large' });
    expect(git.mock.calls).toEqual([
      [['rev-parse', '--verify', 'abc123^{commit}']],
      [['rev-parse', '--verify', '--quiet', 'origin/release']],
      [['rev-parse', '--show-toplevel']],
      [['-C', 'repo-top', '-c', 'core.attributesFile=', 'diff', '--no-relative', '--text', '--numstat', '-z', '--find-renames', '--no-ext-diff', '--no-textconv', 'origin/release...resolved-sha'], { timeout: 60_000 }],
    ]);
    expect(submit).not.toHaveBeenCalled();
  });

  it.each(['', 'HEAD', 'lane/moving-ref'])('submits the resolved commit measured by the default reader for sha %j', (sha) => {
    const extra = sha ? [`--sha=${sha}`] : [];
    const git = vi.fn((args) => args.includes('diff') ? '1\t0\tscripts/a.mjs\0'
      : args.includes('--show-toplevel') ? 'repo-top\n' : 'resolved-sha\n');
    submit.mockReturnValueOnce({ status: 0, stdout: JSON.stringify({ pr: 7, url: 'u' }) });
    const run = defaultReaderRunner({ prePrReview: () => ({ action: 'pass' }), dupBornAs: () => [], env: {}, git });
    const requested = [...argv, ...extra];
    expect(run({ argv: requested })).toMatchObject(opened);
    expect(git).toHaveBeenCalledWith(expect.arrayContaining(['diff', 'origin/main...resolved-sha']), { timeout: 60_000 });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][1].filter((a) => a.startsWith('--sha='))).toEqual(['--sha=resolved-sha']);
    expect(requested).toEqual([...argv, ...extra]);
  });

  it('fails closed with pr-size-unreadable when the bounded size read times out, without timing out other git calls', () => {
    const exec = vi.fn()
      .mockReturnValueOnce('resolved-sha\n')
      .mockReturnValueOnce('base-sha\n')
      .mockReturnValueOnce('repo-top\n')
      .mockImplementationOnce(() => { throw Object.assign(new Error('git timed out'), { code: 'ETIMEDOUT' }); });
    const run = defaultReaderRunner({ prePrReview: () => ({ action: 'pass' }), env: {}, exec });
    expect(run({ argv })).toMatchObject({ outcome: 'refused', reason: 'pr-size-unreadable', detail: expect.stringMatching(/Restore readable git numstat evidence/) });
    expect(exec).toHaveBeenCalledTimes(4);
    for (const [command, args, options] of exec.mock.calls) {
      expect(command).toBe('git');
      if (args.includes('diff')) {
        expect(args).toEqual(expect.arrayContaining(['-C', 'repo-top', '--no-relative']));
        expect(options).toMatchObject({ timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
      } else {
        expect(options).not.toHaveProperty('timeout');
      }
    }
    expect(submit).not.toHaveBeenCalled();
  });

  it.each(['', 'HEAD'])('preserves argv for a plain-text injected reader with sha %j', (sha) => {
    const extra = sha ? [`--sha=${sha}`] : [];
    const { run, spawn } = fixture('1\t0\tscripts/a.mjs\0');
    const requested = [...argv, ...extra];
    expect(run({ argv: requested })).toMatchObject(opened);
    expect(spawn.mock.calls[0][1]).toEqual([expect.stringMatching(/pr-land\.mjs$/), ...requested, '--json']);
  });

  it('the default reader refuses an unresolved commit before attempting a diff', () => {
    const git = vi.fn(() => { throw new Error('not a commit'); });
    const run = defaultReaderRunner({ prePrReview: () => ({ action: 'pass' }), env: {}, git });
    expect(run({ argv: [...argv, '--sha=missing'] })).toMatchObject({ outcome: 'refused', reason: 'pr-size-unreadable' });
    expect(git.mock.calls).toEqual([[['rev-parse', '--verify', 'missing^{commit}']]]);
    expect(submit).not.toHaveBeenCalled();
  });

  it('checks size after the pre-PR review gate and before spawning', () => {
    const order = [];
    const { run } = fixture('', {
      prePrReview: () => { order.push('review'); return { action: 'pass' }; },
      diffStat: () => { order.push('size'); return '1\t0\tscripts/a.mjs\n'; },
      spawn: () => { order.push('spawn'); return { status: 0, stdout: JSON.stringify({ pr: 7, url: 'u' }) }; },
    });
    expect(run({ argv })).toMatchObject(opened);
    expect(order).toEqual(['review', 'size', 'spawn']);
  });

  it('does not read a diff or spawn when the pre-PR review gate refuses', () => {
    const { run, diffStat, spawn } = fixture('', {
      prePrReview: () => ({ action: 'refuse', reason: 'pre-pr-review-missing' }),
    });
    expect(run({ argv })).toMatchObject({ outcome: 'refused', reason: 'pre-pr-review-missing' });
    expect(diffStat).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    [[], { base: 'main', sha: 'HEAD' }],
    [['--base=release', '--sha=abc123'], { base: 'release', sha: 'abc123' }],
  ])('passes the requested base and sha to diffStat for argv %j', (extra, expected) => {
    const { run, diffStat, spawn } = fixture('');
    expect(run({ argv: [...argv, ...extra] })).toMatchObject(opened);
    expect(diffStat).toHaveBeenCalledTimes(1);
    expect(diffStat).toHaveBeenCalledWith(expected);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('skips size admission for --dry-run', () => {
    const { run, prePrReview, diffStat, spawn } = fixture('1000\t0\tscripts/a.mjs\n');
    expect(run({ argv: [...argv, '--dry-run'] })).toMatchObject(opened);
    expect(prePrReview).not.toHaveBeenCalled();
    expect(diffStat).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('reuses the recorded pre-PR review bypass to skip size admission', () => {
    const dir = mkdtempSync(join(tmpdir(), 'open-pr-size-cap-'));
    try {
      const bodyFile = join(dir, 'body.md');
      writeFileSync(bodyFile, 'PR body\n');
      const prePrReview = vi.fn(() => ({
        action: 'pass', bypass: { reason: 'r', actor: 'a', operatorInstruction: 'i' },
      }));
      const { run, diffStat, spawn } = fixture('1000\t0\tscripts/a.mjs\n', { prePrReview });
      expect(run({ argv: [...argv, `--body-file=${bodyFile}`] })).toMatchObject(opened);
      expect(prePrReview).toHaveBeenCalledTimes(1);
      expect(diffStat).not.toHaveBeenCalled();
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ['operator-authorised skip arguments', {}, 'operator approved', 'operator', 'Ship this change'],
    ['worker', { WE_CONVEYOR_WORKER: '1' }, 'reason', 'operator', 'Ship this change'],
    ['unknown role', { WE_CONVEYOR_WORKER: 'unknown' }, 'reason', 'operator', 'Ship this change'],
    ['missing actor', {}, 'reason', '', 'Ship this change'],
    ['missing instruction', {}, 'reason', 'operator', ''],
    ['empty skip', {}, '  ', 'operator', 'Ship this change'],
  ])('refuses an oversized diff without a recorded gate bypass despite %s', (_name, env, skipPrePrReview, actor, operatorInstruction) => {
    const { run, diffStat, spawn } = fixture('1000\t0\tscripts/a.mjs\0', { env });
    expect(run({ argv, skipPrePrReview, actor, operatorInstruction }))
      .toMatchObject({ outcome: 'refused', reason: 'pr-too-large' });
    expect(diffStat).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled();
  });
});
