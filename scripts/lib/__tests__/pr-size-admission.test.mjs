/** Phase 1 RED contracts: the shared size home is intentionally a behavior-free stub. */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as sizeAdmission from '../pr-size-admission.mjs';

// Proposed effect seam: createSizeAdmissionRunner({ diffStat, fileItem, lookupSplitCard })
// returns a runner({ ref, pr?, base, sha, body }) -> { status, lines, body, reviewLabel, sha? }.
// fileItem accepts the declared operation's title/kind/size/digest/scope fields and returns
// its native { run: { verdict: { num, id, rel } } } result. No real operation runs here.
afterEach(() => vi.restoreAllMocks());

describe('measureNonTestLines — pure numstat accounting', () => {
  it('exports a 300-line non-test limit', () => {
    expect(sizeAdmission.OPEN_PR_MAX_NON_TEST_LINES).toBe(300);
  });

  it('treats empty input as zero changes without a backlog exemption', () => {
    expect(sizeAdmission.measureNonTestLines('')).toEqual({ lines: 0, exempt: false });
  });

  it('sums additions and deletions across non-test paths, with or without a trailing newline', () => {
    const text = '100\t50\tscripts/operations/open-pr.mjs\n20\t30\tdocs/a guide.md';
    expect(sizeAdmission.measureNonTestLines(text)).toEqual({ lines: 200, exempt: false });
    expect(sizeAdmission.measureNonTestLines(`${text}\n`)).toEqual({ lines: 200, exempt: false });
  });

  it('reads NUL-delimited paths containing non-ASCII characters, tabs, newlines and quotes literally', () => {
    expect(sizeAdmission.measureNonTestLines('700\t100\tbacklog/é.md\0'))
      .toEqual({ lines: 800, exempt: true });
    expect(sizeAdmission.measureNonTestLines('1\t2\tscripts/a\tb\nc"d.mjs\0'))
      .toEqual({ lines: 3, exempt: false });
    expect(sizeAdmission.measureNonTestLines('200\t50\tscripts/a.mjs\0' + '600\t300\tscripts/__tests__/é.mjs\0'))
      .toEqual({ lines: 250, exempt: false });
  });

  it('counts renames by their numstat counts and classifies both paths', () => {
    expect(sizeAdmission.measureNonTestLines('0\t0\t\0scripts/old.mjs\0scripts/new.mjs\0'))
      .toEqual({ lines: 0, exempt: false });
    expect(sizeAdmission.measureNonTestLines('1\t1\t\0scripts/old.test.mjs\0scripts/new.mjs\0'))
      .toEqual({ lines: 2, exempt: false });
    expect(sizeAdmission.measureNonTestLines('400\t0\t\0scripts/old.mjs\0scripts/new.test.mjs\0'))
      .toEqual({ lines: 400, exempt: false });
    expect(sizeAdmission.measureNonTestLines('400\t0\t\0docs/old.md\0backlog/new.md\0'))
      .toEqual({ lines: 400, exempt: false });
    expect(sizeAdmission.measureNonTestLines('400\t0\t\0backlog/old.md\0docs/new.md\0'))
      .toEqual({ lines: 400, exempt: false });
    expect(sizeAdmission.measureNonTestLines('400\t0\t\0scripts/old.test.mjs\0scripts/__tests__/new.mjs\0'))
      .toEqual({ lines: 0, exempt: false });
    expect(sizeAdmission.measureNonTestLines('400\t0\t\0backlog/old.md\0backlog/new.md\0'))
      .toEqual({ lines: 400, exempt: true });
  });

  it.each([
    'assets/image.png',
    'scripts/a.mjs',
    'scripts/a.test.mjs',
    'backlog/a.md',
  ])('throws for unmeasurable binary counts on %s', (path) => {
    for (const terminator of ['\n', '\0']) {
      expect(() => sizeAdmission.measureNonTestLines(`-\t-\t${path}${terminator}`)).toThrow(/unmeasurable/);
    }
  });

  it.each([
    '__tests__/a.mjs',
    'scripts/x/__tests__/a.test.mjs',
    'scripts/x/__tests__/fixtures/input.json',
    'a.test.mjs',
    'scripts/x/a.spec.ts',
  ])('excludes additions and deletions for test path %s', (path) => {
    expect(sizeAdmission.measureNonTestLines(`200\t50\tscripts/x.mjs\n600\t300\t${path}\n`))
      .toEqual({ lines: 250, exempt: false });
  });

  it('counts similarly named non-test paths', () => {
    expect(sizeAdmission.measureNonTestLines('10\t5\tscripts/__tests__helpers/a.mjs\n20\t5\tscripts/a.testing.mjs\n'))
      .toEqual({ lines: 40, exempt: false });
  });

  it('exempts a nonempty diff only when every path starts with backlog/', () => {
    expect(sizeAdmission.measureNonTestLines('700\t100\tbacklog/a.md\n150\t50\tbacklog/nested/b.md\n'))
      .toEqual({ lines: 1000, exempt: true });
    expect(sizeAdmission.measureNonTestLines('0\t0\tbacklog/a.md\n'))
      .toEqual({ lines: 0, exempt: true });
  });

  it('does not exempt mixed paths, even when the outside path is a test', () => {
    expect(sizeAdmission.measureNonTestLines('1000\t0\tbacklog/a.md\n1\t0\tscripts/a.mjs\n'))
      .toEqual({ lines: 1001, exempt: false });
    expect(sizeAdmission.measureNonTestLines('1000\t0\tbacklog/a.md\n900\t0\tscripts/a.test.mjs\n'))
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
    expect(sizeAdmission.measureNonTestLines).toBeTypeOf('function');
    expect(() => sizeAdmission.measureNonTestLines(text)).toThrow();
  });
});

