import { describe, it, expect } from 'vitest';
import { findUnmarkedLocusRefs as gate } from '../../check-standards-rules.mjs';
import { findUnmarkedLocusRefs as local } from '../../lib/locus-prefix-text.mjs';

// The ruling-card helpers carry a local copy of the detector (they must not import check-standards-rules.mjs).
// Prove that copy matches the gate on the same inputs.
const SAMPLES = [
  'see scripts/a.mjs and we:scripts/b.mjs',
  'link [we:x](scripts/c.mjs) and @scope/pkg.js and https://e.com/f.md',
  'Node.js, *.test.ts, .d.ts, dup scripts/a.mjs scripts/a.mjs',
  'relatedReport: scripts/z.md\n```\nscripts/fenced.mjs\n```\nreal fui:src/q.ts and src/r.ts:12-14',
];
describe('locus-prefix-text local locus detector', () => {
  it.each(SAMPLES)('matches the gate on %#', (s) => { expect(local(s)).toEqual(gate(s)); });
});
