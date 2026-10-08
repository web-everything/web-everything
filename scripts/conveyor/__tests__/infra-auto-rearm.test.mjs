import { describe, it, expect } from 'vitest';
import { autoRearmDecision, rearmInfraBlock, retryDecision, DEFAULT_MAX_ATTEMPTS } from '../infra-blocked.mjs';

const NOW = Date.parse('2026-10-08T08:00:00Z');
const capped = (extra = {}) => ({ num: '4381', ref: 'lane/x', cause: 'GitHub outage (transient)', attempt: DEFAULT_MAX_ATTEMPTS,
  refusals: 0, lastAttemptAt: '2026-10-08T07:59:00Z', nextRetryAt: '2026-10-08T08:30:00Z', ...extra });

describe('auto re-arm of attempt-capped entries after a finished GitHub outage', () => {
  it('is capped (surfaced) before the re-arm', () => {
    expect(retryDecision(capped(), { now: NOW })).toEqual({ action: 'surface', reason: 'attempt-cap' });
  });
  it('re-arms once GitHub status is operational again (cause refined to transient)', () => {
    expect(autoRearmDecision(capped(), { now: NOW })).toEqual({ rearm: true, why: 'github-operational' });
  });
  it('re-arms a still-labelled outage only after the cool-off', () => {
    const e = capped({ cause: 'GitHub outage' });
    expect(autoRearmDecision(e, { now: NOW, cooloffMs: 3_600_000 }).rearm).toBe(false);
    expect(autoRearmDecision(e, { now: NOW + 3_600_000, cooloffMs: 3_600_000 })).toEqual({ rearm: true, why: 'cool-off' });
  });
  it('is bounded by the knob and never touches non-outage or refusal-capped entries', () => {
    expect(autoRearmDecision(capped({ autoRearms: 2 }), { now: NOW, maxAutoRearms: 2 }).rearm).toBe(false);
    expect(autoRearmDecision(capped(), { now: NOW, maxAutoRearms: 0 }).rearm).toBe(false);
    expect(autoRearmDecision(capped({ cause: 'GitHub rate limit' }), { now: NOW }).rearm).toBe(false);
    expect(autoRearmDecision(capped({ refusals: 3 }), { now: NOW }).rearm).toBe(false);
    expect(autoRearmDecision(capped({ attempt: 3 }), { now: NOW }).rearm).toBe(false);
  });
  it('rearmInfraBlock auto mode resets the attempt and counts the re-arm', () => {
    const [e] = rearmInfraBlock([capped({ autoRearms: 1 })], '4381', NOW, { auto: true });
    expect(e.attempt).toBe(1);
    expect(e.autoRearms).toBe(2);
    expect(retryDecision(e, { now: NOW }).action).toBe('retry');
    expect(rearmInfraBlock([capped()], '4381', NOW)[0].autoRearms).toBeUndefined();
  });
});
