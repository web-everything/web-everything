import { expect, it, vi } from 'vitest';
import { archiveRetentionTickAllowed } from '../health-watch.mjs';
import { runArchiveRetentionTick } from '../archive-retention-tick.mjs';
it('retention is scheduled for live health ticks', () => { expect(archiveRetentionTickAllowed({})).toBe(true); });
it.each(['state-root', 'dry-run', 'logs-dir', 'lock-root', 'tmp-sweep-root', 'claude-jobs-root', 'no-gh', 'future-fixture'])('retention never touches host files in %s ticks', async flag => {
  expect(archiveRetentionTickAllowed({ [flag]: true })).toBe(false);
  const archive = vi.fn();
  expect(await runArchiveRetentionTick({ flags: { [flag]: true }, archive })).toEqual({ results: [], error: null });
  expect(archive).not.toHaveBeenCalled();
});

it('archives runs and sessions sequentially with the tick clock and logger', async () => {
  const results = [{ kind: 'runs', errors: [] }, { kind: 'sessions', errors: ['Drive unavailable'] }];
  let finishedRuns = false;
  const archive = vi.fn(async ({ kind }) => {
    if (kind === 'runs') { await Promise.resolve(); finishedRuns = true; return results[0]; }
    expect(finishedRuns).toBe(true);
    return results[1];
  });
  const log = vi.fn();
  const now = Date.parse('2026-10-29T12:00:00Z');
  expect(await runArchiveRetentionTick({ now, archive, log })).toEqual({ results, error: 'Drive unavailable' });
  expect(archive.mock.calls).toEqual([
    [{ kind: 'runs', now, log }], [{ kind: 'sessions', now, log }],
  ]);
});

it('propagates archive failures to the health tick probe error handler', async () => {
  const archive = vi.fn().mockRejectedValue(new Error('Drive unavailable'));
  await expect(runArchiveRetentionTick({ archive })).rejects.toThrow('Drive unavailable');
  expect(archive).toHaveBeenCalledTimes(1);
});
