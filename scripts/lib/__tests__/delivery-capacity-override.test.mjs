import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessCapacity, renderCapacityLine } from '../delivery-capacity.mjs';
import { CAPACITY_LEAVES, OVERRIDE_MAX_HOURS, validateKey, readOperatorOverrides } from '../operator-override-reader.mjs';
import { planCapacityOverride, parseDuration } from '../../operations/delivery-capacity-override.mjs';

const NOW = Date.parse('2026-11-15T20:00:00Z'); // 3:00 PM ET
const H = 3600000;
const HOST = { idlePct: 30, memGb: 8 };
const prs = n => Array.from({ length: n }, (_, i) => ({ number: i + 1, additions: 10, deletions: 0,
  labels: [], files: [{ path: 'scripts/x.mjs' }], updatedAt: new Date(NOW).toISOString() }));
const run = (overrides, n = 2) => assessCapacity({ prs: prs(n), host: HOST, nowMs: NOW,
  policy: { mode: 'units', unitCap: 30, openPrCap: 18 }, overrides });
const ok = values => ({ readable: true, values });

describe('S3 override leaves', () => {
  it('validateKey accepts the new leaves and they validate', () => {
    for (const key of ['deliveryCapacity.pinUnits', 'deliveryCapacity.pinUntil', 'deliveryCapacity.holdUntil']) {
      expect(() => validateKey(key)).not.toThrow();
    }
    expect(CAPACITY_LEAVES['deliveryCapacity.pinUnits'].validate(201)).toBe(false);
    expect(CAPACITY_LEAVES['deliveryCapacity.holdUntil'].validate('2026-11-15')).toBe(false);
    expect(CAPACITY_LEAVES['deliveryCapacity.holdUntil'].validate(Date.now() + 73 * 3600000)).toBe(false);
    expect(CAPACITY_LEAVES['deliveryCapacity.pinUntil'].validate(Date.now() + 71 * 3600000)).toBe(true);
    expect(OVERRIDE_MAX_HOURS).toBe(72);
  });
});
describe('S3 precedence and expiry', () => {
  it('no override leaves build', () => expect(run(ok({})).verdict).toBe('build'));
  it('hold means deliver with zero slots and a readout line', () => {
    const r = run({ ...ok({ 'deliveryCapacity.holdUntil': NOW + 2 * H + 10 * 60000 }), holdReason: 'review backlog' });
    expect(r.verdict).toBe('deliver');
    expect(r.slots).toBe(0);
    const line = renderCapacityLine(r);
    expect(line).toContain('HOLD until 5:10 PM ET (review backlog), 2h10m left');
  });
  it('hold beats pin', () => {
    const r = run(ok({ 'deliveryCapacity.holdUntil': NOW + H, 'deliveryCapacity.pinUnits': 100, 'deliveryCapacity.pinUntil': NOW + H }));
    expect(r.verdict).toBe('deliver');
  });
  it('pin replaces the unit cap until it expires', () => {
    const live = run(ok({ 'deliveryCapacity.pinUnits': 1, 'deliveryCapacity.pinUntil': NOW + H }), 3);
    expect(live.cap).toBe(1);
    expect(live.verdict).toBe('deliver');
    expect(renderCapacityLine(live)).toContain('PIN 1u until');
    expect(run(ok({ 'deliveryCapacity.pinUnits': 1, 'deliveryCapacity.pinUntil': NOW - 1 }), 3).cap).toBe(30);
  });
  it('a live pin expiry without units fails closed to deliver', () => {
    const r = run(ok({ 'deliveryCapacity.pinUntil': NOW + H }));
    expect(r.verdict).toBe('deliver');
    expect(r.why.join(' ')).toContain('has no deliveryCapacity.pinUnits');
  });
  it('pin without an expiry is ignored', () => expect(run(ok({ 'deliveryCapacity.pinUnits': 1 }), 3).cap).toBe(30));
  it('expiry boundary: until == now is expired, one ms later is live', () => {
    expect(run(ok({ 'deliveryCapacity.holdUntil': NOW })).verdict).toBe('build');
    expect(run(ok({ 'deliveryCapacity.holdUntil': NOW + 1 })).verdict).toBe('deliver');
  });
  it('an expired override is reported', () => {
    const r = run(ok({ 'deliveryCapacity.holdUntil': NOW - 1 }));
    expect(r.why.join(' ')).toContain('override expired: deliveryCapacity.holdUntil');
  });
  it('a stored expiry beyond 72h is refused, not honoured', () => {
    const r = run(ok({ 'deliveryCapacity.holdUntil': NOW + 73 * H }));
    expect(r.why.join(' ')).toContain('exceeds 72h');
    expect(r.verdict).toBe('deliver'); // fail closed: a corrupt hold still holds
  });
  it('an unreadable store fails closed to deliver', () => {
    const r = run({ readable: false, values: {} });
    expect(r.verdict).toBe('deliver');
    expect(r.why.join(' ')).toContain('override store unreadable');
  });
  it('an invalid deliveryCapacity leaf fails closed to deliver', () => {
    expect(run({ readable: true, values: {}, invalidPolicies: ['deliveryCapacity'] }).verdict).toBe('deliver');
  });
  it('a closed host gate stays hold under a pin', () => {
    const r = assessCapacity({ prs: prs(1), host: { idlePct: 1, memGb: 1 }, nowMs: NOW,
      policy: { mode: 'units' }, overrides: ok({ 'deliveryCapacity.pinUnits': 50, 'deliveryCapacity.pinUntil': NOW + H }) });
    expect(r.verdict).toBe('hold');
  });
  it('the real store reader returns the new leaves', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'dco-')), 'o.json');
    writeFileSync(file, JSON.stringify({ 'deliveryCapacity.holdUntil': NOW + H }));
    expect(readOperatorOverrides({ file }).values['deliveryCapacity.holdUntil']).toBe(NOW + H);
  });
});
describe('S3 override plans', () => {
  it('parses durations and clamps to 72h', () => {
    expect(parseDuration('4h')).toEqual({ ms: 4 * H, clamped: false });
    expect(parseDuration('10m')).toEqual({ ms: 600000, clamped: false });
    expect(parseDuration('100h')).toEqual({ ms: 72 * H, clamped: true });
    for (const bad of ['', '0h', '-1h', 'abc', '4d', 'NaNh']) expect(() => parseDuration(bad)).toThrow();
  });
  it('hold plan writes one expiry; pin writes units and expiry; clear clears all three', () => {
    expect(planCapacityOverride('delivery-capacity-hold', { for: '4h', reason: 'x' }, NOW).writes)
      .toEqual([{ key: 'deliveryCapacity.holdUntil', value: NOW + 4 * H }]);
    expect(planCapacityOverride('delivery-capacity-pin', { units: 24, for: '8h' }, NOW).writes).toEqual([
      { key: 'deliveryCapacity.pinUnits', value: 24 }, { key: 'deliveryCapacity.pinUntil', value: NOW + 8 * H }]);
    expect(planCapacityOverride('delivery-capacity-clear', {}, NOW).clears).toHaveLength(3);
    expect(planCapacityOverride('delivery-capacity-hold', { for: '999h', reason: 'x' }, NOW).writes[0].value).toBe(NOW + 72 * H);
  });
  it('hold needs a reason and pin refuses out-of-range units', () => {
    expect(() => planCapacityOverride('delivery-capacity-hold', { for: '1h', reason: ' ' }, NOW)).toThrow();
    expect(() => planCapacityOverride('delivery-capacity-pin', { units: 0, for: '1h' }, NOW)).toThrow();
  });
});
