import { describe, it, expect } from 'vitest';
import smell, { landedNothing } from '../drain-landed-nothing.mjs';

const now = Date.parse('2026-11-03T12:00:00Z');
const pass = (minAgo, o = {}) => ({ at: now - minAgo * 60000, considered: 4, merged: 0, skippedPrs: [], deferredDetail: [], ...o });
describe('drain-landed-nothing', () => {
  it('breaches when every pass in 30 min considered PRs and merged none, naming the reason', () => {
    const h = [pass(60), pass(25), pass(10, { skippedPrs: ['#6244 red-main-hold: freeze-unreadable'] }), pass(2)];
    const [r] = smell.evaluate({ drainHistory: h }, { now });
    expect(r.breach).toBe(true);
  });
  it('carries the latest hold reason', () => {
    const r = landedNothing([pass(60), pass(20), pass(3, { skippedPrs: ['red-main-hold: freeze-unreadable'] })], { now });
    expect(r.reason).toMatch(/freeze-unreadable/);
  });
  it('no breach when something merged, nothing was queued, or too few passes', () => {
    expect(landedNothing([pass(60), pass(20, { merged: 1 }), pass(3)], { now })).toBeNull();
    expect(landedNothing([pass(60), pass(20, { considered: 0, exit: 0 }), pass(3, { considered: 0, exit: 0 })], { now })).toBeNull();
    expect(landedNothing([pass(3)], { now })).toBeNull();
  });
  it('is a high-severity alert that repeats reminders (delivery proven in drain-landed-nothing-delivery.test.mjs)', () => {
    expect(smell).toMatchObject({ severity: 'high', action: 'alert', repeatReminders: true });
  });
});
