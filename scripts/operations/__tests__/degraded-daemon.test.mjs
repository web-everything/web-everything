import { describe, it, expect } from 'vitest';
import { assessDegraded } from '../degraded-daemon.mjs';

const now = Date.parse('2026-11-18T12:00:00Z');
const event = (kind, age, daemon = 'wev-control') => ({ kind, at: new Date(now - age * 60000).toISOString(), daemon });
const assess = events => assessDegraded({ events, daemon: 'control', clone: '/workspace/wev-control', now, afterMinutes: 60 });
describe('R1075 daemon log assessor', () => {
  it('degraded: oldest unresolved signal exceeds threshold', () => {
    expect(assess([event('overlay-adoption-overdue', 90)])).toMatchObject({ degraded: true, evidence: { ageMinutes: 90, lastAdoptionAt: null, afterMinutes: 60 } });
  });
  it('healthy: an adoption resolves earlier signals', () => {
    expect(assess([event('overlay-adoption-overdue', 120), event('rebuild-adopted', 90)])).toMatchObject({ degraded: false, evidence: { signals: [] } });
  });
  it('below threshold refuses, including a new signal after an old adoption', () => {
    expect(assess([event('overlay-adoption-overdue', 59)])).toMatchObject({ degraded: false });
    expect(assess([event('rebuild-adopted', 120), event('overlay-adoption-overdue', 10)])).toMatchObject({ degraded: false });
  });
  it('recent adoption prevents degradation despite an old signal', () => {
    expect(assess([event('overlay-adoption-overdue', 120), event('overlay-adopted', 10)])).toMatchObject({ degraded: false });
  });
  it.each([undefined, null, '', [], 'unreadable json', '{}\ntruncated', [{ kind: 'overlay-adoption-overdue', daemon: 'control', at: 'invalid' }]])('empty/unreadable evidence %j fails closed', events => {
    expect(assess(events).degraded).toBe(false);
  });
  it.each(['ready-candidate-discarded', 'ready-candidate-discarded-needs-you', 'REBUILD-DISCARD-LOOP', 'rebuild-discard-loop'])('recognizes discard-loop kind %s from JSONL', kind => {
    expect(assess(JSON.stringify(event(kind, 61)))).toMatchObject({ degraded: true, evidence: { signals: [{ kind, at: event(kind, 61).at }] } });
  });
  it('foreign daemon signals and foreign recovery cannot decide this daemon', () => {
    expect(assess([event('overlay-adoption-overdue', 120, 'review')]).degraded).toBe(false);
    expect(assess([event('overlay-adoption-overdue', 120), event('rebuild-adopted', 1, 'review')]).degraded).toBe(true);
  });
  it('old recovery leaves only later signals unresolved, regardless of log order', () => {
    expect(assess([event('overlay-adoption-overdue', 65), event('rebuild-adopted', 80), event('overlay-adoption-overdue', 120)])).toMatchObject({ degraded: true, evidence: { ageMinutes: 65, signals: [expect.objectContaining({ at: event('overlay-adoption-overdue', 65).at })] } });
  });
  it('future recovery and invalid thresholds fail closed', () => {
    expect(assess([event('overlay-adoption-overdue', 120), event('rebuild-adopted', -1)]).degraded).toBe(false);
    expect(assessDegraded({ events: [event('overlay-adoption-overdue', 120)], daemon: 'control', clone: '/workspace/wev-control', now, afterMinutes: 0 }).degraded).toBe(false);
  });
});
