import { describe, it, expect } from 'vitest';
import b from './rebuild-evidence-compatibility.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
import { probeLegacyReadyAdmission, probeStalePinnedReady } from '../fixtures/rebuild-evidence-probe.mjs';

it.each(['candidate', 'fallback'])('adopts legacy ready %s without a forced field after upgrade', async kind => {
  expect(await probeLegacyReadyAdmission(kind)).toMatchObject({
    adopted: true, match: kind === 'candidate' ? 'exact' : 'fallback', forced: false,
    preserved: true, jobs: 0, reattachments: 0,
  });
});

describe('real Git persisted evidence recovery', () => { defineBreakTest(b); }, 60_000);
it.each([
  ['fast-forward', true, false, false, 0],
  ['rewrite retaining the applied sha', false, true, true, 1],
])('persisted ready evidence after %s preserves the admission policy', async (_kind, fastForward, discarded, freshHead, smokes) => {
  expect(await probeStalePinnedReady({ fastForward })).toMatchObject({
    adopted: true, readyCleared: true, heldTipExcluded: true, discarded, freshHead, smokes,
  });
}, 60_000);
it('adopts audited pins while holding unaudited tips and recovers stale pins, torn tick evidence and abandoned worktrees', async () => {
  expect(b.judge(await b.run())).toEqual([]);
}, 60_000);
