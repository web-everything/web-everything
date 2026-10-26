import { expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireWrite, releaseWrite } from '../daemon-clone-lock.mjs';
import { readFastDrainRoundListing, withFastDrainRoundLock } from '../fast-drain-scope.mjs';

it('bounds persistent writer refusal at the default 180-second deadline and logs the live fallback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fast-drain-round-deadline-'));
  const path = join(root, 'round.json');
  const holder = { owner: 'round-writer-holder', lockRoot: `${path}.locks` };
  // Fake only Date: lock filesystem IO and timer scheduling remain real.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-26T12:00:00Z'));
  const start = Date.now();
  try {
    const sleep = vi.fn(async ms => {
      // A missing deadline must fail deterministically instead of spinning forever.
      if (sleep.mock.calls.length > 180) throw new Error('exceeded default writer deadline');
      expect(ms).toBe(1000);
      vi.setSystemTime(Date.now() + ms);
    });
    expect(await acquireWrite(root, holder)).toEqual({ ok: true });
    const row = {
      number: 42, headRefOid: 'old', labels: [{ name: 'ready-to-merge' }],
      baseRefName: 'main', mergeStateStatus: 'CLEAN', statusCheckRollup: [],
    };
    const target = { ...row, state: 'OPEN', headRefOid: 'fresh' };
    const listLive = vi.fn(async () => {
      expect(Date.now() - start).toBe(180_000);
      return [row];
    });
    const readTarget = vi.fn(async () => target);
    const write = vi.fn();
    const log = vi.fn();
    const populate = vi.fn();
    const lockResult = vi.fn();
    const result = await readFastDrainRoundListing({
      path, repo: 'owner/repo', onlyPr: 42, env: {}, read: () => null,
      listLive, readTarget, write, log,
      lock: async fn => {
        const locked = await withFastDrainRoundLock(path, () => { populate(); return fn(); },
          { owner: 'round-writer-contender', sleep });
        lockResult(locked);
        return locked;
      },
    });

    expect(sleep).toHaveBeenCalledTimes(180);
    expect(lockResult).toHaveBeenCalledOnce();
    expect(lockResult).toHaveBeenCalledWith({
      ok: false, reason: 'concurrent-mover', heldBy: holder.owner,
    });
    expect(listLive).toHaveBeenCalledOnce();
    expect(readTarget).toHaveBeenCalledOnce();
    expect(populate).not.toHaveBeenCalled();
    expect(Date.now() - start).toBe(180_000);
    expect(result).toEqual([target]);
    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(path, {
      repo: 'owner/repo', writtenAt: start + 180_000, rows: [row], defaultBranch: null,
    });
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      'fast-drain: listed-live (round listing; TTL=180s, source=standard; cache lock unavailable, live fallback)',
    );
  } finally {
    releaseWrite(root, holder);
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  }
});
