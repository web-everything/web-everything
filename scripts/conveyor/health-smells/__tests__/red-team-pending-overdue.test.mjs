import { describe, it, expect } from 'vitest';
import smell from '../red-team-pending-overdue.mjs';
import { emptyHealthState, stepEpisodes, planActions } from '../../health-watch-core.mjs';
const now = Date.parse('2026-11-24T12:00:00Z');
const row = (minutes, extra = {}) => ({ repo: 'o/r', number: 7, headRefOid: 'abcdef123456',
  title: 'Pending review', labels: [{ name: 'red-team:pending' }],
  redTeamPendingSince: new Date(now - minutes * 60000).toISOString(), ...extra });
const evaluate = (pr, max = 45) => smell.evaluate({ prs: [pr] }, { now, config: { drain: { redTeamPendingMaxMin: max } } });
describe('red-team-pending-overdue', () => {
  it('fires at 2x the max pending time', () => {
    expect(evaluate(row(90))[0]).toMatchObject({ breach: true, subject: 'o/r#7@abcdef1',
      measure: { pendingForMin: 90, head: 'abcdef123456', title: 'Pending review' } });
  });
  it.each([[89, false], [90, true], [91, true]])('at %i minutes breach is %s', (age, breach) => {
    expect(evaluate(row(age, { labels: ['red-team:pending'] }))[0].breach).toBe(breach);
  });
  it('draft PR with pending is ignored', () => expect(evaluate(row(100, { isDraft: true }))[0].breach).toBe(false));
  it('blocked label is another path and does not breach here', () => {
    expect(evaluate(row(100, { labels: ['red-team:pending', 'red-team:blocked'] }))[0].breach).toBe(false);
  });
  it('a contradictory clear label never hides an overdue pending', () => {
    expect(evaluate(row(100, { labels: ['red-team:pending', 'red-team:clear'] }))[0].breach).toBe(true);
  });
  it.each([undefined, 'invalid'])('missing or unreadable pending-since is unknown and alerts: %s', redTeamPendingSince => {
    expect(evaluate(row(100, { redTeamPendingSince }))[0]).toMatchObject({ breach: true, measure: { pendingForMin: null } });
  });
  it('a new head has a new alert identity', () => {
    expect(evaluate(row(100))[0].subject).not.toBe(evaluate(row(100, { headRefOid: '1234567abcdef' }))[0].subject);
  });
  it('without pending is clean', () => expect(evaluate(row(100, { labels: [] }))[0].breach).toBe(false));
});

it('recent updatedAt cannot hide old pending-since', () => {
  expect(evaluate(row(100, { updatedAt: new Date(now).toISOString() }))[0].breach).toBe(true);
});
it('old updatedAt cannot age a recently added pending label', () => {
  expect(evaluate(row(10, { updatedAt: new Date(now - 999 * 60000).toISOString() }))[0].breach).toBe(false);
});
it('uses twice the configured drain max', () => {
  expect(evaluate(row(41), 20)[0].breach).toBe(true);
  expect(evaluate(row(100), 60)[0].breach).toBe(false);
});
const step = (state, prs) => stepEpisodes(state, [{ smell, results: smell.evaluate({ prs },
  { now, config: { drain: { redTeamPendingMaxMin: 45 } } }) }], now);
it('unknown labels do not clear an open episode', () => {
  const opened = step(emptyHealthState(), [row(100)]).state;
  const unknown = step(opened, [row(100, { labels: [], labelsValid: false })]);
  expect(unknown.transitions.some(t => t.type === 'closed')).toBe(false);
  expect(Object.values(unknown.state.episodes)[0].measure.pendingForMin).toBeNull();
});
it('partial inventory and deferred empty inventory do not clear absent subjects', () => {
  const opened = step(emptyHealthState(), [row(100)]).state;
  for (const prs of [Object.assign([], { inventoryComplete: false }),
    [row(1, { number: 8, inventoryComplete: false })]]) {
    const next = step(opened, prs);
    expect(next.transitions.some(t => t.type === 'closed')).toBe(false);
    expect(Object.values(next.state.episodes)).toHaveLength(1);
  }
});
it('a readable removal closes an open episode', () => {
  const opened = step(emptyHealthState(), [row(100)]).state;
  expect(step(opened, [row(100, { labels: [] })]).transitions.map(t => t.type)).toContain('closed');
});

it('is alert-only even when investigation and filing dispatch are enabled', () => {
  expect(smell.action).toBe('alert');
  const opened = step(emptyHealthState(), [row(100)]);
  const plan = planActions(opened.transitions, { [smell.id]: smell },
    { mode: 'active', investigateDispatch: true, fileDispatch: true });
  expect(plan.some(p => ['investigate', 'file', 'repair'].includes(p.kind))).toBe(false);
});
