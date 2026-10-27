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
  it.each([
    ['counts an empty complete page', 0, 0],
    ['counts fewer than 100 results', 99, 99],
    ['keeps blockedReadyPrs null for a full page of 100 results', 100, null],
  ])('%s', async (_name, count, expected) => {
    execFileSyncThrottled.mockReset();
    execFileSyncThrottled.mockReturnValue(JSON.stringify(
      Array.from({ length: count }, (_, index) => ({ number: index + 1 })),
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
      '--label', 'ready-to-merge', '--json', 'number', '--limit', '100',
    ], expect.objectContaining({ maxBuffer: expect.any(Number), timeout: expect.any(Number) }));
  });
});
