import { expect, it } from 'vitest';
import { archiveRetentionTickAllowed } from '../health-watch.mjs';
it('retention is scheduled for live health ticks', () => { expect(archiveRetentionTickAllowed({})).toBe(true); });
it.each(['state-root', 'dry-run', 'logs-dir', 'lock-root', 'tmp-sweep-root', 'claude-jobs-root', 'no-gh', 'future-fixture'])('retention never touches host files in %s ticks', flag => {
  expect(archiveRetentionTickAllowed({ [flag]: true })).toBe(false);
});
