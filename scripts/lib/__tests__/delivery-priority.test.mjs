import { describe, it, expect } from 'vitest';
import { deliveryPriority, rankByDeliveryPriority, PRIORITY_OVERRIDE_CLASSES } from '../delivery-priority.mjs';

const settings = { mode: 'enforce', agingHours: 8, maxLiveP0: 2, unblockWeightMinutes: 60 };
const now = Date.parse('2026-10-09T12:00:00Z');

describe('operator delivery priority overrides', () => {
  it('declares the frozen operator override classes', () => {
    expect(PRIORITY_OVERRIDE_CLASSES).toEqual({ urgent: 'P0', now: 'P1', low: 'P4' });
    expect(Object.isFrozen(PRIORITY_OVERRIDE_CLASSES)).toBe(true);
  });

  it('classes a verified build-now request as P1', () => {
    const result = deliveryPriority({ override: { value: 'now', byOperator: true } }, settings, now);
    expect(result).toMatchObject({ class: 'P1', override: 'now', p0Kind: null });
    expect(result.reasons).toContain('operator override now');
  });

  it('ignores an unverified build-now request', () => {
    const result = deliveryPriority({ override: { value: 'now', byOperator: false } }, settings, now);
    expect(result).toMatchObject({ class: 'P3', override: null });
    expect(result.reasons).toContain('override now ignored: not verified as operator-set');
  });

  it('keeps build-now at P3 when priority is off', () => {
    expect(deliveryPriority({ override: { value: 'now', byOperator: true } }, { ...settings, mode: 'off' }, now).class).toBe('P3');
  });

  it('ranks incident, build-now, operator-requested, then normal across classes', () => {
    const ranked = rankByDeliveryPriority([
      { id: 'normal', facts: {} },
      { id: 'requested', facts: { operatorRequested: true } },
      { id: 'now', facts: { override: { value: 'now', byOperator: true } } },
      { id: 'incident', facts: { incident: { open: true, owner: true } } },
    ], settings, now);
    expect(ranked.map(({ id, class: cls }) => [id, cls])).toEqual([
      ['incident', 'P0'], ['now', 'P1'], ['requested', 'P2'], ['normal', 'P3'],
    ]);
  });

  it('never caps operator overrides, preserving urgent and low behavior', () => {
    const ranked = rankByDeliveryPriority(['now', 'urgent', 'low'].map(value => ({
      id: value, facts: { override: { value, byOperator: true } },
    })), { ...settings, maxLiveP0: 0 }, now);
    expect(ranked.map(({ id, class: cls, override, p0Kind, reasons }) => ({ id, class: cls, override, p0Kind, reasons }))).toEqual([
      { id: 'urgent', class: 'P0', override: 'urgent', p0Kind: 'override', reasons: ['normal', 'operator override urgent'] },
      { id: 'now', class: 'P1', override: 'now', p0Kind: null, reasons: ['normal', 'operator override now'] },
      { id: 'low', class: 'P4', override: 'low', p0Kind: null, reasons: ['normal', 'operator override low'] },
    ]);
  });
});
