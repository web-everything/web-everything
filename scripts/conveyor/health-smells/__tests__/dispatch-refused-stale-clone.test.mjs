/**
 * @file scripts/conveyor/health-smells/__tests__/dispatch-refused-stale-clone.test.mjs
 * @description xpinskip — the `dispatch-refused-stale-clone` sign, fed the REAL fix-dispatch-daemon log lines from
 *   the 2026-09-26 23:39 ET freeze (pinned #2768 conflict → clone 2 commits behind → every repo refused as
 *   stale) through the real `foldDaemonMemory`, plus the real alert shape from the clone's alerts.jsonl.
 */
import { describe, it, expect } from 'vitest';
import { foldDaemonMemory } from '../../health-watch-core.mjs';
import smell, { staleStreak, latestRebuildBlock } from '../dispatch-refused-stale-clone.mjs';

const MINUTE = 60_000;
const T0 = Date.parse('2026-09-26T23:39:00Z');

const STALE_TICK = [
  'reconcile-fix-dispatch-daemon: tick (web-everything/web-everything, frontier-ui/frontierui, plateauapp/plateau-app) — dispatched 0, refused 11',
  'reconcile-fix-dispatch-daemon: web-everything/web-everything tick failed (non-fatal, other repos unaffected): review-dispatch: the dispatching checkout is 2 commit(s) behind origin/main — refusing to dispatch a review that would run STALE code from this checkout\'s own import path (#3439).',
  'reconcile-fix-dispatch-daemon: frontier-ui/frontierui tick failed (non-fatal, other repos unaffected): review-dispatch: the dispatching checkout is 2 commit(s) behind origin/main — refusing to dispatch a review that would run STALE code from this checkout\'s own import path (#3439).',
  'reconcile-fix-dispatch-daemon: refused main-still-red web-everything/web-everything PR #2778 — main\'s own CI is still red right now',
].join('\n');
const GOOD_TICK = 'reconcile-fix-dispatch-daemon: tick (web-everything/web-everything) — dispatched 1, refused 0';

function feed(chunks) {
  let mem;
  let size = 0;
  chunks.forEach(({ text, at }) => {
    size += text.length + 1;
    mem = foldDaemonMemory(mem, { name: 'fix-dispatch-daemon', mtimeMs: at, sizeBytes: size, text: `${text}\n`, bootstrap: false }, at);
  });
  return mem;
}

const pinnedAlert = {
  at: T0 - MINUTE,
  kind: 'pinned-overlay-conflict',
  detail: { ref: 'lane/fix-rebuild-finalize', pr: 2768, dropReason: 'conflict', pinnedBy: 'mechanism' },
};

describe('dispatch-refused-stale-clone', () => {
  it('opens after 10+ minutes of stale refusals and names the pinned overlay blocking the rebuild', () => {
    const chunks = Array.from({ length: 7 }, (_, i) => ({ text: STALE_TICK, at: T0 + i * 2 * MINUTE }));
    const mem = feed(chunks);
    expect(staleStreak(mem.recentTicks).ticks).toBe(7);
    const now = T0 + 12 * MINUTE;
    const [r] = smell.evaluate({ selfSync: [{ cloneKey: '206df80ef82e6401', alerts: [pinnedAlert] }] }, { now, daemons: { 'fix-dispatch-daemon': mem } });
    expect(r.breach).toBe(true);
    expect(r.summary).toMatch(/refused ALL dispatch/);
    expect(r.summary).toContain('pinned-overlay-conflict lane/fix-rebuild-finalize (PR #2768)');
    expect(r.recommendation).toMatch(/Rebase that overlay's branch/);
  });

  it('stays quiet under 10 minutes, and a productive tick resets the streak', () => {
    const short = feed([{ text: STALE_TICK, at: T0 }, { text: STALE_TICK, at: T0 + 2 * MINUTE }]);
    expect(smell.evaluate({}, { now: T0 + 4 * MINUTE, daemons: { d: short } })[0].breach).toBe(false);
    const recovered = feed([
      ...Array.from({ length: 7 }, (_, i) => ({ text: STALE_TICK, at: T0 + i * 2 * MINUTE })),
      { text: GOOD_TICK, at: T0 + 14 * MINUTE },
    ]);
    expect(staleStreak(recovered.recentTicks).ticks).toBe(0);
    expect(smell.evaluate({}, { now: T0 + 15 * MINUTE, daemons: { d: recovered } })[0].breach).toBe(false);
  });

  it('breaches even without the self-sync probe (daemon log alone is enough)', () => {
    const mem = feed(Array.from({ length: 7 }, (_, i) => ({ text: STALE_TICK, at: T0 + i * 2 * MINUTE })));
    const [r] = smell.evaluate({}, { now: T0 + 12 * MINUTE, daemons: { d: mem } });
    expect(r.breach).toBe(true);
    expect(r.measure.rebuildBlock).toBeNull();
  });

  it('latestRebuildBlock ignores informational alerts like the new skip notice', () => {
    const skip = { at: T0, kind: 'pinned-overlay-conflict-skipped', detail: { ref: 'x' } };
    expect(latestRebuildBlock([{ cloneKey: 'k', alerts: [skip] }], T0 + MINUTE)).toBeNull();
    expect(latestRebuildBlock([{ cloneKey: 'k', alerts: [pinnedAlert, skip] }], T0 + MINUTE).kind).toBe('pinned-overlay-conflict');
  });
});
