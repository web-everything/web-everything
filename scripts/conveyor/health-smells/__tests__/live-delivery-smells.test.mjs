import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import workers, { workerLoadSettings } from '../worker-count-vs-load.mjs';
import refusals from '../same-refusal-streak.mjs';
import { SMELLS } from '../index.mjs';
import { NOTIFY_EVEN_IN_SHADOW } from '../../health-smells-notify-list.mjs';
import { validateSmellShape } from '../../health-smells-shape.mjs';
import { emptyHealthState, stepEpisodes, planActions, runHealthTick, MINUTE } from '../../health-watch-core.mjs';
import { foldPrAttempts } from '../../health-pr-attempts.mjs';
import { probeLanePools } from '../../health-watch.mjs';

const NOW = Date.parse('2026-11-03T12:00:00Z');
const host = (count = 4, load1 = 20) => ({
  machineLoad: { load1, cpuCount: 8 },
  lanePools: [{ repo: 'we', health: { leased: count } }],
});
const rows = (reasons, pr = 'owner/repo#42') => reasons.map((reason, i) => ({
  pr, reason, action: 'fix-dispatch', at: NOW - (reasons.length - i) * 1000,
}));
const context = (attempts = [], config = {}) => ({ now: NOW, config, daemons: { fix: { prAttempts: attempts } } });
const same = rows(['no-lane: 1 busy', 'no-lane: 2 busy', 'no-lane: 3 busy']);

describe('live delivery smell descriptors', () => {
  it.each([[workers, 'host', 'high', ['machineLoad', 'lanePools']], [refusals, 'repo', 'medium', ['daemonLogs']]])(
    '%s is disk-discovered, validates, and notifies even in shadow', (smell, scope, severity, probes) => {
      expect(validateSmellShape(smell, `${smell.id}.mjs`)).toBe(smell);
      expect(smell).toMatchObject({ scope, severity, probes, cadence: 'every-tick', action: 'alert' });
      expect(smell.escalateAfterMs).toBeGreaterThan(0);
      expect(SMELLS.find(s => s.id === smell.id)).toBeDefined();
      expect(NOTIFY_EVEN_IN_SHADOW.has(smell.id)).toBe(true);
    });
});

