import { describe, it, expect } from 'vitest';
import { correctnessSeatVendor, resolveBuilder, resolveCorrectnessSeatRouting } from '../review-seat-routing.mjs';
import { buildDelegationMarker, DELEGATION_TASK_TYPES } from '../delegation-marker.mjs';

const CLAUDE = 'x\n\nCo-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>';

describe('review.seatRouting.correctness', () => {
  it('mode B: a Claude-built PR (trailer) gets a codex correctness seat', () => {
    expect(correctnessSeatVendor({ mode: 'B', headMessage: CLAUDE })).toBe('codex');
  });
  it('mode B: a Claude delegation marker gets codex; a Codex-built PR keeps claude', () => {
    expect(correctnessSeatVendor({ mode: 'B', body: buildDelegationMarker({ provider: 'claude', model: 'm', taskType: DELEGATION_TASK_TYPES[0] }) })).toBe('codex');
    expect(correctnessSeatVendor({ mode: 'B', body: buildDelegationMarker({ provider: 'codex', model: 'm', taskType: DELEGATION_TASK_TYPES[0] }) })).toBe('claude');
  });
  it('mode B: an unknown builder keeps today\'s claude route', () => {
    expect(resolveBuilder({}).provider).toBe('unknown');
    expect(correctnessSeatVendor({ mode: 'B' })).toBe('claude');
  });
  it('mode A (built-in) never moves the seat', () => {
    expect(correctnessSeatVendor({ mode: 'A', headMessage: CLAUDE })).toBe('claude');
    expect(correctnessSeatVendor({ headMessage: CLAUDE })).toBe('claude');
  });
  it('setting cascade: env > file > built-in A', () => {
    expect(resolveCorrectnessSeatRouting({ env: {}, readFile: () => '{}' })).toEqual({ value: 'A', source: 'default' });
    expect(resolveCorrectnessSeatRouting({ env: {}, readFile: () => '{"seatRouting":{"correctness":"B"}}' })).toEqual({ value: 'B', source: 'settings' });
    expect(resolveCorrectnessSeatRouting({ env: { WE_REVIEW_SEAT_ROUTING_CORRECTNESS: 'a' }, readFile: () => '{"seatRouting":{"correctness":"B"}}' }).value).toBe('A');
  });
});
