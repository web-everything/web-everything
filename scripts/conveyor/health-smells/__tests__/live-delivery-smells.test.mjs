import { describe, it, expect } from 'vitest';
import workers, { workerLoadSettings } from '../worker-count-vs-load.mjs';
import refusals from '../same-refusal-streak.mjs';
import { SMELLS } from '../index.mjs';
import { NOTIFY_EVEN_IN_SHADOW } from '../../health-smells-notify-list.mjs';
import { validateSmellShape } from '../../health-smells-shape.mjs';
import { emptyHealthState, stepEpisodes, planActions, runHealthTick, MINUTE } from '../../health-watch-core.mjs';
import { foldPrAttempts } from '../../health-pr-attempts.mjs';

const NOW = Date.parse('2026-11-03T12:00:00Z');
const host = (count = 4, load1 = 20) => ({
  machineLoad: { load1, cpuCount: 8 },
  agents: Array.from({ length: count }, (_, i) => ({ name: `fix-${i}`, state: 'running' })),
});
const rows = (reasons, pr = 'owner/repo#42') => reasons.map((reason, i) => ({
  pr, reason, action: 'fix-dispatch', at: NOW - (reasons.length - i) * 1000,
}));
const context = (attempts = [], config = {}) => ({ now: NOW, config, daemons: { fix: { prAttempts: attempts } } });
const same = rows(['no-lane: 1 busy', 'no-lane: 2 busy', 'no-lane: 3 busy']);

describe('live delivery smell descriptors', () => {
  it.each([[workers, 'host', 'high', ['machineLoad', 'agents']], [refusals, 'repo', 'medium', ['daemonLogs']]])(
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
  it('breaches strictly above the cap even at zero load; ignores terminal agents', () => {
    const config = { workerCountVsLoad: { workerCap: 4 } };
    expect(workers.evaluate(host(4, 0), context([], config))[0].breach).toBe(false);
    expect(workers.evaluate(host(5, 0), context([], config))[0].breach).toBe(true);
    const p = host(4, 0);
    p.agents.push(...['done', 'stopped', 'failed'].map(state => ({ state })));
    expect(workers.evaluate(p, context([], config))[0].measure.liveWorkers).toBe(4);
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
    for (const p of [{}, { ...host(), agents: null }, { ...host(), machineLoad: { load1: 20, cpuCount: 0 } },
      { ...host(), agents: [{}] }]) expect(() => workers.evaluate(p, context())).toThrow(/evidence/i);
    const open = runHealthTick(emptyHealthState(), host(), [workers], NOW);
    const next = runHealthTick(open.state, { ...host(), agents: null }, [workers], NOW + MINUTE);
    expect(Object.values(next.state.episodes)[0].cleanStreak).toBe(0);
    expect(next.evaluations[0].error).toMatch(/evidence/i);
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
    expect(refusals.evaluate({}, context(same, { sameRefusalStreak: { streakLength: 1000000 } }))[0].breach).toBe(false);
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