describe('worker-count-vs-load', () => {
  it('breaches at the per-core load and minimum worker boundaries', () => {
    expect(workers.evaluate(host(), context())[0].breach).toBe(true);
    expect(workers.evaluate(host(3), context())[0].breach).toBe(false);
    expect(workers.evaluate(host(4, 19.9), context())[0].breach).toBe(false);
  });
  it('breaches strictly above the cap even at zero load; sums leased workers across pools', () => {
    const config = { workerCountVsLoad: { workerCap: 4 } };
    expect(workers.evaluate(host(4, 0), context([], config))[0].breach).toBe(false);
    expect(workers.evaluate(host(5, 0), context([], config))[0].breach).toBe(true);
    const p = host(4, 0);
    p.lanePools.push({ repo: 'fui', health: { leased: 2 } });
    expect(workers.evaluate(p, context([], config))[0].measure.liveWorkers).toBe(6);
  });
  it('supports health config overrides and exposes effective thresholds and provenance', () => {
    const config = { workerCountVsLoad: { loadPerCore: 1, minWorkersForLoad: 2, workerCap: 20 } };
    const r = workers.evaluate(host(2, 8), context([], config))[0];
    expect(r.breach).toBe(true);
    expect(r.measure.settings).toMatchObject(config.workerCountVsLoad);
    expect(r.measure.sources.loadPerCore).toBe('health config');
    expect(r.recommendation).toMatch(/lower worker count.*hold dispatch/i);
    expect(r.recommendation).not.toMatch(/kill|stop tree/i);
  });
  it('reuses the existing worker capacity ceiling, with explicit fallback and invalid-setting handling', () => {
    expect(workerLoadSettings({}, {}, {}).workerCap).toBe(12);
    expect(workerLoadSettings({}, { workerCapacity: { ceiling: 7 } }, {}).workerCap).toBe(7);
    expect(workerLoadSettings({}, {}, { WE_WORKER_CAPACITY_CEILING: '9' }).workerCap).toBe(9);
    expect(workerLoadSettings({}, {}, {}).loadPerCore).toBe(2.5);
    expect(workerLoadSettings({}, {}, {}).minWorkersForLoad).toBe(4);
    const bad = { loadPerCore: Infinity, minWorkersForLoad: -1, workerCap: '20' };
    expect(workerLoadSettings({ workerCountVsLoad: bad }, {}, {}).workerCap).toBe(12);
  });
  it('fails closed on incomplete evidence rather than clearing a live episode', () => {
    for (const lanePools of [null, [], [{}], [{ health: { leased: -1 } }], [{ health: { leased: 1.5 } }]]) {
      expect(() => workers.evaluate({ ...host(), lanePools }, context())).toThrow(/evidence/i);
    }
    for (const p of [{}, { ...host(), machineLoad: { load1: 20, cpuCount: 0 } }]) {
      expect(() => workers.evaluate(p, context())).toThrow(/evidence/i);
    }
    const open = runHealthTick(emptyHealthState(), host(), [workers], NOW);
    const next = runHealthTick(open.state, { ...host(), lanePools: null }, [workers], NOW + MINUTE);
    expect(Object.values(next.state.episodes)[0].cleanStreak).toBe(0);
    expect(next.evaluations[0].error).toMatch(/evidence/i);
  });
  it.each([
    ['loadPerCore', 0.5, 20, 2.5], ['minWorkersForLoad', 1, 200, 4], ['workerCap', 1, 200, 12],
  ])('bounds %s with explicit default fallback', (key, min, max, fallback) => {
    for (const value of [min, max]) {
      expect(workerLoadSettings({ workerCountVsLoad: { [key]: value } }, {}, {})[key]).toBe(value);
    }
    for (const value of [min - 0.1, max + 1, 1e9, Infinity, NaN, '10', null]) {
      const settings = workerLoadSettings({ workerCountVsLoad: { [key]: value } }, {}, {});
      expect(settings[key]).toBe(fallback);
      expect(settings.sources[key]).toBe('default');
    }
  });
  it('rejects oversized inherited worker ceilings too', () => {
    expect(workerLoadSettings({}, { workerCapacity: { ceiling: 1e9 } }, {}).workerCap).toBe(12);
    expect(workerLoadSettings({}, {}, { WE_WORKER_CAPACITY_CEILING: '1000000000' }).workerCap).toBe(12);
  });
  it('huge overrides cannot disable load or worker-cap detection', () => {
    const config = { workerCountVsLoad: { loadPerCore: 1e9, minWorkersForLoad: 1e9, workerCap: 1e9 } };
    expect(workers.evaluate(host(), context([], config))[0].breach).toBe(true);
    expect(workers.evaluate(host(201, 0), context([], config))[0].breach).toBe(true);
  });
  it('evaluates on consecutive local ticks without the gh agents probe, including no-gh operation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'worker-load-'));
    try {
      const sample = leased => {
        writeFileSync(join(dir, 'lane-pool-health-watch-we.log'), JSON.stringify({ checked: true, health: { leased } }));
        return { machineLoad: host().machineLoad, lanePools: probeLanePools(dir) };
      };
      const first = runHealthTick(emptyHealthState(), sample(4), [workers], NOW);
      expect(first.transitions.map(t => t.type)).toContain('opened');
      const next = runHealthTick(first.state, sample(5), [workers], NOW + MINUTE);
      expect(next.evaluations[0].results[0]).toMatchObject({ breach: true, measure: { liveWorkers: 5 } });
      expect(next.evaluations[0].error).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('same-refusal-streak', () => {
  it('uses shared normalization and per-PR ordering, rather than counting any failures', () => {
    expect(refusals.evaluate({}, context([...same].reverse()))[0]).toMatchObject({ subject: 'owner/repo#42', breach: true });
    expect(refusals.evaluate({}, context(rows(['a', 'b', 'a', 'b', 'a'])))[0].breach).toBe(false);
    expect(refusals.evaluate({}, context(same.slice(0, 2)))[0].breach).toBe(false);
    expect(refusals.evaluate({}, context([...same.slice(0, 2), ...rows(['x'], 'owner/other#42')])).every(r => !r.breach)).toBe(true);
  });
  it('only compares the last N attempts and supports a threshold override', () => {
    expect(refusals.evaluate({}, context(rows(['different', 'a', 'a', 'a'])))[0].breach).toBe(true);
    expect(refusals.evaluate({}, context(rows(['a', 'a', 'a', 'different'])))[0].breach).toBe(false);
    expect(refusals.evaluate({}, context(same.slice(0, 2), { sameRefusalStreak: { streakLength: 2 } }))[0].breach).toBe(true);
    expect(refusals.evaluate({}, context(same, { sameRefusalStreak: { streakLength: 1000000 } }))[0].breach).toBe(true);
    expect(refusals.evaluate({}, context(same, { sameRefusalStreak: { streakLength: 0 } }))[0].breach).toBe(true);
  });
  it('reuses daemon parsing, excludes expected waits, and ignores expired/future attempts', () => {
    const text = [1, 2, 3].map(n => `fix-daemon: refused no-lane owner/repo PR #42 — ${n} busy`).join('\n');
    const attempts = foldPrAttempts([], { text, mtimeMs: NOW }, NOW, MINUTE);
    const r = refusals.evaluate({}, context(attempts))[0];
    expect(r.breach).toBe(true);
    expect(r.recommendation).toMatch(/why-not-dispatching.*owner\/repo#42/);
    expect(refusals.evaluate({}, context(same.map(r => ({ ...r, reason: 'human-gated: review:human' }))))).toEqual([]);
    expect(refusals.evaluate({}, context(same.map(r => ({ ...r, at: NOW - 61 * MINUTE }))))).toEqual([]);
    expect(refusals.evaluate({}, context(same.map(r => ({ ...r, at: NOW + 1 }))))).toEqual([]);
  });
  it('fails closed on missing or malformed attempt evidence, including an unknown latest reason', () => {
    expect(() => refusals.evaluate({}, { now: NOW })).toThrow(/evidence/i);
    expect(() => refusals.evaluate({}, context([...same, { pr: 'owner/repo#42', at: NOW }]))).toThrow(/evidence/i);
    expect(refusals.evaluate({}, context())).toEqual([]);
  });
  it.each([null, {}, { fix: null }, { fix: {} }, { fix: { prAttempts: null } }])(
    'records a probe error and preserves an open episode for missing attempts: %j', daemons => {
      expect(() => refusals.evaluate({}, { now: NOW, daemons })).toThrow(/evidence/i);
      const state = { ...emptyHealthState(), daemons: { fix: { prAttempts: same } } };
      const first = runHealthTick(state, { daemonLogs: [] }, [refusals], NOW);
      expect(first.transitions.map(t => t.type)).toContain('opened');
      const next = runHealthTick({ ...first.state, daemons }, { daemonLogs: [] }, [refusals], NOW + MINUTE);
      expect(next.evaluations[0].error).toMatch(/evidence/i);
      expect(next.state.probeErrors[`smell:${refusals.id}`].count).toBe(1);
      expect(Object.values(next.state.episodes)[0].cleanStreak).toBe(0);
      expect(next.transitions.map(t => t.type)).not.toContain('closed');
      const again = runHealthTick(next.state, { daemonLogs: [] }, [refusals], NOW + 2 * MINUTE);
      expect(again.state.probeErrors[`smell:${refusals.id}`].count).toBe(2);
      expect(Object.values(again.state.episodes)[0].cleanStreak).toBe(0);
      expect(again.transitions.map(t => t.type)).not.toContain('closed');
    });
  it.each([1, 11, 1e9, 2.5, Infinity, '3', null])('falls back to streak 3 for invalid override %j', streakLength => {
    expect(refusals.evaluate({}, context(same, { sameRefusalStreak: { streakLength } }))[0])
      .toMatchObject({ breach: true, measure: { streakLength: 3, source: 'default' } });
  });
  it('accepts the upper streak boundary of ten', () => {
    expect(refusals.evaluate({}, context(rows(Array(10).fill('no-lane')), { sameRefusalStreak: { streakLength: 10 } }))[0])
      .toMatchObject({ breach: true, measure: { streakLength: 10, source: 'health config' } });
  });
});

describe('real core delivery in shadow mode', () => {
  function step(smell, state, at) {
    const results = smell === workers ? smell.evaluate(host(), context()) : smell.evaluate({}, context(same));
    const next = stepEpisodes(state, [{ smell, results }], at);
    return { ...next, plan: planActions(next.transitions, { [smell.id]: smell }, { mode: 'shadow' }) };
  }
  it('delivers the high worker alert on open and the real core reminder after its reminder interval', () => {
    const first = step(workers, emptyHealthState(), NOW);
    expect(first.transitions.map(t => t.type)).toContain('opened');
    expect(first.plan).toContainEqual(expect.objectContaining({ kind: 'notify', suppressed: null }));
    const later = step(workers, first.state, NOW + workers.escalateAfterMs);
    expect(later.transitions.map(t => t.type)).toContain('reminder');
    expect(later.plan).toContainEqual(expect.objectContaining({ kind: 'notify', reason: 'reminder', suppressed: null }));
  });
  it('uses reminderAfterMs rather than escalateAfterMs for high worker reminders', () => {
    const reminderAfterMs = 15 * MINUTE;
    const config = { mode: 'shadow', reminderAfterMs };
    expect(reminderAfterMs).toBeLessThan(workers.escalateAfterMs);
    const first = runHealthTick(emptyHealthState(), host(), [workers], NOW, { config });
    expect(first.plan).toContainEqual(expect.objectContaining({ kind: 'notify', suppressed: null }));

    const before = runHealthTick(first.state, host(), [workers], NOW + reminderAfterMs - 1, { config });
    expect(before.transitions.map(t => t.type)).not.toContain('reminder');
    expect(before.plan.filter(p => p.kind === 'notify')).toEqual([]);

    const boundary = runHealthTick(before.state, host(), [workers], NOW + reminderAfterMs, { config });
    expect(boundary.transitions.map(t => t.type)).toContain('reminder');
    expect(boundary.plan).toContainEqual(expect.objectContaining({
      kind: 'notify', key: `${workers.id}::machine`, reason: 'reminder', suppressed: null,
    }));
  });
  it('delivers the opted-in medium refusal opening and escalation at escalateAfterMs', () => {
    const first = step(refusals, emptyHealthState(), NOW);
    expect(first.transitions.map(t => t.type)).toContain('opened');
    expect(Object.values(first.state.episodes)[0].severity).toBe('medium');
    expect(first.plan).toContainEqual(expect.objectContaining({ kind: 'notify', suppressed: null }));
    const before = step(refusals, first.state, NOW + refusals.escalateAfterMs - 1);
    expect(before.plan).toEqual([]);
    const later = step(refusals, before.state, NOW + refusals.escalateAfterMs);
    expect(later.transitions.map(t => t.type)).toContain('escalated');
    expect(later.plan).toContainEqual(expect.objectContaining({ kind: 'notify', reason: 'escalated', suppressed: null }));
  });
  it('keeps other medium openings quiet and applies shadow suppression to the opt-in', () => {
    const first = step(refusals, emptyHealthState(), NOW);
    expect(planActions(first.transitions, { [refusals.id]: { ...refusals, notifyOnOpen: false } })).toEqual([]);
    expect(planActions(first.transitions, { [refusals.id]: refusals }, { mode: 'shadow', notifySet: new Set() }))
      .toContainEqual(expect.objectContaining({ kind: 'notify', suppressed: 'shadow mode' }));
  });
});
