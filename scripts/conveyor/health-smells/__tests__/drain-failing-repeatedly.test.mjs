/**
 * @file scripts/conveyor/health-smells/__tests__/drain-failing-repeatedly.test.mjs
 * @description The PURE `evaluate()` of the `drain-failing-repeatedly` smell over real-shaped gh-throttle
 *   `calls.jsonl` entries, reproducing the 2026-09-27 ~04:04-04:33Z window where the drain's own `gh` calls
 *   (`merge-ai-prs.mjs`) failed pass after pass with a bare `gh-error`, distinct from the host-wide aggregate
 *   `gh-call-failures.mjs` already covers (that smell fires on ANY caller; this one only on the drain's own).
 */
import { describe, it, expect } from 'vitest';
import drainFailingRepeatedly, { drainFailureStreak, DRAIN_CALLERS } from '../drain-failing-repeatedly.mjs';
import { emptyHealthState, stepEpisodes, planActions, runHealthTick } from '../../health-watch-core.mjs';
import { SMELLS } from '../index.mjs';

const NOW = Date.parse('2026-09-27T04:33:00Z');
const at = (minAgo) => new Date(NOW - minAgo * 60_000).toISOString();

function healthy() {
  const out = [];
  for (let i = 0; i < 20; i += 1) out.push({ ts: at(i), op: 'pr list', outcome: 'call', ok: true, caller: 'merge-ai-prs.mjs' });
  return out;
}

/** The live 2026-09-27 ~04:04-04:33Z shape: the drain's own calls all fail with a bare gh-error, while OTHER
 *  callers (parked-pr-conflict-watch, review-daemon reads, …) mostly succeed and are interleaved — plenty of
 *  them, on purpose: this smell must fire on the DRAIN'S OWN streak regardless of the host-wide aggregate
 *  ratio, which stays well under `gh-call-failures`'s own 0.4 threshold here (12 failed of 60 total, 0.2) —
 *  proving this is a genuinely distinct, narrower signal, not a duplicate of that smell. */
function incident() {
  const out = [];
  for (let i = 0; i < 12; i += 1) out.push({ ts: at(i), op: 'pr list', outcome: 'call', ok: false, caller: 'merge-ai-prs.mjs' });
  for (let i = 0; i < 48; i += 1) out.push({ ts: at(i % 29), op: 'pr view', outcome: 'call', ok: true, caller: 'parked-pr-conflict-watch-we' });
  return out;
}

describe('drainFailureStreak', () => {
  it('is zero on healthy drain traffic', () => {
    expect(drainFailureStreak(healthy(), { now: NOW }).streak).toBe(0);
  });

  it('counts only the TRAILING consecutive failures, resetting at the first success (most-recent-first)', () => {
    const entries = [
      { ts: at(10), op: 'pr list', outcome: 'call', ok: false, caller: 'merge-ai-prs.mjs' }, // outside the streak (older than a success)
      { ts: at(4), op: 'pr list', outcome: 'call', ok: true, caller: 'merge-ai-prs.mjs' },   // the reset point
      { ts: at(3), op: 'pr list', outcome: 'call', ok: false, caller: 'merge-ai-prs.mjs' },
      { ts: at(2), op: 'pr list', outcome: 'call', ok: false, caller: 'merge-ai-prs.mjs' },
      { ts: at(1), op: 'pr list', outcome: 'call', ok: false, caller: 'merge-ai-prs.mjs' },
    ];
    expect(drainFailureStreak(entries, { now: NOW }).streak).toBe(3);
  });

  it('ignores calls from callers that are not the drain', () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({ ts: at(i), op: 'pr list', outcome: 'call', ok: false, caller: 'review-round-tag' }));
    expect(drainFailureStreak(entries, { now: NOW }).streak).toBe(0);
  });

  it('ignores retry_exhausted / fail_open lines (not a `call` outcome)', () => {
    const entries = [{ ts: at(1), op: 'pr list', outcome: 'retry_exhausted', caller: 'merge-ai-prs.mjs' }];
    expect(drainFailureStreak(entries, { now: NOW }).streak).toBe(0);
  });

  it('recognizes both drain callers (merge-ai-prs.mjs and pr-land.mjs)', () => {
    expect(DRAIN_CALLERS.has('merge-ai-prs.mjs')).toBe(true);
    expect(DRAIN_CALLERS.has('pr-land.mjs')).toBe(true);
  });
});

describe('drain-failing-repeatedly — evaluate()', () => {
  it('stays quiet on normal traffic', () => {
    const [r] = drainFailingRepeatedly.evaluate({ ghCalls: healthy() }, { now: NOW });
    expect(r.breach).toBe(false);
  });

  it('breaches on the 2026-09-27 04:04-04:33Z incident shape (12 consecutive drain gh-error calls)', () => {
    const [r] = drainFailingRepeatedly.evaluate({ ghCalls: incident() }, { now: NOW });
    expect(r.breach).toBe(true);
    expect(r.measure.streak).toBe(12);
    expect(r.subject).toBe('drain');
    expect(r.summary).toMatch(/12 consecutive failed gh call/);
  });

  it('does not breach just under the streak threshold', () => {
    const entries = Array.from({ length: 4 }, (_, i) => ({ ts: at(i), op: 'pr list', outcome: 'call', ok: false, caller: 'merge-ai-prs.mjs' }));
    const [r] = drainFailingRepeatedly.evaluate({ ghCalls: entries }, { now: NOW });
    expect(r.breach).toBe(false);
  });
});

// ── Replay proof: the real SMELLS registry + runHealthTick, exactly the shape a live health tick would see ────

describe('replay — 2026-09-27 ~04:04-04:33Z drain gh-error window, through the real pipeline', () => {
  it('opens exactly one episode and plans exactly one un-suppressed notify, in shadow mode, via the real notify-list', () => {
    // Keep the real detector, with a healthy host fixture independent of local daemon state.
    const smells = SMELLS.map((s) => s.id === 'daemon-build-stale'
      ? { ...s, evaluate: (probes, ctx) => s.evaluate(probes, { ...ctx, io: {
        listStates: () => [{ cloneKey: 'fixture-daemon', raw: JSON.stringify({ adopted: { mainSha: 'a'.repeat(40) } }) }],
        mergesSince: () => [],
      } }) }
      : s);
    const tick1 = runHealthTick(emptyHealthState(), { ghCalls: incident() }, smells, NOW, { config: { mode: 'shadow' } });
    const notifies = tick1.plan.filter((p) => p.kind === 'notify');
    const drainNotify = notifies.find((p) => p.key === 'drain-failing-repeatedly::drain');
    expect(drainNotify).toBeDefined();
    expect(drainNotify.suppressed).toBeNull(); // un-suppressed — this is the one that would actually page

    // Every OTHER notify this tick (if any) must stay suppressed — this replay names exactly one live page.
    const unsuppressed = notifies.filter((p) => p.suppressed == null);
    expect(unsuppressed).toHaveLength(1);
    expect(unsuppressed[0].key).toBe('drain-failing-repeatedly::drain');
  });
});
