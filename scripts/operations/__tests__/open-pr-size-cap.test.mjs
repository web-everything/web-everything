/** Shared accounting, data exclusions, and non-blocking size admission. */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as openPr from '../open-pr.mjs';
import * as openPrIo from '../open-pr-io.mjs';
import * as sizeAdmission from '../../lib/pr-size-admission.mjs';
import { BUILT_IN_PR_SIZE_SETTINGS } from '../../lib/pr-size-defaults.mjs';
import * as prLand from '../../pr-land.mjs';
import { REVIEW_LABELS } from '../../lib/review-labels.mjs';

const argv = ['--ref=lane/size-admission'];
const opened = { outcome: 'opened', pr: 5854, url: 'https://example.invalid/pull/5854' };
const text = '200\t0\tdocs/agent/a.md\0' + '101\t0\tdocs/agent/b.md\0';
const request = { ref: 'lane/size-admission', pr: 5854, base: 'main', sha: '1'.repeat(40), body: 'Describe the change.', repo: 'web-everything/web-everything' };
const card = { verdict: { num: 9001, id: 'xsplit1', rel: 'backlog/xsplit1-split.md' } };

function wrapper(overrides = {}) {
  const diffStat = vi.fn(() => text);
  const fileItem = vi.fn(() => card);
  const spawn = vi.fn(() => ({ status: 0, stdout: JSON.stringify(opened) }));
  const run = openPrIo.createPrLandRunner({ prepGate: () => ({ ok: true }), readPrepBody: () => '', prePrReview: () => ({ action: 'pass' }),
    diffStat, fileItem, spawn, dupBornAs: () => [], env: {}, ...overrides });
  return { run, diffStat, fileItem, spawn };
}

// Proposed direct-producer seam. The implementation phase exports admitPrSize from
// pr-land and CALLS IT from runCli before forge.create, using its body and verdict
// in createParams/applyReviewEscalationLabel. All effects here are injected.
function direct(overrides = {}) {
  const cards = new Map(); // trusted card-store fixture; body markers are advisory
  const effects = { loadSizeSettings: () => BUILT_IN_PR_SIZE_SETTINGS,
    diffStat: vi.fn(() => ({ text, sha: '1'.repeat(40) })),
    fileItem: vi.fn((fields) => {
      cards.set(/^size-split-key:([a-f0-9]{64})/.exec(fields.digest)?.[1], card.verdict);
      return card;
    }), lookupSplitCard: vi.fn(({ key }) => cards.get(key) || null),
    publishSplitCard: vi.fn(async () => ({ batched: true, batchRef: 'lane/card-batch-filing-1' })), ...overrides };
  return { effects, run: (input = request) => {
    expect(prLand.admitPrSize, 'direct pr-land must expose its injected admission seam').toBeTypeOf('function');
    return prLand.admitPrSize(input, effects);
  } };
}

