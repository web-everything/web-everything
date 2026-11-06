/** R497 — forge-share-below-target: sustained low Forge share alarms; unknown fails closed. */
import { describe, expect, it } from 'vitest';
import smell from '../forge-share-below-target.mjs';
import { NOTIFY_EVEN_IN_SHADOW } from '../../health-smells-notify-list.mjs';

const ok = (share, target = 0.9) => ({ status: 'ok', share, target, belowTarget: share < target, windowMs: 3_600_000, runs: { remote: 1, local: 1, expectedLocal: 0, counted: 2 }, byReason: { 'remote-full': 4 }, expectedLocalByReason: {} });
const unknown = (unknownReason = 'no-remote-success-record') => ({ status: 'unknown', share: null, belowTarget: null, unknownReason });
const ev = (forgeShare) => smell.evaluate({ forgeShare }, { now: 0 })[0];

describe('forge-share-below-target', () => {
  it('is registered to notify in shadow, high severity (real reminder path), and needs the forgeShare probe', () => {
    expect(NOTIFY_EVEN_IN_SHADOW.has('forge-share-below-target')).toBe(true);
    expect(smell).toMatchObject({ id: 'forge-share-below-target', severity: 'high', action: 'alert', probes: ['forgeShare'] });
  });
  it('breaches only when the share was below target an alert-window ago AND still is', () => {
    expect(ev({ current: ok(0.5), earlier: ok(0.4) }).breach).toBe(true);
    expect(ev({ current: ok(0.5), earlier: ok(0.95) }).breach).toBe(false);
    expect(ev({ current: ok(0.95), earlier: ok(0.4) }).breach).toBe(false);
    expect(ev({ current: ok(0.9), earlier: ok(0.9) }).breach).toBe(false);
  });
  it('names the share, target and fallback reasons', () => {
    const r = ev({ current: ok(0.5), earlier: ok(0.4) });
    expect(r.subject).toBe('forge-share');
    expect(r.summary).toMatch(/50%/);
    expect(r.summary).toMatch(/90%/);
    expect(r.summary).toMatch(/remote-full/);
  });
  it('fails closed: unknown current or earlier alarms as UNKNOWN, never as a pass', () => {
    for (const input of [{ current: unknown(), earlier: ok(0.99) }, { current: ok(0.99), earlier: unknown('window-not-covered:fallbacks') }, null, undefined, {}, { current: 'x' }]) {
      const r = ev(input);
      expect(r.breach).toBe(true);
      expect(r.summary).toMatch(/UNKNOWN/);
      expect(r.measure.status).toBe('unknown');
    }
  });
});
