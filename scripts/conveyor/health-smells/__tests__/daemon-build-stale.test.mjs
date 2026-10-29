import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as detector from '../daemon-build-stale.mjs';
import daemonBuildStale, { createStateLister, decide, evaluate } from '../daemon-build-stale.mjs';
import { validateSmellShape } from '../../health-smells-shape.mjs';

// Exercise the real registry loader against an in-memory directory listing. Do not
// mock the registry or supply its entries: inclusion must come from discovery.
vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal(),
  readdirSync: vi.fn(() => [
    { name: 'daemon-build-stale.mjs', isFile: () => true },
  ]),
}));

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.parse('2026-10-28T18:00:00Z');
const CLONE = 'we-drain-daemon-code';
const MAIN_SHA = 'a'.repeat(40);

function state(adopted = { mainSha: MAIN_SHA, applied: [] }) {
  return { cloneKey: CLONE, raw: JSON.stringify({ adopted }) };
}

function merges(oldestAgeMs) {
  // Newest first: using the first timestamp would miss the five-hour breach.
  return [
    { sha: 'c'.repeat(40), ctMs: NOW - 10 * MINUTE, subject: 'Merge pull request #6026 from x/z' },
    { sha: 'b'.repeat(40), ctMs: NOW - oldestAgeMs, subject: 'Merge pull request #6014 from x/y' },
  ];
}

async function run({ states = [state()], commits = merges(5 * HOUR), config, error } = {}) {
  const io = {
    listStates: vi.fn(() => states),
    mergesSince: vi.fn(() => {
      if (error) throw error;
      return commits;
    }),
  };
  const results = await evaluate({}, { now: NOW, config, io });
  expect(io.listStates).toHaveBeenCalledTimes(1);
  expect(results).toHaveLength(states.length);
  for (const result of results) {
    expect(result).toEqual(expect.objectContaining({
      subject: expect.any(String),
      breach: expect.any(Boolean),
      measure: expect.any(Object),
      summary: expect.any(String),
      recommendation: expect.any(String),
    }));
    expect(result.recommendation.trim()).not.toBe('');
  }
  return { results, io };
}

function expectUnreadable(result) {
  expect(result.subject).toBe(`daemon-build:${CLONE}`);
  expect(result.breach).toBe(true);
  expect(result.summary).toContain(CLONE);
  expect(result.summary).toMatch(/state unreadable/i);
}

