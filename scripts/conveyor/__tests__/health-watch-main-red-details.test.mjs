import { describe, expect, it, vi } from 'vitest';
import { execFileSyncThrottled } from '../../lib/gh-throttle.mjs';
import { runMainRedAlert } from '../health-watch-main-red.mjs';

vi.mock('../../lib/gh-throttle.mjs', async (importOriginal) => ({
  ...await importOriginal(), execFileSyncThrottled: vi.fn(),
}));
vi.mock('../main-ci-red-io.mjs', () => ({
  DEFAULT_REPO_SLUG: 'web-everything/web-everything',
  readRunJobs: () => ({ complete: true, failed: [] }),
  readFailingTests: () => [],
  readOpenPrsForOwner: () => [],
}));

describe('runMainRedAlert — bounded ready PR count', () => {
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
