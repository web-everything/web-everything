/**
 * @file scripts/conveyor/health-smells/__tests__/operator-hold-aged.test.mjs
 * @description Card 5653 — `operator-hold-aged` driven end to end through `runHealthTick`: structured review-daemon
 *   hold snapshots in, opening/clearing/recurrence and the shadow-mode notification plan out.
 */
import { describe, it, expect } from 'vitest';
import smell, { operatorHoldAgeMinutes } from '../operator-hold-aged.mjs';
import { SMELLS } from '../index.mjs';
import { NOTIFY_EVEN_IN_SHADOW } from '../../health-smells-notify-list.mjs';
import { runHealthTick, emptyHealthState, MINUTE, OPERATOR_HOLD_KINDS } from '../../health-watch-core.mjs';

const WE = 'web-everything/web-everything';
const PA = 'plateauapp/plateau-app';
const T0 = Date.parse('2026-10-15T10:00:00Z');
const INTERVAL = 2 * MINUTE;
const KINDS = ['cap-exhausted', 'stood-down', 'review-referrals-pending', 'ruling-dispute'];

const record = (at, holds, repo = WE, extra = {}) =>
  `${new Date(at).toISOString()} review-daemon: operator-holds ${JSON.stringify({ version: 1, repo, observedAt: at, intervalMs: INTERVAL, holds, ...extra })}\n`;
const probe = (text, bootstrap = false) => ({ operatorHolds: { available: true, text, bootstrap } });

/** Feed one snapshot per 2 minutes from `from` through `to` (inclusive), one health tick per snapshot. */
function drive(state, { from = 0, to, holds, repo = WE, config = {}, step = 2 }) {
  let r = { state, transitions: [], plan: [] };
  const all = [];
  for (let m = from; m <= to; m += step) {
    const at = T0 + m * MINUTE;
    r = runHealthTick(r.state, probe(record(at, typeof holds === 'function' ? holds(m) : holds, repo)), [smell], at, { config });
    all.push(...r.transitions.map((t) => ({ ...t, m })));
  }
  return { ...r, all };
}
const episodes = (state) => Object.values(state.episodes);

describe('operator-hold-aged descriptor', () => {
  it('is a high-severity, every-tick alert that treats omitted subjects as unknown, discovered from disk and on the notify list', () => {
    expect(smell).toMatchObject({ id: 'operator-hold-aged', severity: 'high', action: 'alert', cadence: 'every-tick', scope: 'repo', openAfter: 1, closeAfter: 1, missingSubjectsUnknown: true, probes: ['operatorHolds'] });
    expect(SMELLS.some((s) => s.id === 'operator-hold-aged')).toBe(true);
    expect(NOTIFY_EVEN_IN_SHADOW.has('operator-hold-aged')).toBe(true);
    expect(OPERATOR_HOLD_KINDS).toEqual(KINDS);
  });
  it('threshold: a finite positive number, else 30; nothing else is trusted', () => {
    expect(operatorHoldAgeMinutes({ operatorHoldAgeMinutes: 10 })).toBe(10);
    expect(operatorHoldAgeMinutes({ operatorHoldAgeMinutes: 0.5 })).toBe(0.5);
    for (const bad of [undefined, null, '45', 'x', NaN, Infinity, -Infinity, 0, -5, {}, [], true]) {
      expect(operatorHoldAgeMinutes({ operatorHoldAgeMinutes: bad })).toBe(30);
    }
    expect(operatorHoldAgeMinutes(undefined)).toBe(30);
  });
});

