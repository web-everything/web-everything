import { describe, it, expect } from 'vitest';
import smell from '../drain-landed-nothing.mjs';
import { stepEpisodes, planActions, DEFAULT_HEALTH_CONFIG } from '../../health-watch-core.mjs';
import { NOTIFY_EVEN_IN_SHADOW } from '../../health-smells-notify-list.mjs';

const MIN = 60000;
const T0 = Date.parse('2026-11-03T12:00:00Z');
const stalled = (now) => [1, 2, 3].map((i) => ({ at: now - i * 12 * MIN, considered: 4, merged: 0, skippedPrs: [], deferredDetail: [] }));
const tick = (state, now) => {
  const results = smell.evaluate({ drainHistory: stalled(now) }, { now });
  const stepped = stepEpisodes(state, [{ smell, results }], now);
  const plan = planActions(stepped.transitions, { [smell.id]: smell }, { mode: 'shadow' });
  return { state: stepped.state, plan: plan.filter((p) => p.kind === 'notify') };
};
const empty = { episodes: {}, opens: {}, history: [], silences: [] };

describe('drain-landed-nothing delivery (real core + planner, default shadow mode)', () => {
  it('is on the notify-even-in-shadow list', () => {
    expect(NOTIFY_EVEN_IN_SHADOW.has('drain-landed-nothing')).toBe(true);
  });
  it('notifies unsuppressed when the episode opens, in shadow mode', () => {
    let s = empty; let notified = [];
    for (let i = 0; i < 3; i++) { const r = tick(s, T0 + i * MIN); s = r.state; notified = notified.concat(r.plan); }
    expect(notified.length).toBe(1);
    expect(notified[0].suppressed).toBeNull();
  });
  it('keeps reminding with backoff while the stall persists', () => {
    let s = empty; const at = [];
    for (let i = 0; i < 3; i++) s = tick(s, T0 + i * MIN).state;
    const hours = [1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 20];
    for (const h of hours) { const now = T0 + h * 60 * MIN; const r = tick(s, now); s = r.state; if (r.plan.length) { expect(r.plan[0].suppressed).toBeNull(); at.push(h); } }
    expect(at.length).toBeGreaterThanOrEqual(3);
    for (let i = 2; i < at.length; i++) expect(at[i] - at[i - 1]).toBeGreaterThan(at[i - 1] - at[i - 2] - 1e-9);
  });

  const open3 = () => { let s = empty; for (let i = 0; i < 3; i++) s = tick(s, T0 + i * MIN).state; return s; };
  it('a missing history probe does not close the open episode', () => {
    const s0 = open3();
    const stepped = stepEpisodes(s0, [{ smell, results: smell.evaluate({ drainHistory: null }, { now: T0 + 40 * MIN }) }], T0 + 40 * MIN);
    expect(Object.keys(stepped.state.episodes).length).toBe(1);
    expect(stepped.state.episodes[Object.keys(stepped.state.episodes)[0]].status).not.toBe('closed');
  });
  it('a drain that stops completing passes keeps the episode open and still reminds', () => {
    let s = open3(); let reminded = 0;
    const old = [{ at: T0 - 20 * MIN, considered: 4, merged: 0 }]; // unchanged history, no new passes
    for (const m of [31, 62, 63, 64, 65, 66, 130]) {
      const now = T0 + m * MIN;
      const results = smell.evaluate({ drainHistory: old }, { now });
      const st = stepEpisodes(s, [{ smell, results }], now); s = st.state;
      reminded += planActions(st.transitions, { [smell.id]: smell }, { mode: 'shadow' }).filter((p) => p.kind === 'notify').length;
    }
    expect(Object.keys(s.episodes).length).toBe(1);
    expect(reminded).toBeGreaterThanOrEqual(1);
  });
  it('opens an alert from scratch when the drain stopped completing passes with queued work', () => {
    const old = [{ at: T0 - 20 * MIN, considered: 4, merged: 0 }];
    const now = T0 + 40 * MIN;
    const out = stepEpisodes(empty, [{ smell, results: smell.evaluate({ drainHistory: old }, { now }) }], now);
    const plan = planActions(out.transitions, { [smell.id]: smell }, { mode: 'shadow' }).filter((p) => p.kind === 'notify');
    expect(plan.length).toBe(1);
    expect(plan[0].suppressed).toBeNull();
  });
  it('invalid-count records are unknown: they do not close an open stall', () => {
    const s0 = open3();
    const bad = [{ at: T0 + 30 * MIN, valid: false, considered: 0, merged: 0 }, { at: T0 + 35 * MIN, valid: false, considered: 0, merged: 0 }];
    const now = T0 + 40 * MIN;
    const st = stepEpisodes(s0, [{ smell, results: smell.evaluate({ drainHistory: bad }, { now }) }], now);
    expect(Object.keys(st.state.episodes).length).toBe(1);
  });
  it('two uncovered queued passes do not close an open stall (no evidence of recovery)', () => {
    const s0 = open3();
    const now = T0 + 40 * MIN;
    const h = [{ at: now - 2 * MIN, considered: 4, merged: 0 }, { at: now - 1 * MIN, considered: 4, merged: 0 }];
    const st = stepEpisodes(s0, [{ smell, results: smell.evaluate({ drainHistory: h }, { now }) }], now);
    expect(Object.keys(st.state.episodes).length).toBe(1);
    expect(smell.evaluate({ drainHistory: h }, { now })).toEqual([]);
  });
  it('a merge or an empty queue IS recovery and closes the stall', () => {
    const now = T0 + 40 * MIN;
    const r = smell.evaluate({ drainHistory: [{ at: now - 5 * MIN, considered: 4, merged: 1 }, { at: now - 1 * MIN, considered: 3, merged: 0 }] }, { now });
    expect(r[0].breach).toBe(false);
  });
  it('a failed pass with zero candidates is NOT recovery and does not close the stall', () => {
    const s0 = open3();
    const now = T0 + 40 * MIN;
    const h = [{ at: now - 20 * MIN, considered: 4, merged: 0 }, { at: now - 5 * MIN, considered: 0, merged: 0, exit: 1, failed: 1 }, { at: now - 1 * MIN, considered: 0, merged: 0, exit: 1, failed: 0 }];
    expect(smell.evaluate({ drainHistory: h }, { now })).toEqual([]);
    const ok = smell.evaluate({ drainHistory: [{ at: now - 20 * MIN, considered: 4, merged: 0 }, { at: now - 1 * MIN, considered: 0, merged: 0, exit: 0, failed: 0 }] }, { now });
    expect(ok[0].breach).toBe(false);
    expect(s0).toBeTruthy();
  });
});
