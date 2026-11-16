import { describe, it, expect } from 'vitest';
import smell from '../forge-disk-prune.mjs';
import { NOTIFY_EVEN_IN_SHADOW } from '../../health-smells-notify-list.mjs';
import { validateSmellShape } from '../../health-smells-shape.mjs';

const run = (telemetry) => smell.evaluate({}, { readForgeHealth: () => (telemetry === undefined ? null : { telemetry }) });
const refusal = 'forge-cache-prune: refused: Invalid reserved lock evidence';

describe('forge-disk-prune smell', () => {
  it('has a valid shape and notifies even in shadow', () => {
    expect(() => validateSmellShape(smell, 'forge-disk-prune.mjs')).not.toThrow();
    expect(NOTIFY_EVEN_IN_SHADOW.has('forge-disk-prune')).toBe(true);
  });
  it('disk 100% -> needs-you naming reason, percent, last refusal and next step', () => {
    const [f] = run({ diskUsedPct: 100, prune: { consecutiveRefused: 469, lastRefusal: refusal } });
    expect(f.breach).toBe(true);
    expect(f.escalation).toMatchObject({ humanOnly: true, status: 'needs-you' });
    expect(f.summary).toMatch(/100%/);
    expect(f.summary).toContain('Invalid reserved lock evidence');
    expect(f.recommendation).toMatch(/prune/i);
  });
  it('disk at exactly 80% fires; 79% alone does not', () => {
    expect(run({ diskUsedPct: 80, prune: { consecutiveRefused: 0 } })[0].breach).toBe(true);
    expect(run({ diskUsedPct: 79, prune: { consecutiveRefused: 0 } })[0].breach).toBe(false);
  });
  it('prune refused 3 consecutive runs -> needs-you even with a healthy disk', () => {
    const [f] = run({ diskUsedPct: 35, prune: { consecutiveRefused: 3, lastRefusal: refusal } });
    expect(f.breach).toBe(true);
    expect(f.escalation.status).toBe('needs-you');
    expect(f.summary).toMatch(/3 consecutive/);
  });
  it('healthy -> nothing breaching', () => {
    const out = run({ diskUsedPct: 35, prune: { consecutiveRefused: 2 } });
    expect(out.every((f) => f.breach === false)).toBe(true);
  });
  it('fields missing -> low-severity unobservable note, never silence', () => {
    for (const t of [{ cores: 32 }, undefined, { diskUsedPct: 'x', prune: {} }]) {
      const out = run(t);
      expect(out).toHaveLength(1);
      expect(out[0].breach).toBe(true);
      expect(out[0].severity).toBe('low');
      expect(out[0].summary).toMatch(/unobservable/);
      expect(out[0].escalation).toBeUndefined();
    }
  });
  it('a throwing reader is a note, not a crash', () => {
    const out = smell.evaluate({}, { readForgeHealth: () => { throw new Error('boom'); } });
    expect(out[0].summary).toMatch(/unobservable/);
  });
});
