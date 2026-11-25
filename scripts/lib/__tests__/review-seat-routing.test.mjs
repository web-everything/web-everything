import { describe, it, expect } from 'vitest';
import { correctnessSeatVendor, claudeTrailerIn, resolveCorrectnessSeatRouting } from '../review-seat-routing.mjs';

const CLAUDE = 'x\n\nCo-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>';

describe('review.seatRouting.correctness', () => {
  it('mode B: a Claude trailer on any PR commit gets a codex correctness seat', () => {
    expect(correctnessSeatVendor({ mode: 'B', commitMessages: CLAUDE })).toBe('codex');
    expect(correctnessSeatVendor({ mode: 'B', commitMessages: ['plain', CLAUDE] })).toBe('codex');
  });
  it('mode B: no Claude trailer (Codex-built or unknown) keeps today\'s claude route', () => {
    expect(correctnessSeatVendor({ mode: 'B', commitMessages: 'Co-Authored-By: Codex <a@b>' })).toBe('claude');
    expect(correctnessSeatVendor({ mode: 'B' })).toBe('claude');
    expect(claudeTrailerIn(undefined)).toBe(false);
  });
  it('mode A (built-in) never moves the seat', () => {
    expect(correctnessSeatVendor({ mode: 'A', commitMessages: CLAUDE })).toBe('claude');
    expect(correctnessSeatVendor({ commitMessages: CLAUDE })).toBe('claude');
  });
  it('setting cascade: env > file > built-in; unreadable settings keep the Claude route', () => {
    expect(resolveCorrectnessSeatRouting({ env: {}, readFile: () => '{}' })).toEqual({ value: 'A', source: 'default' });
    expect(resolveCorrectnessSeatRouting({ env: {}, readFile: () => '{"seatRouting":{"correctness":"B"}}' })).toEqual({ value: 'B', source: 'settings' });
    expect(resolveCorrectnessSeatRouting({ env: { WE_REVIEW_SEAT_ROUTING_CORRECTNESS: 'a' }, readFile: () => '{"seatRouting":{"correctness":"B"}}' }).value).toBe('A');
    const broken = resolveCorrectnessSeatRouting({ env: {}, readFile: () => { throw new Error('nope'); } });
    expect(correctnessSeatVendor({ mode: broken.value, commitMessages: CLAUDE })).toBe('claude');
  });
});