// Keep the original accounting regressions here as the admission effects move to the shared suite.
describe('measureNonTestLines — pure numstat accounting', () => {
  it('exports a 300-line non-test limit', () => {
    expect(sizeAdmission.OPEN_PR_MAX_NON_TEST_LINES).toBe(300);
  });

  it('treats empty input as zero changes without a backlog exemption', () => {
    expect(sizeAdmission.measureNonTestLines('')).toEqual({ lines: 0, dataLines: 0, exempt: false });
  });

  it.each(['config/settings.json', 'src/data/entries.json', 'nested/config/entries.yaml',
    'data/entries.yml', 'nested/data/entries.csv'])('excludes and reports data additions and deletions in %s', (path) => {
    expect(sizeAdmission.measureNonTestLines(`600\t100\t${path}\0`))
      .toEqual({ lines: 0, dataLines: 700, exempt: false });
  });

  it.each(['config/setup.mjs', 'scripts/settings.json', 'docs/guide.md', 'data/guide.md',
    'metadata/entries.json', 'config.json'])('still counts code, docs and non-data directories: %s', (path) => {
    expect(sizeAdmission.measureNonTestLines(`200\t101\t${path}\0`))
      .toEqual({ lines: 301, dataLines: 0, exempt: false });
  });

  it('accepts exact extra data paths from resolved settings without matching prefixes', () => {
    const settings = { dataExtensions: [], dataDirs: [], dataPaths: ['scripts/settings.json'] };
    expect(sizeAdmission.measureNonTestLines('600\t100\tscripts/settings.json\0', settings))
      .toEqual({ lines: 0, dataLines: 700, exempt: false });
    expect(sizeAdmission.measureNonTestLines('600\t100\tscripts/settings.json.extra\0', settings))
      .toEqual({ lines: 700, dataLines: 0, exempt: false });
    expect(sizeAdmission.measureNonTestLines('600\t100\tconfig/settings.json\0', settings))
      .toEqual({ lines: 700, dataLines: 0, exempt: false });
  });

  it('counts both paths conservatively when a rename crosses the data boundary', () => {
    expect(sizeAdmission.measureNonTestLines('301\t0\t\0scripts/settings.json\0data/settings.json\0'))
      .toEqual({ lines: 301, dataLines: 0, exempt: false });
    expect(sizeAdmission.measureNonTestLines('301\t0\t\0config/settings.json\0data/settings.json\0'))
      .toEqual({ lines: 0, dataLines: 301, exempt: false });
  });

  it.each(['config/../scripts/a.json', 'config/./a.json', 'config//a.json',
    '/config/a.json', './config/a.json', '../data/a.json', 'data/a.json/'])
  ('counts unsafe data paths even when listed as exact exemptions: %s', (path) => {
    const settings = { dataExtensions: ['.json'], dataDirs: ['config', 'data'], dataPaths: [path] };
    for (const value of [undefined, settings]) {
      expect(sizeAdmission.measureNonTestLines(`301\t0\t${path}\0`, value))
        .toEqual({ lines: 301, dataLines: 0, exempt: false });
    }
  });

  it.each(['config/a.mjs', 'data/a.md'])('never exempts code or markdown even with unchecked settings: %s', (path) => {
    for (const dataPaths of [[], [path]]) {
      const settings = { dataExtensions: ['.mjs', '.md'], dataDirs: ['config', 'data'], dataPaths };
      expect(sizeAdmission.measureNonTestLines(`301\t0\t${path}\0`, settings))
        .toEqual({ lines: 301, dataLines: 0, exempt: false });
    }
  });

  it('fails closed for binary data and overflowing data totals', () => {
    expect(() => sizeAdmission.measureNonTestLines('-\t-\tdata/blob.json\0')).toThrow(/unmeasurable/);
    expect(() => sizeAdmission.measureNonTestLines('9007199254740991\t0\tdata/a.json\0' + '1\t0\tdata/b.json\0')).toThrow();
  });

  it('sums additions and deletions across non-test paths, with or without a trailing newline', () => {
    const text = '100\t50\tscripts/operations/open-pr.mjs\n20\t30\tdocs/a guide.md';
    expect(sizeAdmission.measureNonTestLines(text)).toEqual({ lines: 200, dataLines: 0, exempt: false });
    expect(sizeAdmission.measureNonTestLines(`${text}\n`)).toEqual({ lines: 200, dataLines: 0, exempt: false });
  });

  it('reads NUL-delimited paths containing non-ASCII characters, tabs, newlines and quotes literally', () => {
    expect(sizeAdmission.measureNonTestLines('700\t100\tbacklog/é.md\0'))
      .toEqual({ lines: 800, dataLines: 0, exempt: true });
    expect(sizeAdmission.measureNonTestLines('1\t2\tscripts/a\tb\nc"d.mjs\0'))
      .toEqual({ lines: 3, dataLines: 0, exempt: false });
    expect(sizeAdmission.measureNonTestLines('200\t50\tscripts/a.mjs\0' + '600\t300\tscripts/__tests__/é.mjs\0'))
      .toEqual({ lines: 250, dataLines: 0, exempt: false });
  });

  it('counts renames by their numstat counts and classifies both paths', () => {
    expect(sizeAdmission.measureNonTestLines('0\t0\t\0scripts/old.mjs\0scripts/new.mjs\0'))
      .toEqual({ lines: 0, dataLines: 0, exempt: false });
    expect(sizeAdmission.measureNonTestLines('1\t1\t\0scripts/old.test.mjs\0scripts/new.mjs\0'))
      .toEqual({ lines: 2, dataLines: 0, exempt: false });
    expect(sizeAdmission.measureNonTestLines('400\t0\t\0scripts/old.mjs\0scripts/new.test.mjs\0'))
      .toEqual({ lines: 400, dataLines: 0, exempt: false });
    expect(sizeAdmission.measureNonTestLines('400\t0\t\0docs/old.md\0backlog/new.md\0'))
      .toEqual({ lines: 400, dataLines: 0, exempt: false });
    expect(sizeAdmission.measureNonTestLines('400\t0\t\0backlog/old.md\0docs/new.md\0'))
      .toEqual({ lines: 400, dataLines: 0, exempt: false });
    expect(sizeAdmission.measureNonTestLines('400\t0\t\0scripts/old.test.mjs\0scripts/__tests__/new.mjs\0'))
      .toEqual({ lines: 0, dataLines: 0, exempt: false });
    expect(sizeAdmission.measureNonTestLines('400\t0\t\0backlog/old.md\0backlog/new.md\0'))
      .toEqual({ lines: 400, dataLines: 0, exempt: true });
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
      .toEqual({ lines: 250, dataLines: 0, exempt: false });
  });

  it('counts similarly named non-test paths', () => {
    expect(sizeAdmission.measureNonTestLines('10\t5\tscripts/__tests__helpers/a.mjs\n20\t5\tscripts/a.testing.mjs\n'))
      .toEqual({ lines: 40, dataLines: 0, exempt: false });
  });

  it('exempts a nonempty diff only when every path starts with backlog/', () => {
    expect(sizeAdmission.measureNonTestLines('700\t100\tbacklog/a.md\n150\t50\tbacklog/nested/b.md\n'))
      .toEqual({ lines: 1000, dataLines: 0, exempt: true });
    expect(sizeAdmission.measureNonTestLines('0\t0\tbacklog/a.md\n'))
      .toEqual({ lines: 0, dataLines: 0, exempt: true });
  });

  it('does not exempt mixed paths, even when the outside path is a test', () => {
    expect(sizeAdmission.measureNonTestLines('1000\t0\tbacklog/a.md\n1\t0\tscripts/a.mjs\n'))
      .toEqual({ lines: 1001, dataLines: 0, exempt: false });
    expect(sizeAdmission.measureNonTestLines('1000\t0\tbacklog/a.md\n900\t0\tscripts/a.test.mjs\n'))
      .toEqual({ lines: 1000, dataLines: 0, exempt: false });
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

describe('PR size settings cascade', () => {
  it('loads the production default settings file as a filesystem path', async () => {
    const { loadPrSizeSettingsFile } = await import('../../lib/pr-size-settings.mjs');
    expect(loadPrSizeSettingsFile(undefined, { platform: {}, env: {} })).toEqual({
      dataExtensions: ['.json', '.yaml', '.yml', '.csv'], dataDirs: ['config', 'data'], dataPaths: [],
    });
  });

  it('resolves standard, platform, tool and environment leaves with provenance', async () => {
    const { resolvePrSizeSettings } = await import('../../lib/pr-size-settings.mjs');
    const resolved = resolvePrSizeSettings({ platform: { dataDirs: ['fixtures'], dataPaths: ['platform.json'] },
      tool: { dataPaths: ['tool.json'] }, env: { WE_PR_SIZE_DATA_EXTENSIONS: '[".csv"]' } });
    expect(resolved.value).toEqual({ dataExtensions: ['.csv'], dataDirs: ['fixtures'], dataPaths: ['tool.json'] });
    expect(resolved.sources).toEqual({ dataExtensions: 'env', dataDirs: 'platform', dataPaths: 'tool' });
    expect(sizeAdmission.measureNonTestLines('400\t5\tfixtures/table.csv\0', resolved.value))
      .toEqual({ lines: 0, dataLines: 405, exempt: false });
  });

  it('rejects invalid overrides instead of retaining lower layers', async () => {
    const { resolvePrSizeSettings } = await import('../../lib/pr-size-settings.mjs');
    expect(() => resolvePrSizeSettings({ platform: {}, tool: { dataDirs: ['../scripts'], dataPaths: ['/absolute.json'] },
      env: { WE_PR_SIZE_DATA_EXTENSIONS: 'not-json', WE_PR_SIZE_DATA_PATHS: '["../escape.json"]' } })).toThrow();
  });

  it.each([
    { dataExtensions: ['.mjs'] }, { dataExtensions: ['.json', '.md'] },
    { dataPaths: ['scripts/a.mjs'] }, { dataPaths: ['docs/a.md'] },
    { dataPaths: ['config/../scripts/a.json'] }, { dataPaths: ['config/./a.json'] },
    { dataPaths: ['config//a.json'] }, { dataPaths: ['/config/a.json'] },
    { dataExtensions: '.json' }, { dataExtensions: [1] }, { dataDirs: null },
    { dataPaths: {} }, { dataPaths: { nested: ['scripts/a.json'] } }, null, [], 'invalid',
  ])('rejects invalid settings in every cascade layer: %j', async (invalid) => {
    const { resolvePrSizeSettings } = await import('../../lib/pr-size-settings.mjs');
    expect(() => resolvePrSizeSettings({ platform: {}, tool: invalid, env: {} })).toThrow();
    expect(() => resolvePrSizeSettings({ platform: invalid, tool: {}, env: {} })).toThrow();
    if (invalid && !Array.isArray(invalid) && typeof invalid === 'object') {
      const env = Object.fromEntries(Object.entries(invalid).map(([key, value]) => [
        `WE_PR_SIZE_${key.replace(/[A-Z]/g, letter => `_${letter}`).toUpperCase()}`, JSON.stringify(value),
      ]));
      expect(() => resolvePrSizeSettings({ platform: {}, tool: {}, env })).toThrow();
    }
  });

  it('allows narrowing and extending the extension selection only within pure data', async () => {
    const { resolvePrSizeSettings } = await import('../../lib/pr-size-settings.mjs');
    const { value } = resolvePrSizeSettings({ platform: { dataExtensions: ['.json'] },
      tool: { dataExtensions: ['.json', '.yaml', '.yml', '.csv'] }, env: {} });
    expect(value.dataExtensions).toEqual(['.json', '.yaml', '.yml', '.csv']);
  });

  it('rejects malformed environment JSON even when lower layers are valid', async () => {
    const { resolvePrSizeSettings } = await import('../../lib/pr-size-settings.mjs');
    expect(() => resolvePrSizeSettings({ platform: {}, env: { WE_PR_SIZE_DATA_PATHS: 'not-json' } })).toThrow();
  });

  it('rejects invalid lower layers even when a valid override would replace them', async () => {
    const { resolvePrSizeSettings } = await import('../../lib/pr-size-settings.mjs');
    expect(() => resolvePrSizeSettings({ platform: { dataExtensions: ['.mjs'] },
      tool: { dataExtensions: ['.json'] }, env: { WE_PR_SIZE_DATA_EXTENSIONS: '[".csv"]' } })).toThrow();
  });

  it.each(['{broken', '[]', '{"prSize":null}', '{"prSize":{"dataPaths":["scripts/a.mjs"]}}'])
  ('rejects unreadable or invalid platform preferences: %s', async (contents) => {
    const { resolvePrSizeSettings } = await import('../../lib/pr-size-settings.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'pr-size-platform-'));
    try {
      const path = join(dir, 'preferences.json');
      writeFileSync(path, contents);
      expect(() => resolvePrSizeSettings({ env: { WE_PLATFORM_PREFERENCES_FILE: path } })).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('loads exact repo paths, throws for malformed or unreadable files, and defaults only for absent files', async () => {
    const { loadPrSizeSettingsFile } = await import('../../lib/pr-size-settings.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'pr-size-settings-'));
    try {
      const path = join(dir, 'settings.json');
      writeFileSync(path, JSON.stringify({ dataPaths: ['scripts/settings.json'] }));
      const settings = loadPrSizeSettingsFile(path, { env: {}, platform: {} });
      expect(sizeAdmission.measureNonTestLines('400\t5\tscripts/settings.json\0', settings))
        .toEqual({ lines: 0, dataLines: 405, exempt: false });
      writeFileSync(path, 'invalid');
      expect(() => loadPrSizeSettingsFile(path, { env: {}, platform: {} })).toThrow();
      expect(() => loadPrSizeSettingsFile(dir, { env: {}, platform: {} })).toThrow();
      expect(loadPrSizeSettingsFile(join(dir, 'missing'), { env: {}, platform: {} })).toEqual({
        dataExtensions: ['.json', '.yaml', '.yml', '.csv'], dataDirs: ['config', 'data'], dataPaths: [],
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each(['{broken', 'null', '{"dataExtensions":".json"}', '{"dataExtensions":[".mjs"]}',
    '{"dataPaths":["scripts/a.mjs"]}', '{"dataPaths":["docs/a.md"]}'])
  ('invalid present settings escalate review without refusing direct admission: %s', async (contents) => {
    const { loadPrSizeSettingsFile } = await import('../../lib/pr-size-settings.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'pr-size-invalid-'));
    try {
      const path = join(dir, 'settings.json');
      writeFileSync(path, contents);
      const { run, effects } = direct({
        diffStat: () => ({ text: '1\t0\tconfig/a.json\0', sha: request.sha }),
        loadSizeSettings: () => loadPrSizeSettingsFile(path, { platform: {}, env: {} }),
      });
      expect(await run()).toMatchObject({ status: 'unknown', reviewLabel: REVIEW_LABELS.pending });
      expect(effects.fileItem).toHaveBeenCalledOnce();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('legacy size imports remain compatible with the shared home', () => {
  it('open-pr-io re-exports the shared 300-line constant and measurement function (the declaration stays import-free)', () => {
    expect(sizeAdmission.OPEN_PR_MAX_NON_TEST_LINES).toBe(300);
    expect(openPrIo.OPEN_PR_MAX_NON_TEST_LINES).toBe(sizeAdmission.OPEN_PR_MAX_NON_TEST_LINES);
    expect(openPrIo.measureNonTestLines).toBe(sizeAdmission.measureNonTestLines);
    expect(openPr.measureNonTestLines).toBe(sizeAdmission.measureNonTestLines);
    expect(openPr.OPEN_PR_MAX_NON_TEST_LINES).toBe(sizeAdmission.OPEN_PR_MAX_NON_TEST_LINES);
  });
  it('open-pr-io re-exports the shared diff-stat reader', () => {
    expect(openPrIo.createPrDiffStatReader).toBe(sizeAdmission.createPrDiffStatReader);
  });
});

describe('open-pr delegates size admission to the direct producer', () => {
  it('301 non-test lines are not refused: one producer invocation and no duplicate wrapper measurement/card', () => {
    const { run, diffStat, fileItem, spawn } = wrapper();
    expect(run({ argv })).toMatchObject(opened);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(diffStat).not.toHaveBeenCalled();
    expect(fileItem).not.toHaveBeenCalled();
    expect(spawn.mock.calls[0][1]).toEqual([expect.stringMatching(/pr-land\.mjs$/), ...argv, '--json']);
  });

  it('unreadable wrapper diff cannot refuse or duplicate the producer’s unknown-size handling', () => {
    const diffStat = vi.fn(() => { throw new Error('diff unavailable'); });
    const { run, spawn } = wrapper({ diffStat });
    expect(run({ argv })).toMatchObject(opened);
    expect(diffStat).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('a pre-PR review refusal still stops before producer effects', () => {
    const { run, diffStat, spawn } = wrapper({ prePrReview: () => ({ action: 'refuse', reason: 'pre-pr-review-missing' }) });
    expect(run({ argv })).toMatchObject({ outcome: 'refused', reason: 'pre-pr-review-missing' });
    expect(diffStat).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('a reviewed SHA is passed intact to the producer for measurement and publication', () => {
    const { run, spawn } = wrapper({ prePrReview: () => ({ action: 'pass', sha: '3333333333333333333333333333333333333333' }) });
    const requested = [...argv, '--sha=HEAD'];
    expect(run({ argv: requested })).toMatchObject(opened);
    expect(spawn.mock.calls[0][1].filter((arg) => arg.startsWith('--sha='))).toEqual(['--sha=3333333333333333333333333333333333333333']);
    expect(requested).toEqual([...argv, '--sha=HEAD']);
  });

  it('an audited gate.bypass is recorded while the same producer still handles size', () => {
    const dir = mkdtempSync(join(tmpdir(), 'size-bypass-'));
    try {
      const bodyFile = join(dir, 'body.md');
      writeFileSync(bodyFile, request.body);
      let body;
      const spawn = vi.fn((_command, args) => {
        body = readFileSync(args.find((a) => a.startsWith('--body-file=')).slice('--body-file='.length), 'utf8');
        expect(args.some((a) => /skip-size|size-bypass/.test(a))).toBe(false);
        return { status: 0, stdout: JSON.stringify(opened) };
      });
      const { run } = wrapper({ spawn, prePrReview: () => ({ action: 'pass', bypass: {
        reason: 'operator reason', actor: 'operator', operatorInstruction: 'Ship this change',
      } }) });
      expect(run({ argv: [...argv, `--body-file=${bodyFile}`] })).toMatchObject(opened);
      expect(body).toContain('operator reason');
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('direct pr-land uses the same admission and existing review-label path', () => {
  it.each([
    ['data-only diff', '1000\t0\tconfig/settings.json\0', 0],
    ['300 code lines plus data', '300\t0\tscripts/a.mjs\0' + '1000\t0\tdata/entries.json\0', 300],
  ])('direct pr-land excludes data from the budget for %s', async (_name, evidence, lines) => {
    const { run, effects } = direct({ diffStat: () => ({ text: evidence, sha: request.sha }) });
    expect(await run()).toMatchObject({ status: 'ok', lines, dataLines: 1000,
      body: request.body, reviewLabel: null });
    expect(effects.fileItem).not.toHaveBeenCalled();
    expect(effects.publishSplitCard).not.toHaveBeenCalled();
  });

  it('direct pr-land loads cascade settings using the producer environment', async () => {
    const { run, effects } = direct({
      loadSizeSettings: undefined, // exercise the production settings loader
      env: { WE_PLATFORM_PREFERENCES_FILE: join(tmpdir(), 'absent-pr-size-platform-preferences.json'),
        WE_PR_SIZE_DATA_PATHS: '["scripts/settings.json"]' },
      diffStat: () => ({ text: '400\t5\tscripts/settings.json\0', sha: request.sha }),
    });
    expect(await run()).toMatchObject({ status: 'ok', lines: 0, dataLines: 405, reviewLabel: null });
    expect(effects.fileItem).not.toHaveBeenCalled();
  });

  it('direct pr-land reports excluded data while retaining its file groups for review', async () => {
    const { run, effects } = direct({ diffStat: () => ({
      text: '301\t0\tscripts/a.mjs\0' + '900\t100\tdata/entries.json\0', sha: request.sha,
    }) });
    const result = await run();
    expect(result).toMatchObject({ status: 'over', lines: 301, dataLines: 1000,
      reviewLabel: REVIEW_LABELS.pending });
    expect(result.body).toContain('1000 data lines (not counted).');
    expect(result.body).toContain('we:data/entries.json: 1000');
    expect(effects.fileItem).toHaveBeenCalledOnce();
    expect(effects.fileItem.mock.calls[0][0].scope).toContain('we:data/entries.json');
  });

  it('direct pr-land: 301 lines proceed, one card names PR + groups, body notes both, reviewers escalated', async () => {
    const { run, effects } = direct();
    const result = await run();
    expect(result).toMatchObject({ status: 'over', lines: 301, reviewLabel: REVIEW_LABELS.pending, sha: '1111111111111111111111111111111111111111' });
    expect(effects.fileItem).toHaveBeenCalledTimes(1);
    const filed = effects.fileItem.mock.calls[0][0];
    expect(filed.title).toContain('#5854');
    expect(filed.digest).toMatch(/docs\/agent[^\n]*301/);
    expect(result.body).toContain('301 non-test lines (> 300)');
    expect(result.body).toMatch(/split card.*(?:9001|xsplit1).*filed/i);
    expect(result.body).toContain('extra reviewers requested via the size escalation (review:pending)');
    expect(result.body).toMatch(/file groups[^\n]*docs\/agent[^\n]*301/i);
    const verdict = prLand.resolveProducerReviewLabel({ changedFiles: ['docs/agent/a.md'], diffLines: 301, sizeAdmission: result });
    expect(verdict).toMatchObject({ label: REVIEW_LABELS.pending, apply: true });
  });

  it.each([
    ['exactly 300', '300\t0\tdocs/example.md\0'],
    ['test-only big diff', '1000\t0\tscripts/a.test.mjs\0'],
    ['backlog-only big diff', '1000\t0\tbacklog/a.md\0'],
  ])('direct pr-land: %s needs no size action', async (_name, evidence) => {
    const { run, effects } = direct({ diffStat: vi.fn(() => ({ text: evidence, sha: request.sha })) });
    expect(await run()).toMatchObject({ status: 'ok', body: request.body, reviewLabel: null });
    expect(effects.fileItem).not.toHaveBeenCalled();
  });

  it('direct pr-land: throwing reader proceeds with size unknown, files conservatively and requests extra reviewers', async () => {
    const { run, effects } = direct({ diffStat: vi.fn(() => { throw new Error('diff unavailable'); }) });
    const result = await run();
    expect(result).toMatchObject({ status: 'unknown', reviewLabel: REVIEW_LABELS.pending });
    expect(result.body).toContain('size unknown: extra reviewers requested');
    expect(result.body).toMatch(/file groups/i);
    expect(effects.fileItem).toHaveBeenCalledOnce();
    expect(prLand.resolveProducerReviewLabel({ changedFiles: [], diffLines: 0, sizeAdmission: result }))
      .toMatchObject({ label: REVIEW_LABELS.pending, apply: true });
  });

  it('direct pr-land: an audited review bypass never skips size handling', async () => {
    const { run, effects } = direct();
    const result = await run({ ...request, gate: { action: 'pass', bypass: {
      reason: 'operator reason', actor: 'operator', operatorInstruction: 'Ship this change',
    } } });
    expect(result).toMatchObject({ status: 'over', reviewLabel: REVIEW_LABELS.pending });
    expect(effects.diffStat).toHaveBeenCalledTimes(1);
    expect(effects.fileItem).toHaveBeenCalledTimes(1);
  });

  it('direct pr-land measures the reviewed SHA and returns the pinned publication SHA', async () => {
    const { run, effects } = direct({ diffStat: vi.fn(() => ({ text, sha: '3333333333333333333333333333333333333333' })) });
    const result = await run({ ...request, sha: '3333333333333333333333333333333333333333' });
    expect(effects.diffStat).toHaveBeenCalledWith({ base: 'main', sha: '3333333333333333333333333333333333333333' });
    expect(result.sha).toBe('3333333333333333333333333333333333333333');
  });

  it('direct pr-land: card failure still proceeds and escalates', async () => {
    const { run, effects } = direct({ fileItem: vi.fn(() => { throw new Error('filing unavailable'); }) });
    const result = await run();
    expect(result).toMatchObject({ status: 'over', reviewLabel: REVIEW_LABELS.pending });
    expect(result.body).toContain('split card not filed (file-item failed)');
    expect(result.body).toContain('extra reviewers requested');
    expect(effects.fileItem).toHaveBeenCalledTimes(1);
  });

  it('direct pr-land: repeated admission with the updated body does not file twice', async () => {
    const { run, effects } = direct();
    const first = await run();
    const second = await run({ ...request, body: first.body });
    expect(effects.fileItem).toHaveBeenCalledTimes(1);
    expect(second.body.match(/^## Size$/gm)).toHaveLength(1);
    expect(second.body).toBe(first.body);
    const third = await run({ ...request, body: second.body });
    expect(third.body).toBe(first.body);
    expect(effects.fileItem).toHaveBeenCalledTimes(1);
  });

  it('direct pr-land replaces a plain section in place, preserves surrounding text, and retries twice identically', async () => {
    const { run, effects } = direct();
    const before = 'Author rationale.  \r\n\r\n';
    const after = '\r\n\r\n## Testing\r\nKeep this.  \r\n';
    const body = before + '<!-- pr-size:begin -->\nStale display text\n<!-- pr-size:end -->' + after;
    const first = await run({ ...request, body });
    expect(first.body.startsWith(before + '<!-- pr-size:begin -->\n')).toBe(true);
    expect(first.body.endsWith('<!-- pr-size:end -->' + after)).toBe(true);
    expect(first.body).not.toContain('Stale display text');
    expect(first.body.match(/^## Size$/gm)).toHaveLength(1);
    const retry = await run({ ...request, body: first.body });
    expect(retry.body).toBe(first.body);
    expect((await run({ ...request, body: retry.body })).body).toBe(first.body);
    expect(effects.fileItem).toHaveBeenCalledTimes(1);
    expect(effects.lookupSplitCard).toHaveBeenCalledTimes(3);
    expect(effects.publishSplitCard).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['forged', '<!-- pr-size:begin -->\nKeep prose\n<!-- pr-size:end forged=true -->'],
    ['partial', '<!-- pr-size:begin -->\nKeep prose'],
    ['duplicate', '<!-- pr-size:begin -->\nFirst\n<!-- pr-size:end -->\n<!-- pr-size:begin -->\nSecond\n<!-- pr-size:end -->'],
  ])('direct pr-land preserves all %s marker text and appends identically on two retries', async (_label, markers) => {
    const { run, effects } = direct();
    const body = 'Before\r\n' + markers + '\r\nAfter';
    const first = await run({ ...request, body });
    const generated = (await run({ ...request, body: '' })).body;
    expect(first.body).toBe(body + '\n\n' + generated);
    const retry = await run({ ...request, body: first.body });
    expect(retry.body).toBe(first.body);
    expect((await run({ ...request, body: retry.body })).body).toBe(first.body);
    expect(effects.fileItem).toHaveBeenCalledTimes(1);
  });

  it.each(['over', 'unknown'])('forces %s through review:pending even below the existing 400-line threshold', (status) => {
    // #size-adds-reviewers-never-refuses: reuse the producer rubric/label path.
    expect(prLand.resolveProducerReviewLabel({ changedFiles: ['docs/example.md'], diffLines: 301,
      sizeAdmission: { status, lines: status === 'unknown' ? null : 301 } }))
      .toMatchObject({ label: REVIEW_LABELS.pending, apply: true });
  });

  it('forcing size escalation preserves an existing stronger human-review requirement', () => {
    const verdict = prLand.resolveProducerReviewLabel({ changedFiles: [], diffLines: 301,
      deviation: 'operator ruling required', sizeAdmission: { status: 'over', lines: 301 } });
    expect(verdict).toMatchObject({ label: REVIEW_LABELS.human, humanRequired: true });
  });

  it.each([
    ['301-line admission requests review:pending', 'over', null, REVIEW_LABELS.pending],
    ['unknown evidence requests review:pending', 'unknown', null, REVIEW_LABELS.pending],
    ['301-line admission preserves human-required escalation', 'over', 'operator ruling required', REVIEW_LABELS.human],
    ['unknown evidence preserves human-required escalation', 'unknown', 'operator ruling required', REVIEW_LABELS.human],
  ])('%s through the admission-to-producer review-label path', async (_name, status, deviation, label) => {
    const { run } = direct(status === 'unknown' ? {
      diffStat: vi.fn(() => { throw new Error('diff unavailable'); }),
    } : {});
    const admission = await run();
    expect(admission.status).toBe(status);
    const verdict = prLand.resolveProducerReviewLabel({
      changedFiles: ['docs/example.md'], diffLines: admission.lines ?? 0,
      sizeAdmission: admission, deviation,
    });
    expect(verdict).toMatchObject({ label, apply: true, humanRequired: label === REVIEW_LABELS.human });
  });

  it('the production opening paths contain no legacy size refusal outcomes', () => {
    for (const path of ['scripts/operations/open-pr-io.mjs', 'scripts/operations/open-pr.mjs', 'scripts/pr-land.mjs']) {
      expect(readFileSync(join(process.cwd(), path), 'utf8')).not.toMatch(/pr-too-large|pr-size-unreadable/);
    }
  });

  it('CLI wiring calls the injected admission seam before create and consumes its body and escalation', () => {
    // Complements the effect tests: a new exported helper alone cannot fix direct callers.
    const source = readFileSync(join(process.cwd(), 'scripts/pr-land.mjs'), 'utf8');
    const cli = source.slice(source.indexOf('function runCli('));
    const call = /\b(\w+)\s*=\s*(?:await\s+)?admitPrSize\s*\(/.exec(cli);
    expect(call, 'runCli must actually invoke shared size admission').not.toBeNull();
    expect(call.index).toBeLessThan(cli.indexOf('forge.create(createParams)'));
    expect(cli).toMatch(new RegExp('body\\s*:\\s*' + call[1] + '\\.body|createParams\\.body\\s*=\\s*' + call[1] + '\\.body'));
    expect(cli).toMatch(new RegExp('sizeAdmission\\s*:\\s*' + call[1] + '\\b'));
    expect(source).toContain('#size-adds-reviewers-never-refuses');
  });
});

describe('pr-land CLI size failure boundaries', () => {
  const source = readFileSync(join(process.cwd(), 'scripts/pr-land.mjs'), 'utf8');
  // Execute the production block with injected IO without running publication or Git commands.
  const block = source.slice(source.indexOf('  let sizeBody = CREATE_BODY;'), source.indexOf('\n  if (prNum == null) {', source.indexOf('  let sizeBody = CREATE_BODY;')));
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const executeBlock = new AsyncFunction('forge', 'admitPrSize', 'prNum', 'REVIEW_LABELS', 'buildSizeAdmissionRequest', 'publication', `
    const CREATE_BODY = 'create body', REPO = '.';
    const { REF, REMOTE, BASE, refSha, SRC } = publication;
    const composePrBody = (body) => body;
    const createParams = {};
    ${block}
    return { sizeAdmission, createParams };
  `);
  const runBlock = (forge, admit, prNum, labels, publication = { REF: 'lane/test', REMOTE: 'origin', BASE: 'main', refSha: 'sha', SRC: 'HEAD' }) =>
    executeBlock(forge, admit, prNum, labels, prLand.buildSizeAdmissionRequest, publication);

  it.each([null, 5854])('the real runner outer fallback preserves the body passed to the forge (PR %s)', async (prNum) => {
    const original = prNum == null ? 'create body' : 'Author body\r\n\r\n## Testing\r\nKeep this.  ';
    const forge = { viewPr: vi.fn(() => ({ body: original })), editBody: vi.fn() };
    const { run } = direct();
    const result = await runBlock(forge, (input) => run({ ...input, sha: Symbol('invalid SHA') }), prNum, REVIEW_LABELS);
    expect(result.sizeAdmission).toMatchObject({ status: 'unknown', lines: null, reviewLabel: REVIEW_LABELS.pending });
    expect(result.createParams.body.startsWith(original + '\n\n<!-- pr-size:begin -->')).toBe(true);
    expect(result.createParams.body).toContain('Split-card filing could not be confirmed.');
    expect(result.createParams.body).toMatch(/<!-- pr-size:end -->$/);
    if (prNum != null) expect(forge.editBody).toHaveBeenCalledWith(prNum, result.createParams.body);
    else expect(forge.editBody).not.toHaveBeenCalled();
  });

  it.each([null, 5854])('CLI body reports a split card only after shared admission publishes it (PR %s)', async (prNum) => {
    const forge = { viewPr: vi.fn(() => ({ body: 'live body' })), editBody: vi.fn() };
    const { effects, run } = direct({ publishSplitCard: vi.fn(async () => ({ batched: false, reason: 'publication unavailable' })) });
    const result = await runBlock(forge, (input) => run(input), prNum, REVIEW_LABELS);
    expect(effects.publishSplitCard).toHaveBeenCalledTimes(1);
    expect(result.createParams.body).toContain('split card not filed (file-item failed)');
    expect(result.sizeAdmission.reviewLabel).toBe(REVIEW_LABELS.pending);
    expect(result.createParams.body).toMatch(/<!-- size-admission:[a-f0-9]{64} -->/);
    expect(result.createParams.body).toMatch(/<!-- pr-size:begin -->\n[\s\S]*<!-- pr-size:end -->$/);
    if (prNum != null) expect(forge.editBody).toHaveBeenCalledWith(prNum, result.createParams.body);
  });

  it.each([
    ['an author edit', () => ({ body: 'live body\n\n## Rollout\nAuthor edit during card filing.' })],
    ['an unreadable re-read', () => { throw new Error('body unavailable'); }],
  ])('never writes the size note over %s made while cards were filed', async (_label, reread) => {
    const forge = { viewPr: vi.fn(() => ({ body: 'live body' })), editBody: vi.fn() };
    const admit = vi.fn(async ({ body }) => {
      forge.viewPr.mockImplementation(reread);
      return { status: 'over', body: `${body}\nSize note`, reviewLabel: REVIEW_LABELS.pending };
    });
    const result = await runBlock(forge, admit, 5854, REVIEW_LABELS);
    expect(forge.viewPr).toHaveBeenCalledTimes(2);
    expect(forge.editBody).not.toHaveBeenCalled();
    expect(result.sizeAdmission.reviewLabel).toBe(REVIEW_LABELS.pending);
  });

  it('never edits a live body that is already at the forge limit', async () => {
    const live = 'x'.repeat(65_500);
    const forge = { viewPr: vi.fn(() => ({ body: live })), editBody: vi.fn() };
    const { run } = direct();
    const result = await runBlock(forge, (input) => run(input), 5854, REVIEW_LABELS);
    expect(result.createParams.body).toBe(live);
    expect(result.sizeAdmission.reviewLabel).toBe(REVIEW_LABELS.pending);
    expect(forge.editBody).not.toHaveBeenCalled();
  });

  it('the escalation-reason stamp never writes over an unread live body', () => {
    const start = source.indexOf("        let liveBody = ''");
    const end = source.indexOf('\n      } catch { /* best-effort — the label already carries the signal */ }', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const reconcile = vi.fn(() => ({ changed: true, body: '## Escalation reasons\n- size' }));
    const execute = new Function('forge', 'prNum', 'verdict', 'reconcileEscalationReasonBlock', source.slice(start, end));
    for (const readSucceeds of [false, true]) {
      const forge = { viewPr: vi.fn(() => {
        if (!readSucceeds) throw new Error('body unavailable');
        return { body: 'live body' };
      }), editBody: vi.fn() };
      execute(forge, 5854, { reasons: ['size'] }, reconcile);
      expect(forge.viewPr).toHaveBeenCalledOnce();
      if (readSucceeds) expect(forge.editBody).toHaveBeenCalledWith(5854, '## Escalation reasons\n- size');
      else expect(forge.editBody).not.toHaveBeenCalled();
    }
  });

  it('builds admission arguments from the resolved publication SHA and remote base', () => {
    expect(prLand.buildSizeAdmissionRequest).toBeTypeOf('function');
    expect(prLand.buildSizeAdmissionRequest({ ref: 'lane/reviewed', pr: 5854, remote: 'upstream',
      base: 'release', refSha: 'resolved-reviewed-commit', body: 'live body' })).toEqual({
      ref: 'lane/reviewed', pr: 5854, base: 'upstream/release', sha: 'resolved-reviewed-commit', body: 'live body',
    });
  });

  it.each([null, 5854])('CLI admission measures the exact SHA pushed and the selected remote base (PR %s)', async (prNum) => {
    const publication = { REF: 'lane/reviewed', REMOTE: 'upstream', BASE: 'release', refSha: 'resolved-reviewed-commit', SRC: 'unresolved-source' };
    const forge = { viewPr: vi.fn(() => ({ body: 'live body' })), editBody: vi.fn() };
    const admit = vi.fn(async ({ body }) => ({ status: 'ok', body, reviewLabel: null }));
    // Run the actual push statement and admission block against the same bindings.
    const push = source.match(/gitC\(\['push', REMOTE, `\$\{refSha\}:refs\/heads\/\$\{REF\}`\]\)/)?.[0];
    expect(push).toBeTypeOf('string');
    const gitC = vi.fn();
    new Function('gitC', 'REMOTE', 'refSha', 'REF', push)(gitC, publication.REMOTE, publication.refSha, publication.REF);
    await runBlock(forge, admit, prNum, REVIEW_LABELS, publication);
    const pushedSha = gitC.mock.calls[0][0][2].split(':')[0];
    expect(admit).toHaveBeenCalledWith({ ref: publication.REF, pr: prNum, base: 'upstream/release',
      sha: pushedSha, body: prNum == null ? 'create body' : 'live body' }, { cwd: '.' });
  });

  it.each([false, true])('only edits an existing PR after a successful live body read (read succeeds: %s)', async (readSucceeds) => {
    const forge = {
      viewPr: vi.fn(() => {
        if (!readSucceeds) throw new Error('body unavailable');
        return { body: 'live body' };
      }),
      editBody: vi.fn(),
    };
    const admit = vi.fn(async ({ body }) => ({ status: 'over', body: `${body}\nSize note`, reviewLabel: REVIEW_LABELS.pending }));
    await runBlock(forge, admit, 5854, REVIEW_LABELS);
    expect(admit).toHaveBeenCalledTimes(1);
    if (readSucceeds) expect(forge.editBody).toHaveBeenCalledWith(5854, 'live body\nSize note');
    else expect(forge.editBody).not.toHaveBeenCalled();
  });

  it.each([
    ['synchronous throw', () => { throw new Error('admission failed'); }],
    ['async rejection', async () => { throw new Error('admission failed'); }],
  ])('%s preserves new and existing bodies and forces unknown-size review', async (_name, admit) => {
    for (const prNum of [null, 5854]) {
      const forge = { viewPr: vi.fn(() => ({ body: 'live body' })), editBody: vi.fn() };
      const body = prNum == null ? 'create body' : 'live body';
      const result = await runBlock(forge, admit, prNum, REVIEW_LABELS);
      expect(result).toEqual({ sizeAdmission: { status: 'unknown', body, reviewLabel: REVIEW_LABELS.pending }, createParams: { body } });
      expect(forge.editBody).not.toHaveBeenCalled();
      expect(prLand.resolveProducerReviewLabel({ sizeAdmission: result.sizeAdmission }))
        .toMatchObject({ label: REVIEW_LABELS.pending, apply: true });
    }
  });

  it('entry-point rejection emits internal-error with a nonzero exit code', async () => {
    const entry = source.slice(source.indexOf('if (IS_CLI) runCli()'), source.indexOf('\nasync function runCli()'));
    const emit = vi.fn();
    const run = new Function('runCli', 'emit', 'REPO', entry.replace('if (IS_CLI) ', 'return '));
    await run(async () => { throw new Error('unexpected failure'); }, emit, '.');
    expect(emit).toHaveBeenCalledWith({ repo: '.', merged: false, reason: 'internal-error', detail: 'unexpected failure' }, 3);
    expect(source).toMatch(/async function runCli\(\)\s*\{\s*\/\/[^\n]*\n\s*emit = emitResult;/);
  });
});
