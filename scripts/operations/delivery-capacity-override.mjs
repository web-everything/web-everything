/** S3 delivery-capacity hold/pin/clear operations; they wrap the host override store through an injected sink. */
import { op } from './registry.mjs';
import { compute, effect } from './step-kinds.mjs';
import { OVERRIDE_MAX_HOURS } from '../lib/operator-override-reader.mjs';

export const DELIVERY_CAPACITY_OVERRIDE_OPS = Object.freeze(['delivery-capacity-hold', 'delivery-capacity-pin', 'delivery-capacity-clear']);
export const DELIVERY_CAPACITY_OVERRIDE_EFFECT = 'delivery-capacity-override.write';
const KEYS = Object.freeze({ hold: 'deliveryCapacity.holdUntil', pin: 'deliveryCapacity.pinUntil', units: 'deliveryCapacity.pinUnits' });
const UNITS = { m: 60000, h: 3600000 };

/** `4h` / `10m` (fractions allowed); refuses anything else and clamps to the 72h cap. */
export function parseDuration(text) {
  const match = /^(\d+(?:\.\d+)?)([mh])$/.exec(String(text ?? '').trim());
  const ms = match ? Number(match[1]) * UNITS[match[2]] : NaN;
  if (!Number.isFinite(ms) || ms < 60000) throw Error(`--for must look like 30m or 4h (at least 1m); got ${JSON.stringify(text)}`);
  const cap = OVERRIDE_MAX_HOURS * UNITS.h;
  return ms > cap ? { ms: cap, clamped: true } : { ms: Math.round(ms), clamped: false };
}
export function planCapacityOverride(name, input = {}, nowMs = Date.now()) {
  const reason = String(input.reason ?? '').trim();
  if (name === 'delivery-capacity-clear') {
    return { clears: [KEYS.hold, KEYS.pin, KEYS.units], writes: [], reason: reason || 'delivery-capacity clear' };
  }
  const { ms, clamped } = parseDuration(input.for);
  const until = nowMs + ms;
  if (name === 'delivery-capacity-hold') {
    if (!reason) throw Error('--reason must be non-empty');
    return { writes: [{ key: KEYS.hold, value: until }], clears: [], reason, clamped, until };
  }
  if (name === 'delivery-capacity-pin') {
    if (!Number.isInteger(input.units) || input.units < 1 || input.units > 200) throw Error('--units must be an integer from 1 to 200');
    return { writes: [{ key: KEYS.units, value: input.units }, { key: KEYS.pin, value: until }], clears: [],
      reason: reason || 'delivery-capacity pin', clamped, until };
  }
  throw Error(`Unknown delivery-capacity override operation: ${name}`);
}
export function deliveryCapacityOverrideOperation(name, { now = Date.now } = {}) {
  if (!DELIVERY_CAPACITY_OVERRIDE_OPS.includes(name)) throw Error(`Unknown delivery-capacity override operation: ${name}`);
  const optional = type => ({ type, required: false });
  const input = name === 'delivery-capacity-hold' ? { for: 'string', reason: 'string' }
    : name === 'delivery-capacity-pin' ? { units: 'number', for: 'string', reason: optional('string') }
      : { reason: optional('string') };
  return op(name, {
    input, verdictFrom: 'plan',
    plan: compute({ reads: ['input'], fn: ({ input: given }) => planCapacityOverride(name, given, now()) }),
    write: effect({ reads: ['verdict'], effects: view => [{ type: DELIVERY_CAPACITY_OVERRIDE_EFFECT,
      idempotent: true, payload: view.verdict }] }),
  });
}