describe('planSizeAdmission — size dials capacity, never permission', () => {
  it.each([0, 299, 300])('exactly %i non-test lines need no action', (lines) => {
    expect(sizeAdmission.planSizeAdmission({ lines, exempt: false })).toMatchObject({ status: 'ok', lines });
  });
  it.each([301, 399, 400, 1000])('%i non-test lines plan over rather than a refusal', (lines) => {
    expect(sizeAdmission.planSizeAdmission({ lines, exempt: false })).toMatchObject({ status: 'over', lines });
  });
  it('backlog-only big diff is exempt', () => {
    expect(sizeAdmission.planSizeAdmission({ lines: 1000, exempt: true })).toMatchObject({ status: 'ok', lines: 1000 });
  });
  it('reader errors plan unknown without inventing a zero line count', () => {
    expect(sizeAdmission.planSizeAdmission(new Error('diff unavailable'))).toMatchObject({ status: 'unknown', lines: null });
  });
  it.each([undefined, null, {}, { lines: NaN }, { lines: -1 }, { lines: Infinity }])(
    'incomplete evidence %j plans unknown rather than ok', (evidence) => {
      expect(sizeAdmission.planSizeAdmission(evidence)).toMatchObject({ status: 'unknown', lines: null });
    });
});

const evidence = '100\t50\tscripts/operations/a.mjs\0'
  + '50\t0\tscripts/operations/b.mjs\0'
  + '101\t0\tdocs/agent/a.md\0'
  + '900\t0\tscripts/operations/__tests__/a.test.mjs\0';
