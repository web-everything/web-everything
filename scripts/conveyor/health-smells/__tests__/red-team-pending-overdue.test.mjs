import { describe, it, expect } from 'vitest';
import smell from '../red-team-pending-overdue.mjs';
const now = Date.parse('2026-11-24T12:00:00Z');
const row = (minutes, extra = {}) => ({ repo: 'o/r', number: 7, headRefOid: 'abcdef123456',
  title: 'Pending review', labels: [{ name: 'red-team:pending' }],
  updatedAt: new Date(now - minutes * 60000).toISOString(), ...extra });
const evaluate = pr => smell.evaluate({ prs: [pr] }, { now });
describe('red-team-pending-overdue', () => {
  it('fires at 2x the max pending time', () => {
    expect(smell.maxPendingMs).toBe(45 * 60000);
    expect(evaluate(row(90))[0]).toMatchObject({ breach: true, subject: 'o/r#7@abcdef1',
      measure: { pendingForMin: 90, head: 'abcdef123456', title: 'Pending review' } });
  });
  it.each([[89, false], [90, true], [91, true]])('at %i minutes breach is %s', (age, breach) => {
    expect(evaluate(row(age, { labels: ['red-team:pending'] }))[0].breach).toBe(breach);
  });
  it('draft PR with pending has no row', () => expect(evaluate(row(100, { isDraft: true }))).toEqual([]));
  it.each(['red-team:blocked', 'red-team:clear'])('%s label prevents breach', label => {
    expect(evaluate(row(100, { labels: ['red-team:pending', { name: label }] })).some(r => r.breach)).toBe(false);
  });
  it.each([undefined, 'invalid'])('missing or unreadable updatedAt never breaches: %s', updatedAt => {
    expect(evaluate(row(100, { updatedAt }))[0]).toMatchObject({ breach: false, measure: { pendingForMin: 0 } });
  });
  it('a new head has a new alert identity', () => {
    expect(evaluate(row(100))[0].subject).not.toBe(evaluate(row(100, { headRefOid: '1234567abcdef' }))[0].subject);
  });
  it('without pending has no row', () => expect(evaluate(row(100, { labels: [] }))).toEqual([]));
});
