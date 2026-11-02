// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { assessWorkerCapacity, computeCap, fitWorkerCost, parseSamples, renderWorkerCapacity, resolveWorkerCapacitySettings, stepRuleCap } from '../../lib/worker-capacity.mjs';
import { finishWorkerCapacity, workerCapacityOperation } from '../worker-capacity.mjs';

const NOW = Date.parse('2026-11-01T22:00:00Z');
const row = (minAgo, load1, total) => JSON.stringify({ sampledAt: new Date(NOW - minAgo * 60000).toISOString(), cpu: { loadAvg: [load1, 0, 0] }, agentSessions: { total } });
// load = 6 + 3 * sessions, sessions cycle 1..6
const history = Array.from({ length: 48 }, (_, i) => row(i + 1, 6 + 3 * ((i % 6) + 1), (i % 6) + 1)).join('\n');
const settings = resolveWorkerCapacitySettings();

describe('worker capacity (shadow)', () => {
  it('step rule matches R349', () => {
    expect([10, 23.9, 24, 35.9, 36, 80].map(stepRuleCap)).toEqual([8, 8, 5, 5, 0, 0]);
  });
  it('fits baseline and per-worker cost and computes floor((target-baseline)/cost) clamped', () => {
    const fit = fitWorkerCost(parseSamples(history, { nowMs: NOW }));
    expect(fit.method).toBe('regression');
    expect(fit.baseline).toBeCloseTo(6, 5); expect(fit.perWorkerCost).toBeCloseTo(3, 5);
    expect(computeCap({ targetLoad: 30, ceiling: 10, ...fit })).toBe(8);
    expect(computeCap({ targetLoad: 300, ceiling: 10, ...fit })).toBe(10);
    expect(computeCap({ targetLoad: 1, ceiling: 10, ...fit })).toBe(1);
  });
  it('drops samples outside the last hour, in the future, or malformed', () => {
    const text = [row(90, 5, 1), row(-5, 5, 1), 'nope', '{"sampledAt":"x"}', row(10, 5, 1)].join('\n');
    expect(parseSamples(text, { nowMs: NOW })).toHaveLength(1);
  });
  it('falls back to a ratio when sessions never vary, and reports insufficient data', () => {
    const flat = Array.from({ length: 40 }, (_, i) => ({ at: i, load1: 12, sessions: 4 }));
    expect(fitWorkerCost(flat)).toMatchObject({ method: 'ratio', baseline: 0, perWorkerCost: 3 });
    expect(fitWorkerCost(flat.slice(0, 3)).method).toBe('insufficient');
    expect(computeCap({ targetLoad: 30, ceiling: 10, baseline: null, perWorkerCost: null })).toBeNull();
  });
  it('settings cascade: defaults, repo, env, invalid ignored', () => {
    expect(settings).toMatchObject({ targetLoad: 30, ceiling: 10 });
    const r = resolveWorkerCapacitySettings({ settings: { workerCapacity: { targetLoad: 20, ceiling: -1 } }, env: { WE_WORKER_CAPACITY_CEILING: '6' } });
    expect(r).toMatchObject({ targetLoad: 20, ceiling: 6, sources: { targetLoad: 'repo', ceiling: 'env' } });
  });
  it('assess puts the measured cap next to the step rule and renders both', () => {
    const a = assessWorkerCapacity({ historyText: history, load1: 28, settings, nowMs: NOW });
    expect(a).toMatchObject({ cap: 8, stepCap: 5, shadow: true });
    const text = renderWorkerCapacity(a);
    expect(text).toContain('measured cap 8'); expect(text).toContain('R349 step rule 5');
  });
  it('operation needs a reader and finish logs the row without failing on log errors', () => {
    expect(() => workerCapacityOperation()).toThrow(/collect/);
    const rows = [];
    const out = finishWorkerCapacity({ log: (r) => rows.push(r) })({ run: { verdict: assessWorkerCapacity({ historyText: history, load1: 28, settings, nowMs: NOW }) }, code: 0, lines: [] });
    expect(rows).toHaveLength(1); expect(out.lines[0]).toContain('SHADOW');
    expect(() => finishWorkerCapacity({ log: () => { throw new Error('x'); } })({ run: { verdict: rows[0] }, code: 0, lines: [] })).not.toThrow();
  });
});