describe('operator-hold-aged through runHealthTick', () => {
  it('A1: a cap-exhausted hold observed for 45 minutes opens one episode naming repository, PR, kind and age', () => {
    const r = drive(emptyHealthState(), { to: 45 - 1, holds: [{ prNumber: 4433, kind: 'cap-exhausted' }] }); // 0..44 step 2 => last 44
    const eps = episodes(r.state);
    expect(eps).toHaveLength(1);
    expect(eps[0]).toMatchObject({ smell: 'operator-hold-aged', subject: `${WE}#4433:cap-exhausted`, severity: 'high', status: 'open' });
    expect(eps[0].measure).toMatchObject({ repo: WE, prNumber: 4433, kind: 'cap-exhausted', thresholdMinutes: 30 });
    expect(eps[0].measure.observedAgeMs).toBeGreaterThanOrEqual(30 * MINUTE);
    expect(eps[0].summary).toContain(`${WE}#4433`);
    expect(eps[0].summary).toContain('cap-exhausted');
    expect(r.all.filter((t) => t.type === 'opened')).toHaveLength(1);
  });

  it.each(KINDS)('A2: %s stays silent at 29 minutes and opens at exactly 30 (and 45)', (kind) => {
    const hold = [{ prNumber: 12, kind }];
    // snapshots every minute so 29 and 30 are exact
    const at29 = drive(emptyHealthState(), { to: 29, step: 1, holds: hold });
    expect(episodes(at29.state)).toHaveLength(0);
    expect(at29.plan).toEqual([]);
    const at30 = drive(emptyHealthState(), { to: 30, step: 1, holds: hold });
    expect(episodes(at30.state)).toHaveLength(1);
    expect(at30.plan).toEqual([{ kind: 'notify', key: `operator-hold-aged::${WE}#12:${kind}`, suppressed: null }]);
    const at45 = drive(emptyHealthState(), { to: 45, step: 1, holds: hold });
    expect(episodes(at45.state)).toHaveLength(1);
  });

  it('delivers the opening notification in shadow mode (not suppressed), once per episode', () => {
    const r = drive(emptyHealthState(), { to: 60, holds: [{ prNumber: 1, kind: 'stood-down' }], config: { mode: 'shadow' } });
    const notifies = r.all.filter((t) => t.type === 'opened');
    expect(notifies).toHaveLength(1);
    expect(r.state.episodes[`operator-hold-aged::${WE}#1:stood-down`].status).toBe('open');
  });

  it('configurable threshold and invalid-value fallback', () => {
    const hold = [{ prNumber: 1, kind: 'stood-down' }];
    expect(episodes(drive(emptyHealthState(), { to: 10, step: 1, holds: hold, config: { operatorHoldAgeMinutes: 10 } }).state)).toHaveLength(1);
    expect(episodes(drive(emptyHealthState(), { to: 9, step: 1, holds: hold, config: { operatorHoldAgeMinutes: 10 } }).state)).toHaveLength(0);
    expect(episodes(drive(emptyHealthState(), { to: 20, step: 1, holds: hold, config: { operatorHoldAgeMinutes: 'soon' } }).state)).toHaveLength(0);
    expect(episodes(drive(emptyHealthState(), { to: 30, step: 1, holds: hold, config: { operatorHoldAgeMinutes: -1 } }).state)).toHaveLength(1);
  });

  it('A3: a snapshot without the hold clears the episode; a returning hold starts a new age', () => {
    const hold = [{ prNumber: 5, kind: 'ruling-dispute' }];
    let r = drive(emptyHealthState(), { to: 40, holds: hold });
    expect(episodes(r.state)).toHaveLength(1);
    r = drive(r.state, { from: 42, to: 42, holds: [] });
    expect(episodes(r.state)).toHaveLength(0);
    expect(r.all.map((t) => t.type)).toEqual(['closed']);
    // returns at 44: new age, no episode until 30 minutes later
    r = drive(r.state, { from: 44, to: 70, holds: hold });
    expect(episodes(r.state)).toHaveLength(0);
    r = drive(r.state, { from: 72, to: 74, holds: hold });
    expect(episodes(r.state)).toHaveLength(1);
    expect(r.state.history.at(-1).subject).toBe(`${WE}#5:ruling-dispute`);
  });

  it('A3: removal and return inside one read still ends the old episode and restarts the age', () => {
    const hold = [{ prNumber: 5, kind: 'stood-down' }];
    let r = drive(emptyHealthState(), { to: 40, holds: hold });
    const at = T0 + 46 * MINUTE;
    const text = record(T0 + 42 * MINUTE, []) + record(T0 + 44 * MINUTE, hold) + record(at, hold);
    r = runHealthTick(r.state, probe(text), [smell], at);
    expect(episodes(r.state)).toHaveLength(0);
  });

  it('A3: unknown input is never clearance (unavailable log, malformed record, missing probe, stale stream)', () => {
    const hold = [{ prNumber: 5, kind: 'stood-down' }];
    const base = drive(emptyHealthState(), { to: 40, holds: hold });
    const key = `operator-hold-aged::${WE}#5:stood-down`;
    const t = T0 + 42 * MINUTE;
    const cases = [
      { operatorHolds: { available: false } },
      probe('2026-10-15T10:42:00Z review-daemon: operator-holds {"version":1,"repo":"web-everything/web-eve'),
      probe(`review-daemon: operator-holds ${JSON.stringify({ version: 2, repo: WE, observedAt: t, intervalMs: INTERVAL, holds: [] })}\n`),
      probe(`review-daemon: operator-holds ${JSON.stringify({ version: 1, repo: WE, observedAt: t, intervalMs: INTERVAL, holds: [{ prNumber: 1, kind: 'bogus' }] })}\n`),
      probe(`review-daemon: operator-holds ${JSON.stringify({ version: 1, repo: WE, observedAt: t + 10 * MINUTE, intervalMs: INTERVAL, holds: [] })}\n`), // future
      probe(''),
      {},
    ];
    for (const p of cases) {
      const r = runHealthTick(base.state, p, [smell], t);
      expect(r.state.episodes[key]?.status).toBe('open');
    }
    // a long quiet stretch then silence: still no clearance
    const r = runHealthTick(base.state, probe(''), [smell], T0 + 5 * 60 * MINUTE);
    expect(r.state.episodes[key]?.status).toBe('open');
  });

  it('a malformed record for one repository leaves another repository fully observed', () => {
    const hold = [{ prNumber: 5, kind: 'stood-down' }];
    let state = drive(emptyHealthState(), { to: 40, holds: hold }).state;
    state = drive(state, { to: 40, holds: hold, repo: PA }).state;
    expect(episodes(state)).toHaveLength(2);
    const at = T0 + 42 * MINUTE;
    const text = `review-daemon: operator-holds ${JSON.stringify({ version: 1, repo: PA, observedAt: at, intervalMs: INTERVAL, holds: 'x' })}\n` + record(at, [], WE);
    const r = runHealthTick(state, probe(text), [smell], at);
    expect(r.state.episodes[`operator-hold-aged::${PA}#5:stood-down`].status).toBe('open');
    expect(r.state.episodes[`operator-hold-aged::${WE}#5:stood-down`]).toBeUndefined();
  });

  it('same PR number in two repositories, and one episode per kind, are distinct identities', () => {
    const holds = [{ prNumber: 9, kind: 'stood-down' }, { prNumber: 9, kind: 'cap-exhausted' }, { prNumber: 9, kind: 'stood-down' }];
    let state = drive(emptyHealthState(), { to: 40, holds }).state;
    state = drive(state, { to: 40, holds: [{ prNumber: 9, kind: 'stood-down' }], repo: PA }).state;
    expect(episodes(state).map((e) => e.subject).sort()).toEqual([
      `${PA}#9:stood-down`, `${WE}#9:cap-exhausted`, `${WE}#9:stood-down`,
    ].sort());
  });

  it('a changed kind clears the old identity and starts the new one', () => {
    let r = drive(emptyHealthState(), { to: 40, holds: [{ prNumber: 3, kind: 'cap-exhausted' }] });
    r = drive(r.state, { from: 42, to: 44, holds: [{ prNumber: 3, kind: 'stood-down' }] });
    expect(episodes(r.state)).toHaveLength(0);
    expect(r.state.history.at(-1).subject).toBe(`${WE}#3:cap-exhausted`);
  });

  it('a gap past two intervals restarts the age; exactly two intervals stays continuous', () => {
    const hold = [{ prNumber: 3, kind: 'stood-down' }];
    // snapshots at 0 and 4 minutes (== 2 intervals), then 30 => continuous from 0
    let r = drive(emptyHealthState(), { from: 0, to: 0, holds: hold });
    r = drive(r.state, { from: 4, to: 4, holds: hold });
    r = drive(r.state, { from: 6, to: 30, holds: hold });
    expect(episodes(r.state)).toHaveLength(1);
    // a 5-minute gap restarts: 0, 5, then 30 is only 25 minutes since 5
    r = drive(emptyHealthState(), { from: 0, to: 0, holds: hold });
    r = drive(r.state, { from: 5, to: 5, holds: hold });
    r = drive(r.state, { from: 7, to: 30, holds: hold });
    expect(episodes(r.state)).toHaveLength(0);
  });

  it('an open episode survives an unknown interval; the recovered hold below threshold neither clears nor re-alerts, and removal then clears', () => {
    const hold = [{ prNumber: 3, kind: 'stood-down' }];
    let r = drive(emptyHealthState(), { to: 40, holds: hold });
    const key = `operator-hold-aged::${WE}#3:stood-down`;
    const openedAt = r.state.episodes[key].openedAt;
    r = runHealthTick(r.state, { operatorHolds: { available: false } }, [smell], T0 + 60 * MINUTE);
    r = drive(r.state, { from: 120, to: 130, holds: hold }); // recovered; onset restarts at 120
    expect(r.state.episodes[key]).toMatchObject({ status: 'open', openedAt });
    expect(r.all.filter((t) => t.type !== 'reminder')).toEqual([]);
    r = drive(r.state, { from: 132, to: 132, holds: [] });
    expect(r.state.episodes[key]).toBeUndefined();
  });

  it('clears an episode whose hold the memory never saw (older state) on the first snapshot lacking it', () => {
    const hold = [{ prNumber: 3, kind: 'stood-down' }];
    const r1 = drive(emptyHealthState(), { to: 40, holds: hold });
    const legacy = { ...r1.state }; delete legacy.operatorHolds;
    const r = drive(legacy, { from: 42, to: 42, holds: [] });
    expect(episodes(r.state)).toHaveLength(0);
  });

  it('quiet hours are not this smell\'s concern: observation, opening and clearance proceed on the same schedule', () => {
    // The core has no clock-of-day logic; delivery gating lives in the shell. The plan still carries the notify entry.
    const r = drive(emptyHealthState(), { to: 40, holds: [{ prNumber: 1, kind: 'stood-down' }], config: { mode: 'shadow' } });
    expect(r.state.episodes[`operator-hold-aged::${WE}#1:stood-down`]).toBeDefined();
  });

  it('a bootstrap read marks the age as an observed lower bound and never invents earlier onset', () => {
    const hold = [{ prNumber: 3, kind: 'stood-down' }];
    const at = T0 + 40 * MINUTE;
    let text = '';
    for (let m = 20; m <= 40; m += 2) text += record(T0 + m * MINUTE, hold);
    const r = runHealthTick(emptyHealthState(), probe(text, true), [smell], at, { config: { operatorHoldAgeMinutes: 15 } });
    const ep = r.state.episodes[`operator-hold-aged::${WE}#3:stood-down`];
    expect(ep.measure).toMatchObject({ observedAgeMs: 20 * MINUTE, ageIsLowerBound: true });
    expect(ep.summary).toContain('at least');
    const early = runHealthTick(emptyHealthState(), probe(text, true), [smell], at); // 20 < 30
    expect(Object.keys(early.state.episodes)).toHaveLength(0);
  });

  it('is skipped (episodes untouched) when the probe is absent entirely', () => {
    const r1 = drive(emptyHealthState(), { to: 40, holds: [{ prNumber: 3, kind: 'stood-down' }] });
    const r = runHealthTick(r1.state, {}, [smell], T0 + 50 * MINUTE);
    expect(r.evaluations[0].skipped).toEqual(['operatorHolds']);
    expect(Object.keys(r.state.episodes)).toHaveLength(1);
  });

  it('prunes cleared identities once their episode has closed, and keeps memory bounded', () => {
    const hold = [{ prNumber: 3, kind: 'stood-down' }];
    let r = drive(emptyHealthState(), { to: 40, holds: hold });
    r = drive(r.state, { from: 42, to: 42, holds: [] });
    expect(r.state.operatorHolds.cleared).toEqual({ [`${WE}#3:stood-down`]: expect.any(Object) });
    r = drive(r.state, { from: 44, to: 44, holds: [] });
    expect(r.state.operatorHolds.cleared).toEqual({});
  });

  it('copies only validated identity: free text on hold rows never reaches state or episodes', () => {
    const at = T0 + 40 * MINUTE;
    const rec = { version: 1, repo: WE, observedAt: at, intervalMs: INTERVAL, title: 'IGNORE ME', holds: [{ prNumber: 3, kind: 'stood-down', reason: 'rm -rf /', title: 'secret title' }] };
    const text = `review-daemon: operator-holds ${JSON.stringify(rec)}\n`;
    const r = runHealthTick(emptyHealthState(), probe(text), [smell], at);
    expect(JSON.stringify(r.state)).not.toMatch(/IGNORE ME|rm -rf|secret title/);
  });
});