const request = { ref: 'lane/size-admission', pr: 5854, base: 'main', sha: 'HEAD', body: 'Existing PR description.' };
const cardResult = { run: { verdict: { num: 9001, id: 'xsplit1', rel: 'backlog/xsplit1-split.md' } } };
function effects(overrides = {}) {
  return {
    diffStat: vi.fn(() => ({ text: evidence, sha: 'pinned-sha' })),
    fileItem: vi.fn(() => cardResult),
    lookupSplitCard: vi.fn(() => null),
    ...overrides,
  };
}
function expectSizeNote(body) {
  expect(body).toContain(request.body);
  expect(body).toMatch(/## Size\b/);
  expect(body).toContain('301 non-test lines (> 300)');
  expect(body).toMatch(/split card.*(?:9001|xsplit1).*filed/i);
  expect(body).toContain('extra reviewers requested via the size escalation (review:pending)');
  expect(body).toMatch(/file groups[^\n]*scripts\/operations[^\n]*200/i);
  expect(body).toMatch(/file groups[^\n]*docs\/agent[^\n]*101/i);
  expect(body).not.toMatch(/900 non-test|a\.test\.mjs/);
}

describe('shared admission effects', () => {
  it('301 non-test lines proceed with one split card naming PR and file groups, reviewers escalated and body noting both', async () => {
    const io = effects();
    const run = sizeAdmission.createSizeAdmissionRunner(io);
    const result = await run(request);
    expect(result).toMatchObject({ status: 'over', lines: 301, reviewLabel: 'review:pending', sha: 'pinned-sha' });
    expect(io.fileItem).toHaveBeenCalledTimes(1);
    const card = io.fileItem.mock.calls[0][0];
    expect(card).toMatchObject({ kind: 'story', size: expect.any(Number) });
    expect(card.title).toContain('#5854');
    expect(card.digest).toMatch(/scripts\/operations[^\n]*200/);
    expect(card.digest).toMatch(/docs\/agent[^\n]*101/);
    expect(card.scope).toContain('we:scripts/operations/a.mjs');
    expect(card.scope).not.toContain('a.test.mjs');
    expectSizeNote(result.body);
  });

  it('a new PR without a number names its ref in the split card', async () => {
    const io = effects();
    await sizeAdmission.createSizeAdmissionRunner(io)({ ...request, pr: null });
    expect(io.fileItem).toHaveBeenCalledTimes(1);
    expect(io.fileItem.mock.calls[0][0].title).toContain(request.ref);
  });

  it.each([
    ['exactly 300', '200\t100\tscripts/a.mjs\0', 300],
    ['test-only big diff', '1000\t0\tscripts/__tests__/a.mjs\0', 0],
    ['backlog-only big diff', '1000\t0\tbacklog/a.md\0', 1000],
  ])('%s does nothing: no card, reviewer escalation or Size section', async (_name, text, lines) => {
    const io = effects({ diffStat: vi.fn(() => text) });
    const result = await sizeAdmission.createSizeAdmissionRunner(io)(request);
    expect(result).toMatchObject({ status: 'ok', lines, body: request.body, reviewLabel: null });
    expect(io.fileItem).not.toHaveBeenCalled();
  });

  it.each([
    ['reader throws', () => { throw new Error('diff unavailable'); }],
    ['malformed evidence', () => '1\t0\tscripts/a.mjs\0truncated'],
    ['unmeasurable binary', () => '-\t-\tassets/image.png\0'],
  ])('unreadable diff (%s) proceeds, says size unknown, escalates reviewers and needs no card', async (_name, diffStat) => {
    const io = effects({ diffStat: vi.fn(diffStat) });
    const result = await sizeAdmission.createSizeAdmissionRunner(io)(request);
    expect(result).toMatchObject({ status: 'unknown', lines: null, reviewLabel: 'review:pending' });
    expect(result.body).toContain('size unknown: extra reviewers requested');
    expect(result.body).toMatch(/file groups/i);
    expect(result.body).toContain(request.body);
    expect(io.fileItem).not.toHaveBeenCalled();
  });

  it('card filing failure still proceeds and escalates with the filing reason in the body', async () => {
    const io = effects({ fileItem: vi.fn(() => { throw new Error('filing unavailable'); }) });
    const result = await sizeAdmission.createSizeAdmissionRunner(io)(request);
    expect(result).toMatchObject({ status: 'over', reviewLabel: 'review:pending' });
    expect(result.body).toContain('split card not filed: filing unavailable');
    expect(result.body).toContain('extra reviewers requested');
    expect(result.body).toMatch(/file groups[^\n]*200/i);
    expect(io.fileItem).toHaveBeenCalledTimes(1);
  });

  it('an unsuccessful file-item verdict also proceeds without claiming a card was filed', async () => {
    const io = effects({ fileItem: vi.fn(() => ({ run: { verdict: { outcome: 'refused', reason: 'operation unavailable' } } })) });
    const result = await sizeAdmission.createSizeAdmissionRunner(io)(request);
    expect(result).toMatchObject({ status: 'over', reviewLabel: 'review:pending' });
    expect(result.body).toContain('split card not filed: operation unavailable');
    expect(result.body).not.toMatch(/split card (?!not filed)\S+ filed/);
  });

  it('same-ref retries reuse the body marker across fresh runners: one card and one Size section', async () => {
    const io = effects();
    const first = await sizeAdmission.createSizeAdmissionRunner(io)(request);
    const second = await sizeAdmission.createSizeAdmissionRunner(io)({ ...request, body: first.body });
    expect(io.fileItem).toHaveBeenCalledTimes(1);
    expect(second.body.match(/^## Size$/gm)).toHaveLength(1);
    expectSizeNote(second.body);
  });

  it('injected lookup reuses a card for the same ref even when the body has no marker', async () => {
    const io = effects({ lookupSplitCard: vi.fn(() => cardResult.run.verdict) });
    const result = await sizeAdmission.createSizeAdmissionRunner(io)(request);
    expect(io.lookupSplitCard).toHaveBeenCalledWith(expect.objectContaining({ ref: request.ref }));
    expect(io.fileItem).not.toHaveBeenCalled();
    expectSizeNote(result.body);
  });

  it('local split-card lookup keeps prefix-related refs lane/foobar and lane/foo distinct across fresh runners', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'size-split-refs-'));
    mkdirSync(join(cwd, 'backlog'));
    const fileItem = vi.fn((fields) => {
      const num = 9000 + fileItem.mock.calls.length;
      writeFileSync(join(cwd, 'backlog', `${num}-split.md`), fields.digest);
      return { run: { verdict: { num } } };
    });
    const run = (ref) => sizeAdmission.createSizeAdmissionRunner({ cwd, diffStat: () => evidence, fileItem })({ ...request, ref, pr: null });
    try {
      expect((await run('lane/foobar')).body).toContain('split card 9001 filed');
      expect((await run('lane/foo')).body).toContain('split card 9002 filed');
      expect(fileItem).toHaveBeenCalledTimes(2);
      expect(fileItem.mock.calls[0][0].title).toContain('lane/foobar');
      expect(fileItem.mock.calls[1][0].title).toContain('lane/foo');
      // Exact-ref retries reuse their own durable card without a PR-body marker.
      expect((await run('lane/foobar')).body).toContain('split card 9001 filed');
      expect((await run('lane/foo')).body).toContain('split card 9002 filed');
      expect(fileItem).toHaveBeenCalledTimes(2);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('a different ref cannot inherit another ref’s split-card marker', async () => {
    const io = effects();
    const first = await sizeAdmission.createSizeAdmissionRunner(io)(request);
    await sizeAdmission.createSizeAdmissionRunner(io)({ ...request, ref: 'lane/other', body: first.body });
    expect(io.fileItem).toHaveBeenCalledTimes(2);
  });
});

// Reader failures still reject evidence. Admission catches them as unknown; it must not
// weaken the audited measurement to get a non-blocking result.
function readerFixture({ numstat = '301\t0\tscripts/a.mjs\0', root = 'repo-top\n', read: override = () => undefined } = {}) {
  const git = vi.fn((args, options) => {
    const value = override(args, options);
    if (value !== undefined) return value;
    if (args.includes('--show-toplevel')) return root;
    if (args.includes('rev-parse')) return 'resolved-sha\n';
    if (args.includes('diff')) return numstat;
    if (args.includes('merge-base')) return 'base-sha\n';
    if (args.includes('ls-tree')) return `100644 blob ${args.includes('resolved-sha') ? 'a'.repeat(40) : 'b'.repeat(40)}\t${args.at(-1)}\0`;
    if (args.includes('cat-file')) return 'code\n';
    throw new Error(`unexpected git read: ${args}`);
  });
  const read = sizeAdmission.createPrDiffStatReader({ git });
  expect(read, 'shared reader factory must provide an evidence reader').toBeTypeOf('function');
  return { git, read: (extra = {}) => read({ base: 'main', sha: 'HEAD', ...extra }) };
}

describe('shared reader — retained sha, rename, binary and timeout audits', () => {
  it('pins the measured SHA, roots the diff, clears attributes and disables external diff/textconv', () => {
    const { git, read } = readerFixture();
    expect(read({ base: 'release', sha: 'moving-ref' })).toEqual({ text: '301\t0\tscripts/a.mjs\0', sha: 'resolved-sha' });
    expect(git.mock.calls).toEqual([
      [['rev-parse', '--verify', 'moving-ref^{commit}']],
      [['rev-parse', '--verify', '--quiet', 'origin/release']],
      [['rev-parse', '--show-toplevel']],
      [['-C', 'repo-top', '-c', 'core.attributesFile=', 'diff', '--no-relative', '--text', '--numstat', '-z', '--find-renames', '--no-ext-diff', '--no-textconv', 'origin/release...resolved-sha'], { timeout: 60_000 }],
    ]);
  });

  it('rejects an unresolved commit before reading a diff', () => {
    const { git, read } = readerFixture({ read: () => { throw new Error('not a commit'); } });
    expect(() => read({ sha: 'missing' })).toThrow('not a commit');
    expect(git.mock.calls).toEqual([[['rev-parse', '--verify', 'missing^{commit}']]]);
  });

  it.each([' ', '\t', '\r', '\n'])('preserves repository trailing whitespace %j', (suffix) => {
    const root = `repo${suffix}`;
    const { git, read } = readerFixture({ root: `${root}\n` });
    expect(read().sha).toBe('resolved-sha');
    expect(git.mock.calls.find(([args]) => args.includes('diff'))[0].slice(0, 2)).toEqual(['-C', root]);
  });

  it('counts both binary blobs at the pinned SHA and merge base, preserving arbitrary bytes', () => {
    const { git, read } = readerFixture({ numstat: '-\t-\tscripts/a.mjs\0', read: (args, options) => {
      if (args.includes('cat-file')) {
        expect(options.encoding).toBe('latin1');
        return args.includes('a'.repeat(40)) ? '\xff\0\n'.repeat(301) : 'old\n';
      }
    } });
    const result = read();
    expect(result).toEqual({ text: '301\t1\tscripts/a.mjs\0', sha: 'resolved-sha' });
    expect(git.mock.calls.filter(([args]) => args.includes('ls-tree')).map(([args]) => args))
      .toEqual([
        ['-C', 'repo-top', 'ls-tree', '-z', '--full-tree', 'resolved-sha', '--', 'scripts/a.mjs'],
        ['-C', 'repo-top', 'ls-tree', '-z', '--full-tree', 'base-sha', '--', 'scripts/a.mjs'],
      ]);
  });

  it('binary rename reads the destination at head and source at base, without discarding either path', () => {
    const { git, read } = readerFixture({ numstat: '-\t-\t\0scripts/old.mjs\0scripts/new.mjs\0' });
    expect(read().text).toBe('1\t1\t\0scripts/old.mjs\0scripts/new.mjs\0');
    expect(git.mock.calls.filter(([args]) => args.includes('ls-tree')).map(([args]) => [args[5], args.at(-1)]))
      .toEqual([['resolved-sha', 'scripts/new.mjs'], ['base-sha', 'scripts/old.mjs']]);
  });

  it.each(['resolved-sha', 'base-sha'])('rejects failed binary tree reads at %s', (revision) => {
    const { git, read } = readerFixture({ numstat: '-\t-\tscripts/a.mjs\0', read: (args) => {
      if (args.includes('ls-tree') && args.includes(revision)) throw new Error('tree unavailable');
    } });
    expect(() => read()).toThrow('tree unavailable');
    expect(git).toHaveBeenCalledWith(expect.arrayContaining(['ls-tree', revision]), expect.any(Object));
  });

  it.each(['a'.repeat(40), 'b'.repeat(40)])('rejects failed binary blob reads for %s', (blob) => {
    const { read } = readerFixture({ numstat: '-\t-\tscripts/a.mjs\0', read: (args) => {
      if (args.includes('cat-file') && args.includes(blob)) throw new Error('blob unavailable');
    } });
    expect(() => read()).toThrow('blob unavailable');
  });

  it.each(['resolved-sha', 'base-sha'])('accepts a binary addition/deletion only after an empty tree proves the absent side at %s', (revision) => {
    const { git, read } = readerFixture({ numstat: '-\t-\tscripts/a.mjs\0', read: (args) => {
      if (args.includes('ls-tree') && args.includes(revision)) return '';
    } });
    expect(read().text).toBe(revision === 'resolved-sha' ? '0\t1\tscripts/a.mjs\0' : '1\t0\tscripts/a.mjs\0');
    expect(git.mock.calls.filter(([args]) => args.includes('ls-tree'))).toHaveLength(2);
    expect(git.mock.calls.filter(([args]) => args.includes('cat-file'))).toHaveLength(1);
  });

  it('bounds all binary fallback rows by one shared 60-second budget', () => {
    let elapsed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const { git, read } = readerFixture({ numstat: '-\t-\tscripts/a.mjs\0-\t-\tscripts/b.mjs\0', read: (args) => {
      if (args.includes('merge-base') || args.includes('ls-tree') || args.includes('cat-file')) elapsed += 10_000;
    } });
    expect(() => read()).toThrow(/timed out/);
    const fallback = git.mock.calls.filter(([args]) => args.includes('merge-base') || args.includes('ls-tree') || args.includes('cat-file'));
    expect(fallback.map(([, options]) => options.timeout)).toEqual([60_000, 50_000, 40_000, 30_000, 20_000, 10_000]);
    expect(fallback.at(-1)[0]).toEqual(expect.arrayContaining(['ls-tree', 'scripts/b.mjs']));
    expect(git.mock.calls.filter(([args]) => args.includes('cat-file'))).toHaveLength(2);
    expect(elapsed).toBe(60_000);
  });

  it('bounds the initial diff to 60 seconds and 64 MB without timing out unrelated git calls', () => {
    const exec = vi.fn((_command, args) => {
      if (args.includes('diff')) throw Object.assign(new Error('git timed out'), { code: 'ETIMEDOUT' });
      return Buffer.from(args.includes('--show-toplevel') ? 'repo-top\n' : 'resolved-sha\n');
    });
    const read = sizeAdmission.createPrDiffStatReader({ exec, cwd: '.' });
    expect(() => read({ base: 'main', sha: 'HEAD' })).toThrow('git timed out');
    expect(exec).toHaveBeenCalledTimes(4);
    for (const [command, args, options] of exec.mock.calls) {
      expect(command).toBe('git');
      expect(options.maxBuffer).toBe(64 * 1024 * 1024);
      if (args.includes('diff')) expect(options.timeout).toBe(60_000);
      else expect(options).not.toHaveProperty('timeout');
    }
  });
});

function encodedReader({ numstat, root = Buffer.from('repo\n'), entry, blob = Buffer.from('code\n') }) {
  const exec = vi.fn((_command, args, options) => {
    const output = args.includes('--show-toplevel') ? root
      : args.includes('rev-parse') ? Buffer.from('resolved-sha\n')
      : args.includes('diff') ? numstat
      : args.includes('merge-base') ? Buffer.from('base-sha\n')
      : args.includes('ls-tree') ? entry ?? Buffer.alloc(0)
      : args.includes('cat-file') ? blob : undefined;
    if (output === undefined) throw new Error(`unexpected git call: ${args}`);
    return options.encoding ? output.toString(options.encoding) : output;
  });
  const read = sizeAdmission.createPrDiffStatReader({ cwd: '.', exec });
  expect(read, 'shared reader factory must provide a lossless evidence reader').toBeTypeOf('function');
  return { exec, read: () => read({ base: 'main', sha: 'HEAD' }) };
}

describe('shared reader — lossless filename metadata', () => {
  it.each([
    ['truncated', [0xe2, 0x82]], ['overlong', [0xc0, 0xaf]],
    ['surrogate', [0xed, 0xa0, 0x80]], ['out-of-range', [0xf4, 0x90, 0x80, 0x80]],
  ])('rejects %s UTF-8 in numeric and binary paths before blob lookup', (_kind, bytes) => {
    for (const counts of ['301\t0\t', '-\t-\t']) {
      const { read, exec } = encodedReader({ numstat: Buffer.concat([Buffer.from(`${counts}production-`), Buffer.from(bytes), Buffer.from('.mjs\0')]) });
      expect(() => read()).toThrow();
      expect(exec.mock.calls.some(([, args]) => args.includes('ls-tree'))).toBe(false);
    }
  });

  it.each([
    ['ordinary path', 'production-', '.mjs'],
    ['rename source', '\0production-', '.mjs\0replacement.mjs'],
    ['rename destination', '\0original.mjs\0production-', '.mjs'],
  ])('rejects lossy binary %s decoding before blob lookup', (_kind, prefix, suffix) => {
    const { read, exec } = encodedReader({ numstat: Buffer.concat([Buffer.from(`-\t-\t${prefix}`), Buffer.from([0xff]), Buffer.from(`${suffix}\0`)]) });
    expect(() => read()).toThrow();
    expect(exec.mock.calls.some(([, args]) => args.includes('ls-tree'))).toBe(false);
  });

  it('rejects invalid repository UTF-8 before using it as cwd', () => {
    const { read, exec } = encodedReader({ numstat: Buffer.from('1\t0\ta.mjs\0'), root: Buffer.concat([Buffer.from('repo-'), Buffer.from([0xff]), Buffer.from('\n')]) });
    expect(() => read()).toThrow();
    expect(exec.mock.calls.some(([, args]) => args.includes('diff'))).toBe(false);
  });

  it('rejects invalid tree metadata instead of accepting a substituted filename', () => {
    const { read } = encodedReader({ numstat: Buffer.from('-\t-\tproduction-\ufffd.mjs\0'),
      entry: Buffer.concat([Buffer.from(`100644 blob ${'a'.repeat(40)}\tproduction-`), Buffer.from([0xff]), Buffer.from('.mjs\0')]) });
    expect(() => read()).toThrow();
  });

  it.each(['production-\ufffd.mjs', '\ufeffproduction-é.mjs'])('preserves valid UTF-8 %j and arbitrary binary bytes', (path) => {
    const { read, exec } = encodedReader({ numstat: Buffer.from(`-\t-\t${path}\0`),
      entry: Buffer.from(`100644 blob ${'a'.repeat(40)}\t${path}\0`), blob: Buffer.concat([Buffer.from([0xff]), Buffer.from('\n'.repeat(301))]) });
    expect(read().text).toBe(`301\t301\t${path}\0`);
    expect(exec.mock.calls.filter(([, args]) => args.includes('ls-tree')).map(([, args]) => args.at(-1))).toEqual([path, path]);
  });
});

describe('shared reader — real git evidence', () => {
  function repo(probe) {
    const cwd = mkdtempSync(join(tmpdir(), 'size-admission-git-'));
    const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
    const commit = (message) => {
      git(['add', '.']);
      git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', message]);
    };
    try {
      git(['init', '--quiet', '--initial-branch=main']);
      commit('base');
      git(['update-ref', 'refs/remotes/origin/main', 'main']);
      git(['checkout', '--quiet', '-b', 'lane/size-admission']);
      probe({ cwd, git, commit });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  }

  it('counts production outside the cwd and roots backlog paths despite diff.relative=true', () => repo(({ cwd, git, commit }) => {
    git(['config', 'diff.relative', 'true']);
    mkdirSync(join(cwd, 'backlog'));
    writeFileSync(join(cwd, 'production.mjs'), 'code\n'.repeat(301));
    writeFileSync(join(cwd, 'backlog/card.md'), 'card\n'.repeat(400));
    commit('oversized');
    expect(git(['-C', join(cwd, 'backlog'), 'diff', '--numstat', '-z', 'main...HEAD'])).toBe('400\t0\tcard.md\0');
    const read = sizeAdmission.createPrDiffStatReader({ cwd: join(cwd, 'backlog') });
    expect(read).toBeTypeOf('function');
    const result = read({ base: 'main', sha: 'HEAD' });
    expect(sizeAdmission.measureNonTestLines(result.text)).toEqual({ lines: 701, exempt: false });
    expect(result.sha).toBe(git(['rev-parse', 'HEAD']).trim());
    git(['rm', '--quiet', 'production.mjs']);
    commit('backlog only');
    expect(sizeAdmission.measureNonTestLines(read({ base: 'main', sha: 'HEAD' }).text)).toEqual({ lines: 400, exempt: true });
  }));

  it.each(['worktree -diff', 'worktree binary', 'info -diff', 'global -diff', 'NUL bytes'])(
    'binary fallback counts hidden production content despite %s', (kind) => repo(({ cwd, git, commit }) => {
      if (kind.startsWith('worktree')) writeFileSync(join(cwd, '.gitattributes'), `production.mjs ${kind === 'worktree binary' ? 'binary' : '-diff'}\n`);
      if (kind === 'info -diff') writeFileSync(join(cwd, '.git/info/attributes'), 'production.mjs -diff\n');
      if (kind === 'global -diff') {
        writeFileSync(join(cwd, 'global-attributes'), 'production.mjs -diff\n');
        git(['config', 'core.attributesFile', join(cwd, 'global-attributes')]);
      }
      writeFileSync(join(cwd, 'production.mjs'), `${kind === 'NUL bytes' ? '\0' : ''}${'code\n'.repeat(301)}`);
      commit('oversized');
      expect(git(['diff', '--numstat', '-z', 'main...HEAD'])).toContain('-\t-\tproduction.mjs\0');
      const read = sizeAdmission.createPrDiffStatReader({ cwd });
      expect(read).toBeTypeOf('function');
      const measured = sizeAdmission.measureNonTestLines(read({ base: 'main', sha: 'HEAD' }).text);
      // Attribute files can contribute additional lines; the production count itself must survive.
      expect(measured.lines).toBeGreaterThanOrEqual(301);
      expect(measured.exempt).toBe(false);
    }),
  );

  it('preserves a non-ASCII backlog path and counts a 400-line production rename with two changed lines as two', () => repo(({ cwd, git, commit }) => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i}\n`);
    writeFileSync(join(cwd, 'old.mjs'), lines.join(''));
    commit('production base');
    git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    mkdirSync(join(cwd, 'backlog'));
    writeFileSync(join(cwd, 'backlog/é.md'), 'card\n'.repeat(400));
    commit('card');
    const read = sizeAdmission.createPrDiffStatReader({ cwd });
    expect(read).toBeTypeOf('function');
    expect(sizeAdmission.measureNonTestLines(read({ base: 'main', sha: 'HEAD' }).text)).toEqual({ lines: 400, exempt: true });
    git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    renameSync(join(cwd, 'old.mjs'), join(cwd, 'new.mjs'));
    lines[200] = 'changed\n';
    writeFileSync(join(cwd, 'new.mjs'), lines.join(''));
    commit('rename');
    const result = read({ base: 'main', sha: 'HEAD' });
    expect(result.text).toBe('1\t1\t\0old.mjs\0new.mjs\0');
    expect(sizeAdmission.measureNonTestLines(result.text)).toEqual({ lines: 2, exempt: false });
  }));
});