describe('daemon-build-stale', () => {
  it('invokes bounded first-parent git history for adopted SHA through origin/main', () => {
    expect(detector.createGitHistoryReader).toBeTypeOf('function');
    const exec = vi.fn(() => `${MAIN_SHA}\t123\tMerge pull request #42 from x/y\twith tab\n`);
    const readHistory = detector.createGitHistoryReader({ exec, repoRoot: 'fixture-repo' });
    expect(readHistory(MAIN_SHA)).toEqual([
      { sha: MAIN_SHA, ctMs: 123_000, subject: 'Merge pull request #42 from x/y\twith tab' },
    ]);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith('git', [
      '-C', 'fixture-repo', 'log', '--first-parent', '--format=%H%x09%ct%x09%s', `${MAIN_SHA}..origin/main`,
    ], { encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
  });

  it.each(['', 'NaN', 'Infinity', 'bad'])('rejects unreadable git timestamps: %j', (ct) => {
    expect(detector.createGitHistoryReader).toBeTypeOf('function');
    const readHistory = detector.createGitHistoryReader({ exec: () => `${MAIN_SHA}\t${ct}\tsubject\n` });
    expect(() => readHistory(MAIN_SHA)).toThrow(/timestamp/i);
  });

  it('reads real first-parent history and rejects an unknown SHA without Git writes', () => {
    expect(detector.createGitHistoryReader).toBeTypeOf('function');
    // Use the existing checkout read-only: sandbox repairs forbid even temporary .git writes.
    const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
    const git = (args) => execFileSync('git', ['-C', repoRoot, ...args], {
      encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0' },
    }).trim();
    const adopted = git(['rev-parse', 'origin/main~3']);
    const readHistory = detector.createGitHistoryReader({ repoRoot });
    const records = readHistory(adopted);
    expect(records.map(({ sha }) => sha)).toEqual(git(['rev-list', '--first-parent', `${adopted}..origin/main`]).split('\n'));
    expect(records).toHaveLength(3);
    for (const record of records) {
      expect(record.ctMs).toBe(Number(git(['show', '-s', '--format=%ct', record.sha])) * 1000);
      expect(record.subject).toBe(git(['show', '-s', '--format=%s', record.sha]));
    }
    expect(() => readHistory('0'.repeat(40))).toThrow();
  });

  it('breaches at five hours and names the clone, merge count, oldest age and the merged PRs', async () => {
    const { results: [result], io } = await run();
    expect(io.mergesSince).toHaveBeenCalledTimes(1);
    expect(io.mergesSince).toHaveBeenCalledWith(MAIN_SHA);
    expect(result.subject).toBe(`daemon-build:${CLONE}`);
    expect(result.breach).toBe(true);
    expect(result.summary).toContain(CLONE);
    expect(result.summary).toMatch(/\b2\s+merge/i);
    expect(result.summary).toMatch(/\b5\s*(?:h\b|hours?\b)/i);
    expect(result.summary).toContain('#6014');
    expect(result.summary).toContain('#6026');
  });

  it('does not count a drain commit whose (#N) is not a merged PR', async () => {
    const commits = [
      ...merges(5 * HOUR),
      { sha: 'e'.repeat(40), ctMs: NOW - 6 * HOUR, subject: 'drain: mark card 5755 resolved on land (#2748)' },
    ];
    const { results: [result] } = await run({ commits });
    expect(result.breach).toBe(true);
    expect(result.summary).toContain('#6014');
    expect(result.summary).not.toContain('#2748');
    expect(result.measure.prs).not.toContain(2748);
    expect(result.measure.behind).toBe(2);
    expect(result.measure.oldestAgeMin).toBe(300);
  });

  it('does not breach for an old drain-only history', async () => {
    const { results: [result] } = await run({ commits: [
      { sha: 'e'.repeat(40), ctMs: NOW - 6 * HOUR, subject: 'drain: mark card resolved (#2748)' },
    ] });
    expect(result.breach).toBe(false);
    expect(result.measure).toMatchObject({ behind: 0, oldestAgeMin: 0, prs: [] });
  });

  it('uses only recent PR merges when an older drain commit is present', async () => {
    const { results: [result] } = await run({ commits: [
      ...merges(30 * MINUTE),
      { sha: 'e'.repeat(40), ctMs: NOW - 6 * HOUR, subject: 'drain: mark card resolved (#2748)' },
    ] });
    expect(result.breach).toBe(false);
    expect(result.measure).toMatchObject({ behind: 2, oldestAgeMin: 30, prs: [6014, 6026] });
  });

  it.each([{ names: [] }, { names: ['unrelated.json'] }])('fails closed when the directory has no rebuild state files: $names', async ({ names }) => {
    const io = {
      listStates: createStateLister({ readdir: () => names, directory: 'state' }),
      mergesSince: vi.fn(),
    };
    const results = await evaluate({}, { now: NOW, io });
    expect(results).toHaveLength(1);
    expect(results[0].breach).toBe(true);
    expect(results[0].summary).toMatch(/state unreadable/i);
    expect(io.mergesSince).not.toHaveBeenCalled();
  });

  it.each(['2h', '7200000', NaN, Infinity, -Infinity, 0, -1, false, {}, []].map(value => ({ value })))(
    'falls back to two hours for an invalid threshold: $value', async ({ value }) => {
      const { results: [result] } = await run({ config: { daemonBuildStaleMaxMs: value } });
      const { results: [recent] } = await run({
        commits: merges(30 * MINUTE), config: { daemonBuildStaleMaxMs: value },
      });
      expect(result.breach).toBe(true);
      expect(recent.breach).toBe(false);
      expect(decide({ states: [{ ...state(), merges: merges(5 * HOUR) }], now: NOW, maxMs: value })[0].breach).toBe(true);
    },
  );

  it('breaches when an individual rebuild state file cannot be read', async () => {
    const io = {
      listStates: createStateLister({
        readdir: () => [`${CLONE}.rebuild.json`], directory: 'state',
        read: () => { throw new Error('file unreadable'); },
      }),
      mergesSince: vi.fn(),
    };
    const results = await evaluate({}, { now: NOW, io });
    expect(results).toHaveLength(1);
    expectUnreadable(results[0]);
    expect(io.mergesSince).not.toHaveBeenCalled();
  });

  it.each(['short', 'g'.repeat(40), `${MAIN_SHA}\n`, `--${MAIN_SHA}`, `${MAIN_SHA}..origin/main`])(
    'rejects malformed adopted.mainSha without invoking git: %j', async (mainSha) => {
      const { results: [result], io } = await run({ states: [state({ mainSha })] });
      expectUnreadable(result);
      expect(io.mergesSince).not.toHaveBeenCalled();
    },
  );

  it('fails closed for an empty injected state listing', async () => {
    const io = { listStates: () => [], mergesSince: vi.fn() };
    const results = await evaluate({}, { now: NOW, io });
    expect(results).toHaveLength(1);
    expect(results[0].breach).toBe(true);
    expect(results[0].summary).toMatch(/state unreadable/i);
  });

  it('fails closed when the state directory itself cannot be read', async () => {
    const readdir = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
    const io = { listStates: createStateLister({ readdir, directory: 'state' }), mergesSince: vi.fn() };
    const results = await evaluate({}, { now: NOW, io });
    expect(results).toHaveLength(1);
    expect(results[0].breach).toBe(true);
    expect(results[0].summary).toMatch(/state unreadable/i);
  });

  it('fails closed when the state directory is missing', async () => {
    const readdir = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
    const io = { listStates: createStateLister({ readdir, directory: 'state' }), mergesSince: vi.fn() };
    const results = await evaluate({}, { now: NOW, io });
    expect(results).toHaveLength(1);
    expect(results[0].breach).toBe(true);
    expect(results[0].summary).toMatch(/state unreadable/i);
  });

  it('does not breach when the oldest missing merge is thirty minutes old', async () => {
    const { results: [result] } = await run({ commits: merges(30 * MINUTE) });
    expect(result.subject).toBe(`daemon-build:${CLONE}`);
    expect(result.breach).toBe(false);
  });

  it('still breaches for an overlay-carrying clone whose adopted mainSha is far behind', async () => {
    const { results: [result], io } = await run({
      states: [state({ mainSha: MAIN_SHA, applied: [{ pr: 5998, sha: 'd'.repeat(40) }] })],
    });
    expect(io.mergesSince).toHaveBeenCalledTimes(1);
    expect(io.mergesSince).toHaveBeenCalledWith(MAIN_SHA);
    expect(result.subject).toBe(`daemon-build:${CLONE}`);
    expect(result.breach).toBe(true);
    expect(result.summary).toContain('#6014');
  });

  it('fails closed as state unreadable for unparseable rebuild JSON', async () => {
    const { results: [result] } = await run({ states: [{ cloneKey: CLONE, raw: '{broken JSON' }] });
    expectUnreadable(result);
  });

  it('fails closed as state unreadable when adopted.mainSha is missing', async () => {
    const { results: [result] } = await run({ states: [state({ applied: [] })] });
    expectUnreadable(result);
  });

  it('fails closed as state unreadable when mergesSince throws for an unknown SHA', async () => {
    const { results: [result], io } = await run({ error: new Error('unknown revision') });
    expect(io.mergesSince).toHaveBeenCalledTimes(1);
    expect(io.mergesSince).toHaveBeenCalledWith(MAIN_SHA);
    expectUnreadable(result);
  });

  it('does not breach when mergesSince returns no missing merges', async () => {
    const { results: [result] } = await run({ commits: [] });
    expect(result.subject).toBe(`daemon-build:${CLONE}`);
    expect(result.breach).toBe(false);
  });

  it('uses a two-hour default threshold', async () => {
    const { results: [under] } = await run({ commits: merges(119 * MINUTE) });
    const { results: [over] } = await run({ commits: merges(121 * MINUTE) });
    expect(under.breach).toBe(false);
    expect(over.breach).toBe(true);
  });

  it('honors ctx.config.daemonBuildStaleMaxMs for shorter and longer thresholds', async () => {
    const { results: [short] } = await run({
      commits: merges(30 * MINUTE), config: { daemonBuildStaleMaxMs: 20 * MINUTE },
    });
    const { results: [long] } = await run({ config: { daemonBuildStaleMaxMs: 6 * HOUR } });
    expect(short.breach).toBe(true);
    expect(long.breach).toBe(false);
  });

  it('exports decide and exposes the required smell shape through the real registry', async () => {
    expect(decide).toBeTypeOf('function');
    expect(daemonBuildStale).toMatchObject({
      id: 'daemon-build-stale', scope: 'host', cadence: 'every-tick',
      probes: [], severity: 'high', action: 'alert', evaluate,
    });
    expect(validateSmellShape(daemonBuildStale, 'daemon-build-stale.mjs')).toBe(daemonBuildStale);
    const { SMELLS } = await import('../index.mjs');
    expect(SMELLS.filter((smell) => smell.id === 'daemon-build-stale')).toEqual([daemonBuildStale]);
  });
});
