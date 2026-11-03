/**
 * @file R492 (B) — the review daemon's RSS is bounded: past a ceiling the loop returns `rss-recycle` between ticks
 *   (so launchd restarts it); under it, or with the ceiling off, the loop is unchanged.
 */
import { describe, it, expect } from 'vitest';
import { runDaemonLoop, resolveMaxRssMb, shouldRecycleForRss, DEFAULT_MAX_RSS_MB } from '../review-daemon.mjs';

const MB = 1024 * 1024;
describe('rss ceiling', () => {
  it('defaults to 3072 MB, honours the env, 0 disables, junk falls back', () => {
    expect(resolveMaxRssMb({})).toBe(DEFAULT_MAX_RSS_MB);
    expect(resolveMaxRssMb({ WE_REVIEW_DAEMON_MAX_RSS_MB: '1500' })).toBe(1500);
    expect(resolveMaxRssMb({ WE_REVIEW_DAEMON_MAX_RSS_MB: 'x' })).toBe(DEFAULT_MAX_RSS_MB);
    expect(shouldRecycleForRss(10_000 * MB, { WE_REVIEW_DAEMON_MAX_RSS_MB: '0' })).toBe(false);
    expect(shouldRecycleForRss(3000 * MB, {})).toBe(false);
    expect(shouldRecycleForRss(3200 * MB, {})).toBe(true);
  });
  it('a growing process is recycled: the loop stops, the sleep is not entered', async () => {
    let rss = 1000 * MB, ticks = 0, slept = 0;
    const out = await runDaemonLoop({
      tickOnce: async () => { ticks += 1; rss += 800 * MB; }, // the tick grows the process
      sleep: async () => { slept += 1; },
      shouldRecycle: () => shouldRecycleForRss(rss, {}),
      maxTicks: 50,
    });
    expect(out.stoppedReason).toBe('rss-recycle');
    expect(ticks).toBe(3); // 1000 -> 1800 -> 2600 -> 3400 > 3072
    expect(slept).toBe(2);
  });
  it('a flat process keeps looping to maxTicks', async () => {
    const out = await runDaemonLoop({ tickOnce: async () => {}, sleep: async () => {}, shouldRecycle: () => shouldRecycleForRss(500 * MB, {}), maxTicks: 4 });
    expect(out).toMatchObject({ ticks: 4, stoppedReason: 'max-ticks' });
  });
});
