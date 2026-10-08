/**
 * @file worker-result-probe.test.mjs — the pure helpers of the S0 launcher probe (live runs are the PR evidence).
 */
import { describe, it, expect } from 'vitest';

import { PROBE_SCHEMA, matchesProbeShape, tryParse, main } from '../worker-result-probe.mjs';

describe('worker-result-probe pure helpers', () => {
  it('matchesProbeShape accepts exactly the probe schema shape', () => {
    expect(matchesProbeShape({ outcome: 'done', note: 'hi' })).toBe(true);
    expect(matchesProbeShape({ outcome: 'maybe', note: 'hi' })).toBe(false);
    expect(matchesProbeShape({ outcome: 'done' })).toBe(false);
    expect(matchesProbeShape({ outcome: 'done', note: 'x', extra: 1 })).toBe(false);
    expect(matchesProbeShape(null)).toBe(false);
    expect(matchesProbeShape([])).toBe(false);
  });
  it('tryParse returns null for non-JSON', () => {
    expect(tryParse('{"a":1}')).toEqual({ a: 1 });
    expect(tryParse('nope')).toBeNull();
  });
  it('main refuses an unknown --only name instead of printing an empty clean run', () => {
    expect(main(['--only=codex-exec', '--json'])).toBe(2);
  });
  it('the probe schema is strict (all keys required, no extras) so all three CLIs accept it', () => {
    expect(PROBE_SCHEMA.additionalProperties).toBe(false);
    expect(PROBE_SCHEMA.required.sort()).toEqual(Object.keys(PROBE_SCHEMA.properties).sort());
  });
});
