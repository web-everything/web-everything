/** @file R502 item 3 — the stale-claim-or-binding smell: shape, evaluation, and that it notifies in shadow. */
import { describe, it, expect } from 'vitest';
import smell from '../stale-claim-or-binding.mjs';
import { validateSmellShape } from '../../health-smells-shape.mjs';
import { NOTIFY_EVEN_IN_SHADOW } from '../../health-smells-notify-list.mjs';

const finding = { type: 'stale-claim', repo: 'we', pr: 6300, session: { name: 'fix-6300' }, claimAgeMinutes: 120, holderIdleMinutes: 40, holderClass: 'stalled', headSha: 'abc123456789', thresholdMinutes: 90, idleThresholdMinutes: 20 };
describe('stale-claim-or-binding', () => {
  it('is a valid smell, detection only, and notifies even in shadow', () => {
    expect(() => validateSmellShape(smell, 'stale-claim-or-binding.mjs')).not.toThrow();
    expect(smell.action).toBe('alert');
    expect(NOTIFY_EVEN_IN_SHADOW.has('stale-claim-or-binding')).toBe(true);
  });
  it('breaches once per stale-claim finding and names the measure', () => {
    const out = smell.evaluate({ sessionWatchdog: { findings: [finding, { type: 'fixer-stuck', repo: 'we', pr: 1 }] } });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ subject: 'pr:we#6300', breach: true, measure: { claimAgeMinutes: 120, holderIdleMinutes: 40 } });
    expect(out[0].summary).toContain('120m');
  });
  it('fails closed when the watchdog probe is missing', () => {
    expect(smell.evaluate({ sessionWatchdog: null })).toEqual([]);
    expect(smell.evaluate({})).toEqual([]);
  });
});
