/** @file Pure incident replays: a lease is never proof of live work. No IO or wall clock. */
import { describe, it, expect } from 'vitest';
import { derivePrState, settingsFromEnv, DEFAULTS } from '../pr-state-core.mjs';
const base = { pr: 4017, now: '2026-10-06T12:00:00Z', state: 'OPEN', labels: ['review:changes'],
  head: { sha: 'abcdef0123456789', committedAt: '2026-10-06T10:00:00Z' },
  requiredChecks: [{ name: 'test', state: 'green' }], sessions: [], handoffs: [], refusals: [] };
const ended = { name: 'fix-4017', kind: 'fix', live: false, state: 'done',
  startedAt: '2026-10-06T11:00:00Z', endedAt: '2026-10-06T11:50:00Z', outcome: 'blocked-on-load-flake' };
const claim = { held: true, owner: 'fix-4017', kind: 'fix' };
const derive = (overrides, settings) => derivePrState({ ...base, ...overrides }, settings);
describe('derivePrState', () => {
  it('recognizes a live busy fixer despite a held claim', () => {
    const result = derive({ claim, sessions: [{ ...ended, live: true, state: 'busy' }] });
    expect(result.phase).toBe('FIXING'); expect(result.headline).toContain('live fix-4017');
  });
  it('recognizes live review before human holds', () => {
    expect(derive({ labels: ['review:human'], sessions: [{ ...ended, kind: 'review', live: true }] }).phase).toBe('IN-REVIEW');
  });
  it('new push after a hand-off waits for its checks', () => {
    const result = derive({ sessions: [ended], claim,
      head: { ...base.head, committedAt: '2026-10-06T11:55:00Z' }, requiredChecks: [{ name: 'test', state: 'pending' }] });
    expect(result.phase).toBe('WAITING-CI'); expect(result.evidence.join(' ')).toContain('new head pushed');
  });
  it('without a new push the load-flake hand-off owns the next event', () => {
    const result = derive({ sessions: [ended], claim });
    expect(result.phase).toBe('HANDED-OFF'); expect(result.next).toContain('load-flake-reverify');
  });
  it('a new green head proceeds to review, not the old hand-off', () => {
    expect(derive({ sessions: [ended], head: { ...base.head, committedAt: '2026-10-06T11:55:00Z' } }).phase).toBe('IN-REVIEW');
  });
  it('an ended claim owner with no new head is stuck', () => {
    const result = derive({ claim, sessions: [{ ...ended, outcome: 'failed' }] });
    expect(result.phase).toBe('STUCK'); expect(result.headline).toContain('claim held, session ended failed, no new head');
  });
  it('no owner past grace is stuck, but within grace is dispatch hand-off', () => {
    expect(derive({}).headline).toBe('no owner');
    expect(derive({ head: { ...base.head, committedAt: '2026-10-06T11:55:00Z' } }).phase).toBe('HANDED-OFF');
  });
  it('flags an advisory covering an older head and includes its text', () => {
    const result = derive({ labels: ['review:human'], advisory: { coveredHead: '12345678', text: 'needs a design decision' } });
    expect(result.phase).toBe('NEEDS-OPERATOR'); expect(result.headline).toContain('OLDER head');
    expect(result.evidence.join(' ')).toContain('12345678: needs a design decision');
  });
  it.each(['MERGED', 'CLOSED'])('terminal %s outranks live sessions', state => {
    expect(derive({ state, sessions: [{ ...ended, live: true }] }).phase).toBe(state);
  });
  it('requires green required checks on the current head for ready', () => {
    expect(derive({ labels: ['ready-to-merge'] }).phase).toBe('READY-TO-MERGE');
    expect(derive({ labels: ['ready-to-merge'], requiredChecks: [{ name: 'test', state: 'missing' }] }).phase).toBe('WAITING-CI');
    expect(derive({ labels: ['ready-to-merge'], requiredChecks: [] }).phase).not.toBe('READY-TO-MERGE');
  });
  it('referrals precede human gates', () => {
    expect(derive({ referrals: { pending: ['finding'], ruled: [] }, roundCapNote: true }).phase).toBe('NEEDS-RULING');
  });
  it.each([{ roundCapNote: true }, { needsDecisionNote: true }, { refusals: [{ text: 'cap-exhausted', at: base.now }] }])('operator gates %j', gate => {
    expect(derive(gate).phase).toBe('NEEDS-OPERATOR');
  });
  it('review and hand-offs become stuck only past their thresholds', () => {
    expect(derive({ labels: ['review:pending'] }).phase).toBe('STUCK');
    expect(derive({ labels: ['review:pending'] }, { reviewStaleMin: 180 }).phase).toBe('IN-REVIEW');
    expect(derive({ sessions: [ended] }, { handoffStaleMin: 5 }).phase).toBe('STUCK');
  });
  it('unknown clocks or failed owner probes do not prove no owner', () => {
    expect(derive({ head: { sha: 'abc' } }).phase).toBe('NEEDS-OPERATOR');
    expect(derive({ probeErrors: ['claude agents unavailable'] }).phase).toBe('NEEDS-OPERATOR');
    expect(derive({ claim }).phase).not.toBe('FIXING');
  });
  it('all thresholds support environment overrides and reject invalid values', () => {
    expect(settingsFromEnv({})).toEqual(DEFAULTS);
    expect(settingsFromEnv({ WE_STATE_DISPATCH_GRACE_MIN: '0', WE_STATE_REVIEW_STALE_MIN: '90', WE_STATE_HANDOFF_STALE_MIN: '120' }))
      .toEqual({ dispatchGraceMin: 0, reviewStaleMin: 90, handoffStaleMin: 120 });
    expect(settingsFromEnv({ WE_STATE_DISPATCH_GRACE_MIN: '-1', WE_STATE_REVIEW_STALE_MIN: 'NaN' })).toEqual(DEFAULTS);
  });
});
