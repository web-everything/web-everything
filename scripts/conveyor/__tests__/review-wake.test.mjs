// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { homedir } from 'node:os';
import * as promotion from '../draft-promotion-loop.mjs';
import * as daemon from '../../../skills-src/conveyor/review-daemon.mjs';

// No host files or wall-clock waits: the filesystem only records the observable wake mtime.
const memoryFs = (now) => {
  const files = new Map();
  const fs = {
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(path => files.set(path, { mtimeMs: now() })),
    utimesSync: vi.fn((path, _atime, mtime) => {
      if (!files.has(path)) throw new Error('ENOENT');
      files.set(path, { mtimeMs: mtime instanceof Date ? mtime.getTime() : mtime * 1000 });
    }),
    statSync: vi.fn(path => {
      if (!files.has(path)) throw new Error('ENOENT');
      return files.get(path);
    }),
  };
  return { fs, files };
};

describe('review wake file', () => {
  const dir = join('fixture-locks', 'runner');

  it('creates and updates review-wake so a newer promotion can wake a later sleep', () => {
    let nowMs = 10_000;
    const { fs, files } = memoryFs(() => nowMs);
    expect(promotion.touchReviewWake({ dir, fs, now: () => nowMs })).toBe(true);
    expect(files.has(join(dir, 'review-wake'))).toBe(true);
    expect(promotion.hasReviewWakeSince(9_999, { dir, fs })).toBe(true);
    nowMs = 20_000;
    expect(promotion.touchReviewWake({ dir, fs, now: () => nowMs })).toBe(true);
    expect(promotion.hasReviewWakeSince(15_000, { dir, fs })).toBe(true);
  });

  it('uses the shared runner-lock directory by default without touching the host filesystem', () => {
    const { fs, files } = memoryFs(() => 10_000);
    expect(promotion.touchReviewWake({ fs, now: () => 10_000 })).toBe(true);
    expect(files.has(join(homedir(), '.claude', 'conveyor-runner-locks', 'review-wake'))).toBe(true);
    expect(promotion.hasReviewWakeSince(9_999, { fs })).toBe(true);
  });

  it('fails closed when review-wake is missing', () => {
    const { fs } = memoryFs(() => 10_000);
    expect(promotion.hasReviewWakeSince(0, { dir, fs })).toBe(false);
  });

  it('fails closed when review-wake cannot be read', () => {
    const fs = { statSync: vi.fn(() => { throw new Error('EACCES'); }) };
    expect(promotion.hasReviewWakeSince(0, { dir, fs })).toBe(false);
    expect(fs.statSync).toHaveBeenCalledTimes(1);
  });

  it.each([9_999, 10_000, 10_001])('requires mtime %s to be strictly newer than the sleep start', mtimeMs => {
    const { fs, files } = memoryFs(() => mtimeMs);
    files.set(join(dir, 'review-wake'), { mtimeMs });
    expect(promotion.hasReviewWakeSince(10_000, { dir, fs })).toBe(mtimeMs > 10_000);
  });

  it('returns false without throwing when the wake directory is unwritable', () => {
    const { fs, files } = memoryFs(() => 10_000);
    // Existing file exercises timestamp-update paths as well as file-creation paths.
    files.set(join(dir, 'review-wake'), { mtimeMs: 1 });
    // Refuse every mutation so either valid touch strategy encounters the same failure.
    for (const method of ['mkdirSync', 'writeFileSync', 'utimesSync']) {
      fs[method].mockImplementation(() => { throw new Error('EACCES'); });
    }
    expect(promotion.touchReviewWake({ dir, fs, now: () => 10_000 })).toBe(false);
    expect(promotion.hasReviewWakeSince(1, { dir, fs })).toBe(false);
  });
});

describe('withReviewWake interruptible sleep', () => {
  afterEach(() => vi.useRealTimers());

  // poll is the wake predicate, sinceFn supplies the clock, effects.sleep advances that clock.
  const setup = ({ mtimeMs = null, onSleep = () => {}, pollEveryMs = 5_000 } = {}) => {
    let nowMs = 100_000;
    const start = nowMs;
    const dir = 'fixture-locks';
    const { fs, files } = memoryFs(() => nowMs);
    if (mtimeMs !== null) files.set(join(dir, 'review-wake'), { mtimeMs });
    const sleep = vi.fn(async ms => {
      expect(ms).toBeGreaterThan(0);
      nowMs += ms;
      onSleep({ files, nowMs, calls: sleep.mock.calls.length, path: join(dir, 'review-wake') });
    });
    const tickOnce = vi.fn();
    const poll = vi.fn(sinceMs => promotion.hasReviewWakeSince(sinceMs, { dir, fs }));
    const effects = { sleep, tickOnce, intervalMs: 120_000 };
    const wrapped = daemon.withReviewWake(effects, { poll, pollEveryMs, sinceFn: () => nowMs });
    return { wrapped, effects, sleep, poll, start, elapsed: () => nowMs - start };
  };

  it('returns normally within one poll after a newer wake arrives during sleep', async () => {
    const run = setup({ onSleep: ({ files, nowMs, calls, path }) => {
      if (calls === 2) files.set(path, { mtimeMs: nowMs });
    } });
    await expect(run.wrapped.sleep(120_000)).resolves.toBeUndefined();
    expect(run.elapsed()).toBeGreaterThanOrEqual(10_000);
    expect(run.elapsed()).toBeLessThanOrEqual(15_000);
    expect(run.poll.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(run.poll.mock.calls.every(([since]) => since === run.start)).toBe(true);
    expect(run.wrapped.tickOnce).toBe(run.effects.tickOnce);
  });

  it.each([['missing', null], ['older', 99_999], ['equal', 100_000]])(
    'sleeps the full interval with a %s wake, including the final partial poll', async (_, mtimeMs) => {
      const run = setup({ mtimeMs });
      await run.wrapped.sleep(12_345);
      expect(run.elapsed()).toBe(12_345);
      expect(run.sleep.mock.calls.every(([ms]) => ms <= 5_000)).toBe(true);
      expect(run.sleep.mock.calls.reduce((sum, [ms]) => sum + ms, 0)).toBe(12_345);
      expect(run.poll).toHaveBeenCalled();
    },
  );

  it('does not reuse a previous sleep start and wake repeatedly for the same file', async () => {
    const run = setup({ onSleep: ({ files, nowMs, calls, path }) => {
      if (calls === 1) files.set(path, { mtimeMs: nowMs });
    } });
    await run.wrapped.sleep(120_000);
    const firstElapsed = run.elapsed();
    expect(firstElapsed).toBeLessThanOrEqual(5_000);
    await run.wrapped.sleep(12_345);
    expect(run.elapsed() - firstElapsed).toBe(12_345);
  });

  it('defaults to polling within five seconds using the default clock', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    let wakeMtime = 0;
    const poll = vi.fn(since => wakeMtime > since);
    const sleep = vi.fn(ms => new Promise(resolve => setTimeout(resolve, ms)));
    const wrapped = daemon.withReviewWake({ sleep }, { poll });
    const finished = vi.fn();
    const sleeping = wrapped.sleep(120_000).then(finished);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(finished).not.toHaveBeenCalled();
    wakeMtime = Date.now();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(finished).toHaveBeenCalledTimes(1);
    await sleeping;
  });
});
