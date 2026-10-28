import { describe, expect, it, vi } from 'vitest';
import daemonBuildStale, { decide, evaluate } from '../daemon-build-stale.mjs';
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
