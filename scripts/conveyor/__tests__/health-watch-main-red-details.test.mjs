import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSyncThrottled } from '../../lib/gh-throttle.mjs';
import { runMainRedAlert } from '../health-watch-main-red.mjs';
import { readRunJobs, readFailingTests } from '../main-ci-red-io.mjs';

vi.mock('../../lib/gh-throttle.mjs', async (importOriginal) => ({
  ...await importOriginal(), execFileSyncThrottled: vi.fn(),
}));
vi.mock('../main-ci-red-io.mjs', () => ({
  DEFAULT_REPO_SLUG: 'web-everything/web-everything',
  readRunJobs: vi.fn(),
  readFailingTests: vi.fn(),
  readOpenPrsForOwner: () => [],
}));

beforeEach(() => {
  readRunJobs.mockReset().mockReturnValue({ complete: true, failed: [] });
  readFailingTests.mockReset().mockReturnValue([]);
});

describe('runMainRedAlert — current failure details within a red episode', () => {
  const first = { headSha: 'a'.repeat(40), databaseId: 2, status: 'completed',
    conclusion: 'failure', createdAt: '2026-10-26T12:00:00.000Z' };
  const later = { ...first, headSha: 'b'.repeat(40), databaseId: 3,
    createdAt: '2026-10-26T12:25:00.000Z' };
  const options = () => ({
    probe: { runs: [first] }, now: Date.parse('2026-10-26T12:30:00.000Z'),
    dir: 'unused-injected-state', publish: vi.fn(), readState: () => ({}), writeState: vi.fn(),
  });
  const seed = async () => {
    execFileSyncThrottled.mockReturnValue('[]');
    readRunJobs.mockReturnValue({ complete: true, failed: [{ id: 20, name: 'unit' }] });
    readFailingTests.mockReturnValue(['unit > fails']);
    return runMainRedAlert(options());
  };

  it('reads a later failing run for integration details while retaining the first red timestamp and SHA', async () => {
    const red = await seed();
    readRunJobs.mockReturnValue({ complete: true, failed: [{ id: 30, name: 'integration' }] });
    readFailingTests.mockReturnValue(['integration > fails']);
    const changed = await runMainRedAlert({ ...options(), probe: { runs: [later, first] },
      readState: () => red.next });
    expect(readRunJobs.mock.calls.map(([id]) => id)).toEqual([2, 3]);
    expect(readFailingTests.mock.calls.map(([id]) => id)).toEqual([20, 30]);
    expect(changed.items).toEqual([expect.objectContaining({ kind: 'main-red',
      failingJobs: ['integration'], firstFailingTest: 'integration > fails',
      firstRedSha: first.headSha, since: first.createdAt })]);
    expect(changed.next.fingerprint).not.toBe(red.next.fingerprint);
  });

  it.each(['empty annotations', 'no failing jobs', 'unavailable annotations', 'unavailable jobs', 'incomplete jobs'])(
    '%s clears an observed absence and carries only unavailable test details', async (observation) => {
      const red = await seed();
      if (observation === 'empty annotations') readFailingTests.mockReturnValue([]);
      if (observation === 'no failing jobs') readRunJobs.mockReturnValue({ complete: true, failed: [] });
      if (observation === 'unavailable annotations') readFailingTests.mockImplementation(() => { throw new Error('unavailable'); });
      if (observation === 'unavailable jobs') readRunJobs.mockImplementation(() => { throw new Error('unavailable'); });
      if (observation === 'incomplete jobs') readRunJobs.mockReturnValue({ complete: false, failed: [] });
      const result = await runMainRedAlert({ ...options(), readState: () => red.next });
      const observedEmpty = ['empty annotations', 'no failing jobs'].includes(observation);
      expect(result.next.fingerprintParts.firstFailingTest).toBe(observedEmpty ? null : 'unit > fails');
      expect(result.items.map(item => item.kind)).toEqual(observedEmpty ? ['main-red'] : []);
    },
  );
});

describe('runMainRedAlert — bounded ready PR count', () => {
  it.each([[{ number: 2 }], [{ number: 2, labels: null }]])('keeps blockedReadyPrs null when a PR row has no readable labels (%j)', async (bad) => {
    execFileSyncThrottled.mockReset();
    execFileSyncThrottled.mockReturnValue(JSON.stringify([{ number: 1, labels: [{ name: 'ready-to-merge' }] }, bad]));
    const publish = vi.fn();
    await runMainRedAlert({
      probe: { runs: [{ headSha: 'a'.repeat(40), databaseId: 2,
        status: 'completed', conclusion: 'failure', createdAt: '2026-10-26T12:00:00.000Z' }] },
      now: Date.parse('2026-10-26T12:30:00.000Z'), dir: 'unused-injected-state',
      publish, readState: () => ({}), writeState: vi.fn(),
    });
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ kind: 'main-red', blockedReadyPrs: null }));
  });

  it('counts only PRs carrying the ready-to-merge label (client-side, no search-backed --label)', async () => {
    execFileSyncThrottled.mockReset();
    execFileSyncThrottled.mockReturnValue(JSON.stringify([
      { number: 1, labels: [{ name: 'ready-to-merge' }] }, { number: 2, labels: [{ name: 'other' }] }, { number: 3, labels: [] },
    ]));
    const publish = vi.fn();
    await runMainRedAlert({
      probe: { runs: [{ headSha: 'a'.repeat(40), databaseId: 2,
        status: 'completed', conclusion: 'failure', createdAt: '2026-10-26T12:00:00.000Z' }] },
      now: Date.parse('2026-10-26T12:30:00.000Z'), dir: 'unused-injected-state',
      publish, readState: () => ({}), writeState: vi.fn(),
    });
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ kind: 'main-red', blockedReadyPrs: 1 }));
  });

  it.each([
    ['counts an empty complete page', 0, 0],
    ['counts fewer than 200 results', 199, 199],
    ['keeps blockedReadyPrs null for a full page of 200 results', 200, null],
  ])('%s', async (_name, count, expected) => {
    execFileSyncThrottled.mockReset();
    execFileSyncThrottled.mockReturnValue(JSON.stringify(
      Array.from({ length: count }, (_, index) => ({ number: index + 1, labels: [{ name: 'ready-to-merge' }, { name: 'x' }] })),
    ));
    const publish = vi.fn();
    await runMainRedAlert({
      probe: { runs: [{ headSha: 'a'.repeat(40), databaseId: 2,
        status: 'completed', conclusion: 'failure', createdAt: '2026-10-26T12:00:00.000Z' }] },
      now: Date.parse('2026-10-26T12:30:00.000Z'), dir: 'unused-injected-state',
      publish, readState: () => ({}), writeState: vi.fn(),
    });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'main-red', blockedReadyPrs: expected,
    }));
    expect(execFileSyncThrottled).toHaveBeenCalledTimes(1);
    expect(execFileSyncThrottled).toHaveBeenCalledWith('gh', [
      'pr', 'list', '--repo', 'web-everything/web-everything', '--state', 'open',
      '--json', 'number,labels', '--limit', '200',
    ], expect.objectContaining({ maxBuffer: expect.any(Number), timeout: expect.any(Number) }));
  });
});
