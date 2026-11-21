/** @file The live-owner watchdog retries a transient PR-list failure with backoff before failing closed. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLiveOwnerWatchIo } from '../pr-live-owner-watch-io.mjs';

const NOW = Date.parse('2026-11-10T18:00:00Z');
const REPO = 'web-everything/web-everything';
const pr = () => ({ number: 863, headRefOid: 'a'.repeat(40), labels: [], isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: [] });
const transient = () => Object.assign(Error('spawnSync gh ETIMEDOUT'), { code: 'ETIMEDOUT' });
const dirs = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

async function makeIo(adapters, extraEnv = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'live-owner-retry-')); dirs.push(dir);
  writeFileSync(join(dir, 'platform.json'), '{}');
  const env = { GH_REPO: REPO, WE_PLATFORM_PREFERENCES_FILE: join(dir, 'platform.json'),
    WE_COORDINATION_ROOT: join(dir, 'coordination'), WE_LIVE_OWNER_WATCH_DIR: join(dir, 'watch'),
    WE_NEEDS_YOU_FEED: join(dir, 'feed.jsonl'), WE_POLICY_CASCADE_LOG: '0', ...extraEnv };
  return createLiveOwnerWatchIo({ env, home: dir, root: dir, now: NOW, adapters: {
    lockOptions: { stamp: () => ({ runnerStart: 'fixture-birth' }), identity: () => ({ alive: true }) }, ...adapters } });
}

describe('watchdog retries PR list with backoff before evidence-unavailable', () => {
  it('watchdog retries PR list with backoff before evidence-unavailable: recovers after two failures', async () => {
    const readGhText = vi.fn().mockImplementationOnce(() => { throw transient(); })
      .mockImplementationOnce(() => { throw transient(); }).mockReturnValueOnce(JSON.stringify([pr()]));
    const sleepMs = vi.fn();
    const io = await makeIo({ readGhText, sleepMs });
    expect(io.listPRs()).toEqual([{ ...pr(), repo: REPO }]);
    expect(readGhText).toHaveBeenCalledTimes(3);
    expect(sleepMs.mock.calls.map(c => c[0])).toEqual([1000, 4000]);
  });
  it('three consecutive failures still raise, fail closed', async () => {
    const readGhText = vi.fn(() => { throw transient(); });
    const io = await makeIo({ readGhText, sleepMs: vi.fn() });
    expect(() => io.listPRs()).toThrow(/PR list unavailable after 2 retries.*ETIMEDOUT/);
    expect(readGhText).toHaveBeenCalledTimes(3);
  });
  it('a non-transient error (auth, 4xx) raises at once without sleeping', async () => {
    for (const msg of ['HTTP 401: Bad credentials', 'HTTP 403: forbidden', 'HTTP 404: Not Found', 'HTTP 410: Gone',
      'Unexpected token < in JSON at position 0', 'unrecognized permanent gh failure']) {
      const readGhText = vi.fn(() => { throw Error(msg); });
      const sleepMs = vi.fn();
      const io = await makeIo({ readGhText, sleepMs });
      expect(() => io.listPRs()).toThrow(msg);
      expect(readGhText).toHaveBeenCalledTimes(1);
      expect(sleepMs).not.toHaveBeenCalled();
    }
  });
  it('the retry never exceeds the tick budget', async () => {
    const readGhText = vi.fn(() => { throw transient(); });
    const sleepMs = vi.fn();
    const io = await makeIo({ readGhText, sleepMs }, { WE_LIVE_OWNER_WATCH_CONFIG: JSON.stringify({ tickBudgetMs: 3000 }) });
    expect(() => io.listPRs()).toThrow(/tick budget/);
    // 1 s fits the 3 s budget; the 4 s second backoff (plus margin) does not, so it is never slept.
    expect(sleepMs.mock.calls.map(c => c[0])).toEqual([1000]);
    expect(readGhText).toHaveBeenCalledTimes(2);
  });
});
