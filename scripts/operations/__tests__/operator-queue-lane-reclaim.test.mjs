/**
 * @file scripts/operations/__tests__/operator-queue-lane-reclaim.test.mjs
 * @description Proof of #3383's "needs your decision" lane-reclaim feed on `operator-queue.mjs`:
 * `laneReclaimQueue` shells out to `lane-whois.mjs --json` and surfaces only the two verdicts worth the
 * operator's time, degrading to `[]` on any failure — never breaking the PR-queue report it rides beside.
 * `--with-lanes` gates it OFF by default (see that flag's own comment in `operator-queue.mjs`) so the many
 * existing `main()` tests that replace the whole `node:child_process` module keep their exact gh-call
 * sequencing untouched.
 */
import { describe, it, expect } from 'vitest';
import { laneReclaimQueue } from '../operator-queue.mjs';

describe('laneReclaimQueue', () => {
  it('filters a real whois report down to finished-needs-review / unknown-work rows', () => {
    const fakeReport = {
      lanes: [
        { exists: true, lane: 1, path: '/p/lane-1', verdict: 'in-use', reason: 'x' },
        { exists: true, lane: 2, path: '/p/lane-2', verdict: 'finished-reclaimable', reason: 'x' },
        { exists: true, lane: 3, path: '/p/lane-3', verdict: 'finished-needs-review', reason: 'not preserved' },
        { exists: true, lane: 4, path: '/p/lane-4', verdict: 'unknown-work', reason: 'no card/PR' },
        { exists: false, lane: 5, path: '/p/lane-5' },
      ],
    };
    const exec = (file, args) => {
      expect(file).toBe('node');
      expect(args[0]).toMatch(/lane-whois\.mjs$/);
      expect(args[1]).toBe('--json');
      return JSON.stringify(fakeReport);
    };
    expect(laneReclaimQueue({ exec })).toEqual([
      { lane: 3, path: '/p/lane-3', verdict: 'finished-needs-review', reason: 'not preserved' },
      { lane: 4, path: '/p/lane-4', verdict: 'unknown-work', reason: 'no card/PR' },
    ]);
  });

  it('degrades to [] — never throws — when the subprocess fails (no pool, no lane-whois.mjs sibling, etc.)', () => {
    const exec = () => { throw new Error('spawn node ENOENT'); };
    expect(laneReclaimQueue({ exec })).toEqual([]);
  });

  it('degrades to [] on unparsable output too', () => {
    expect(laneReclaimQueue({ exec: () => 'not json' })).toEqual([]);
  });

  it('gives the subprocess a genuinely long timeout — a full-pool scan measured live at 9+ minutes', () => {
    // Regression: this call originally carried a 60s timeout, which silently killed the subprocess long before
    // a real ~65-lane pool scan finishes (measured live at 9m07s) and degraded every real run to `[]` — never
    // an error, just wrong. `laneDecisions` read empty in production for exactly this reason before the fix.
    let seenOpts;
    const exec = (file, args, opts) => { seenOpts = opts; return '{"lanes":[]}'; };
    laneReclaimQueue({ exec });
    expect(seenOpts.timeout).toBeGreaterThanOrEqual(10 * 60_000);
  });
});
